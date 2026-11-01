"""Deterministic status-only reporter for installed Hermes profiles.

Reads gateway health and the active-session count. Never reads prompts,
message bodies, model credentials, or session transcripts.
"""
import argparse
import json
import os
from pathlib import Path
import socket
import time
import urllib.error
import urllib.request

def snapshot(home: Path):
    try:
        lock=json.loads((home/'gateway.lock').read_text())
        pid=int(lock['pid'])
        os.kill(pid,0)
        if os.name != 'nt':
            cmd=(Path('/proc')/str(pid)/'cmdline').read_bytes().lower()
            if b'hermes' not in cmd: return False,0
        active=home/'runtime/active_sessions.json'
        data=json.loads(active.read_text()) if active.exists() else {}
        entries=data.get('entries',[])
        return True,len(entries) if isinstance(entries,(list,dict)) else 0
    except (OSError,ValueError,KeyError,TypeError):
        return False,0

def report(config, previous=None):
    previous = previous if previous is not None else {}
    for item in config['profiles']:
        alive,count=snapshot(Path(item['home']).expanduser())
        title=f'{count} active session'+('s' if count!=1 else '') if alive and count else 'Gateway online; no active sessions' if alive else 'Gateway is not running'
        status='active' if count and alive else 'done' if alive else 'failed'
        body={'agent_id':item['agent_id'],'platform':'hermes','machine':socket.gethostname().split('.')[0].lower(),
              'display_name':item['name'],'kind':'heartbeat' if previous.get(item['agent_id']) == status else 'session_start','session_id':item['agent_id']+'-gateway',
              'status':status,'title':title,'summary':title,'detail':{'gateway_online':alive,'active_sessions':count}}
        req=urllib.request.Request(config['url'].rstrip('/')+'/api/ingest',data=json.dumps(body).encode(),
            headers={'Content-Type':'application/json','Authorization':'Bearer '+item['token']},method='POST')
        try:
            with urllib.request.urlopen(req,timeout=10) as response:
                result=json.load(response)
                if result.get('demo') or not result.get('ok'): raise ValueError('report was not persisted')
            previous[item['agent_id']] = status
            print(json.dumps({'agent':item['agent_id'],'reported':status}),flush=True)
        except Exception as e:
            print(json.dumps({'agent':item['agent_id'],'error':type(e).__name__,'status':getattr(e,'code',None)}),flush=True)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--config',required=True);parser.add_argument('--once',action='store_true');args=parser.parse_args()
    previous = {}
    while True:
        config=json.loads(Path(args.config).read_text())
        report(config, previous)
        if args.once:return
        time.sleep(config.get('interval',60))
if __name__=='__main__':main()
