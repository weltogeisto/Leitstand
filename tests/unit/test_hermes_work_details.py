import contextlib
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]/'agents/hermes'))
import work_details as wd
import status_reporter as reporter


class WorkDetailsTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.home=Path(self.tmp.name)
        self.db=sqlite3.connect(self.home/'state.db'); self.addCleanup(self.db.close)
        self.db.executescript('''CREATE TABLE sessions(id TEXT,last_activity_description TEXT,last_activity_at REAL);
          CREATE TABLE messages(session_id TEXT,role TEXT,content TEXT,timestamp REAL,active INTEGER,tool_calls TEXT,reasoning TEXT);
          CREATE TABLE async_delegations(delegation_id TEXT,state TEXT,dispatched_at REAL,updated_at REAL,completed_at REAL,
          owner_pid INTEGER,owner_started_at INTEGER,parent_session_id TEXT,origin_session TEXT,task_json TEXT,result_json TEXT);''')
        self.db.execute("INSERT INTO sessions VALUES ('s','delegate_task: subagent running terminal (iteration 4/250)',1000)")
        self.item={'chat_id':'chat','thread_id':'1'}
        self.add_task('ours','s','route',['Build the ABSOLVO scene. Keep the painting visible.','Investigate local inference.'],
                      [{'task_index':1,'status':'completed','summary':'Local inference is available. Verify access before connecting.'}])
        self.add_task('sibling','other','other-route',['OTHER_TOPIC_PRIVATE_TASK'],[])
        self.db.execute("INSERT INTO messages VALUES ('s','assistant','The confessional scene is taking shape.',999,1,NULL,'PRIVATE_REASONING')")
        self.db.execute("INSERT INTO messages VALUES ('s','tool','PRIVATE_TOOL_OUTPUT',1000,1,NULL,NULL)")
        self.db.execute("INSERT INTO messages VALUES ('s','assistant','PRIVATE_TOOL_ARGUMENT_CONTEXT',1001,1,'[{}]',NULL)")
        self.db.commit()

    def add_task(self, id, parent, origin, goals, results):
        task={'goals':goals,'goal':'group','context':'PRIVATE_CONTEXT','model':'PRIVATE_MODEL_CONFIG','task_transcripts':{'0':'PRIVATE_LOG_PATH'}}
        result={'results':results,'tool_trace':'PRIVATE_TOOL_TRACE','live_transcripts':['PRIVATE_TRANSCRIPT']}
        self.db.execute('INSERT INTO async_delegations VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                        (id,'running',900,1000,None,42,50,parent,origin,json.dumps(task),json.dumps(result)))
        self.db.commit()

    def details(self, alive=True):
        return wd.work_details(self.home,self.item,{'route','s'},'s',1100,True,lambda *_:alive)

    def test_names_progress_and_partial_results_are_topic_scoped(self):
        d=self.details()
        self.assertEqual([w['status'] for w in d['work_items']],['running','completed'])
        self.assertEqual(d['work_items'][0]['title'],'Build the ABSOLVO scene.')
        self.assertIn('Local inference',d['work_items'][1]['result'])
        self.assertEqual(d['work_step'],'Using the terminal')
        self.assertEqual(d['work_update'],'The confessional scene is taking shape.')
        self.assertNotIn('PRIVATE',json.dumps(d))

    def test_unverified_owner_does_not_claim_work_is_running(self):
        self.assertEqual(self.details(False)['work_items'][0]['status'],'unknown')

    def test_redacts_sensitive_text_before_truncation(self):
        raw='Build a UI.\nAPI_KEY=super-sensitive-secret\nBearer abcdefghijklmnop\n'+('x'*40)+'\n'+\
            'sk-private1234567890\n```echo hidden-command```\n<think>hidden thoughts</think>\n'+\
            'https://example.org/read?token=secret#key https://user:pass@example.org/path /home/me/.env C:\\Users\\me\\secret.txt'
        cleaned=wd.clean_text(raw,2000)
        for secret in ['super-sensitive','abcdefghijklmnop','hidden-command','hidden thoughts','private123','token=','user:pass','/home/me','C:\\Users','x'*40]:
            self.assertNotIn(secret,cleaned)
        self.assertIn('https://example.org/read',cleaned)
        self.assertNotIn('http[local file]',cleaned)
        self.assertLessEqual(len(wd.clean_text(raw,80)),80)

    def test_no_reasoning_even_in_malformed_open_tag_or_json(self):
        self.assertEqual(wd.clean_text('<analysis>never public'),'')
        self.assertEqual(wd.clean_text('{"token":"private"}'),'')
        self.assertEqual(wd.clean_text('Normal answer. <reasoning>hidden</reasoning> Done.'),'Normal answer. Done.')

    def test_names_scheduled_work_without_exporting_its_prompt(self):
        (self.home/'cron').mkdir()
        (self.home/'cron/jobs.json').write_text(json.dumps({'jobs':[
            {'id':'a','name':'Morning research digest','prompt':'PRIVATE_PROMPT','enabled':True,'last_status':'ok',
             'origin':{'platform':'telegram','chat_id':'chat','thread_id':'1'},'next_run_at':'2026-11-03T06:00:00Z'},
            {'id':'b','name':'OTHER_TOPIC','enabled':True,'origin':{'platform':'telegram','chat_id':'chat','thread_id':'2'}}]}))
        d=self.details()
        self.assertEqual(d['scheduled_work'][0]['title'],'Morning research digest')
        self.assertEqual(len(d['scheduled_work']),1)
        self.assertNotIn('PRIVATE',json.dumps(d))

    def test_ordinary_chat_uses_a_bounded_brief(self):
        self.db.execute('DELETE FROM async_delegations')
        self.db.execute("INSERT INTO messages VALUES ('s','user','Review the local website. API_KEY=hidden',950,1,NULL,NULL)")
        self.db.commit()
        d=self.details();self.assertEqual(d['work_items'][0]['source'],'conversation')
        self.assertNotIn('hidden',json.dumps(d))


class WorkSnapshotTests(unittest.TestCase):
    def test_heartbeats_reference_work_and_periodic_snapshots_refresh_it(self):
        sent=[];previous={}
        detail={'topic_scoped':True,'work_details_enabled':True,'last_activity_at':'a','work_update':'Working on the scene',
                'work_items':[{'id':'a','title':'ABSOLVO','status':'running','updated_at':'a'}]}
        def post(req,timeout): sent.append(json.loads(req.data));return io.BytesIO(b'{"ok":true}')
        cfg={'url':'https://example.invalid','profiles':[{'home':'.','agent_id':'a','name':'A','token':'test'}]}
        with patch.object(reporter,'snapshot',side_effect=lambda *_:('active','1 background job running',dict(detail))), \
             patch.object(reporter.urllib.request,'urlopen',side_effect=post),patch.object(reporter.time,'time',return_value=1000) as clock,contextlib.redirect_stdout(io.StringIO()):
            reporter.report(cfg,previous)
            detail['last_activity_at']='b';detail['work_items'][0]['updated_at']='b';clock.return_value=1020
            reporter.report(cfg,previous)
            clock.return_value=1301;reporter.report(cfg,previous)
            detail['work_items'][0]['status']='completed';clock.return_value=1320;reporter.report(cfg,previous)
        self.assertEqual([x['kind'] for x in sent],['session_start','heartbeat','status','session_start'])
        self.assertNotIn('work_items',sent[1]['detail'])
        self.assertTrue(sent[2]['detail']['work_snapshot_only'])
        self.assertEqual(sent[3]['detail']['work_items'][0]['status'],'completed')

if __name__=='__main__':unittest.main()
