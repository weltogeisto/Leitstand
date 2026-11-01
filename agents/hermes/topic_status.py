"""Read Hermes gateway/topic status without selecting conversation content."""
from datetime import datetime
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import time


class StatusUnavailable(Exception):
    pass


def process_alive(pid, expected_start=None):
    """Check both PID and process creation time when the registry provides it."""
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        return False
    try:
        if os.name == 'nt':
            raise StatusUnavailable('Gateway monitoring requires Linux')
        os.kill(pid, 0)
        if expected_start is not None:
            fields = (Path('/proc') / str(pid) / 'stat').read_text().rsplit(')', 1)[1].split()
            boot = next(int(line.split()[1]) for line in Path('/proc/stat').read_text().splitlines() if line.startswith('btime '))
            started = boot + int(fields[19]) / os.sysconf('SC_CLK_TCK')
            if abs(started - float(expected_start)) >= .02:
                return False
        return True
    except (ProcessLookupError, FileNotFoundError):
        return False
    except (OSError, ValueError, IndexError, StopIteration) as exc:
        raise StatusUnavailable('Process identity is unavailable') from exc


def gateway_pid(home, now):
    lock = json.loads((home / 'gateway.lock').read_text())
    pid = int(lock['pid'])
    if not process_alive(pid):
        raise StatusUnavailable('Gateway is not running')
    if b'hermes' not in (Path('/proc') / str(pid) / 'cmdline').read_bytes().lower():
        raise StatusUnavailable('Gateway process identity changed')
    heartbeat = json.loads((home / 'state/gateway.heartbeat').read_text())
    updated = datetime.fromisoformat(heartbeat['updated_at'].replace('Z', '+00:00')).timestamp()
    if int(heartbeat['pid']) != pid or not -30 <= now - updated <= 180:
        raise StatusUnavailable('Gateway heartbeat is stale')
    return pid


def read_entries(home):
    entries = json.loads((home / 'runtime/active_sessions.json').read_text())['entries']
    if not isinstance(entries, list) or any(not isinstance(e, dict) for e in entries):
        raise StatusUnavailable('Active-turn registry is unavailable')
    return entries


def topic_route(home, item):
    # entry_json can contain a prompt pin. Extract only routing fields inside
    # SQLite, never select or deserialize the complete record in this reporter.
    uri = (home / 'state.db').resolve().as_uri() + '?mode=ro'
    with closing(sqlite3.connect(uri, uri=True, timeout=3)) as db:
        db.execute('PRAGMA query_only=ON')
        rows = db.execute("""
            SELECT session_key, json_extract(entry_json, '$.session_id'),
                   json_extract(entry_json, '$.suspended')
            FROM gateway_routing
            WHERE scope = ?
              AND json_extract(entry_json, '$.origin.platform') = 'telegram'
              AND CAST(json_extract(entry_json, '$.origin.chat_id') AS TEXT) = ?
              AND CAST(json_extract(entry_json, '$.origin.thread_id') AS TEXT) = ?
              AND COALESCE(json_extract(entry_json, '$.origin.profile'), 'default') = ?
            """, (str(home / 'sessions'), str(item['chat_id']), str(item['thread_id']),
                  item.get('profile', 'default'))).fetchall()
    if len(rows) != 1:
        raise StatusUnavailable('Topic routing is unavailable')
    return rows[0]


def snapshot(home, item, now=None):
    try:
        pid = gateway_pid(home, time.time() if now is None else now)
        entries = read_entries(home)
        suspended = False
        if 'thread_id' in item:
            session_key, session_id, suspended = topic_route(home, item)
            identities = {key for key in (session_key, session_id) if key}
            entries = [e for e in entries if e.get('surface') == 'gateway:telegram'
                       and e.get('session_id') in identities and e.get('pid') == pid]
        count = sum(process_alive(e.get('pid'), e.get('process_start_time')) for e in entries)
        status = 'active' if count else 'waiting' if suspended else 'done'
        title = ('Turn running' if count == 1 else f'{count} turns running') if count else (
            'Topic paused; needs attention' if suspended else 'Idle — no active turn')
        return status, title, {'gateway_online': True, 'active_turns': count,
                               'topic_scoped': 'thread_id' in item}
    except StatusUnavailable as exc:
        return 'failed', str(exc), {'status_known': False}
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error):
        return 'failed', 'Status metadata unavailable', {'status_known': False}
