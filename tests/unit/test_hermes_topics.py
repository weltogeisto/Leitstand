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
        self.db.execute('CREATE TABLE sessions (id TEXT, last_activity_at REAL)')
        self.db.execute('CREATE TABLE async_delegations (parent_session_id TEXT, origin_session TEXT, state TEXT, owner_pid INTEGER, owner_started_at INTEGER)')
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

    def test_managed_worker_need_not_share_gateway_pid(self):
        self.entries([self.lease('session-1', pid=123)])
        with patch.object(ts, 'process_alive', return_value=True):
            self.assertEqual(ts.snapshot(self.home, self.items[1])[0], 'active')
            self.assertEqual(ts.snapshot(self.home, self.items[0])[0], 'done')

    def test_background_process_is_scoped_and_does_not_leak_command(self):
        (self.home / 'processes.json').write_text(json.dumps([
            {'session_key': 'gateway:chat:default:2', 'pid': 77, 'host_start_time': 100,
             'command': 'PRIVATE_COMMAND_SENTINEL', 'pid_scope': 'host'}]))
        with patch.object(ts, 'kernel_process_alive', return_value=True):
            status, title, detail = ts.snapshot(self.home, self.items[2])
            self.assertEqual(status, 'active')
            self.assertEqual(detail['background_processes'], 1)
            self.assertEqual(ts.snapshot(self.home, self.items[1])[0], 'done')
            self.assertNotIn('PRIVATE_', json.dumps([title, detail]))
        with patch.object(ts, 'kernel_process_alive', return_value=False):
            self.assertEqual(ts.snapshot(self.home, self.items[2])[0], 'done')

    def test_unverifiable_remote_process_is_not_idle(self):
        (self.home / 'processes.json').write_text(json.dumps([
            {'session_key': 'session-0', 'pid_scope': 'container', 'pid': 42}]))
        status, _, detail = ts.snapshot(self.home, self.items[0])
        self.assertEqual(status, 'failed')
        self.assertFalse(detail['status_known'])

    def test_delegation_is_scoped_and_dead_owner_is_unknown(self):
        self.db.execute('INSERT INTO async_delegations VALUES (?,?,?,?,?)', ('session-3','','running',77,100))
        self.db.commit()
        with patch.object(ts, 'kernel_process_alive', return_value=True):
            self.assertEqual(ts.snapshot(self.home, self.items[3])[0], 'active')
            self.assertEqual(ts.snapshot(self.home, self.items[2])[0], 'done')
        with patch.object(ts, 'kernel_process_alive', return_value=False):
            self.assertEqual(ts.snapshot(self.home, self.items[3])[0], 'failed')

    def test_schedule_and_last_activity_are_not_heartbeat_time(self):
        cron = self.home / 'cron'; cron.mkdir()
        (cron / 'jobs.json').write_text(json.dumps({'jobs':[
            {'id':'job','enabled':True,'next_run_at':'2026-11-03T06:00:00+00:00',
             'last_run_at':'2026-11-02T06:00:00+00:00','prompt':'PRIVATE_PROMPT_SENTINEL',
             'origin':{'platform':'telegram','chat_id':'chat','thread_id':'1'}},
            {'id':'other','enabled':True,'origin':{'platform':'telegram','chat_id':'other','thread_id':'1'}}]}))
        with contextlib.closing(sqlite3.connect(cron / 'executions.db')) as db:
            db.execute('CREATE TABLE executions (job_id TEXT,pid INTEGER,process_started_at INTEGER,status TEXT,finished_at TEXT,claimed_at TEXT)')
            db.execute("INSERT INTO executions VALUES ('job',77,100,'completed','2026-11-02T06:02:00+00:00','2026-11-02T06:00:00+00:00')")
            db.commit()
        status, title, detail = ts.snapshot(self.home, self.items[1], now=1793650000)
        self.assertEqual(status,'done')
        self.assertEqual(detail['scheduled_jobs'],1)
        self.assertEqual(detail['last_activity_at'],'2026-11-02T06:02:00+00:00')
        self.assertEqual(ts.snapshot(self.home,self.items[0])[2]['scheduled_jobs'],0)
        self.assertNotIn('PRIVATE_',json.dumps([title,detail]))
        with contextlib.closing(sqlite3.connect(cron / 'executions.db')) as db:
            db.execute("UPDATE executions SET status='running',finished_at=NULL")
            db.commit()
        with patch.object(ts,'kernel_process_alive',return_value=True):
            self.assertEqual(ts.snapshot(self.home,self.items[1])[0],'active')

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

    def test_new_activity_refreshes_summary_without_changing_status(self):
        sent = []; previous = {}
        def post(req, timeout):
            sent.append(json.loads(req.data)); return io.BytesIO(b'{"ok":true}')
        with patch.object(reporter.urllib.request, 'urlopen', side_effect=post), contextlib.redirect_stdout(io.StringIO()):
            config = {'url':'https://example.invalid','profiles':self.items[:1]}
            reporter.report(config,previous)
            self.db.execute("INSERT INTO sessions VALUES ('session-0', 1793645000)"); self.db.commit()
            reporter.report(config,previous)
            reporter.report(config,previous)
        self.assertEqual([r['kind'] for r in sent], ['session_start','session_start','heartbeat'])
        self.assertEqual(sent[1]['detail']['last_activity_at'], '2026-11-02T18:43:20+00:00')


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
