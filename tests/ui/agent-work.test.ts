import {test} from "node:test";
import assert from "node:assert/strict";
import {agentWork,agentSchedules,workUpdate} from "../../src/lib/agent-work";
import {topicTelemetry,buildStrips} from "../../src/lib/leitstand-board";
import type {Event,FleetAgent} from "../../src/lib/types";
test("work cards tolerate malformed fields and keep bounded text",()=>{
  const d={work_items:[null,{id:"a",title:"ABSOLVO",status:"running",result:"x".repeat(9000)},{id:"a",title:"duplicate"},{id:"b",title:"Other",status:"unexpected"}]};
  assert.equal(agentWork(d).length,2);assert.equal(agentWork(d)[0].result?.length,1800);
  assert.equal(agentWork(d)[1].status,"unknown");assert.deepEqual(agentWork({work_items:"bad"}),[]);
  assert.deepEqual(agentSchedules({scheduled_work:[{id:"a",title:"Digest",next_run_at:"invalid"}]}),[{id:"a",title:"Digest",next_run_at:null,last_status:null}]);
  assert.equal(workUpdate({work_update:{secret:"no"}}).text,"");
});
test("topic heartbeat keeps task details from the latest scoped snapshot",()=>{
  const snapshot:Event={id:1,agent_id:"muse",session_id:"s",kind:"session_start",created_at:"2026-11-02T20:00:00Z",title:"Working",detail:{topic_scoped:true,work_details_enabled:true,work_items:[{id:"a",title:"ABSOLVO",status:"running"}],work_update:"Building the scene"}};
  const heartbeat:Event={...snapshot,id:2,kind:"heartbeat",created_at:"2026-11-02T20:01:00Z",detail:{topic_scoped:true,work_details_enabled:true,work_step:"Using the terminal"}};
  const sibling={...snapshot,id:3,agent_id:"other",created_at:"2026-11-02T20:02:00Z",detail:{...snapshot.detail,work_update:"SIBLING"}};
  const merged=topicTelemetry("muse",[snapshot,heartbeat,sibling]);
  assert.equal(merged?.created_at,heartbeat.created_at);assert.equal(merged?.detail?.work_update,"Building the scene");
  assert.equal(agentWork(merged?.detail)[0].title,"ABSOLVO");assert.equal(merged?.detail?.work_step,"Using the terminal");
  const a={id:"muse",platform:"hermes",derived_status:"active",current_session:null} as FleetAgent;
  assert.equal(buildStrips([a],[],[snapshot,heartbeat])[0].workItems?.[0].title,"ABSOLVO");
  heartbeat.detail!.work_details_enabled=false;
  assert.deepEqual(agentWork(topicTelemetry("muse",[snapshot,heartbeat])?.detail),[]);
});
