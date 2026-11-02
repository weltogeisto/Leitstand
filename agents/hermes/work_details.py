"""Bounded work briefs for the private dashboard; never export tool logs/reasoning.

Enabled explicitly per topic with share_work_details. Every text field is cleaned
before it can enter an ingest payload. SQL selects only the requested topic and
public-facing task/result fields, not provider config or conversation transcripts.
"""
from contextlib import closing
from datetime import datetime, timezone
import re
import sqlite3
from urllib.parse import urlsplit, urlunsplit


def clean_text(value, limit=500):
    if not isinstance(value, str): return ''
    text = value[:24000]
    if text.lstrip().startswith(('{','[{')): return ''
    text = re.sub(r'(?is)<(think|thinking|analysis|reasoning)\b[^>]*>.*?(?:</\1>|$)', '', text)
    text = re.sub(r'(?s)```.*?(?:```|$)', '[code omitted]', text)
    text = re.sub(r'(?is)-----BEGIN [^-]*PRIVATE KEY-----.*?(?:-----END [^-]*PRIVATE KEY-----|$)', '[redacted]', text)
    text = re.sub(r'(?im)^.*\b(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret|authorization|recovery[_ -]?code|setup[_ -]?key)\b\s*[:=].*$', '[redacted]', text)
    text = re.sub(r'(?i)\bBearer\s+\S+|\b(?:sk-|ghp_|github_pat_|akc_|xox[baprs]-)[\w-]+', '[redacted]', text)
    text = re.sub(r'\b\d{6,12}:[A-Za-z0-9_-]{20,}\b|\beyJ[\w-]+\.[\w-]+\.[\w-]+\b', '[redacted]', text)
    def public_url(match):
        try:
            u = urlsplit(match.group()); host = u.hostname or ''
            if u.username or u.password or host in ('localhost','127.0.0.1') or re.fullmatch(r'[\d.]+',host): return '[private link]'
            return urlunsplit((u.scheme, host, u.path, '', ''))
        except ValueError: return '[link]'
    text = re.sub(r'https?://[^\s<>"\)]+', public_url, text)
    text = re.sub(r'(?i)\b(?:postgres(?:ql)?|redis|otpauth)://\S+', '[private link]', text)
    text = re.sub(r'(?i)(?<![A-Za-z0-9])(?:[A-Z]:[\\/]|/(?:home|var|tmp|root|mnt|Users)/)[^\s,;<>]+', '[local file]', text)
    text = re.sub(r'\b[A-Za-z0-9_+/-]{28,}={0,2}\b', '[redacted]', text)
    text = re.sub(r'<[^>]+>', '', text)
    text = re.sub(r'[\x00-\x08\x0b-\x1f\x7f]', '', text)
    text = re.sub(r'(?m)^\s*#{1,6}\s*', '', text).replace('**', '').replace('`', '')
    text = re.sub(r'\s+', ' ', text).strip()
    return text if len(text) <= limit else text[:limit-1].rsplit(' ',1)[0] + '…'


def title_for(value):
    text = clean_text(value, 1000)
    first = re.split(r'(?<=[.!?])\s+(?=[A-Z])', text, maxsplit=1)[0]
    return clean_text(first, 180) or 'Task details not reported'


def iso(value):
    if not value: return None
    try:
        return datetime.fromtimestamp(float(value), timezone.utc).isoformat()
    except (ValueError, TypeError, OverflowError, OSError): return None


def step_label(description):
    # Runtime descriptions may name a tool; never forward tool arguments.
    text = (description or '').lower()
    for word,label in [('web_search','Searching sources'),('web_extract','Reading sources'),
                       ('browser','Checking in the browser'),('terminal','Using the terminal'),
                       ('receiving stream','Preparing a response'),('delegate_task','Working with delegated agents')]:
        if word in text: return label
    return None


def scheduled_details(home, item, owner_alive):
    path = home/'cron/jobs.json'
    if not path.exists(): return [], []
    with closing(sqlite3.connect(':memory:')) as db:
        rows = db.execute("""SELECT json_extract(value,'$.id'),json_extract(value,'$.name'),
            json_extract(value,'$.next_run_at'),json_extract(value,'$.last_status')
            FROM json_each(?,'$.jobs') WHERE json_extract(value,'$.enabled')=1
              AND json_extract(value,'$.origin.platform')='telegram'
              AND CAST(json_extract(value,'$.origin.chat_id') AS TEXT)=?
              AND CAST(json_extract(value,'$.origin.thread_id') AS TEXT)=? LIMIT 8""",
            (path.read_text(),str(item['chat_id']),str(item['thread_id']))).fetchall()
    scheduled = [{'id':r[0],'title':title_for(r[1]),'next_run_at':r[2],
                  'last_status':r[3] if r[3] in ('ok','error') else None} for r in rows]
    names = {r['id']:r['title'] for r in scheduled}
    running = []
    ledger = home/'cron/executions.db'
    if names and ledger.exists():
        with closing(sqlite3.connect(ledger.resolve().as_uri()+'?mode=ro',uri=True,timeout=3)) as db:
            for eid, job, pid, birth, started in db.execute("SELECT id,job_id,pid,process_started_at,started_at FROM executions WHERE status IN ('running','claimed')"):
                if job in names and owner_alive(pid,birth):
                    running.append({'id':'cron:'+eid,'title':names[job],'status':'running','source':'schedule',
                                    'started_at':started,'updated_at':started,'result':None})
    return scheduled, running


def work_details(home, item, identities, session_id, now, is_active, owner_alive):
    result = {'work_items': [], 'work_details_enabled': True}
    with closing(sqlite3.connect((home/'state.db').resolve().as_uri()+'?mode=ro', uri=True, timeout=3)) as db:
        db.execute('PRAGMA query_only=ON')
        session = db.execute('SELECT last_activity_description,last_activity_at FROM sessions WHERE id=?', (session_id,)).fetchone()
        if session and is_active: result['work_step'] = step_label(session[0])
        # Origin key persists across a topic reset; parent id scopes the current conversation.
        placeholders = ','.join('?' for _ in identities)
        keys = sorted(identities)
        rows = db.execute(f"""SELECT delegation_id,state,dispatched_at,updated_at,completed_at,owner_pid,owner_started_at,
                    json_extract(task_json,'$.goal')
                FROM async_delegations WHERE parent_session_id IN ({placeholders}) OR origin_session IN ({placeholders})
                ORDER BY CASE WHEN state IN ('running','stalling','finalizing') THEN 0 ELSE 1 END, dispatched_at DESC LIMIT 4""", (*keys,*keys)).fetchall()
        for delegation, state, started, updated, ended, pid, birth, goal in rows:
            running = state in ('running','stalling','finalizing')
            verified = owner_alive(pid,birth) if running else False
            goals = db.execute("SELECT CAST(j.key AS INTEGER),j.value FROM async_delegations a,json_each(a.task_json,'$.goals') j WHERE a.delegation_id=? AND j.type='text' ORDER BY CAST(j.key AS INTEGER) LIMIT 4",(delegation,)).fetchall()
            if not goals: goals = [(0,goal)]
            outputs = {r[0]:r[1:] for r in db.execute("""SELECT json_extract(j.value,'$.task_index'),json_extract(j.value,'$.status'),
                json_extract(j.value,'$.summary') FROM async_delegations a,json_each(a.result_json,'$.results') j
                WHERE a.delegation_id=? AND j.type='object' LIMIT 8""",(delegation,))}
            for index, brief in goals:
                child_state, summary = outputs.get(index, (None,None))
                child_status = 'completed' if child_state == 'completed' else 'failed' if child_state in ('error','failed','interrupted','cancelled') else 'running' if running and verified else 'unknown' if running else 'completed' if state == 'completed' else 'failed'
                result['work_items'].append({'id':f'{delegation}:{index}', 'title':title_for(brief),
                    'brief':clean_text(brief,600), 'status':child_status, 'source':'delegation',
                    'started_at':iso(started),'updated_at':iso(ended or updated),
                    'result':clean_text(summary,1800) or None})
        # This is a user-visible assistant message, not its private reasoning or tool output.
        update = db.execute("""SELECT content,timestamp FROM messages WHERE session_id=? AND role='assistant'
            AND active=1 AND content IS NOT NULL AND content!='' AND (tool_calls IS NULL OR tool_calls='[]')
            ORDER BY timestamp DESC LIMIT 1""",(session_id,)).fetchone()
        if update and update[1] and update[1] >= now-14*86400:
            result['work_update'] = clean_text(update[0],1000)
            result['work_update_at'] = iso(update[1])
        if not result['work_items']:
            # For ordinary chat turns, expose a short task brief rather than a transcript.
            prompt = db.execute("""SELECT content,timestamp FROM messages WHERE session_id=? AND role='user'
                AND active=1 AND content IS NOT NULL ORDER BY timestamp DESC LIMIT 1""",(session_id,)).fetchone()
            if prompt:
                result['work_items'].append({'id':f'chat:{session_id}', 'title':title_for(prompt[0]),
                    'brief':clean_text(prompt[0],400), 'status':'running' if is_active else 'recent',
                    'source':'conversation','started_at':iso(prompt[1]),'updated_at':iso(session[1]) if session else None,
                    'result':None})
        scheduled, running = scheduled_details(home,item,owner_alive)
        result['scheduled_work'] = scheduled
        result['work_items'] = running + result['work_items']
        result['work_items'] = result['work_items'][:8]
    return result
