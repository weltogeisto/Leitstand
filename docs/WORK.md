# Working in Leitstand

Open **Work** or select **Start work** on the board. Choose a project and an agent, describe what you need, then send. Codex is the default; Claude Code uses your existing Claude account and its usage limits.

Choose **Model** and **Reasoning effort** above your instructions. The compatible effort levels change with the model. Your choices are remembered on this device; opening a conversation restores its latest settings. You can change either setting before sending a follow-up. A running message keeps its original settings. Every reply shows its saved model and effort; older messages without recorded settings are labeled Previous runner defaults.

Model and effort are validated on the server and again by the PC dispatcher, then passed as explicit CLI flags. No raw command arguments or permissions are accepted from the browser. Provider plan access and usage limits still apply. The catalog in `agents/dispatcher/work-models.json` is shared by the web app and dispatcher. Its Codex entries were checked against the signed-in CLI model catalog on 2026-11-02; Claude entries and effort support were checked against [Claude's model configuration documentation](https://code.claude.com/docs/en/model-config). Codex uses [`model_reasoning_effort`](https://learn.chatgpt.com/docs/config-file/config-reference). Update both installed copies when the catalog changes. Models that reject a request report their error in the conversation.

The PC must be on and connected. Requests are saved immediately, then picked up when the dispatcher is free. You can close your browser and return to Recent work later. The agent's full reply appears in the conversation. Send follow-up instructions after the run finishes; the conversation and project files are carried forward. Each run receives up to 12 recent turns and 80,000 characters of previous conversation. Older replies remain readable in Leitstand.

**Stop work** requests cancellation. The page shows Stopping until the dispatcher has terminated the worker and verified cleanup. Changes already made remain in the workspace. You can continue after the stop is acknowledged. Queued work can be stopped before it runs.

Your public repositories are registered in the project picker. A repository is prepared on first use, in a separate linked worktree on the PC. Existing edits are preserved. No dependency install or repository hook runs during preparation. Empty repositories get an empty local starting commit. Files and follow-ups remain in that workspace; changes are not automatically published or deployed. Ask the worker to explain its changes and any publishing steps it could not complete.

Hermes currently sends status from Telegram to Leitstand. Its conversations still take place in Telegram. The four topic credentials have no authority to read or create work.

Instructions entered in Work and the resulting replies are deliberately saved in the private task queue. Passive reporters continue to send status metadata without prompt text. Work routes require the same signed-in dashboard session (including enabled MFA) or explicitly scoped task credentials. Workers receive no dashboard, database, or dispatcher credentials.

For installation, the trusted dispatcher accepts `MC_WORKSPACE_REGISTRY` (a local copy of `src/lib/work-projects.json`), `MC_REPOSITORIES_DIR`, and `MC_CANCELLATION_ENABLED=1`. Install `workspaces.py` and `process_control.py` beside `mc_dispatcher.py`. The registry is local configuration; a task cannot supply a repository URL or choose an arbitrary filesystem location.

Also install `work_settings.py` and `work-models.json` beside the dispatcher before deploying model controls. Legacy queued tasks without recorded settings retain their original runner defaults.

`POST /api/work` accepts `message`, `project`, `platform`, and optional `parent_id`, `model`, and `effort`, with an optional `Idempotency-Key`. Omitted settings inherit a same-agent parent or use the new-work defaults. `GET /api/work?task=<id>` restores a conversation. `GET /api/tasks/<id>` returns one task for dispatcher history and cancellation checks. These require `tasks:write` or `tasks:read` as appropriate. A late worker completion cannot overwrite an operator cancellation.
