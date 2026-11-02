"""Deterministic status-only reporter for installed Hermes profiles.

Reads gateway health, topic turns, background work and schedules. Topics may opt
in to redacted work briefs and public-facing updates; no raw tool logs/reasoning.
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
        shared = detail.get('work_details_enabled') is True
        semantic = {k:v for k,v in detail.items() if k not in ('last_activity_at','work_step','work_update_at')}
        if shared:
            semantic['work_items'] = [{k:v for k,v in w.items() if k != 'updated_at'} for w in detail.get('work_items',[])]
        signature = json.dumps([status, title, semantic if shared else detail], sort_keys=True)
        changed = previous.get(item['agent_id']) != signature
        sent_key = item['agent_id']+':work_snapshot_at'
        include_work = shared and (changed or time.time()-previous.get(sent_key,0) >= 300)
        kind = 'session_start' if changed else 'status' if include_work else 'heartbeat'
        if shared and not include_work:
            detail = {k:v for k,v in detail.items() if k not in ('work_items','scheduled_work','work_update','work_update_at')}
        if include_work and not changed: detail['work_snapshot_only'] = True
        body={'agent_id':item['agent_id'],'platform':'hermes','machine':socket.gethostname().split('.')[0].lower(),
              'display_name':item['name'],'kind':kind,'session_id':item['agent_id']+'-status',
              'status':status,'title':title,'summary':title,'detail':detail,
              'project':item.get('project','Hermes gateway')}
        req=urllib.request.Request(config['url'].rstrip('/')+'/api/ingest',data=json.dumps(body).encode(),
            headers={'Content-Type':'application/json','Authorization':'Bearer '+item['token']},method='POST')
        try:
            with urllib.request.urlopen(req,timeout=10) as response:
                result=json.load(response)
                if result.get('demo') or not result.get('ok'): raise ValueError('report was not persisted')
            previous[item['agent_id']] = signature
            if include_work: previous[sent_key] = time.time()
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
