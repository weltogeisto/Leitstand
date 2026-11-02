"""Deterministic status-only reporter for installed Hermes profiles.

Reads gateway health, topic turns, background work and schedules. Projects only
metadata from local records; never sends prompts, commands or transcripts.
"""
import argparse
import json
from pathlib import Path
import socket
import time
import urllib.request
from topic_status import snapshot

def report(config, previous=None):
    previous = previous if previous is not None else {}
    for item in config['profiles']:
        status,title,detail=snapshot(Path(item['home']).expanduser(),item)
        signature = json.dumps([status, title, detail], sort_keys=True)
        body={'agent_id':item['agent_id'],'platform':'hermes','machine':socket.gethostname().split('.')[0].lower(),
              'display_name':item['name'],'kind':'heartbeat' if previous.get(item['agent_id']) == signature else 'session_start','session_id':item['agent_id']+'-status',
              'status':status,'title':title,'summary':title,'detail':detail,
              'project':item.get('project','Hermes gateway')}
        req=urllib.request.Request(config['url'].rstrip('/')+'/api/ingest',data=json.dumps(body).encode(),
            headers={'Content-Type':'application/json','Authorization':'Bearer '+item['token']},method='POST')
        try:
            with urllib.request.urlopen(req,timeout=10) as response:
                result=json.load(response)
                if result.get('demo') or not result.get('ok'): raise ValueError('report was not persisted')
            previous[item['agent_id']] = signature
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
        time.sleep(config.get('interval',30))
if __name__=='__main__':main()
