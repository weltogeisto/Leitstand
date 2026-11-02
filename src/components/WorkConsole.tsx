"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Markdown } from "./Markdown";
import { WORK_MESSAGE_LIMIT, WORK_PLATFORMS, WORK_PROJECTS, workFinished, workMessage, workStatus, workThreadId, workTurn } from "@/lib/work";
import { defaultWorkSettings, EFFORT_HELP, EFFORT_NAMES, resolveWorkSettings, WORK_MODELS, workSettingsLabel, type WorkSettings } from "@/lib/work-settings";
import type { Task } from "@/lib/types";
import { WorkIcon, WorkMark } from "./WorkIcon";
import { WorkSidebar } from "./WorkSidebar";
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
  const [settings, setSettings] = useState<WorkSettings>(() => defaultWorkSettings("codex"));
  const preferences = useRef<Record<string, WorkSettings>>({});
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
  const panel = useRef<HTMLDivElement>(null);
  const messages = useRef<HTMLDivElement>(null);
  const historyDialog = useRef<HTMLDialogElement>(null);
  const nearLatest = useRef(true);
  const previousThread = useRef<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => {
      if (viewport && viewport.scale === 1) panel.current?.style.setProperty("--work-viewport", `${viewport.height}px`);
    };
    resize();
    viewport?.addEventListener("resize", resize);
    return () => viewport?.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    const el = input.current;
    if (el) { el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 160)}px`; }
  }, [message]);
  useEffect(() => {
    if (historyOpen) historyDialog.current?.showModal();
    else historyDialog.current?.close();
  }, [historyOpen]);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("leitstand-work-settings-v1") || "{}");
      for (const agent of WORK_PLATFORMS) {
        if (saved[agent.id]) preferences.current[agent.id] = resolveWorkSettings(agent.id, saved[agent.id]);
      }
    } catch { /* Local storage is optional; the saved conversation is authoritative. */ }
  }, []);

  useEffect(() => {
    const requested = params.get("project")?.toLowerCase();
    if (requested && WORK_PROJECTS.some(p => p.id === requested)) setProject(requested);
    const agent = params.get("agent");
    if (!selectedId) {
      const next = WORK_PLATFORMS.some(p => p.id === agent) ? agent! : platform;
      setPlatform(next);
      setSettings(preferences.current[next] ?? defaultWorkSettings(next));
    }
    // URL navigation restores preferences once, without overwriting draft selections on polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const savedConversations = recent.map(task => {
    const first = all.find(t => t.id === workThreadId(task)) ?? task;
    // Keep our explicitly named verification conversations accessible without
    // presenting setup prompts as the user's working history.
    const setup = /^(?:Leitstand (?:setup|model-controls) verification|Cancellation verification only|Follow-up verification only|Verify (?:Claude Code|Codex)|Verify isolated PC worker$|Verify Windows dispatcher setup$|Isolated (?:worker|dispatch))/i.test(first.title);
    return { task, title: first.title, setup };
  });
  const lastId = last?.id;
  const lastResult = last?.result;
  useEffect(() => {
    const el = messages.current;
    if (el && (previousThread.current !== threadId || nearLatest.current)) el.scrollTop = el.scrollHeight;
    previousThread.current = threadId;
  }, [threadId, lastId, lastResult]);
  useEffect(() => {
    if (!last) return;
    const agent = WORK_PLATFORMS.some(p => p.id === last.platform) ? last.platform : "codex";
    setPlatform(agent);
    try { setSettings(resolveWorkSettings(agent, workTurn(last)?.settings)); }
    catch { setSettings(defaultWorkSettings(agent)); }
    // Restore when opening a different turn, never on a background status refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastId]);

  function remember(agent: string, chosen: WorkSettings) {
    preferences.current[agent] = chosen;
    try { localStorage.setItem("leitstand-work-settings-v1", JSON.stringify(preferences.current)); } catch { /* Optional. */ }
    setSettings(chosen);
  }
  function changeAgent(agent: string) {
    setPlatform(agent);
    remember(agent, preferences.current[agent] ?? defaultWorkSettings(agent));
  }
  function changeModel(model: string) {
    const selectedModel = WORK_MODELS[platform].models.find(m => m.id === model)!;
    remember(platform, { model, effort: selectedModel.efforts.includes(settings.effort) ? settings.effort : selectedModel.default_effort });
  }
  const selectedModel = WORK_MODELS[platform].models.find(m => m.id === settings.model);

  const choose = useCallback((task: Task) => {
    if (busy) return;
    setSendError("");
    setMessage("");
    historyDialog.current?.close();
    setHistoryOpen(false);
    attempt.current = null;
    setPlatform(WORK_PLATFORMS.some(p => p.id === task.platform) ? task.platform : "codex");
    router.push(`/work?task=${task.id}`, { scroll: false });
  }, [busy, router]);

  function newWork() {
    setMessage(""); setSendError(""); attempt.current = null; setConversation([]);
    historyDialog.current?.close();
    setHistoryOpen(false); nearLatest.current = true;
    router.push(`/work?project=${encodeURIComponent(chosenProject)}`, { scroll: false });
    input.current?.focus();
  }
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (busy || active || !loaded || error || !message.trim() || (selectedId && !last)) return;
    const body = JSON.stringify({ message: message.trim(), project: chosenProject, platform, ...settings, parent_id: last?.id ?? null });
    if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() };
    setBusy(true); setSendError("");
    nearLatest.current = true;
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

  const sidebar = <WorkSidebar recent={savedConversations} threadId={threadId} loaded={loaded} busy={busy} cursor={cursor} olderBusy={olderBusy} onChoose={choose} onNew={newWork} onOlder={olderWork}/>;
  const sendLabel = busy ? "Sending…" : last ? "Send follow-up" : "Start work";
  return <div className="work-console" ref={panel}>
    <aside className="work-sidebar" aria-label="Saved work">{sidebar}</aside>
    <dialog ref={historyDialog} className="work-history-dialog" aria-label="Conversations and navigation" onClose={() => setHistoryOpen(false)} onClick={e => { if (e.target === historyDialog.current) setHistoryOpen(false); }}>
      {historyOpen && <div className="work-drawer"><WorkSidebar recent={savedConversations} threadId={threadId} loaded={loaded} busy={busy} cursor={cursor} olderBusy={olderBusy} onChoose={choose} onNew={newWork} onOlder={olderWork} onClose={() => setHistoryOpen(false)}/></div>}
    </dialog>
    <section className="work-main" aria-label="Conversation">
      <header className="work-topbar">
        <button type="button" className="work-icon-button work-menu-button" aria-label="Open conversations" onClick={() => setHistoryOpen(true)}><WorkIcon name="menu"/></button>
        <div className="work-project-context"><span className="work-context-label">PROJECT</span><label className="work-project-picker"><WorkIcon name="folder"/><span className="sr-only">Project</span><select aria-label="Project" style={{ width: `${Math.min(24, Math.max(8, projectName.length + 1))}ch` }} value={chosenProject} onChange={e => setProject(e.target.value)} disabled={busy || !!last}>{WORK_PROJECTS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>{!last && <WorkIcon name="chevron"/>}</label></div>
        <div className="work-topbar-actions">{last && <span className={`work-status work-${last.status}`}><i/>{workStatus(last)}</span>}<button type="button" className="work-icon-button" onClick={newWork} disabled={busy} aria-label="New conversation" title="New conversation"><WorkIcon name="plus"/></button></div>
      </header>
      {error && <p className="work-error" role="alert">{error}</p>}
      <div className={`work-messages ${!last ? "work-messages-empty" : ""}`} ref={messages} onScroll={() => { const el = messages.current; if (el) nearLatest.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}>
        {!last && !selectedId && <div className="work-welcome"><div className="work-hero-mark"><WorkMark/></div><p className="work-eyebrow">LEITSTAND / WORKSPACE</p><h1>What are we<br/>working on?</h1><p className="work-welcome-caption">Your ideas. Your agents. A place to make progress.</p>
          <div className="work-starters">
            <button type="button" onClick={() => { setMessage("Explore this project and suggest the three most useful next improvements. Explain why, and wait for my choice before changing files."); input.current?.focus(); }}><WorkIcon name="code"/><span>Explore project<small>Find the next step</small></span><span className="work-starter-arrow">↗</span></button>
            <button type="button" onClick={() => { setMessage("Help me plan a change to this project. First ask me what I want to achieve, then propose a clear plan before changing files."); input.current?.focus(); }}><WorkIcon name="plan"/><span>Make a plan<small>Think it through</small></span><span className="work-starter-arrow">↗</span></button>
            <button type="button" onClick={() => { setMessage("Review this project's code for bugs and practical improvements. Give me the most important findings with file references. Do not change files yet."); input.current?.focus(); }}><WorkIcon name="review"/><span>Review code<small>Get a second look</small></span><span className="work-starter-arrow">↗</span></button>
          </div>
        </div>}
        {selectedId && !selected && !error && <p className="work-opening" role="status">Opening conversation…</p>}
        <div className="work-thread">
          {earlier && <a className="work-text-button" href={`/work?task=${earlier}`}>View earlier conversation</a>}
          {turns.map(t => <article key={t.id} className="work-turn">
            <div className="work-user"><span>You</span><p>{workMessage(t)}</p></div>
            <div className="work-reply"><div className="work-reply-heading"><span className={`work-agent-symbol work-agent-${t.platform}`}><WorkIcon name="code"/></span><span><strong>{WORK_PLATFORMS.find(p => p.id === t.platform)?.name || t.platform}</strong><span className="work-run-settings">{workSettingsLabel(t.platform, workTurn(t)?.settings)}</span></span><span className={`work-status work-${t.status}`}>{workStatus(t)}</span></div>
              {t.result ? <Markdown source={t.result.replace(/^\[stopped\]\s*/, "")} /> : <p className="work-pending" role="status"><span className="work-thinking-dot"/>{t.status === "queued" ? "Queued. Your PC will pick this up when it is free." : t.status === "claimed" ? "Preparing your project…" : t.status === "cancelled" ? "Stopping the worker…" : "Working on it. Your reply will appear here."}</p>}
              {t.result && <a className="work-download" href={`data:text/plain;charset=utf-8,${encodeURIComponent(`${workMessage(t)}\n\n${t.result}`)}`} download={`leitstand-${t.id}.txt`}><WorkIcon name="download"/>Save reply</a>}
            </div>
          </article>)}
        </div>
      </div>
      <div className="work-composer-dock">
        <form className="work-compose" onSubmit={send}>
          <div className="work-composer-top"><label className="work-agent-picker"><span className={`work-agent-dot work-agent-${platform}`}/><select aria-label="Agent" value={platform} onChange={e => changeAgent(e.target.value)} disabled={busy || !!active}>{WORK_PLATFORMS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select><WorkIcon name="chevron"/></label><span>{active ? "Draft your next message" : last ? "Continue the conversation" : "New conversation"}</span></div>
          <label htmlFor="work-message" className="sr-only">{last ? "Follow-up instructions" : "Your instructions"}</label>
          <textarea ref={input} id="work-message" value={message} maxLength={WORK_MESSAGE_LIMIT} rows={2} onChange={e => setMessage(e.target.value)} disabled={busy} placeholder={last ? "What’s the next step?" : "Give your agent something to work on…"} onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}/>
          {sendError && <p role="alert" className="work-error">{sendError}</p>}
          <div className="work-composer-controls">
            <label className="work-control work-model-control"><span className="sr-only">Model</span><select aria-label="Model" title={selectedModel?.name} value={settings.model} onChange={e => changeModel(e.target.value)} disabled={busy || !!active}>{WORK_MODELS[platform].models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select><WorkIcon name="chevron"/></label>
            <label className="work-control work-effort-control"><span className="work-effort-bars" aria-hidden="true"><i/><i/><i/></span><select aria-label="Reasoning effort" title={`${EFFORT_NAMES[settings.effort]} effort. ${EFFORT_HELP[settings.effort]}`} value={settings.effort} onChange={e => remember(platform, { ...settings, effort: e.target.value })} disabled={busy || !!active}>{selectedModel?.efforts.map(e => <option key={e} value={e}>{EFFORT_NAMES[e] ?? e}</option>)}</select><WorkIcon name="chevron"/></label>
            {active ? <button type="button" className="work-send-button work-stop-button" aria-label={last.status === "cancelled" ? "Stopping…" : "Stop work"} title="Stop work" disabled={busy || last.status === "cancelled"} onClick={stop}><WorkIcon name="stop"/></button> : <button type="submit" className="work-send-button" aria-label={sendLabel} title={`${sendLabel} (Ctrl + Enter)`} disabled={busy || !loaded || !!error || !message.trim() || (!!selectedId && !last)}><WorkIcon name="arrow"/></button>}
          </div>
        </form>
        <div className="work-composer-footnote"><span><WorkIcon name="monitor"/>Runs on your PC</span><span>{active ? "You can leave. Work keeps going." : "Conversations are saved."}</span></div>
      </div>
    </section>
  </div>;
}
