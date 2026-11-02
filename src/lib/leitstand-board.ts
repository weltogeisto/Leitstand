import type { Event, FleetAgent, Task } from "./types";

export type Source = "claude" | "openai" | "hermes" | "jobs";
export type Bay = "needs" | "moving" | "stuck" | "quiet";
export type Strip = { id: string; source: Source; bay: Bay; who: string; title: string; text: string; at: string | null; activityAt?: string | null; nextAt?: string | null; scheduled?: number; href: string; action: string };
export function topicTelemetry(agentId: string, events: Event[]) {
  return events.filter(e => e.agent_id === agentId && e.detail?.topic_scoped === true)
    .sort((a,b) => Date.parse(b.created_at)-Date.parse(a.created_at))[0];
}
function timestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}
export function sourceFor(platform: string): Source {
  if (/claude|cowork/.test(platform)) return "claude";
  if (/codex|chatgpt|openai/.test(platform)) return "openai";
  if (/hermes/.test(platform)) return "hermes";
  return "jobs";
}
export function buildStrips(agents: FleetAgent[], tasks: Task[], events: Event[] = []): Strip[] {
  const visibleAgents = agents.filter(a => !a.dashboard_hidden);
  const strips: Strip[] = visibleAgents.map(a => {
    const status = a.derived_status;
    const bay: Bay = status === "waiting" ? "needs" : status === "failed" || status === "offline" ? "stuck" : status === "active" ? "moving" : "quiet";
    const session = a.current_session ?? a.recent_sessions?.[0];
    const task = tasks.find(t => t.assigned_agent === a.id && ["claimed", "running", "review"].includes(t.status));
    const canWork = ["codex", "claude-code"].includes(a.platform);
    const telemetry = a.platform === "hermes" ? topicTelemetry(a.id, events) : undefined;
    const detail = telemetry?.detail;
    return { id: `agent:${a.id}`, source: sourceFor(`${a.platform} ${a.id}`), bay,
      who: a.display_name || a.id,
      title: status === "offline" ? "No recent heartbeat" : telemetry?.title || session?.summary || (status === "active" ? "Session active" : status === "waiting" ? "Waiting for input" : status === "failed" ? "Session failed" : "Ready when needed"),
      text: [a.machine, session?.project].filter(Boolean).join(" · ") || "Status reporting connected",
      at: a.last_seen_at,
      activityAt: timestamp(detail?.last_activity_at), nextAt: timestamp(detail?.next_run_at),
      scheduled: typeof detail?.scheduled_jobs === "number" ? detail.scheduled_jobs : undefined,
      href: task ? `/work?task=${task.id}` : canWork ? `/work?agent=${encodeURIComponent(a.platform)}` : `/history?agent=${encodeURIComponent(a.id)}`,
      action: task ? "Open work" : canWork ? "Start work" : "View activity" };
  });
  for (const t of tasks) {
    if (["done", "cancelled"].includes(t.status)) continue;
    // Assigned work is already represented by its reporting agent.
    if (["running", "claimed"].includes(t.status) && visibleAgents.some(a => a.id === t.assigned_agent)) continue;
    strips.push({ id: `task:${t.id}`, source: sourceFor(t.platform),
      bay: t.status === "review" ? "needs" : t.status === "failed" ? "stuck" : ["running", "claimed"].includes(t.status) ? "moving" : "quiet",
      who: `Task #${t.id} · ${t.platform}`, title: t.title,
      text: `${t.status}${t.project ? ` · ${t.project}` : ""}`, at: t.updated_at,
      href: `/work?task=${t.id}`, action: t.status === "review" ? "Review task" : "Open work" });
  }
  return strips.sort((a,b) => (Date.parse(b.at || "") || 0) - (Date.parse(a.at || "") || 0));
}
