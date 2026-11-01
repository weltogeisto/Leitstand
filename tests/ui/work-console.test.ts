import { after, test } from "node:test";
import assert from "node:assert/strict";
import { setSqlForTests } from "../../src/lib/db";
import { authorizeRoute } from "../../src/lib/scopes";
import { workFinished, workInput, workMessage, workThreadId } from "../../src/lib/work";
import type { Task } from "../../src/lib/types";
import { GET, POST } from "../../src/app/api/work/route";
import { updateTask } from "../../src/lib/store";

process.env.MC_TOKEN = "work-test-token";
process.env.MC_DASHBOARD_PASSWORD = "test-password";
process.env.DATABASE_URL = "postgres://test:test@localhost/work-test";
const rows = new Map<number, Task>();
let inserted: unknown[] = [];
const task = (id: number, extra: Partial<Task> = {}) => ({ id, title: "Review the project", description: "Original request", project: "leitstand", platform: "codex", status: "done", result: "Review complete", assigned_agent: "codex-pc", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", ...extra }) as Task;
setSqlForTests(async (parts, ...values) => {
  const query = parts.join("?");
  if (query.includes("select * from tasks where id")) return rows.has(Number(values[0])) ? [rows.get(Number(values[0]))!] : [];
  if (query.includes("insert into tasks")) { inserted = values; return [task(9, { status: "queued" })]; }
  if (query.includes("update tasks")) {
    assert.match(query, /status <> 'cancelled'/);
    return [];
  }
  throw new Error("Unexpected query in work test");
});
after(() => setSqlForTests(null));
function request(body: unknown) {
  return new Request("https://work.test/api/work", { method: "POST", headers: { Authorization: "Bearer work-test-token", "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
const input = { message: "Implement the first improvement", project: "leitstand", platform: "codex" };

test("work rejects unknown paths, unsupported runners, null and oversized input", async () => {
  for (const body of [null, { ...input, project: "../secrets" }, { ...input, platform: "hermes" }, { ...input, message: "x".repeat(12001) }]) {
    assert.equal((await POST(request(body))).status, 400);
  }
  assert.equal(workInput(input).project, "leitstand");
});
test("work requires authentication and status-only reporters cannot control or read work", async () => {
  assert.equal((await GET(new Request("https://work.test/api/work?task=1"))).status, 401);
  const reporter = { kind: "agent", id: "topic", scopes: ["status:write"] } as const;
  for (const [method, path] of [["POST", "/api/work"], ["GET", "/api/work"], ["GET", "/api/tasks/1"]]) assert.equal(authorizeRoute(reporter, method, path).ok, false);
});
test("follow-up keeps project and server-side ancestry, and blocks a running parent", async () => {
  rows.set(1, task(1, { status: "running" }));
  assert.equal((await POST(request({ ...input, parent_id: 1 }))).status, 409);
  rows.set(1, task(1));
  assert.equal((await POST(request({ ...input, project: "hegel-in-delhi", parent_id: 1 }))).status, 400);
  const response = await POST(request({ ...input, parent_id: 1, thread_id: 999, history: "invented" }));
  assert.equal(response.status, 200);
  const envelope = inserted.find(v => typeof v === "string" && v.startsWith('{"leitstand_work"')) as string;
  assert.deepEqual(JSON.parse(envelope), { leitstand_work: 1, message: input.message, parent_id: 1, thread_id: 1 });
});
test("saved conversation is available after reload, without unrelated project history", async () => {
  // PostgreSQL bigint ids arrive as strings. Conversation links must remain numbers.
  rows.set(1, task(1, { id: "1" as unknown as number }));
  rows.set(2, task(2, { id: "2" as unknown as number, description: JSON.stringify({ leitstand_work: 1, message: "Continue", parent_id: 1, thread_id: 1 }) }));
  const response = await GET(new Request("https://work.test/api/work?task=2", { headers: { Authorization: "Bearer work-test-token" } }));
  const data = await response.json();
  assert.deepEqual(data.tasks.map((t: Task) => t.id), [1, 2]);
  assert.equal(workMessage(data.tasks[1]), "Continue");
  assert.equal(workThreadId(data.tasks[1]), 1);
  rows.set(1, task(1, { project: "hegel-in-delhi" }));
  const restricted = await GET(new Request("https://work.test/api/work?task=2", { headers: { Authorization: "Bearer work-test-token" } }));
  assert.deepEqual((await restricted.json()).tasks.map((t: Task) => t.id), [2]);
});
test("cancelled worker cannot publish a late success or accept follow-up until stopped", async () => {
  const stopping = task(3, { status: "cancelled", result: null });
  rows.set(3, stopping);
  assert.equal(workFinished(stopping), false);
  assert.equal((await updateTask({ id: 3, status: "done", result: "late success" })).status, "cancelled");
  assert.equal(workFinished({ ...stopping, result: "[stopped] Worker is gone" }), true);
  assert.equal(workFinished({ ...stopping, assigned_agent: null }), true);
});
