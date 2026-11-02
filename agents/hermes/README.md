# Connecting Hermes (NousResearch hermes-agent)

## Leitstand topic reporter

This installation uses `status_reporter.py`, a deterministic, status-only service
with a separate credential for each Telegram topic. It does not require the model
to remember to call an MCP tool. It observes:

- Gateway heartbeat and topic routing, with process identity checks.
- Foreground turns, including turns owned by managed worker processes.
- Topic-owned background processes and asynchronous delegations.
- Enabled cron schedules, running executions, next run and last recorded activity.

The reporter projects only metadata from SQLite/JSON. Commands, prompts, message
text, results and Telegram identifiers are not sent to Leitstand. Credentials stay
in the private service configuration. The installed service polls every 15 seconds
plus request time; short work may appear as a new last-activity timestamp without
being caught in the running state. External services without a local process or
execution record require a separate reporter. Unverifiable process ownership or
unavailable metadata is reported as unknown/needs checking, not idle.

Fleet and filtered History show the last connection check separately from the
last work activity and next scheduled run. A connected gateway is not evidence
that all work is finished. Automated regression checks live in
`tests/unit/test_hermes_topics.py`.

The optional MCP integration below is separate from this status-only setup and
requires additional permissions if enabled.

Hermes Agent (github.com/NousResearch/hermes-agent, MIT) is model-agnostic —
point it at Nous Portal, OpenRouter, Anthropic, or OpenAI via `hermes model`.
It has first-class MCP support ("connect to any MCP server", with tool
filtering), 60+ built-in tools, persistent memory, and a cron scheduler.
Docs: https://hermes-agent.nousresearch.com/docs/

## 1. Add the MCP server

Follow hermes-agent's MCP integration docs
(https://hermes-agent.nousresearch.com/docs/ → MCP) and add:

- URL: `https://YOUR-DEPLOY.vercel.app/api/mcp`
- Auth: `Authorization: Bearer YOUR_MC_TOKEN`

Use Hermes's MCP tool filtering to expose all Agent Kontrol tools:
`report_status`, `get_fleet_status`, `remember`, `recall`, `check_inbox`, `reply_to_operator`,
`create_task`, `get_task_queue`, `claim_task`, `update_task`.

## 2. Teach it to report in

Add to Hermes's SOUL.md / MEMORY.md persona files:

```
You are part of the operator's agent fleet, tracked at Agent Kontrol.
- At session start (and on heartbeat/cron): call check_inbox
  (agent_id: "hermes-<host>"). If there are messages, act on them and
  reply_to_operator. Also read get_fleet_status before starting work another
  agent might already own.
- When you start a task, call report_status (platform: "hermes") with a
  one-line summary. Update on milestones and completion.
- Store cross-agent notes with remember; check recall at session start.
- Idle or asked to "pull work"? claim_task (platform: "hermes"), do it,
  then update_task with the result.
```

Hermes's niche in the fleet: messaging-first ops (it fronts Signal/Telegram/
Discord/iMessage), inbox/calendar triage, recurring jobs via its scheduler,
and being the agent that pings you — while the coding CLIs stay heads-down.

## 3. Deterministic heartbeat

Hermes has a built-in cron scheduler. Add a job that POSTs a heartbeat so the
dashboard shows Hermes as online even between tasks:

```bash
curl -s -X POST "$MC_URL/api/ingest" \
  -H "Authorization: Bearer $MC_TOKEN" -H "Content-Type: application/json" \
  -d '{"agent_id":"hermes-home-server","platform":"hermes","machine":"home-server","kind":"heartbeat","title":"Hermes online"}'
```

Also worth a cron job: a morning `get_task_queue` + `get_fleet_status` digest
sent to you on your messaging platform of choice — Hermes as the fleet's
voice, Agent Kontrol as its source of truth.
