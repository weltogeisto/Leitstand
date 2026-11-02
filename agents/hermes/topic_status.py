"""Read Hermes gateway/topic status without selecting conversation content."""
from datetime import datetime, timezone
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


def kernel_process_alive(pid, start):
    """Hermes background/cron ownership uses kernel ticks, not Unix seconds."""
    if not process_alive(pid):
        return False
    if start is None:
        raise StatusUnavailable('Background process identity is unavailable')
    try:
        fields = (Path('/proc') / str(pid) / 'stat').read_text().rsplit(')', 1)[1].split()
        return fields[0] != 'Z' and int(fields[19]) == int(start)
    except FileNotFoundError:
        return False


def metadata_rows(path, expression, parameters=()):
    """Project a local JSON file inside SQLite; never deserialize its commands/prompts."""
    with closing(sqlite3.connect(':memory:')) as db:
        return db.execute(expression, (path.read_text(), *parameters)).fetchall()


def topic_activity(home, item, identities, session_id, now):
    detail = {'background_processes': 0, 'delegated_work': 0, 'scheduled_jobs': 0,
              'running_jobs': 0, 'status_known': True, 'coverage': 'local-turns-processes-delegations-cron'}
    timestamps = []
    with closing(sqlite3.connect((home / 'state.db').resolve().as_uri() + '?mode=ro', uri=True, timeout=3)) as db:
        db.execute('PRAGMA query_only=ON')
        row = db.execute('SELECT last_activity_at FROM sessions WHERE id=?', (session_id,)).fetchone()
        if row and row[0]: timestamps.append(float(row[0]))
        for parent, origin, state, pid, started in db.execute("""
            SELECT parent_session_id, origin_session, state, owner_pid, owner_started_at
            FROM async_delegations WHERE state IN ('running','stalling','finalizing')
        """):
            if parent in identities or origin in identities:
                if kernel_process_alive(pid, started): detail['delegated_work'] += 1
                else: detail['status_known'] = False
    processes = home / 'processes.json'
    if processes.exists():
        for key, pid, started, scope in metadata_rows(processes, """
            SELECT json_extract(value,'$.session_key'), json_extract(value,'$.pid'),
                   json_extract(value,'$.host_start_time'), COALESCE(json_extract(value,'$.pid_scope'),'host')
            FROM json_each(?)
        """):
            if key not in identities: continue
            if scope != 'host': detail['status_known'] = False
            elif kernel_process_alive(pid, started): detail['background_processes'] += 1
    jobs = home / 'cron/jobs.json'
    if jobs.exists():
        rows = metadata_rows(jobs, """
            SELECT json_extract(value,'$.id'), json_extract(value,'$.enabled'),
                   json_extract(value,'$.next_run_at'), json_extract(value,'$.last_run_at')
            FROM json_each(?, '$.jobs')
            WHERE json_extract(value,'$.origin.platform')='telegram'
              AND CAST(json_extract(value,'$.origin.chat_id') AS TEXT)=?
              AND CAST(json_extract(value,'$.origin.thread_id') AS TEXT)=?
        """, (str(item['chat_id']), str(item['thread_id'])))
        next_runs = []
        for job_id, enabled, next_at, last_at in rows:
            if last_at: timestamps.append(datetime.fromisoformat(last_at).timestamp())
            if enabled:
                detail['scheduled_jobs'] += 1
                if next_at: next_runs.append(datetime.fromisoformat(next_at).timestamp())
        if next_runs: detail['next_run_at'] = datetime.fromtimestamp(min(next_runs), timezone.utc).isoformat()
        ids = {r[0] for r in rows}
        ledger = home / 'cron/executions.db'
        if ids and ledger.exists():
            with closing(sqlite3.connect(ledger.resolve().as_uri() + '?mode=ro', uri=True, timeout=3)) as db:
                db.execute('PRAGMA query_only=ON')
                for job_id, finished in db.execute('SELECT job_id,MAX(finished_at) FROM executions GROUP BY job_id'):
                    if job_id in ids and finished: timestamps.append(datetime.fromisoformat(finished).timestamp())
                for job_id, pid, started in db.execute(
                        "SELECT job_id,pid,process_started_at FROM executions WHERE status IN ('running','claimed')"):
                    if job_id not in ids: continue
                    if kernel_process_alive(pid, started): detail['running_jobs'] += 1
                    else: detail['status_known'] = False
        elif ids:
            detail['status_known'] = False
    if timestamps:
        valid = [t for t in timestamps if 0 < t <= now + 30]
        if valid: detail['last_activity_at'] = datetime.fromtimestamp(max(valid), timezone.utc).isoformat()
    return detail


def snapshot(home, item, now=None):
    try:
        now = time.time() if now is None else now
        gateway_pid(home, now)
        entries = read_entries(home)
        suspended = False
        detail = {}
        if 'thread_id' in item:
            session_key, session_id, suspended = topic_route(home, item)
            identities = {key for key in (session_key, session_id) if key}
            entries = [e for e in entries if e.get('surface') == 'gateway:telegram'
                       and e.get('session_id') in identities]
            detail = topic_activity(home, item, identities, session_id, now)
        count = sum(process_alive(e.get('pid'), e.get('process_start_time')) for e in entries)
        background = sum(detail.get(k, 0) for k in ('background_processes','delegated_work','running_jobs'))
        status = 'active' if count or background else 'waiting' if suspended else 'failed' if not detail.get('status_known', True) else 'done'
        if count: title = 'Working in chat' if count == 1 else f'{count} chat turns running'
        elif background: title = f'{background} background job' + ('s' if background != 1 else '') + ' running'
        elif suspended: title = 'Topic paused; needs attention'
        elif not detail.get('status_known', True): title = 'Some work cannot be verified'
        elif detail.get('scheduled_jobs'): title = f"{detail['scheduled_jobs']} scheduled jobs enabled"
        else: title = 'Connected · no local work detected'
        return status, title, {**detail, 'gateway_online': True, 'active_turns': count,
                               'topic_scoped': 'thread_id' in item}
    except StatusUnavailable as exc:
        return 'failed', str(exc), {'status_known': False}
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error):
        return 'failed', 'Status metadata unavailable', {'status_known': False}
