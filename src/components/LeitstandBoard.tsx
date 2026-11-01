"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useFleet } from "./use-fleet";
import { buildStrips, type Bay, type Source, type Strip } from "@/lib/leitstand-board";
import type { Task } from "@/lib/types";
import "./leitstand.css";

type Project = { name: string; repo: string; description: string | null; url: string; language: string | null; pushed_at: string; archived: boolean; fork: boolean; open_items: number };
const SOURCES: Record<Source, { label: string; color: string; glyph: string }> = {
  claude: {label:"Claude",color:"#262A33",glyph:"M6 8l4 4-4 4M13 16h5"},
  openai: {label:"OpenAI",color:"#1E6B57",glyph:"M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 6l-3 12"},
  hermes: {label:"Hermes",color:"#2F6FDB",glyph:"M20 4L3.5 11l6.5 2.5L12.5 20zM10 13.5L20 4"},
  jobs: {label:"Jobs",color:"#4A5260",glyph:"M4 12a8 8 0 1 0 16 0a8 8 0 1 0-16 0M12 8v4l3 2"},
};
const BAYS: Record<Bay,{name:string;hint:string;color:string}> = {
  needs:{name:"Needs you",hint:"Waiting for your input",color:"#C8312F"},
  moving:{name:"Moving",hint:"Running without you",color:"#1D5FD0"},
  stuck:{name:"Stuck",hint:"Failed or no recent signal",color:"#9A5800"},
  quiet:{name:"Quiet",hint:"Ready or queued",color:"#5D6571"},
};
const COLORS = ["#5B4FD6","#1F6FD1","#2F7D5B","#B4561D","#0F7C86","#B0306A","#4A5260","#6B5A48","#8A5A12"];
const PROJECT_LABELS: Record<string,string> = {"AI-COLLABORATIVE-LABORATORY":"AI Lab","hegel-in-delhi":"Hegel in Delhi","The-Logic-of-Failure":"Kessel","WiederCARE-Berlin":"Wiedersehen Berlin","LOTR-Tower-Defense":"Tower Defense"};
function age(at:string|null,now:number) {
  if (!at) return ["—","no signal"];
  const minutes = Math.max(0, Math.floor((now-Date.parse(at))/60000));
  if (!Number.isFinite(minutes)) return ["—","unknown"];
  if (minutes<1) return ["now",""];
  if (minutes<60) return [String(minutes),"min"];
  if (minutes<1440) return [String(Math.floor(minutes/60)),"hours"];
  return [String(Math.floor(minutes/1440)),"days"];
}
function Glyph({source}:{source:Source}) {
  return <span className="ls-source" style={{background:SOURCES[source].color}}><svg aria-hidden width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={SOURCES[source].glyph}/></svg></span>;
}
function BayPanel({bay,items,now}:{bay:Bay;items:Strip[];now:number}) {
  const config=BAYS[bay];
  return <section className="ls-bay" aria-label={config.name}>
    <div className="ls-bay-head"><span style={{color:config.color}}>{items.length}</span><h2>{config.name}</h2><small>{config.hint}</small></div>
    {items.length===0 ? <p className="ls-empty">Nothing here for this filter.</p> : <ul>{items.map(s=>{
      const [value,unit]=age(s.at,now);
      return <li className="ls-strip" key={s.id}><Glyph source={s.source}/><div className="ls-strip-body"><span className="ls-who">{s.who}</span><h3>{s.title}</h3><p>{s.text}</p><Link className={`ls-action ${bay==="needs"?"ls-primary":""}`} href={s.href}>{s.action}</Link></div><div className="ls-age" style={{color:config.color}}><strong>{value}</strong><small>{unit}</small></div></li>;
    })}</ul>}
  </section>;
}
export default function LeitstandBoard() {
  const {data,error}=useFleet();
  const [tasks,setTasks]=useState<Task[]>([]);
  const [taskError,setTaskError]=useState<string|null>(null);
  const [projects,setProjects]=useState<Project[]>([]);
  const [repoError,setRepoError]=useState<string|null>(null);
  const [reposLoaded,setReposLoaded]=useState(false);
  const [picked,setPicked]=useState("");
  const [filter,setFilter]=useState<Source|"all">("all");
  const [query,setQuery]=useState("");
  const [answer,setAnswer]=useState("");
  const [now,setNow]=useState(0);
  const [showDormant,setShowDormant]=useState(false);
  useEffect(()=>{
    let alive=true;
    const clock=()=>setNow(Date.now()); clock(); const tick=setInterval(clock,30000);
    async function loadTasks(){try{const r=await fetch("/api/tasks?status=all&limit=100");if(!r.ok)throw new Error();const j=await r.json();if(alive){setTasks(j.tasks??[]);setTaskError(null);}}catch{if(alive)setTaskError("Task queue unavailable; its status is unknown.");}}
    async function loadRepos(){try{const r=await fetch("/api/projects");if(!r.ok)throw new Error();const j=await r.json();if(alive){setProjects(j.projects??[]);setRepoError(null);}}catch{if(alive)setRepoError("GitHub is unavailable. Repository details will retry automatically.");}finally{if(alive)setReposLoaded(true);}}
    void loadTasks();void loadRepos();const tasksTimer=setInterval(loadTasks,30000);const reposTimer=setInterval(loadRepos,900000);
    return()=>{alive=false;clearInterval(tick);clearInterval(tasksTimer);clearInterval(reposTimer);};
  },[]);
  const strips=buildStrips(data?.agents??[],tasks);
  const visible=strips.filter(s=>filter==="all"||s.source===filter);
  const needs=strips.filter(s=>s.bay==="needs").length;
  const stuck=strips.filter(s=>s.bay==="stuck").length;
  const headline=!data?"Connecting your fleet…":needs===0?"Nothing needs you.":needs===1?"One thing needs you.":`${needs} things need you.`;
  const projectActivity=(p:Project)=>(data?.agents??[]).filter(a=>a.current_session?.project?.toLowerCase()===p.name.toLowerCase()&&a.derived_status==="active").length;
  const dormant=(p:Project)=>p.archived||(now>0&&now-Date.parse(p.pushed_at)>30*86400000&&!projectActivity(p));
  const shownProjects=projects.filter(p=>showDormant||!dormant(p));
  const selected=shownProjects.find(p=>p.repo===picked)??shownProjects[0];
  const chips:(Source|"all")[]=["all","claude","openai","hermes","jobs"];
  function ask(e:React.FormEvent){
    e.preventDefault();const q=query.toLowerCase();
    const bay:Bay|null=/wait|need|approv|attention|wart/.test(q)?"needs":/stuck|fail|offline|block/.test(q)?"stuck":/run|mov|active|läuft/.test(q)?"moving":/idle|quiet|queue/.test(q)?"quiet":null;
    const found=bay?strips.filter(s=>s.bay===bay):strips.filter(s=>`${s.who} ${s.title} ${s.text}`.toLowerCase().includes(q));
    setAnswer(!data||error||taskError?"Some live sources are unavailable. The board shows the last received data; check the connection notices below.":found.length?found.map(s=>`${s.who}: ${s.title}`).join(" · "):bay?`Nothing is currently in ${BAYS[bay].name.toLowerCase()}.`:"Try asking what is waiting, running, stuck, or queued—or enter an agent or project name. Answers use this board’s current status data.");
  }
  return <div className="leitstand"><div className="ls-wrap">
    <header className="ls-header"><div className="ls-brand"><Link href="/">Leitstand</Link><span>{now?new Date(now).toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long"}):""}</span><span className="ls-live-label"><i className={data&&!error?"ls-live":""}/>{data&&!error?"Live":error?"Disconnected":"Connecting"}</span></div><form className="ls-ask" onSubmit={ask}><label className="sr-only" htmlFor="ls-ask">Ask the Leitstand status board</label><input id="ls-ask" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Ask: what is waiting on me?"/><button disabled={!query.trim()}>Ask</button></form></header>
    <nav className="ls-nav" aria-label="Leitstand"><Link href="/tasks">Tasks</Link><Link href="/history">History</Link><Link href="/progress">Progress</Link><Link href="/settings">Settings</Link><Link href="/security">Security</Link><Link href="/help">Help</Link></nav>
    {answer&&<div className="ls-answer" role="status">{answer}<button aria-label="Dismiss answer" onClick={()=>setAnswer("")}>×</button></div>}
    {(error||taskError||data?.demo)&&<div className="ls-notice" role="alert">{error?"Fleet connection interrupted. Showing last received data. ":""}{taskError}{data?.demo?" Demo data — no live database is connected.":""}</div>}
    <section className="ls-intro"><div><h1>{headline}</h1><p>{!data?"Waiting for the first live status update.":error||taskError?"Some sources are unavailable. Check the connection notices.":stuck?`${stuck} ${stuck===1?"signal needs":"signals need"} checking. The board shows what was last reported.`:"Your agents and projects, in one place."}</p></div><div className="ls-chips" aria-label="Filter by source">{chips.map(k=><button key={k} aria-pressed={filter===k} onClick={()=>setFilter(k)}>{k==="all"?"All":SOURCES[k].label}<span>{strips.filter(s=>k==="all"||s.source===k).length}</span>{k!=="all"&&strips.some(s=>s.source===k&&s.bay==="needs")?<i aria-label="needs you"/>:null}</button>)}</div></section>
    <div className="ls-columns"><BayPanel bay="needs" items={visible.filter(s=>s.bay==="needs")} now={now}/><BayPanel bay="moving" items={visible.filter(s=>s.bay==="moving")} now={now}/><div className="ls-stack"><BayPanel bay="stuck" items={visible.filter(s=>s.bay==="stuck")} now={now}/><BayPanel bay="quiet" items={visible.filter(s=>s.bay==="quiet")} now={now}/></div></div>
    <section className="ls-projects"><div className="ls-projects-head"><h2>Projects</h2><p>{projects.length?`${projects.filter(p=>projectActivity(p)>0).length} with active agents · ${projects.length} public repositories. Select a project for details.`:reposLoaded?"No public repositories found.":"Loading repositories…"}</p></div>{repoError&&<p role="status">{repoError}</p>}
      <div className="ls-project-layout"><div className="ls-apps">{shownProjects.map((p,i)=><button key={p.repo} className="ls-app" aria-pressed={selected?.repo===p.repo} onClick={()=>setPicked(p.repo)}><span className="ls-app-icon" style={{background:COLORS[i%COLORS.length]}}>{(PROJECT_LABELS[p.name]||p.name).split(/[- _]/).slice(0,2).map(s=>s[0]).join("").toUpperCase()}{p.open_items>0&&<b aria-label={`${p.open_items} open issues and pull requests`}>{p.open_items}</b>}</span><span>{PROJECT_LABELS[p.name]||p.name}</span></button>)}{projects.some(dormant)&&<button className="ls-app" aria-pressed={showDormant} onClick={()=>setShowDormant(!showDormant)}><span className="ls-app-icon ls-dormant">{COLORS.map(c=><i key={c} style={{background:c}}/>)}</span><span>{showDormant?"Hide dormant":`Dormant ${projects.filter(dormant).length}`}</span></button>}</div>
      {selected&&<article className="ls-project-detail"><h3>{PROJECT_LABELS[selected.name]||selected.name}</h3><small>{selected.language||"No language listed"} · pushed {age(selected.pushed_at,now).join(" ")} ago{selected.fork?" · fork":""}</small><p>{selected.description||"This repository has no description yet."}</p><div className="ls-next"><small>Next step</small><p>{selected.archived?"Archived on GitHub. Read the existing work before deciding whether to resume it.":selected.open_items>0?`Review ${selected.open_items} open ${selected.open_items===1?"issue or pull request":"issues and pull requests"} on GitHub.`:!selected.description?"Add a repository description so its purpose is clear.":"No open issues or pull requests. Review the repository and choose its next task."}</p></div><a className="ls-action" href={selected.url} target="_blank" rel="noreferrer">Open on GitHub ↗</a></article>}</div>
    </section><footer className="ls-footer">Installed reporters send status metadata without prompt text. Project metadata refreshes every 15 minutes. <Link href="/settings">Manage connections</Link></footer>
  </div></div>;
}
