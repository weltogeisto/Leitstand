import { test } from "node:test";
import assert from "node:assert/strict";
import {buildStrips} from "../../src/lib/leitstand-board";
import type {FleetAgent,Task} from "../../src/lib/types";
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
