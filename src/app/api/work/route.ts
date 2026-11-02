import { NextResponse } from "next/server";
import { actorFromPrincipal } from "@/lib/actor";
import { deny, resolveApiAccess } from "@/lib/auth";
import { apiError, publicError } from "@/lib/api-error";
import { isConfigured } from "@/lib/db";
import { readIdempotencyHeader } from "@/lib/idempotency";
import { createTask, getTask } from "@/lib/store";
import { WorkInputError, workFinished, workInput, workThreadId, workTurn } from "@/lib/work";
import type { Task } from "@/lib/types";
import { resolveWorkSettings, WorkSettingsError } from "@/lib/work-settings";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Load a saved conversation by its latest turn, including older turns outside the queue page. */
export async function GET(req: Request) {
  const access = await resolveApiAccess(req);
  if (!access.ok) return deny(access);
  if (!isConfigured()) return apiError("setup_required", { message: "The work queue is not connected." });
  const id = Number(new URL(req.url).searchParams.get("task"));
  if (!Number.isSafeInteger(id) || id < 1) return apiError("validation_failed", { message: "Choose a conversation." });
  try {
    let task = await getTask(id);
    if (!task) return apiError("task_not_found");
    const project = task.project;
    const tasks: Task[] = [];
    const seen = new Set<number>();
    while (task && tasks.length < 50 && !seen.has(task.id)) {
      if (task.project !== project) break;
      tasks.unshift(task);
      seen.add(task.id);
      const parent: number | null = workTurn(task)?.parent_id ?? null;
      task = parent && parent < task.id ? await getTask(parent) : null;
    }
    return NextResponse.json({ tasks, earlier_task: task?.id ?? null });
  } catch (e) { return publicError("[work] conversation failed", e); }
}

export async function POST(req: Request) {
  const access = await resolveApiAccess(req);
  if (!access.ok) return deny(access);
  if (!isConfigured()) return apiError("setup_required", { message: "The work queue is not connected. Your message was not sent." });
  let body;
  try { body = await req.json(); }
  catch { return apiError("invalid_json"); }
  let input;
  try { input = workInput(body); }
  catch (failure) { return apiError("validation_failed", { message: failure instanceof WorkInputError ? failure.userMessage : "Invalid message." }); }
  try {
    const parent = input.parentId ? await getTask(input.parentId) : null;
    if (input.parentId && !parent) return apiError("task_not_found");
    if (parent && parent.project !== input.project) return apiError("validation_failed", { message: "A follow-up must use the same project. Start new work to change projects." });
    if (parent && !workFinished(parent)) return apiError("conflict", { message: "Wait for this run to finish or stop before sending a follow-up." });
    const settings = resolveWorkSettings(input.platform, input, parent?.platform === input.platform ? workTurn(parent)?.settings : undefined);
    const task = await createTask({
      title: input.message.replace(/\s+/g, " ").slice(0, 140),
      description: JSON.stringify({ leitstand_work: 1, message: input.message, parent_id: parent?.id ?? null, thread_id: parent ? workThreadId(parent) : null, settings }),
      project: input.project, platform: input.platform, priority: 2, created_by: "leitstand-work",
      actor: actorFromPrincipal(access.principal), idempotency_key: readIdempotencyHeader(req),
    });
    return NextResponse.json({ ok: true, task });
  } catch (e) {
    if (e instanceof WorkSettingsError) return apiError("validation_failed", { message: e.userMessage });
    return publicError("[work] send failed", e);
  }
}
