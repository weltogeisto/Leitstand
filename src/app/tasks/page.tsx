"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { workMessage, workFinished } from "@/lib/work";
import { PlatformBadge, TaskStatusChip, TimeAgo } from "@/components/ui";
import { PanelHeader } from "@/components/PanelHeader";
import { CollapsibleMarkdown } from "@/components/Markdown";
import { PreviewDialog } from "@/components/PreviewDialog";
import type { DryRunResult } from "@/lib/dry-run";
import type { Task } from "@/lib/types";

function NewTaskForm({ onCancel }: { onCreated: () => void; onCancel?: () => void }) {
  return <div className="rounded-xl border border-white/10 bg-[#101828] p-4 mb-6">
    <p className="mb-3 text-sm text-gray-300">Start a conversation, choose a project, and continue with follow-ups in Work.</p>
    <Link href="/work" className="inline-block rounded-lg bg-[#f44800] px-4 py-2 text-sm font-semibold text-white">Start work</Link>
    {onCancel && <button type="button" className="ml-4 text-sm text-gray-400" onClick={onCancel}>Close</button>}
  </div>;
}

function TaskRow({ t, onAction, onCancelTask }: { t: Task; onAction: () => void; onCancelTask?: (task: Task) => void }) {
  const open = ["queued", "claimed", "running", "review"].includes(t.status);

  async function patch(body: Record<string, unknown>) {
    await fetch(`/api/tasks/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    onAction();
  }

  return (
    <div className="rounded-xl border border-white/10 bg-[#101828] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium flex items-center gap-2 flex-wrap">
            <span className="text-gray-500 mono text-xs">#{t.id}</span>
            {t.title}
            {t.priority === 1 && <span className="text-[11px] mono text-[#ff7a40]">HIGH</span>}
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-gray-500 flex-wrap">
            <PlatformBadge platform={t.platform} />
            {t.project && <span className="mono text-[#7aa5ff]">{t.project}</span>}
            {t.reviewer_platform && <span>review: {t.reviewer_platform}</span>}
            {t.assigned_agent && <span className="mono">{t.assigned_agent}</span>}
            {t.cost_usd != null && <span className="mono">${Number(t.cost_usd).toFixed(2)}</span>}
            <span>updated <TimeAgo iso={t.updated_at} /></span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <TaskStatusChip status={t.status} />
          {open && onCancelTask && (
            <button onClick={() => onCancelTask(t)}
              className="text-[11px] text-gray-500 hover:text-red-400 transition-colors" title="Cancel">
              ✕
            </button>
          )}
          {(t.status === "failed" || (t.status === "cancelled" && workFinished(t))) && (
            <button onClick={() => patch({ status: "queued" })}
              className="text-[11px] text-gray-500 hover:text-white transition-colors" title="Requeue">
              ↻
            </button>
          )}
        </div>
      </div>
      <Link href={`/work?task=${t.id}`} className="mt-3 inline-block text-sm text-blue-300 underline">Open conversation</Link>
      {t.description && (
        <div className="mt-2">
          <CollapsibleMarkdown source={workMessage(t)} className="text-sm leading-relaxed text-gray-400" />
        </div>
      )}
      {t.result && (
        <div className={`mt-2 flex gap-2 border-l-2 pl-3 ${t.status === "failed" ? "border-red-500/50" : "border-white/10"}`}>
          <span className="mono shrink-0 pt-[3px] text-[10px] uppercase tracking-wider text-gray-500">Result</span>
          <div className="min-w-0 flex-1">
            <CollapsibleMarkdown source={t.result} className="text-sm leading-relaxed text-gray-300" />
          </div>
        </div>
      )}
    </div>
  );
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingCancel, setPendingCancel] = useState<{ id: number; preview: DryRunResult } | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks?status=all&limit=100", { cache: "no-store" });
      if (!res.ok) throw new Error(`tasks API ${res.status}`);
      const json = (await res.json()) as { demo?: boolean; tasks: Task[] };
      setTasks(json.tasks);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 7000);
    return () => clearInterval(t);
  }, [load]);

  async function startCancel(task: Task) {
    setActionError(null);
    setCancelling(true);
    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "cancelled", dry_run: true }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<DryRunResult> & { error?: string };
      if (res.ok && body.dry_run === true && Array.isArray(body.changes)) {
        setPendingCancel({ id: task.id, preview: body as DryRunResult });
      } else {
        setActionError(body.error ?? `Could not preview the cancel (${res.status}).`);
      }
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setCancelling(false);
    }
  }

  async function confirmCancel() {
    if (!pendingCancel) return;
    setCancelling(true);
    setActionError(null);
    try {
      const id = pendingCancel.id;
      const expected = pendingCancel.preview.expected_revision;
      const res = await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "cancelled",
          ...(typeof expected === "string" ? { expected_revision: expected } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<DryRunResult> & { error?: string };
      if (res.status === 409 && body.error === "stale_write") {
        const fresh = await fetch(`/api/tasks/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "cancelled", dry_run: true }),
        });
        const preview = (await fresh.json().catch(() => ({}))) as Partial<DryRunResult> & { error?: string };
        if (fresh.ok && preview.dry_run === true && Array.isArray(preview.changes)) {
          setPendingCancel({ id, preview: preview as DryRunResult });
          setActionError("This task changed since the preview. Review the new preview before cancelling.");
          return;
        }
        setActionError(preview.error ?? "This task changed. Preview the cancel again.");
        setPendingCancel(null);
        return;
      }
      if (!res.ok) {
        setActionError(body.error ?? `Cancel failed (${res.status}).`);
        setPendingCancel(null);
        return;
      }
      setPendingCancel(null);
      await load();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setCancelling(false);
    }
  }

  if (error) return <div className="text-red-400 text-sm">Failed to load tasks: {error}</div>;
  if (!tasks) return <div className="text-gray-500 text-sm animate-pulse">Loading the queue…</div>;

  const open = tasks.filter((t) => ["queued", "claimed", "running", "review"].includes(t.status));
  const closed = tasks.filter((t) => !["queued", "claimed", "running", "review"].includes(t.status));

  // The queue is what people come to see; the form opens on demand, or by
  // default when there is nothing queued yet.
  const showForm = composing || open.length === 0;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-2">
        <h1 className="text-lg font-semibold">Tasks</h1>
        <div className="text-sm text-gray-500">
          <span className="text-gray-200 font-semibold">{open.length}</span> open ·{" "}
          {closed.length} closed
        </div>
        {!showForm && (
          <button
            type="button"
            onClick={() => setComposing(true)}
            className="ml-auto rounded-lg bg-[#2563eb] px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[#1d4ed8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#19d2ff]/70"
          >
            + Queue a task
          </button>
        )}
      </div>

      {showForm && (
        <NewTaskForm
          onCreated={() => {
            setComposing(false);
            load();
          }}
          onCancel={open.length > 0 ? () => setComposing(false) : undefined}
        />
      )}

      {actionError && <p className="mb-3 text-sm text-red-400">{actionError}</p>}

      <div className="grid gap-3">
        {open.map((t) => (
          <TaskRow key={t.id} t={t} onAction={load} onCancelTask={(task) => void startCancel(task)} />
        ))}
        {open.length === 0 && (
          <div className="text-gray-500 text-sm">
            Nothing queued. Fill in the form above — a dispatcher will pick it up, or any MCP-connected
            agent can claim it with <span className="mono">claim_task</span>.
          </div>
        )}
      </div>

      {closed.length > 0 && (
        <>
          <PanelHeader title="Recently closed" count={closed.length} className="mt-10" />
          <div className="grid gap-3">
            {closed.slice(0, 20).map((t) => (
              <TaskRow key={t.id} t={t} onAction={load} />
            ))}
          </div>
        </>
      )}
      {pendingCancel && (
        <PreviewDialog
          title="Cancel task"
          preview={pendingCancel.preview}
          confirmLabel="Cancel task"
          busy={cancelling}
          onConfirm={() => void confirmCancel()}
          onCancel={() => setPendingCancel(null)}
        />
      )}
    </div>
  );
}
