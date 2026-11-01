import type { FleetAgent, Task } from "./types";

export type Source = "claude" | "openai" | "hermes" | "jobs";
export type Bay = "needs" | "moving" | "stuck" | "quiet";
export type Strip = { id: string; source: Source; bay: Bay; who: string; title: string; text: string; at: string | null; href: string; action: string };
export function sourceFor(platform: string): Source {
  if (/claude|cowork/.test(platform)) return "claude";
  if (/codex|chatgpt|openai/.test(platform)) return "openai";
  if (/hermes/.test(platform)) return "hermes";
  return "jobs";
}
export function buildStrips(agents: FleetAgent[], tasks: Task[]): Strip[] {
  const visibleAgents = agents.filter(a => !a.dashboard_hidden);
  const strips: Strip[] = visibleAgents.map(a => {
    const status = a.derived_status;
    const bay: Bay = status === "waiting" ? "needs" : status === "failed" || status === "offline" ? "stuck" : status === "active" ? "moving" : "quiet";
    const session = a.current_session ?? a.recent_sessions?.[0];
    const task = tasks.find(t => t.assigned_agent === a.id && ["claimed", "running", "review"].includes(t.status));
    const canWork = ["codex", "claude-code"].includes(a.platform);
    return { id: `agent:${a.id}`, source: sourceFor(`${a.platform} ${a.id}`), bay,
      who: a.display_name || a.id,
      title: status === "offline" ? "No recent heartbeat" : session?.summary || (status === "active" ? "Session active" : status === "waiting" ? "Waiting for input" : status === "failed" ? "Session failed" : "Ready when needed"),
      text: [a.machine, session?.project].filter(Boolean).join(" · ") || "Status reporting connected",
      at: a.last_seen_at,
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
