"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Markdown } from "./Markdown";
import { WORK_MESSAGE_LIMIT, WORK_PLATFORMS, WORK_PROJECTS, workFinished, workMessage, workStatus, workThreadId } from "@/lib/work";
import type { Task } from "@/lib/types";
import "./work.css";

function mergeTasks(previous: Task[], incoming: Task[]) {
  const byId = new Map(previous.map(t => [t.id, t]));
  incoming.forEach(t => byId.set(t.id, t));
  return [...byId.values()].sort((a, b) => b.id - a.id);
}
async function request(path: string, init?: RequestInit) {
  const response = await fetch(path, { ...init, cache: "no-store" });
  if (response.status === 401) {
    window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    throw new Error("Please sign in again. Your work is saved.");
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}

export default function WorkConsole() {
  const router = useRouter();
  const params = useSearchParams();
  const selectedId = Number(params.get("task")) || null;
  const [tasks, setTasks] = useState<Task[]>([]);
  const [conversation, setConversation] = useState<Task[]>([]);
  const [project, setProject] = useState("leitstand");
  const [platform, setPlatform] = useState("codex");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [sendError, setSendError] = useState("");
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [earlier, setEarlier] = useState<number | null>(null);
  const [olderBusy, setOlderBusy] = useState(false);
  const attempt = useRef<{ body: string; key: string } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const requested = params.get("project")?.toLowerCase();
    if (requested && WORK_PROJECTS.some(p => p.id === requested)) setProject(requested);
    const agent = params.get("agent");
    if (WORK_PLATFORMS.some(p => p.id === agent)) setPlatform(agent!);
  }, [params]);

  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    async function refresh() {
      if (loading) return;
      loading = true;
      try {
        const [queue, history] = await Promise.all([
          request("/api/tasks?status=all&limit=100", { signal: controller.signal }),
          selectedId ? request(`/api/work?task=${selectedId}`, { signal: controller.signal }) : Promise.resolve(null),
        ]);
        if (controller.signal.aborted) return;
        if (queue.demo) throw new Error("The work queue is not connected yet.");
        setTasks(previous => mergeTasks(previous, queue.tasks ?? []));
        setCursor(previous => previous === undefined ? queue.next_cursor ?? null : previous);
        setConversation(history?.tasks ?? []);
        setEarlier(history?.earlier_task ?? null);
        setError("");
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Connection interrupted. Retrying…"); }
      finally { loading = false; if (!controller.signal.aborted) setLoaded(true); }
    }
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [selectedId]);

  const all = mergeTasks(tasks, conversation);
  const selected = all.find(t => t.id === selectedId);
  const threadId = selected ? workThreadId(selected) : null;
  const turns = threadId ? all.filter(t => workThreadId(t) === threadId).sort((a, b) => a.id - b.id) : [];
  const last = turns.at(-1);
  const active = last && !workFinished(last);
  const chosenProject = last?.project || project;
  const projectName = WORK_PROJECTS.find(p => p.id === chosenProject)?.name || chosenProject;
  const recent = [...new Map([...all].reverse().map(t => [workThreadId(t), t])).values()].sort((a, b) => b.id - a.id);

  const choose = useCallback((task: Task) => {
    if (busy) return;
    setSendError("");
    setMessage("");
    attempt.current = null;
    setPlatform(WORK_PLATFORMS.some(p => p.id === task.platform) ? task.platform : "codex");
    router.push(`/work?task=${task.id}`, { scroll: false });
  }, [busy, router]);

  function newWork() {
    setMessage(""); setSendError(""); attempt.current = null; setConversation([]);
    router.push(`/work?project=${encodeURIComponent(chosenProject)}`, { scroll: false });
    input.current?.focus();
  }
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (busy || active || !message.trim()) return;
    const body = JSON.stringify({ message: message.trim(), project: chosenProject, platform, parent_id: last?.id ?? null });
    if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() };
    setBusy(true); setSendError("");
    try {
      const result = await request("/api/work", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.current.key }, body });
      if (!result.task) throw new Error("No saved run was returned. Please retry.");
      setTasks(previous => mergeTasks(previous, [result.task]));
      setConversation(previous => [...previous, result.task]);
      setMessage(""); attempt.current = null;
      router.replace(`/work?task=${result.task.id}`, { scroll: false });
    } catch (e) { setSendError(e instanceof Error ? e.message : "Could not send. Your message is still here; retry safely."); }
    finally { setBusy(false); }
  }
  async function stop() {
    if (!last || busy) return;
    setBusy(true); setSendError("");
    try {
      const path = `/api/tasks/${last.id}`;
      const preview = await request(path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "cancelled", dry_run: true }) });
      const result = await request(path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "cancelled", expected_revision: preview.expected_revision }) });
      setTasks(previous => mergeTasks(previous, [result.task]));
      setConversation(previous => previous.map(t => t.id === result.task.id ? result.task : t));
    } catch (e) { setSendError(e instanceof Error ? e.message : "Could not stop. Try again."); }
    finally { setBusy(false); }
  }
  async function olderWork() {
    if (!cursor || olderBusy) return;
    setOlderBusy(true);
    try {
      const result = await request(`/api/tasks?status=all&limit=100&cursor=${encodeURIComponent(cursor)}`);
      setTasks(previous => mergeTasks(previous, result.tasks ?? [])); setCursor(result.next_cursor ?? null);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load older work."); }
    finally { setOlderBusy(false); }
  }

  return <div className="work-console">
    <div className="work-heading"><div><h1>Work with your agents</h1><p>Choose a project, give instructions, and keep the conversation here.</p></div><button type="button" className="work-secondary" onClick={newWork} disabled={busy}>+ New work</button></div>
    {error && <p className="work-error" role="alert">{error} Saved conversations remain available when the connection returns.</p>}
    <div className="work-layout">
      <aside className="work-sidebar" aria-label="Saved work"><h2>Recent work</h2>
        {!loaded ? <p>Loading…</p> : !recent.length ? <p>Your conversations will appear here.</p> : <div className="work-recent">{recent.map(t => <button type="button" key={workThreadId(t)} aria-current={workThreadId(t) === threadId ? "true" : undefined} onClick={() => choose(t)} disabled={busy}><strong>{t.title}</strong><span>{t.project} · {workStatus(t)}</span></button>)}</div>}
        {cursor && <button type="button" className="work-link" onClick={olderWork} disabled={olderBusy}>{olderBusy ? "Loading…" : "Load older work"}</button>}
        <p className="work-note">Codex and Claude Code run on your PC, which must be on and connected. Hermes currently reports status here; its conversations are still in Telegram.</p>
      </aside>
      <section className="work-main" aria-label="Conversation">
        <div className="work-context"><span>{last ? projectName : "New conversation"}</span>{last && <span className={`work-status work-${last.status}`}>{workStatus(last)}</span>}</div>
        <div className="work-messages">
          {!last && <div className="work-welcome"><h2>What would you like to work on?</h2><p>Ask for a change, a review, a plan, or an answer about your project. The agent’s reply will appear here, even if you close this page.</p><p>Project files stay in a separate workspace on your PC. Follow-ups continue with those files; changes are not automatically published.</p><button type="button" className="work-secondary" onClick={() => { setMessage("Review this project and suggest the three most useful next improvements. Explain why, and wait for my choice before changing files."); input.current?.focus(); }}>Help me choose the next step</button></div>}
          {selectedId && loaded && !selected && !error && <p>Opening saved conversation…</p>}
          {earlier && <a className="work-link" href={`/work?task=${earlier}`}>View earlier conversation</a>}
          {turns.map(t => <article key={t.id} className="work-turn">
            <div className="work-user"><small>You · #{t.id}</small><p>{workMessage(t)}</p></div>
            <div className="work-reply"><small>{WORK_PLATFORMS.find(p => p.id === t.platform)?.name || t.platform} · {workStatus(t)}</small>
              {t.result ? <Markdown source={t.result.replace(/^\[stopped\]\s*/, "")} /> : <p className="work-note" role="status">{t.status === "queued" ? "Saved and queued. Your PC picks up work automatically, usually within 30 seconds when it is free. You can leave this page." : t.status === "claimed" ? "Preparing the project workspace…" : t.status === "cancelled" ? "Waiting for the worker to confirm it has stopped…" : "Working on your request. The reply will appear here when the run finishes."}</p>}
              {t.result && <a className="work-link" href={`data:text/plain;charset=utf-8,${encodeURIComponent(`${workMessage(t)}\n\n${t.result}`)}`} download={`leitstand-${t.id}.txt`}>Download reply</a>}
            </div>
          </article>)}
        </div>
        <form className="work-compose" onSubmit={send}>
          <div className="work-selects">{!last && <label>Project<select aria-label="Project" value={project} onChange={e => setProject(e.target.value)} disabled={busy}>{WORK_PROJECTS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
            <label>Agent<select aria-label="Agent" value={platform} onChange={e => setPlatform(e.target.value)} disabled={busy || !!active}>{WORK_PLATFORMS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          </div>
          <label htmlFor="work-message">{last ? "Follow-up instructions" : "Your instructions"}</label>
          <textarea ref={input} id="work-message" value={message} maxLength={WORK_MESSAGE_LIMIT} rows={4} onChange={e => setMessage(e.target.value)} disabled={busy} placeholder={last ? "Ask a question or tell the agent what to do next…" : "Describe what you want done…"} />
          {sendError && <p role="alert" className="work-error">{sendError}</p>}
          <div className="work-send"><span>{active ? "You can draft your follow-up while the agent works." : last ? "Continues with this conversation and the same project files." : "Your request and reply are saved in Leitstand."}</span>
            {active ? <button type="button" className="work-secondary" disabled={busy || last.status === "cancelled"} onClick={stop}>{last.status === "cancelled" ? "Stopping…" : "Stop work"}</button> : <button type="submit" className="work-primary" disabled={busy || !loaded || !!error || !message.trim() || (!!selectedId && !last)}>{busy ? "Sending…" : last ? "Send follow-up" : "Start work"}</button>}
          </div>
        </form>
      </section>
    </div>
  </div>;
}
