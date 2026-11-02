"use client";
import {agentSchedules,agentWork,workUpdate,WORK_LABELS,type AgentWork} from "@/lib/agent-work";
import {TimeAgo} from "./ui";
import type {Event} from "@/lib/types";
import "./agent-work.css";

function WorkItem({item}:{item:AgentWork}) {
  return <article className={`agent-work-item agent-work-${item.status}`}>
    <div className="agent-work-item-meta"><span><i/>{WORK_LABELS[item.status]}</span>{item.started_at&&<span>Started <TimeAgo iso={item.started_at}/></span>}</div>
    <h3>{item.title}</h3>
    {item.result&&<details className="agent-work-result"><summary>Read result</summary><p>{item.result}</p><small>Result excerpt from Hermes</small></details>}
    {item.brief&&item.brief!==item.title&&<details className="agent-work-brief"><summary>Task brief</summary><p>{item.brief}</p></details>}
  </article>;
}
export function AgentWorkDetails({detail}:{detail:Event["detail"]|undefined}) {
  const items=agentWork(detail),schedules=agentSchedules(detail),update=workUpdate(detail);
  const current=items.filter(i=>i.status==="running"||i.status==="unknown"),recent=items.filter(i=>!["running","unknown"].includes(i.status));
  if(!items.length&&!schedules.length&&!update.text)return <p className="history-empty">Task details have not arrived yet. Status checks are available below.</p>;
  return <section className="agent-work-details" aria-label="What this agent is working on">
    {detail?.work_details_unavailable===true&&<p className="ds-notice">Task descriptions could not refresh. Showing the last received details.</p>}
    {current.length>0&&<><div className="agent-work-heading"><h2>Working on</h2>{update.step&&<span>{update.step}</span>}</div>{current.map(item=><WorkItem key={item.id} item={item}/>)}</>}
    {update.text&&<section className="agent-work-update" aria-label="Latest update from Hermes"><div><h2>Latest update from Hermes</h2><TimeAgo iso={update.at}/></div><p>{update.text}</p></section>}
    {recent.length>0&&<div className="agent-work-recent"><h2>Recent work & results</h2>{recent.map(item=><WorkItem key={item.id} item={item}/>)}</div>}
    {schedules.length>0&&<div className="agent-work-schedules"><h2>Scheduled work</h2>{schedules.map(s=><article key={s.id}><h3>{s.title}</h3><p>{s.next_run_at?<>Next <time dateTime={s.next_run_at}>{new Date(s.next_run_at).toLocaleString([],{weekday:"short",hour:"2-digit",minute:"2-digit"})}</time></>:"Next run not reported"}{s.last_status&&` · Last run ${s.last_status==="ok"?"succeeded":"failed"}`}</p></article>)}</div>}
  </section>;
}
