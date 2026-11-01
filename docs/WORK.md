# Working in Leitstand

Open **Work** or select **Start work** on the board. Choose a project and an agent, describe what you need, then send. Codex is the default; Claude Code uses your existing Claude account and its usage limits.

The PC must be on and connected. Requests are saved immediately, then picked up when the dispatcher is free. You can close your browser and return to Recent work later. The agent's full reply appears in the conversation. Send follow-up instructions after the run finishes; the conversation and project files are carried forward. Each run receives up to 12 recent turns and 80,000 characters of previous conversation. Older replies remain readable in Leitstand.

**Stop work** requests cancellation. The page shows Stopping until the dispatcher has terminated the worker and verified cleanup. Changes already made remain in the workspace. You can continue after the stop is acknowledged. Queued work can be stopped before it runs.

Your public repositories are registered in the project picker. A repository is prepared on first use, in a separate linked worktree on the PC. Existing edits are preserved. No dependency install or repository hook runs during preparation. Empty repositories get an empty local starting commit. Files and follow-ups remain in that workspace; changes are not automatically published or deployed. Ask the worker to explain its changes and any publishing steps it could not complete.

Hermes currently sends status from Telegram to Leitstand. Its conversations still take place in Telegram. The four topic credentials have no authority to read or create work.

Instructions entered in Work and the resulting replies are deliberately saved in the private task queue. Passive reporters continue to send status metadata without prompt text. Work routes require the same signed-in dashboard session (including enabled MFA) or explicitly scoped task credentials. Workers receive no dashboard, database, or dispatcher credentials.

For installation, the trusted dispatcher accepts `MC_WORKSPACE_REGISTRY` (a local copy of `src/lib/work-projects.json`), `MC_REPOSITORIES_DIR`, and `MC_CANCELLATION_ENABLED=1`. Install `workspaces.py` and `process_control.py` beside `mc_dispatcher.py`. The registry is local configuration; a task cannot supply a repository URL or choose an arbitrary filesystem location.

`POST /api/work` accepts `message`, `project`, `platform`, and optional `parent_id`, with an optional `Idempotency-Key`. `GET /api/work?task=<id>` restores a conversation. `GET /api/tasks/<id>` returns one task for dispatcher history and cancellation checks. These require `tasks:write` or `tasks:read` as appropriate. A late worker completion cannot overwrite an operator cancellation.
