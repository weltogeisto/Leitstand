import contextlib
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'agents/hermes'))
import topic_status as ts
import status_reporter as reporter


class TopicStatusTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        (self.home / 'runtime').mkdir()
        (self.home / 'state').mkdir()
        self.db = sqlite3.connect(self.home / 'state.db')
        self.addCleanup(self.db.close)
        self.db.execute('CREATE TABLE gateway_routing (scope TEXT, session_key TEXT, entry_json TEXT)')
        self.items = []
        for n in range(4):
            item = {'home': str(self.home), 'chat_id': 'chat', 'thread_id': str(n),
                    'profile': 'default', 'agent_id': f'topic-{n}', 'name': f'Topic {n}', 'token': f'test-key-{n}'}
            self.items.append(item)
            self.route(n)
        self.entries([])
        self.addCleanup(patch.stopall)
        patch.object(ts, 'gateway_pid', return_value=42).start()
        patch.object(ts, 'process_alive', side_effect=lambda pid, start=None: pid == 42 and start != -1).start()

    def route(self, n, chat='chat', profile='default', suspended=False):
        key = f'gateway:{chat}:{profile}:{n}'
        raw = {'session_id': f'session-{n}', 'suspended': suspended,
               'origin': {'platform': 'telegram', 'chat_id': chat, 'thread_id': str(n), 'profile': profile},
               'prompt_pin': 'PRIVATE_PROMPT_SENTINEL', 'title': 'PRIVATE_TITLE_SENTINEL'}
        self.db.execute('INSERT INTO gateway_routing VALUES (?,?,?)', (str(self.home / 'sessions'), key, json.dumps(raw)))
        self.db.commit()
        return key

    def entries(self, entries):
        (self.home / 'runtime/active_sessions.json').write_text(json.dumps({'entries': entries}))

    def lease(self, identity, pid=42, start=None, surface='gateway:telegram'):
        return {'session_id': identity, 'pid': pid, 'process_start_time': start,
                'surface': surface, 'metadata': {'message': 'PRIVATE_MESSAGE_SENTINEL'}}

    def test_one_active_topic_does_not_mark_siblings_active(self):
        self.entries([self.lease('gateway:chat:default:1')])
        self.assertEqual([ts.snapshot(self.home, item)[0] for item in self.items], ['done', 'active', 'done', 'done'])

    def test_exact_route_and_live_identity_match(self):
        self.route(1, chat='another-chat')
        self.route(1, profile='second')
        self.entries([self.lease('gateway:another-chat:default:1'), self.lease('gateway:chat:second:1'),
                      self.lease('gateway:chat:default:10'), self.lease('session-1', pid=99),
                      self.lease('session-1', start=-1), self.lease('session-1', surface='cli')])
        self.assertEqual(ts.snapshot(self.home, self.items[1])[0], 'done')
        self.entries([self.lease('session-1')])
        self.assertEqual(ts.snapshot(self.home, self.items[1])[0], 'active')

    def test_suspended_topic_needs_attention(self):
        self.db.execute("UPDATE gateway_routing SET entry_json=json_set(entry_json,'$.suspended',1) WHERE session_key=?", ('gateway:chat:default:2',))
        self.db.commit()
        self.assertEqual(ts.snapshot(self.home, self.items[2])[0], 'waiting')
        self.assertEqual(ts.snapshot(self.home, self.items[0])[0], 'done')

    def test_unavailable_metadata_is_not_idle(self):
        self.assertEqual(ts.snapshot(self.home, {**self.items[0], 'thread_id': 'missing'})[0], 'failed')
        (self.home / 'runtime/active_sessions.json').write_text('{broken')
        self.assertEqual(ts.snapshot(self.home, self.items[0])[0], 'failed')

    def test_reports_use_distinct_keys_and_no_private_content(self):
        self.entries([self.lease('session-2')])
        sent = []
        def post(req, timeout):
            sent.append(req)
            return io.BytesIO(b'{"ok":true}')
        with patch.object(reporter.urllib.request, 'urlopen', side_effect=post), contextlib.redirect_stdout(io.StringIO()):
            reporter.report({'url': 'https://example.invalid', 'profiles': self.items})
        self.assertEqual([r.get_header('Authorization') for r in sent], [f'Bearer test-key-{n}' for n in range(4)])
        self.assertEqual([json.loads(r.data)['status'] for r in sent], ['done', 'done', 'active', 'done'])
        for req in sent:
            self.assertNotIn(b'PRIVATE_', req.data)
            self.assertNotIn(b'chat_id', req.data)
            self.assertNotIn(b'thread_id', req.data)

    def test_recovery_reopens_status_and_unchanged_status_heartbeats(self):
        sent = []
        previous = {'topic-0': 'failed'}
        def post(req, timeout):
            sent.append(json.loads(req.data))
            return io.BytesIO(b'{"ok":true}')
        with patch.object(reporter.urllib.request, 'urlopen', side_effect=post), contextlib.redirect_stdout(io.StringIO()):
            config = {'url': 'https://example.invalid', 'profiles': self.items[:1]}
            reporter.report(config, previous)
            reporter.report(config, previous)
        self.assertEqual([r['kind'] for r in sent], ['session_start', 'heartbeat'])
        self.assertTrue(all(r['status'] == 'done' for r in sent))


class GatewayHealthTests(unittest.TestCase):
    def test_stale_heartbeat_is_not_healthy(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            (home / 'state').mkdir()
            (home / 'gateway.lock').write_text('{"pid":42}')
            (home / 'state/gateway.heartbeat').write_text('{"pid":42,"updated_at":"2026-01-01T00:00:00+00:00"}')
            with patch.object(ts, 'process_alive', return_value=True), patch.object(Path, 'read_bytes', return_value=b'hermes gateway'):
                with self.assertRaisesRegex(ts.StatusUnavailable, 'stale'):
                    ts.gateway_pid(home, 1790000000)


if __name__ == '__main__':
    unittest.main()
