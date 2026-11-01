import projects from "./work-projects.json";
import type { Task } from "./types";

export const WORK_PROJECTS = projects;
export const WORK_PLATFORMS = [{ id: "codex", name: "Codex" }, { id: "claude-code", name: "Claude Code" }];
export const WORK_MESSAGE_LIMIT = 12000;
export class WorkInputError extends Error {
  constructor(readonly userMessage: string) { super(userMessage); }
}
export type WorkTurn = { leitstand_work: 1; message: string; parent_id: number | null; thread_id: number | null };

/** Versioned envelope in the existing queue. No duplicated or client-supplied history. */
export function workTurn(task: Pick<Task, "description">): WorkTurn | null {
  try {
    const value = JSON.parse(task.description || "");
    if (value?.leitstand_work !== 1 || typeof value.message !== "string" || value.message.length > WORK_MESSAGE_LIMIT) return null;
    for (const id of [value.parent_id, value.thread_id]) {
      if (id !== null && (!Number.isSafeInteger(id) || id < 1)) return null;
    }
    return value;
  } catch { return null; }
}

export function workMessage(task: Pick<Task, "description" | "title">): string {
  return workTurn(task)?.message ?? task.description ?? task.title;
}

export function workThreadId(task: Task): number { return workTurn(task)?.thread_id ?? task.id; }
export function workFinished(task: Task): boolean {
  return ["done", "failed"].includes(task.status) || (task.status === "cancelled" && (!task.assigned_agent || task.result?.startsWith("[stopped]") === true));
}
export function workStatus(task: Task): string {
  if (task.status === "cancelled") return workFinished(task) ? "Stopped" : "Stopping…";
  return ({ queued: "Queued", claimed: "Preparing project", running: "Working", review: "Reviewing", done: "Finished", failed: "Needs attention" } as const)[task.status];
}

export function workInput(value: unknown): { message: string; project: string; platform: string; parentId: number | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkInputError("Send a message and choose a project.");
  const body = value as Record<string, unknown>;
  if (typeof body.message !== "string" || !body.message.trim() || body.message.length > WORK_MESSAGE_LIMIT) throw new WorkInputError(`Write a message of 1–${WORK_MESSAGE_LIMIT} characters.`);
  if (!WORK_PROJECTS.some(p => p.id === body.project)) throw new WorkInputError("Choose a connected project from the list.");
  if (!WORK_PLATFORMS.some(p => p.id === body.platform)) throw new WorkInputError("Choose Codex or Claude Code. Hermes conversations are currently in Telegram.");
  const parentId = body.parent_id ?? null;
  if (parentId !== null && (typeof parentId !== "number" || !Number.isSafeInteger(parentId) || parentId < 1)) throw new WorkInputError("The conversation could not be found. Open it again.");
  return { message: body.message.trim(), project: body.project as string, platform: body.platform as string, parentId: parentId as number | null };
}
