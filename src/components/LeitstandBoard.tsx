"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useFleet } from "./use-fleet";
import { buildStrips, type Bay, type Source, type Strip } from "@/lib/leitstand-board";
import type { Task } from "@/lib/types";
import { WORK_PROJECTS } from "@/lib/work";
import { WorkIcon } from "./WorkIcon";
import { TimeAgo } from "./ui";
import "./fleet.css";

type Project = { name: string; repo: string; description: string | null; url: string; language: string | null; archived: boolean };
const BAYS: Record<Bay, string> = { moving: "Running", needs: "Needs you", stuck: "Check connection", quiet: "Connected & scheduled" };
const SOURCE_NAMES: Record<Source, string> = { claude: "Claude", openai: "Codex", hermes: "Hermes", jobs: "Other" };
function AgentRow({ item }: { item: Strip }) {
  return <li className={`fleet-row fleet-${item.bay}`}>
    <span className={`fleet-avatar fleet-avatar-${item.source}`} aria-hidden="true">{item.source === "hermes" ? "H" : item.source === "openai" ? "C" : item.source === "claude" ? "✳" : "↗"}</span>
    <div className="fleet-agent"><Link href={item.href}><h3>{item.who.replace(/^Hermes · /, "")}</h3><span className="fleet-agent-arrow">↗</span></Link><p className="fleet-state"><i/>{item.title}</p><div className="fleet-row-meta"><span>{item.source === "hermes" ? "Hermes · " : ""}{item.text.replace(" · Hermes_Hegel topic", "")}</span>{item.activityAt && <span>Activity <TimeAgo iso={item.activityAt}/></span>}</div>{item.nextAt && <p className="fleet-next">Next run <time dateTime={item.nextAt}>{new Date(item.nextAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}</time></p>}</div>
    <div className="fleet-check"><span>Checked</span><TimeAgo iso={item.at}/></div>
  </li>;
}
export default function LeitstandBoard() {
  const { data, error } = useFleet();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskError, setTaskError] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [repoError, setRepoError] = useState(false);
  const [filter, setFilter] = useState<Source | "all">("all");
  const [query, setQuery] = useState("");
  const [allProjects, setAllProjects] = useState(false);
  useEffect(() => {
    let alive = true;
    async function loadTasks() { try { const r = await fetch("/api/tasks?status=all&limit=100"); if (!r.ok) throw new Error(); const j = await r.json(); if (alive) { setTasks(j.tasks ?? []); setTaskError(false); } } catch { if (alive) setTaskError(true); } }
    async function loadProjects() { try { const r = await fetch("/api/projects"); if (!r.ok) throw new Error(); const j = await r.json(); if (alive) { setProjects(j.projects ?? []); setRepoError(false); } } catch { if (alive) setRepoError(true); } }
    void loadTasks(); void loadProjects(); const taskTimer = setInterval(loadTasks, 30000); const repoTimer = setInterval(loadProjects, 900000);
    return () => { alive = false; clearInterval(taskTimer); clearInterval(repoTimer); };
  }, []);
  const strips = buildStrips(data?.agents ?? [], tasks, data?.events ?? []);
  const visible = strips.filter(s => (filter === "all" || s.source === filter) && `${s.who} ${s.title} ${s.text}`.toLowerCase().includes(query.toLowerCase()));
  const counts = (bay: Bay) => strips.filter(s => s.bay === bay).length;
  const bays: Bay[] = ["moving", "needs", "stuck", "quiet"];
  return <div className="fleet-page">
    <div className="ds-heading"><div><p className="ds-eyebrow">Your agents</p><h1>Fleet overview</h1><p className="ds-description">What’s running, what’s scheduled, and what needs a closer look.</p></div><span className={`fleet-live ${error ? "fleet-disconnected" : ""}`}><i/>{!data ? "Connecting" : error ? "Reconnecting" : "Live updates"}</span></div>
    {(error || taskError || data?.demo) && <p className="ds-notice" role="alert">{error ? "Fleet refresh failed. Showing the last received status. " : ""}{taskError ? "The task queue is unavailable. " : ""}{data?.demo ? "Demo data: no live database is connected." : ""}</p>}
    <div className="fleet-stats">{bays.map(b => <a href={`#fleet-${b}`} key={b} className={`fleet-stat fleet-${b}`}><span><i/>{b === "stuck" ? "To check" : b === "quiet" ? "Connected" : BAYS[b]}</span><strong>{data ? counts(b) : "—"}</strong></a>)}</div>
    <div className="fleet-toolbar"><div className="fleet-filters" aria-label="Filter by source">{(["all", "hermes", "openai", "claude"] as const).map(s => <button key={s} aria-pressed={filter === s} onClick={() => setFilter(s)}>{s === "all" ? "All agents" : SOURCE_NAMES[s]}</button>)}</div><label className="fleet-search"><WorkIcon name="search"/><input aria-label="Find an agent or project" placeholder="Find an agent…" value={query} onChange={e => setQuery(e.target.value)}/></label></div>
    {!data && !error && <p className="history-empty">Connecting to your agents…</p>}
    {data && visible.length === 0 && <p className="history-empty">No agents match this filter.</p>}
    <div className="fleet-groups">{bays.map(b => { const items = visible.filter(s => s.bay === b); return <section id={`fleet-${b}`} key={b} className={`fleet-group ${items.length ? "" : "fleet-empty-group"}`} aria-label={BAYS[b]}>{items.length > 0 && <><div className="fleet-group-heading"><h2>{BAYS[b]}</h2><span>{items.length}</span></div><ul>{items.map(item => <AgentRow key={item.id} item={item}/>)}</ul></>}</section>; })}</div>
    <p className="fleet-coverage">Hermes reports local chat turns, background processes, delegations, and scheduled jobs. “Checked” is the last connection update; “Activity” is the last recorded work. External services may need their own connection.</p>
    <section className="fleet-projects"><div className="fleet-group-heading"><h2>Projects</h2><Link href="/work">Start a conversation ↗</Link></div>{repoError && <p className="ds-notice">Repository details are unavailable. You can still open your projects in Work.</p>}<div className="fleet-project-grid">{(allProjects ? WORK_PROJECTS : WORK_PROJECTS.slice(0,6)).map(p => { const repo = projects.find(r => r.repo.toLowerCase() === p.repository.toLowerCase()); return <Link key={p.id} href={`/work?project=${encodeURIComponent(p.id)}`}><WorkIcon name="folder"/><div><h3>{p.name}</h3><p>{repo?.description || p.repository}</p></div><span>↗</span></Link>; })}</div>{WORK_PROJECTS.length > 6 && <button className="fleet-more-projects" onClick={() => setAllProjects(!allProjects)}>{allProjects ? "Show fewer projects" : `View all ${WORK_PROJECTS.length} projects`}</button>}{projects.length > 0 && <details className="fleet-repos"><summary>Repository details <span>{projects.length}</span></summary><div>{projects.map(p => <a key={p.repo} href={p.url} target="_blank" rel="noreferrer">{p.name}<small>{p.archived ? "Archived" : p.language}</small><span>↗</span></a>)}</div></details>}</section>
  </div>;
}
