import { test } from "node:test";
import assert from "node:assert/strict";
import {buildStrips} from "../../src/lib/leitstand-board";
import type {Event,FleetAgent,Task} from "../../src/lib/types";
test("offline signals stay stuck and task review needs attention",()=>{
  const a={id:"h",platform:"hermes",derived_status:"offline",display_name:"Hermes",last_seen_at:null,current_session:null} as FleetAgent;
  const t={id:1,platform:"codex",status:"review",title:"Review change",updated_at:"2026-11-01T00:00:00Z"} as Task;
  const rows=buildStrips([a],[t]);
  assert.equal(rows.find(x=>x.id==="agent:h")?.bay,"stuck");
  assert.equal(rows.find(x=>x.id==="task:1")?.bay,"needs");
  assert.equal(rows.find(x=>x.id==="agent:h")?.title,"No recent heartbeat");
});
test("running task represented by an agent is not counted twice",()=>{
  const a={id:"c",platform:"codex",derived_status:"active",current_session:null} as FleetAgent;
  const t={id:1,platform:"codex",status:"running",assigned_agent:"c"} as Task;
  assert.equal(buildStrips([a],[t]).length,1);
});
test("idle and failed topic cards retain their latest status summary",()=>{
  const a={id:"hermes-topic",platform:"hermes",derived_status:"done",current_session:null,
    recent_sessions:[{summary:"Idle — no active turn",project:"Hermes_Hegel topic"}]} as FleetAgent;
  assert.equal(buildStrips([a],[])[0].title,"Idle — no active turn");
  a.derived_status="failed";
  a.recent_sessions[0].summary="Status metadata unavailable";
  assert.equal(buildStrips([a],[])[0].title,"Status metadata unavailable");
  assert.equal(buildStrips([a],[])[0].bay,"stuck");
});
test("retired reporters stay in History data without duplicate dashboard cards",()=>{
  const old={id:"old",platform:"hermes",derived_status:"offline",current_session:null,dashboard_hidden:true} as FleetAgent;
  const topic={id:"topic",platform:"hermes",derived_status:"done",current_session:null} as FleetAgent;
  const agents=[old,topic];
  assert.deepEqual(buildStrips(agents,[]).map(s=>s.id),["agent:topic"]);
  assert.equal(agents.length,2);
  const task={id:1,platform:"hermes",status:"running",assigned_agent:"old"} as Task;
  assert.ok(buildStrips(agents,[task]).some(s=>s.id==="task:1"));
});
test("topic activity and schedules come from the newest scoped metadata, not heartbeat time",()=>{
  const a={id:"hermes-topic",platform:"hermes",derived_status:"done",last_seen_at:"2026-11-02T19:30:00Z",
    current_session:null,recent_sessions:[{summary:"Old status"}]} as FleetAgent;
  const old:Event={id:1,kind:"heartbeat",session_id:null,agent_id:a.id,created_at:"2026-11-02T19:00:00Z",title:"Old",detail:{topic_scoped:true}};
  const latest:Event={...old,id:2,created_at:a.last_seen_at!,title:"3 scheduled jobs enabled",detail:{topic_scoped:true,
    scheduled_jobs:3,last_activity_at:"2026-11-02T19:22:00Z",next_run_at:"2026-11-02T19:52:00Z"}};
  const unrelated={...latest,agent_id:"another-topic",title:"Another topic is working"};
  const [row]=buildStrips([a],[],[old,unrelated,latest]);
  assert.equal(row.title,"3 scheduled jobs enabled");assert.equal(row.activityAt,"2026-11-02T19:22:00Z");
  assert.equal(row.at,a.last_seen_at);assert.equal(row.nextAt,"2026-11-02T19:52:00Z");
  assert.equal(row.scheduled,3);assert.equal(row.href,"/history?agent=hermes-topic");
  a.derived_status="offline";
  assert.equal(buildStrips([a],[],[latest])[0].title,"No recent heartbeat");
});
