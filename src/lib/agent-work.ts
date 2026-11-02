import type { Event } from "./types";

export type AgentWork = {id:string; title:string; brief:string; status:"running"|"completed"|"failed"|"unknown"|"recent"; source:string; started_at:string|null; updated_at:string|null; result:string|null};
export type AgentSchedule = {id:string; title:string; next_run_at:string|null; last_status:string|null};
function text(v:unknown,max=1800):string {return typeof v === "string" ? v.slice(0,max) : "";}
function time(v:unknown):string|null {return typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null;}
function record(v:unknown):v is Record<string,unknown> {return v !== null && typeof v === "object" && !Array.isArray(v);}
export function agentWork(detail:Event["detail"]|undefined):AgentWork[] {
  if (!Array.isArray(detail?.work_items)) return [];
  const seen=new Set<string>();
  return detail.work_items.filter(record).slice(0,8).flatMap(v=>{
    const id=text(v.id,160),title=text(v.title,240);
    if (!id||!title||seen.has(id)) return [];
    seen.add(id);
    const status=["running","completed","failed","unknown","recent"].includes(String(v.status)) ? v.status as AgentWork["status"] : "unknown";
    return [{id,title,status,brief:text(v.brief,800),source:text(v.source,30),started_at:time(v.started_at),updated_at:time(v.updated_at),result:text(v.result)||null}];
  });
}
export function agentSchedules(detail:Event["detail"]|undefined):AgentSchedule[] {
  if(!Array.isArray(detail?.scheduled_work))return [];
  return detail.scheduled_work.filter(record).slice(0,8).filter(v=>typeof v.id==="string"&&typeof v.title==="string").map(v=>({id:text(v.id,160),title:text(v.title,240),next_run_at:time(v.next_run_at),last_status:text(v.last_status,20)||null}));
}
export function workUpdate(detail:Event["detail"]|undefined) {return {text:text(detail?.work_update,1200),at:time(detail?.work_update_at),step:text(detail?.work_step,100)};}
export const WORK_LABELS:Record<AgentWork["status"],string>={running:"Working",completed:"Finished",failed:"Stopped or failed",unknown:"Status unverified",recent:"Recent conversation"};
