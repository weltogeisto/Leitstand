"use client";
import { useState } from "react";
import Link from "next/link";
import type { Task } from "@/lib/types";
import { NAV_LINKS } from "@/lib/nav";
import { workStatus, workThreadId } from "@/lib/work";
import { WorkIcon, WorkMark } from "./WorkIcon";

export type WorkConversation = { task: Task; title: string; setup: boolean };
export function WorkSidebar({ recent, threadId, loaded, busy, cursor, olderBusy, onChoose, onNew, onOlder, onClose }: {
  recent: WorkConversation[]; threadId: number | null; loaded: boolean; busy: boolean; cursor?: string | null; olderBusy: boolean;
  onChoose: (task: Task) => void; onNew: () => void; onOlder: () => void; onClose?: () => void;
}) {
  const [query, setQuery] = useState("");
  const matches = recent.filter(c => `${c.title} ${c.task.project}`.toLowerCase().includes(query.toLowerCase()));
  const conversations = matches.filter(c => !c.setup);
  const checks = matches.filter(c => c.setup);
  function row({ task, title }: WorkConversation) {
    return <button type="button" key={workThreadId(task)} className="work-history-item" aria-current={workThreadId(task) === threadId ? "true" : undefined} onClick={() => onChoose(task)} disabled={busy}>
      <span className="work-history-title">{title}</span><span className="work-history-meta"><span>{task.project}</span><span className={`work-history-status work-${task.status}`}>{workStatus(task)}</span></span>
    </button>;
  }
  return <>
    <div className="work-sidebar-brand"><Link href="/"><WorkMark/>Leitstand<span>workspace</span></Link>{onClose && <button type="button" className="work-icon-button" onClick={onClose} aria-label="Close conversations"><WorkIcon name="close"/></button>}</div>
    <button type="button" className="work-new-button" onClick={onNew} disabled={busy}><WorkIcon name="plus"/>New conversation<span>↗</span></button>
    <nav className="work-primary-nav" aria-label="Workspace"><Link href="/work" aria-current="page"><WorkIcon name="chat"/>Work</Link><Link href="/"><WorkIcon name="grid"/>Fleet overview</Link></nav>
    <div className="work-history-heading"><h2>Conversations</h2><span>{recent.filter(c => !c.setup).length}</span></div>
    <label className="work-history-search"><WorkIcon name="search"/><input aria-label="Search conversations" value={query} onChange={e => setQuery(e.target.value)} placeholder="Find a conversation…"/></label>
    <div className="work-history-list">
      {!loaded ? <p className="work-sidebar-empty">Loading conversations…</p> : conversations.length ? conversations.map(row) : <p className="work-sidebar-empty">{query ? "No matching conversations." : "A fresh start. Your conversations will live here."}</p>}
      {checks.length > 0 && <details className="work-setup-history"><summary>Setup checks<span>{checks.length}</span></summary>{checks.map(row)}</details>}
      {cursor && <button type="button" className="work-text-button" onClick={onOlder} disabled={olderBusy}>{olderBusy ? "Loading…" : "Load earlier conversations"}</button>}
    </div>
    <div className="work-sidebar-footer"><details className="work-tools"><summary><WorkIcon name="grid"/>All tools<WorkIcon name="chevron"/></summary><nav aria-label="All tools">{NAV_LINKS.filter(l => !["/", "/work", "/settings", "/help"].includes(l.href)).map(l => <Link key={l.href} href={l.href}>{l.label}</Link>)}</nav></details><Link href="/settings"><WorkIcon name="settings"/>Settings</Link><Link href="/help"><WorkIcon name="help"/>Help & how it works</Link><div className="work-local-note"><WorkIcon name="monitor"/><span>Your agents run on your PC.<br/>Keep it on while they work.</span></div></div>
  </>;
}
