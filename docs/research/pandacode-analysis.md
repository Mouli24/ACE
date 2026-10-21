# PandaCode: reference-architecture analysis

> Studied from source at e86dae6; nothing was built or run. Line numbers are approximate.

- **Repository:** https://github.com/aicodeking/pandacode at `e86dae6` (v0.3.11), read 2026-10-21.
- **Paths:** relative to the PandaCode root. Rust code is in `src-tauri/src/`, frontend code in `src/`.
- **"(docs only)":** stated in PandaCode's docs or README but not confirmed in code.
- **Scope:** PandaCode only. Comparisons with ACE belong in later docs.

## 1. Summary

PandaCode runs the coding CLIs already installed on a machine side by side, one task per conversation. Supported CLIs are Claude Code, Codex, Kimi Code, OpenCode, Antigravity, Grok and Pi. GLM and MiMo are Claude Code pointed at other endpoints.

- **Stack:** Tauri 2, with a Rust core (tokio, bundled rusqlite), a plain TypeScript DOM frontend with no framework, and SQLite.
- **No agent loop of its own:** PandaCode has no agent loop or model client. Each turn is a CLI child process speaking that CLI's machine protocol over stdin/stdout.
- **What PandaCode adds:** it normalizes and persists that stream. Around it, it builds a task board, worktrees, agent teams, per-turn change review, a terminal, a browser and GitHub.

What it does particularly well:

1. **One parser for nine harnesses.** A sans-IO protocol state machine (`Protocol::receive(frame) -> Step`) handles them all, and tests replay recorded frames without running a CLI.
2. **One process per turn.** Each turn resumes the native session by ID. Process groups and Job Objects reap child processes. Warm spares are used only when provably equivalent.
3. **No guessing.** Model catalogs come from the installed CLI, every setting is acknowledged before the prompt, and unknown values stay null.
4. **Durable execution control.** An atomic run claim, an exactly-once queue, acknowledged steering, and no auto-resume after a restart.
5. **App tools on an authenticated per-run loopback MCP server.** The app, not the CLI, owns the approval boundary.
6. **Teams via tool calls.** Workers are hidden real tasks. A scheduler serializes workers whose file scopes overlap.
7. **Per-turn change capture.** Edits are attributed to the tool that made them, without git, and patches are immutable.
8. **One bounded runner for Git and gh, with a scrubbed environment.** Removals and merges never use force.
9. **A UI that stays fast with many streams.** Frame-coalesced rendering, folded agent work, one approval bar and cached pages.
10. **Hardened loopback servers and webviews.** Host/Origin checks, a per-webview IPC allowlist and credential scrubbing.

## 2. Architecture at a glance

```
+-------------------- Tauri 2 app (one OS process) ------------------------+
| webview "main" (src/main.ts)        webview "launcher" (overlay, 11 cmds) |
|   global state + render*()           native child webview "browser-guest" |
|        | call()/subscribe()  (src/bridge.ts)            (no IPC access)   |
|        v invoke              ^ events: agent-event, sessions-changed,     |
|                              |  queue-changed, terminal-event, ...       |
| Rust core (src-tauri/src/lib.rs)                                          |
|   AppState.agents: Mutex<HashMap<session_id, RunningAgent>>  (registry)   |
|   AppState.store : Arc<Mutex<Store>> -> SQLite kingcode.sqlite3 (WAL)     |
|   launch_operation_admitted --sink--> persist + emit                      |
|        | RunInput: Stop | Steer | Goal | Approval | UserInput | ...       |
|        v                                                                  |
|   providers::run_process_with_tools   (tokio::select! loop)               |
|     Protocol::receive(frame) -> Step{events, write, calls, done}          |
|        | NDJSON stdin/stdout             ^ HTTP MCP, bearer, 127.0.0.1    |
+--------|---------------------------------|--------------------------------+
         v                                 |
  one CLI child per turn (claude -p / codex app-server / kimi acp / pi ...)
  in its own process group (Unix) or Job Object (Windows)
```

- **Processes.**
  - One Tauri process holds the Rust core and up to three webviews: `main`, `launcher` (a global-shortcut overlay) and `browser-guest` (an incognito native child webview).
  - Agent CLIs live for one turn. Terminals are PTYs.
  - Loopback HTTP servers run in the core: one MCP server per run, file preview, and bots on `127.0.0.1:47321`.
- **Split.**
  - Rust owns processes, protocol parsing, SQLite, Git/gh, secrets, the team scheduler and change capture.
  - The webview owns rendering, and also dispatches the message queue for normal tasks (§4).
  - `src/main.ts` is about 3,600 lines (275 KB), with one mutable `state` and template-string HTML.
- **IPC.**
  - Tauri invoke is wrapped by `src/bridge.ts`. Pushes arrive as Tauri events.
  - `lib.rs` `invoke_handler` (~L2900) allowlists commands per webview: the launcher gets 11, other webviews none.
  - Without `__TAURI_INTERNALS__`, calls go to the mock `src/preview.ts`, which Playwright uses.
- **Storage.**
  - `kingcode.sqlite3` (WAL, `user_version` 25, `src-tauri/src/storage.rs`), secrets in the OS keychain (`secret_store.rs`), UI prefs in `localStorage`.
  - State has three layers: SQLite; the in-memory agent registry, which is the authority on "a process is running"; and webview state, including the memory-only `state.queueHolds`.
  - Lock order is registry → approvals → store.

## 3. A. Multi-agent execution and provider architecture

### A.1 Core design

There is no provider trait. All protocol code is in `src-tauri/src/providers.rs` (4,314 lines) and `providers/*.rs`, and providers are plain strings (`discover()` ~L565).

**Normalized types:**
- `RunConfig` (~L75);
- `AgentEvent{session_id, kind, text, data, tool}` (~L100);
- `ToolActivity{…, write_paths}` (~L126);
- `RunInput = Stop | Steer | Goal | CodexRequest | Approval | UserInput` (~L372).

**The protocol state machine.**
- `struct Protocol` (~L996) holds all per-run state.
- `receive(&mut self, Value) -> Result<Step, String>` (~L1667) returns `Step{events, write, done, calls, failure, …}`.
- It dispatches to `codex()`, `kimi()`, `pi()`, `acp()` (opencode, antigravity, grok) or `claude()`. `claude()` is the default and also serves glm and mimo.
- Outgoing frames come from match-based `initial()`, `approve()` and `cancel()`.
- Quirks sit behind `config.provider` checks. AGENTS.md says a new harness touches every such match (docs only, but visible).

**The I/O loop.** `run_process_with_tools()` (~L2761) is the single loop:
1. Spawn the CLI and write `initial()`.
2. Run `tokio::select!` over inputs, host-tool completions, deadlines and stdout.
3. Pass each `Step` to `host_tools::apply_step()`, which allows at most 8 concurrent host calls.

### A.2 Launching

- **Finding the binary.** `executable()` (~L482) honours settings overrides and maps glm/mimo to `claude`. `widen_process_path()` (`providers/launch.rs`) runs at startup so GUI launches find user-installed tools.
- **Windows shims.** On Windows, `resolve()` (~L65) never runs npm `.cmd` shims through cmd.exe:
  - it accepts only codex, claude, opencode and pi;
  - it reads the package's `bin` entry, refusing paths that escape the package;
  - it runs `node.exe <script>`, "so paths, JSON and model names never become shell syntax".
- **Framing.**
  - NDJSON, with a 5 s write timeout.
  - Stdout is scanned incrementally, because rescanning "makes large tool results quadratic".
  - Frames are capped at 4 MiB, and a 16 KiB stderr tail is kept.

### A.3 Harness protocols

| Harness | Launch / protocol | Before the prompt | Turn done | Interrupt | Steer | Resume | System prompt |
|---|---|---|---|---|---|---|---|
| Claude Code (+GLM, MiMo) | `claude -p` stream-json, `--permission-prompt-tool stdio --replay-user-messages --disallowedTools=ScheduleWakeup,Monitor,CronCreate` (`configure_command()` ~L2601) | `initialize`; effort checked against returned models | `result`, only once `steers_pending == 0` | `interrupt` control request | yes | `--resume=<id>` | yes |
| Codex | `app-server --enable goals`, JSON-RPC | `thread/start` or `thread/resume{excludeTurns}` (`goals.rs::codex_bootstrap`), then `turn/start` | `turn/completed` + goal check | `turn/interrupt` | `turn/steer` | `thread/resume` | no |
| Kimi Code | `acp` (ACP v1) | session, then mode, model, thinking, each acked | prompt result | `session/cancel` | no | resume, else load | no |
| OpenCode / Antigravity / Grok | ACP v1 (`acp::configure()`); OpenCode via `OPENCODE_CONFIG_CONTENT`; Grok adds `authenticate` | mode, model, effort, each acked | prompt result | `session/cancel` | no | resume, else load, else error | no |
| Pi | `--mode rpc --extension <bridge.mjs>` | bridge ready; model and thinking level confirmed | `agent_settled` | `abort` | yes | `--session-id` | yes |

**Credentials and edge cases.**
- GLM and MiMo (`providers/glm.rs`, `mimo.rs`) blank competing credentials and set the endpoint and token in the child's environment only. The key never reaches argv and is redacted in errors.
- `providers/claude_auth.rs` can strip API-key overrides from the child.
- Codex `/compact` and `/review` map to native RPCs (`codex_prompt()` ~L1871).
- Unsupported reverse requests get an error reply instead of hanging (test `unsupported_reverse_rpc_gets_error_instead_of_hanging`).

### A.4 Models and effort

`list_model_catalog()` (~L642) runs one discovery per provider and never runs inference:

| Harness | How models are discovered |
|---|---|
| Claude | Only `initialize`, sent to a throwaway process with sessions, MCP and hooks disabled (`claude_models()` ~L861) |
| Codex | `model/list`; the context window is left null |
| Kimi | `provider list --json`, parsed into a typed whitelist because the raw JSON holds credentials |
| Grok | `initialize._meta.modelState` |
| GLM, MiMo | Static lists |

- **Default entry.** Every catalog starts with `default`, meaning "use the CLI's configured model".
- **Effort.** It is allowlisted per harness (`validate_reasoning_effort()` ~L430) and re-checked against the live catalog before the prompt.
- **Picker.** `src/model-picker.ts` accepts custom IDs, shows only advertised effort levels, and caches for 5 minutes without polling.

### A.5 Event stream and delivery

**Event kinds:** `status`, `session`, `error`, `done`, `text` (deltas), `message_start`, `tool`, `approval`, `input_request`, `usage`, `limited`, `subagent`, `goal`, `turn_start` and `turn_complete`.

- **Text** (`providers/text_stream.rs`):
  - keeps a byte count and running hash per message ID (LRU of 128);
  - for a completed snapshot, emits only the missing suffix, and only if the hash of what was already emitted matches;
  - drops rewrites.
- **Tools** (`tool_update()` ~L1282):
  - a 64-entry cache joins start, update and result;
  - previews are 4/8 KiB, produced by a `Preview` writer that stops serializing once full;
  - finished tools never regress;
  - `write_paths` come only from explicit `file_path` arguments (Bash counts as unknown).
  - Only scalar metadata crosses IPC.
- **Limits** (`providers/limits.rs`): Claude `rate_limit_event` and Codex `usageLimitExceeded` become a `limited` event carrying the provider's reset time, or `null`.
- **Delivery** (`lib.rs::launch_operation_admitted` ~L1418). A per-run sink:
  - drops the provider's `done` (lib.rs emits its own after persistence);
  - namespaces tool and approval IDs by run;
  - buffers text;
  - emits `agent-event`.

### A.6 Process lifecycle and resume

- **One process per turn** (README "Resource limits"). Background jobs therefore never report back:
  - Claude runs disable session-bound tools;
  - the instructions include `TURN_ENDS` (`lib.rs` ~L438).
- **Teardown.** `finish_child()` (~L2546) closes stdin, sends SIGTERM to the group, then kills. The `ProcessGroup` drop then kills the whole group (`kill(-pgid)`, or Job close / `taskkill /T` on Windows).
- **Stop.** Stop first declines pending approvals and writes the cancel frame. It then waits 3 s for EOF.
- **App exit** (`lib.rs` ~L3166). Stops all agents, waits up to 12 s, then calls `shutdown_all()`.
- **Timeouts.**
  - Init: 90 s.
  - Ordinary turns: **no timeout**.
  - Team runs: a 20-minute silence watchdog.
- **Windows Job assignment.** `providers/windows_job.rs` assigns a `KILL_ON_JOB_CLOSE` Job right after spawn. A grandchild spawned in that window could escape (the study notes' reading).
- **Resume.**
  - Each adapter emits `session` with the native ID, which `Store::resume()` (`storage.rs` ~L1293) saves.
  - If that ID cannot be used (harness switch, Codex team toggle, fork), `context_recovery.rs` replays a bounded excerpt instead (B.5).

### A.7 Concurrency

- **Registry.** `AppState.agents` (`lib.rs` ~L147) maps each session to a `RunningAgent`: input sender, `stopped` flag, a fresh `run_id`, approvals and the text buffer.
- **Admission.** `prepare_task_run_in_project` (~L1167) runs under the registry lock, then the store lock. It rejects duplicates, console conflicts, and starts during CLI updates or shutdown. There is **no global cap** (§9).
- **Per-run isolation.** Each run gets its own:
  - process group;
  - `Protocol`;
  - MCP server (random port, 64-hex token);
  - cwd, from `store.workspace_root()`.
- **Race guard.** The registry guard is held while `done` is emitted, so a new Start cannot race the old stream.
- **Native subagents.** These get isolated child `Protocol` parsers (`providers/subagents.rs`), up to 64. ACP and Pi do not get them.

### A.8 Warm spares and instructions

**Warm spares** (`providers/warm.rs`):
- Only plain `claude` qualifies: at most 2 spares, each for at most 10 minutes.
- Each spare is keyed by the JSON of provider, model, effort, mode, cwd, resume ID, instructions, tool catalog and credential mode, plus a per-task launch epoch.
- On adoption, `server.rebind()` keeps the MCP address and token.
- The saving is about 1.4 s, per a code comment; it was not measured.

**App instructions.** `app_instructions()` (`lib.rs` ~L433) is constant text.
- Claude, GLM, MiMo and Pi get it via `--append-system-prompt` ("paid once, then read at a tenth of the price").
- The other harnesses get it on a new conversation and every 8th turn.

### A.9 Permissions and approvals

Modes are `ask | auto | plan | full`, re-applied on every launch or turn. Revoking Full access therefore affects resumed sessions.

| Harness | ask | auto | plan | full |
|---|---|---|---|---|
| Claude/GLM/MiMo | `--permission-mode default` | `acceptEdits` | `plan` | `bypassPermissions` |
| Codex (explicit `sandboxPolicy` each `turn/start`, `codex_permissions()` ~L1243) | workspace-write, on-request | same + `auto_review` | read-only | danger-full-access |
| Kimi (`session/set_mode`) | `default` | `yolo` | `plan` | `auto` |
| OpenCode | per-mode object in `OPENCODE_CONFIG_CONTENT` | | `{"*":"deny","read":"allow",…}` | |
| Grok | `--permission-mode` | | prompt prefix; non-reads `reject_once` | `--always-approve` |
| Pi | `providers/pi-extension.mjs`: reads pass, others confirm | edit/write allowed | non-reads blocked | all allowed |

**Interception** (`Protocol::approval` ~L1609):
- Each request gets a UUID, with at most 64 pending. The native request stays in the adapter; the UI gets a 4,000-character label.
- **Claude** auto-denies `AskUserQuestion` and auto-allows PandaCode's own metadata, bot and team tools.
- **Codex** questions become `input_request` events with an allowlisted schema (`providers/host_inputs.rs`).
- **ACP** `approve()` (~L1620) is yes/no. It picks the offered `allow_once` or `reject_once`, and falls back to `_always` only if that is all that is offered.
- **Stale replies.** `respond_approval` rejects IDs from stopped or earlier runs.

### A.10 App tools over a per-run MCP server

**Host composition.** `ToolHost{tools, handler, approval_tools}` (`providers/host_tools.rs`) is built in `lib.rs` (~L1692–1706):
- The base is `architect::host` for teams, or `agent_tools::host` for **non-team Codex runs only**.
- Wrappers are added on top: Jev, bot, simulator, VM, deploy, run/preview, change tracker and title.
- If team tools are missing, the run fails ("No unrestricted tool fallback was used").
- `agent_tools::host` makes every non-read tool approval-required, because "Host callbacks are outside Codex's sandbox".

| Harness | How the tools arrive |
|---|---|
| Codex | `dynamicTools` on `thread/start` (`providers/goals.rs` ~L264). These are fixed at thread creation, so `split_jev_host()` (~L2732) moves per-run tools to a per-run MCP server injected via `config["mcp_servers.<name>"]` on start and resume |
| Claude/GLM/MiMo | `--mcp-config` with an HTTP server and a bearer header |
| Kimi/ACP | `mcpServers` in the session calls. This needs `mcpCapabilities.http`; otherwise optional tools are dropped |
| Pi | The extension proxies over HTTP and deletes the token from its environment |

**The server.** `providers/mcp_host.rs` is a hand-written HTTP/1.1 JSON-RPC server on `127.0.0.1:0`.
- `read_request()` rejects:
  - any `Origin` header;
  - a non-literal `Host`;
  - a bad bearer token;
  - non-POST requests;
  - bodies over 160 KiB;
  - unknown MCP versions.
- `authorize()` (~L487) decides by mode:
  - plan: deny;
  - full: allow, except tools in `cloud::deploy::ALWAYS_ASK`;
  - otherwise: request approval and wait up to 300 s.

## 4. B. Tasks, conversations and execution control

### B.1 Data model (`src-tauri/src/storage.rs`)

**Base tables:**
- `projects`;
- `sessions` (a task: provider, model, mode, status, `resume_id`, `archived`);
- `messages(session_id, role, content)`.

**Migrations.** Migrations up to `SCHEMA_VERSION = 25` add:
- tool-row upserts (`UNIQUE(session_id, tool_id)`);
- `task_stage` and `goal_state`;
- team tables;
- `turn_changes` and `context_recovery`;
- worktree fields and drafts;
- `queued_messages`;
- usage-limit fields and bots.

They run in one `Immediate` transaction that re-reads `user_version` ("another app instance may have migrated while this one waited"). A test checks `SCHEMA_VERSION` against the source.

**Rules as triggers.** Business rules are SQL triggers. For example, the first prompt publishes a draft, and new user work clears a usage limit.

**No events or turns table.**
- A tool call is a `messages` row with role `tool` and versioned JSON (`{"type":"tool_activity","version":1,…}`).
- A turn is implicit: the `user` or `coordination` row, the rows after it, and an optional `changes` row.

### B.2 Status, stage and the run claim

PandaCode keeps two separate fields:
- `status` (`idle | running | waiting | interrupted | error`) is machine-owned.
- `task_stage` (`pending | in_progress | review | completed`) is the board column.

| Transition | Where |
|---|---|
| Any send or Start → `running` + `in_progress`, plus a provisional title | `Store::begin_task_turn_with_kind` (~L1329) |
| Approval pending → `waiting`, then back to `running` | `save_approval`, `respond_approval` |
| Run end, status: stopped → `interrupted`, ok → `idle`, else `error` | `Store::finish_task_operation` (~L1378), one SQL `CASE` |
| Run end, stage: success → `review`; error or stop → `in_progress`; an unfinished goal stays `in_progress`; maintenance commands restore the prior stage | same SQL `CASE` |
| `review` ↔ `completed`, or → `pending`: **manual only**, refused while running | `Store::set_task_stage` (~L1035) |
| Completed tasks are archived after 7 days | `Store::archive_completed` |

**The run claim** is one compare-and-set, in the same transaction as the prompt insert:

```sql
UPDATE sessions SET status='running',task_stage='in_progress',completed_at=NULL,title=?2,updated_at=?3
WHERE id=?1 AND archived=0 AND task_stage<>'completed' AND status NOT IN ('running','waiting')
-- then INSERT the user message RETURNING id; commit (rolled back if the insert fails)
```

Board Start and Retry re-send the stored description (`prepare_task_run_in_project` ~L1199). Drafts stay hidden until their first prompt.

### B.3 Persistence and restart

**Writing.**
- Text is buffered in memory, with no per-token writes.
- The buffer becomes one `assistant` row at `message_start`, at `turn_complete`, or when a *new* tool ID appears. Late tool updates therefore don't split a streaming answer.
- Tool rows are upserted, capped at 96 KiB.
- If a boundary write fails, the buffer is kept. Any persistence error fails the run.

**Run end.** Under the registry lock, then the store lock:
1. Flush the buffer.
2. Persist changes.
3. Settle tools and subagents.
4. Pause any goal.
5. Finish the operation.
6. Acknowledge recovery.
7. Apply the title.
8. Leave the registry.
9. Emit `done`.
10. Optionally prewarm.

**Reading.** `Store::messages` (~L1535):
- reads 100 rows newest-first;
- reads assistant content via `substr(CAST(content AS BLOB),…)`;
- shows at most 128 KiB per row;
- caps each page at 2 MiB.

**Restart** (`Store::open` ~L406):
- Unfinished tools are settled.
- Running and waiting tasks become `interrupted`.
- Goals are paused.
- Teams are interrupted ("Resume explicitly to continue.").
- `reconcile_inactive_task` (`lib.rs` ~L183) applies the same rule lazily.
- Nothing continues automatically, except an overdue, opted-in "resume at reset".
- Approvals are memory-only and are lost.

### B.4 Queue, holds and steering

- **Queue** (`message_queue.rs`, `queued_messages`):
  - at most 50 entries per task, 128 KiB each;
  - `take` is get-plus-delete, "so it can only ever be sent once";
  - `restore` puts an entry back at the front.
- **Dispatch is in the webview, not Rust.** `dispatchQueue()` (`src/main.ts` ~L1988) sends only when the task is idle, unheld and not archived. If the send fails, it restores the entry and sets a hold. Bots drain natively, and only after successful runs.
- **Holds** (`restart | failed | stopped | limited`, `src/message-queue.ts`) are memory-only and re-derived:
  - every queue found at startup is held;
  - every stop, failure or limit sets a hold, even on an empty queue, because "a message saved a moment later must not slip past a failure or limit";
  - Resume, a manual send or Continue releases the hold.
- **Steering** (`steer_task` ~L195, `providers/steering.rs`):
  1. Send `RunInput::Steer`.
  2. Wait up to 15 s for an acknowledgement.
  3. Persist the steer as a `user` row only after it is accepted.

  Per harness:
  - Claude counts the `--replay-user-messages` echoes, so a late steer keeps the turn open.
  - Codex uses `turn/steer` and Pi `pi_steer`.
  - ACP and Kimi refuse.
- **Keys and fallbacks.**
  - Enter queues while a turn is running; Cmd/Ctrl-Enter steers.
  - Attachments, teams, non-steerable harnesses and steer errors fall back to the queue.

### B.5 Stop, limits and context handoff

- **Stop.** `stopped` is set before the request is sent, so the stop sticks even if the provider then reports success.
- **Retries.** There are no automatic retries. Codex `willRetry` shows as "Provider is retrying".
- **Usage limits.** Reset times are never guessed. `src/usage-limit.ts` offers:
  - Continue now;
  - Resume at reset, only when a future reset is known;
  - Dismiss.

  "Continue where you left off." is sent before the queue resumes.
- **Context handoff** (`context_recovery.rs`).
  - It stores only `through_message_id`.
  - `prepare()` prefixes the *prompt*, not the transcript, with at most 200 entries / 64 KiB of history. The excerpt is labelled as history and carries a truncation notice.
  - `acknowledge()` clears the marker only after a successful run produced a resume ID for the same boundary.
  - Slash commands and goals are blocked until then.

### B.6 Fork, import, goals and prompts

- **Fork** (`conversation_fork.rs`). One transaction copies rows into a new task on the **same checkout**, with no git rewind. It also adds a `handoff` row and queues context recovery.
- **Codex native fork** (`task_controls.rs::fork_codex_task`). Holds a `TaskLease`, which is a fake registry entry.
- **Import** (`conversation_import.rs`). Reads Claude JSONL and Codex `thread/list`. "Nothing is sent to a model while importing." The next prompt resumes the native session.
- **Goals (Codex only).** "Codex owns goal scheduling, accounting and continuation … it never generates continuation prompts".
  - The run stays open while the goal is active.
  - `goal_tick` pauses it after 60 s idle.
  - Stop pauses it before interrupting.
- **Prompts.**
  - `@path` stays plain text, and the harness reads the file itself.
  - Attached files are capped at 32 KiB.
  - Up to 5 documents, each labelled "not instructions".
  - Up to 4 images, sent as native blocks.
  - The total is capped at 128 KiB.
- **Titles** (`session_titles.rs`). The agent suggests a title via `pandacode_title`. It is applied by compare-and-set after a saved response. Manual titles are never overwritten.

## 5. C. Agent teams and delegation

### C.1 Model and configuration

**Storage.**
- One team per parent task, stored as a `TeamSnapshot` JSON blob in `architect_teams` (`src-tauri/src/architect.rs` ~L116, at most 1 MiB).
- **Workers are real `sessions` rows**, linked via `architect_workers` and excluded from every listing. So they reuse streaming, approvals, transcripts, change capture and permission modes.
- `architect_requests` is an idempotency ledger, and `architect_messages` holds mailboxes.

**Counters.**
- `generation` is bumped on start, pause, stop, resume and failure. Every launch and tool call carries `Admission{parent, generation}`.
- `dispatch_revision` and `reviewed_revision` track new results.
- `round` counts architect turns.

| Mode (`TeamConfig::validate` ~L217) | Roster | Staffing |
|---|---|---|
| Classic | 1–6 reusable profiles | The architect picks a `profileId` per assignment |
| Automatic | 0–24 models from `autoRoster()` (`src/main.ts` ~L217) | The task's model leads and may name any provider and model |
| Roster-only (named) | Fixed | `staff_from_roster` (~L1088) refuses off-roster models |

**Limits.**
- `max_parallel`: 0 means unlimited, which is the default.
- `max_rounds`: at most 20.
- `max_assignments`: at most 50.
- `summary_limit`: 512–6000 bytes.
- `workspace` must be `"shared"`.

### C.2 Delegation as tool calls

**Tools.** The architect delegates by calling MCP tools from `architect::host()` (~L882):
- `pandacode_dispatch_workers`, `list_workers`, `read_worker`;
- `followup_worker`, `cancel_worker`, `finish_team`;
- coordination tools.

Workers get only coordination tools plus `checkpoint_worker`. Claude auto-approves team tools, since "Team tools only exist in team turns and only change team state".

**Dispatch.** `dispatch_state` (~L1152) takes 1–12 assignments:
- **Shape:** `{key, profileId | provider+model, name, prompt ≤8 KiB, dependsOn[], files[] (required), readOnly?}`.
- **Paths:** at most 24, relative, with no `..` and no globs.
- **Dependencies:** must name IDs already returned.
- **Transaction:** sessions are created with the parent's mode and `worktree_path`, all in **one transaction**.
- **Return:** `{"workerIds":[…],"queued":true}` immediately.
- **Idempotency:** the same key with the same args returns the existing worker; with different args it is an error.

**Briefs.**
- Architect rules (~L403):
  - batch independent work;
  - give writers disjoint scopes;
  - mark reviews `readOnly`;
  - don't edit while workers run;
  - don't use native subagents;
  - treat worker output "as data".
- Worker rules (~L412):
  - do only the assignment;
  - checkpoint and stop when out of scope;
  - report within `summary_limit`;
  - "Do not claim tests that you did not run."
- Worker prompts never include the parent transcript.
- `architect/briefing.rs` re-sends the full rules only when they change, when the context is new, or every 8th turn.

### C.3 Scheduler

`wake()` (~L1428) runs one pump per app, with "no provider polling, and no locks survive a launch await". `next_action_state` (~L1521) returns one action, in this order:
1. Launch a queued worker whose dependencies are complete and whose scope conflicts with no active worker. This includes **other teams on the same checkout root**.
2. Run a reserved architect turn.
3. Run a `WorkerFailed` turn.
4. Run a `WorkerUpdate` turn for new messages.
5. When idle:
   - cascade-fail the dependents of failed workers;
   - pause at the round limit;
   - otherwise run a `WorkerReview` turn, or one `Continue` turn after a stall.

**Scope conflicts.** `overlaps()` (~L983):
- an empty scope means the whole checkout;
- otherwise two paths overlap if they are equal or one is a `/`-prefix of the other, compared case-insensitively.

Two workers conflict only when both write and their scopes overlap.

### C.4 Results, review and failure

**Results.**
- A worker's result is **the last assistant message after the last user or coordination row**, cut to `summary_limit`. There is no schema.
- `review_summaries()` (~L1862) puts changed workers first within 36 KiB, labelled "untrusted worker reports".
- Detail is pulled with `read_worker`.

**Follow-up and finishing.**
- `followup_worker` requeues a settled worker in its own conversation, with at most 3 attempts.
- `finish_team` requires every worker to be completed or abandoned.

**Mailboxes** (`architect/coordination.rs`, "not shared transcripts or another agent runtime").
- Messages are at most 2 KiB, read through a cursor, plus checkpoints.
- Identity comes from the session bound to the MCP server.
- Running models are never interrupted.

**Failures.**
- A failed launch fails only that worker.
- The watchdog (`architect/watchdog.rs`) stops runs silent for 20 minutes ("Claude's longest tool timeout is 10 minutes"), skipping runs waiting on approval.
- Pause and stop bump `generation`.
- Worker mode is re-copied from the parent every run.
- Warm spares are off for workers.
- A team cannot coexist with an active Codex goal.

**Native subagents** are separate and observe-only (`providers/subagents.rs`, `subagent_state.rs`).
- Live text is persisted at most once per second, to "keep child streaming off SQLite's shared write lock".
- Team rules forbid them.

**UI.** `src/architect.ts` has the setup screen, a workers panel with per-worker change cards and approvals, and pause/stop/resume.

## 6. D. Git, worktrees and code review

### D.1 One bounded runner

**`run_bounded`** (`src-tauri/src/workspace.rs` ~L188–300):
- stdin is null.
- Each pipe drains on its own thread, which stores output only up to a cap. A full pipe never blocks the child.
- The child runs in a process group or Job Object.
- `try_wait` is polled every 10 ms until the deadline, which kills the group ("Check the repository before retrying.").

**`run_git_bounded`** (~L152):
- strips `GIT_*` variables;
- passes `--no-pager --literal-pathspecs`;
- disables fsmonitor and color;
- sets `core.hooksPath=/dev/null` except for commit and merge;
- sets `GIT_TERMINAL_PROMPT=0` and `LC_ALL=C`;
- timeouts are 30 s for reads, 120 s for commit and 180 s for push.

**`github.rs::run_gh`** uses the same runner with `GH_PROMPT_DISABLED=1` and passes arguments as `--flag=value`.

### D.2 Worktrees (`workspace.rs`, `lib.rs` ~L2117–2300, `src/worktrees.ts`)

- **Naming.** The branch is `pandacode/<slug>`. The folder is `<parent>/<project>-worktrees/<branch>`.
- **Creation.**
  - An unstarted task can attach a new worktree. This is race-safe: the UPDATE requires no messages and no `resume_id`.
  - A started task spawns a sibling task in a new worktree instead.
- **Routing.** `Store::workspace_root()` routes every git, file and terminal call to the worktree. It errors if the worktree's `.git` is missing.
- **Cleanup offer.**
  - A dirty worktree is never removed.
  - Clean and merged: the remove box is pre-checked.
  - Unpushed: it is unchecked.
  - `remove_worktree` never uses `--force` and deletes the branch with `branch -d`.
- **Merge** (`merge_worktree` ~L985).
  1. Requires a clean worktree, and no tracked changes in the main checkout.
  2. Switches main to the default branch if needed.
  3. Runs `git merge --no-edit`.
  4. On conflict, lists the files, runs `merge --abort` and switches back: "Nothing was changed; merge Y into the worktree, resolve it there, and try again." The abort and switch-back are best-effort.
- **Branch switching** accepts only names that exist in `refs/heads`.
- **Agent running.** None of these actions run while the agent is running.

### D.3 Turn changes: attributed snapshots, not `git diff`

`src-tauri/src/turn_changes.rs` describes itself: "Immutable, bounded snapshots scoped to write tools from this task. Unreported writes and ambiguous shared-file edits are never attributed by checkout status."

**Evidence of writes.**
- Explicit write paths from tool events. Bash counts as unknown and marks the capture as limited.
- A `pandacode_track_files` handshake (`turn_changes/host.rs`): `begin` captures baselines for exact paths, and `complete` names the files that changed. The app instructions ask agents to call it before any batch of edits.

**Capture** (`Tracker::observe_tool` ~L421).
- Bytes are copied to a temp folder and hashed with SHA-256.
- "Before" is the first baseline; "after" is the latest.
- A file that changed between this task's own tools was touched by someone else. It is marked `ambiguous` and **omitted**.

**Leases.** A global map of live trackers is keyed by checkout root. A file claimed by two runs is omitted from both. Separate worktrees never conflict.

**Output.** At `turn_complete`, `compare()` (~L1072) emits A/M/D/R entries (a rename is the same hash at a new path). Patches come from an in-house bounded Myers diff.

**Bounds.**
- 200 files per turn.
- 1 MiB per file.
- 32 MiB captured.
- Patches: 256 KiB per file, 2 MiB per turn.

**Storage.**
- A `changes` message plus `turn_changes` and `turn_change_files` rows.
- A 128 MiB global budget drops the oldest patch bodies but keeps their summaries.
- Viewing never reads the working tree.

**Teams** (`turn_changes/team.rs::merge`).
- Rolls settled workers' captures, including failed and stopped ones, into the architect's capture.
- Uses one SQL join over `json_each(team.content,'$.workers')`.
- Uses `teamSources` to avoid double counting.

### D.4 Diffs, staging and GitHub

**Diff views.**
- `src/turn-changes.ts` renders the turn card.
- `src/diff-viewer.ts` lazy-loads `@pierre/diffs` (Shiki, unified or split).
- The inspector's Changes tab works on live git:
  - status;
  - diff, with untracked files via `diff --no-index`;
  - stage;
  - commit, with hooks.

**GitHub** goes only through `gh`, and no tokens are stored (`github.rs`, `github_pull.rs`, `github_hub.rs`).
- **Push and open PR** (`lib.rs::github_create_pull_request` ~L2468):
  1. Refuses on any changes or on the base branch.
  2. Pushes and runs `gh pr create`.
  3. Links the PR to the task.
- **PR detection.** After every `done`, `github_pull::detect` scans the turn's messages for this repo's `/pull/N` URLs. It accepts a PR whose head branch matches, or one created during the turn.
- **GitHub view actions** (Review, Fix failing checks, Solve issue…) are prompts that start ordinary tasks.

**Review is model-driven.** There is no human line-comment UI in the code.
- The architect reviews worker reports.
- The optional Jev add-on (`jev_decisions.rs`) grades saved diffs with paid model calls. It is advisory only.

## 7. E. Developer workspace and UI/UX

**Shell** (`src/main.ts` ~L256–276):
- **Sidebar.** Tasks are grouped Pinned, then per project (`src/sidebar-tree.ts`), with attention, running and limited dots.
- **Main pane.** A Conversation / Board / GitHub switch, plus:
  - Run, shown only when `pandacode-run.sh` exists;
  - Deploy;
  - browser, terminal and inspector.
- **Inspector.** Changes, Files, Browser, PR, Simulator and VM.

**State and rendering.**
- **State.** One global `state` holds everything. Races are guarded by counters (`state.generation`, `menuEpoch`).
- **Row updates.** `morph()` (`src/dom.ts`) replaces any row whose `id` changed, "so a click landing during a background update still reaches the row under the pointer".

**Composer** (`renderComposer` ~L1286):
- **Above the input:** the approval bar, the worktree/branch bar, the limit banner and the queue panel.
- **Toolbar:** attach, model picker, a 4-mode permission picker, Team, token saver and Send/Stop.
- **Input:** never disabled during a run. Its placeholder reads "Queue a follow-up · ⌘↩ steers now".

**Turns** (`src/turn-activity.ts::groupTurns`):
- **Answer.** The last substantive assistant row is the answer. It renders as Markdown **outside** a collapsed "Worked for Xm Ys" fold.
- **Tool groups.** Inside the fold, tools are grouped in fives, with counts of failures per category.
- **Attached context.** It folds under the user message at `CONTEXT_BOUNDARY`.

**Performance.**
- **Repaint scope.** The selected transcript repaints at most once per animation frame. The sidebar repaints only on state transitions ("Four busy agents share one navigation frame").
- **Tool groups.** They repaint only when `revision` changes, with open, scroll and focus state captured and restored.
- **Markdown.** `src/streaming-markdown.ts` paints every 32 ms with an append-only reconcile. `src/dom.ts` renders via md4c WASM and DOMPurify, with an 800-entry LRU of rendered HTML.
- **Thread switching.** `threadPages` (LRU of 24) draws instantly. The view redraws only if `pageSignature` (`id:length`) changed.
- **Other details.** "Follow output" is a stored intent. Find uses the CSS Custom Highlight API. Animation is off.

**Approvals** (`src/approval-bar.ts`):
- **One bar.** A single request is one line with Deny / Approve. Several collapse to "N approvals needed" with Approve all / Deny all.
- **Decisions** are binary.
- **No OS notifications.**

**Keyboard:**
- **Navigation:** ⌘K opens the palette (static commands plus task-title matches), ⌘F finds, ⌘N creates a task, ⌘J opens the terminal, ⇧⌘B opens the inspector.
- **Sending:** Enter sends, or queues while a turn runs; ⌘Enter steers.
- **Esc** runs a cascade whose last step **stops the running agent**.

**Terminal** (`src-tauri/src/terminal.rs` with portable-pty; `src/terminal.ts` with xterm 6):
- **Windows shell.** It prefers `pwsh` and ignores Git Bash's `SHELL`. Job Objects handle cleanup.
- **Harness console.** It opens the task's own CLI, resumed. "Insert /cmd" never presses Enter.
- **Themes.** `terminal_preferences.rs` imports them from Ghostty, Kitty, Alacritty, WezTerm ("never evaluates Lua") and Windows Terminal.

**Preview server and run script:**
- **`file_preview.rs`** is an authenticated loopback static server. It uses a token path plus a cookie, checks Host, Origin, Sec-Fetch-Site and Referer, blocks dotfiles and key files, and re-checks canonical paths.
- **`pandacode-run.sh`** (`run_script.rs`) may carry a `# pandacode-preview:` header.
  - `inspect()` reads the script but never executes it.
  - It runs in a managed "Run" terminal, from the header button or the approval-gated `pandacode_run_project` tool.
  - Agents are told to maintain it.
  - `url_ready()` probes loopback only.

**Embedded browser** (`browser.rs`, `src/browser.ts`):
- **What it is.** A native child webview: incognito, no devtools, http/https only.
- **Isolation.** `guard()` rejects every IPC caller except `main`. `obscured()` hides the webview whenever a dialog or menu overlaps it.
- **Agent access.** The agent tools (`read_browser`: ≤24,000 chars, ≤100 elements; click; type) go through `request_ui()` and work only for the **visible** task.
- **Gap.** `browser_type` does **not** refuse password fields.

**Quick launcher and mock mode.**
- `overlay.rs` opens a prompt, pickers and live tasks on Cmd/Ctrl+Shift+Space. While visible, it polls every 1.5 s.
- `src/preview.ts` (1,188 lines) mocks every IPC command. AGENTS.md requires a mock for each new command, and about 55 Playwright specs run against it.

## 8. F. Additional capabilities

| Capability | Exists? | Key files | Cost to maintain |
|---|---|---|---|
| Token saver ("Caveman", "Lean code", "Quiet tools", RTK) | Yes | `src/token-saver.ts`; `src-tauri/src/token_saver.rs` (detects `rtk`, installs it with brew) | Tiny. Prompt text sent only on change, on the first message or every 8 messages. Savings figures are heuristics |
| Account limits | Yes, on demand | `src-tauri/src/agent_usage.rs` (Codex `account/rateLimits/read`, Claude OAuth usage endpoint), `agent_usage_providers.rs` (Kimi, GLM, OpenCode, Antigravity) | High: vendor-internal endpoints. Cached 60 s; a stale snapshot is kept on error |
| Cost estimate | Yes | `src-tauri/src/usage_ledger.rs`, `usage_ledger/{parse,pricing}.rs`. Parses Claude JSONL and Codex rollouts incrementally; prices from LiteLLM JSON, with a bundled fallback | High: depends on log formats. Performance figures are docs only |
| CLI versions and updates | Yes | `src-tauri/src/agent_updates.rs` (`metadata_endpoint()` ~L268, `apply_with()` ~L763), `agent_updates_install.rs` (Native, Npm, Brew, Uv) | High, per vendor. Needs no running agents, terminals, goals or teams. Re-reads the version after updating. The 6-hour check is docs only |
| Embedded browser | Yes | §7 | Moderate; fragile across platforms |
| App testing (Jev) | Optional, off by default | `src-tauri/src/jev.rs` (pinned Python runtime, fresh Chrome profile per test), `jev_decisions.rs` | High: an external runtime plus paid model calls |
| iOS/Android simulators | Yes (Mac tab) | `src-tauri/src/simulator.rs`, `simulator/` (`simctl`, optional AXe), `src/simulator-3d.ts` (three.js) | High, Mac-specific |
| Local VMs | Yes | `src-tauri/src/vm.rs`, `vm/rfb.rs` (in-house VNC client for Tart) | High |
| Cloud sandboxes | Yes | `src-tauri/src/cloud.rs` (daytona, cloudflare, aws, agentcore). IDs are `provider:native-id`, so the `vm_*` tools address local and cloud machines | High: four vendor APIs |
| Bots | Yes | `src-tauri/src/bots.rs`, `bots/` (~3,100 lines): web, Telegram, Slack, Discord, WhatsApp. Each conversation is an ordinary task. `guard.rs` has allow/ask/deny globs plus a fixed `ALWAYS_ASK` list | Large; runs only while the app is open |
| Deploys | Yes | `src/deploy.ts` starts an agent task with a platform brief. `src-tauri/src/cloud/deploy.rs` provides `pandacode_cloud_cli`: pinned `vercel@64.3.1` / `wrangler@4.151.0`, credentials injected into that child only, secrets scrubbed from output, **always asks even in Full access** | Small |
| Resource limits and privacy | Yes | `secret_store.rs` ("Values never enter prompts, logs, the database or the webview"); CSP in `tauri.conf.json`; capability files; `get_metrics` | Low. "No telemetry" (README) |
| Moodboards, sketch, wallpapers, motion | Yes | `moodboards.rs`, `src/sketch.ts`, `src/wallpapers.ts`, `src/motion.ts` (437 lines, disabled) | Polish with real code weight |

## 9. Where PandaCode's docs and code disagree

| Topic | Docs say | Code does |
|---|---|---|
| Concurrency cap | "four-agent concurrency limit" (`docs/goals-and-command-workflows.md` L13, `docs/validation.md` ~L613) | No cap; a test admits 12 simultaneous starts. `docs/providers.md` and `docs/architect-workers.md` also say there is no cap, so the docs contradict each other |
| Default permission mode | `docs/design.md` L48: "Tasks default to Standard approvals" | `storage.rs` L23 `DEFAULT_PERMISSION_MODE = "full"`; `createTask` and `create_board_task` pass `full` |
| Team size | README L37: "An architect and up to three workers" | 1–6 classic profiles or 0–24 automatic models; parallelism unlimited by default |
| Sidebar | `docs/design.md`: Active/Inactive groups | Grouped by project; activity is only a `data-activity` attribute |
| Windows local servers | `docs/browser.md`: "not implemented" | `local_servers.rs::parse_windows` exists |
| Browser screenshots | macOS only | `browser/platform.rs::capture` has Windows and Linux paths (runtime unverified) |
| GitHub commands | `docs/github.md` lists seven | Also PR detail, diff, merge, link and detect, plus hub commands |
| App tools for non-Codex harnesses | `docs/agent-tools.md`: Claude, GLM, Kimi, OpenCode and Antigravity "receive these host tools through the authenticated, run-local MCP bridge" | `lib.rs` ~L1692–1697 attaches the task/browser/UI catalog (`agent_tools::host`) only to non-team Codex runs. Other harnesses get only the wrapper families: Jev, bot, simulator, VM, deploy, run/preview, tracker and title. The `mcp_host.rs` header says "team and opt-in browser tools" |

**Still docs only:**
- the 6-hour update check;
- ipc.md's rule that model and effort changes are rejected while an agent is active (the picker locks and switching needs idle, but no backend rule was seen);
- the 1.4 s warm saving (a code comment);
- the usage-ledger speed figures;
- "opening a page is not reported as successful testing";
- a global `transition:none!important`;
- the moodboard limits;
- that README screenshots come from mock mode;
- the 500-task / four-stream validation figures.

**Marked docs-only in one study note but confirmed in code:**
- Codex `dynamicTools` (`providers/goals.rs` ~L264);
- team file-scope serialization (`architect.rs::next_action_state`);
- the warm pool;
- the 100-row / 2 MiB page;
- the post-update version re-read;
- the missing-worktree rejection (`Store::workspace_root`).

## 10. Design lessons

1. **Sans-IO protocol core.** Each harness is a pure `receive(frame) -> Step` behind one generic I/O loop.
   - *Why:* recorded frames replay in tests with no CLI or tokens, and the same parser handles subagents.
   - *Cost:* PandaCode keeps it as one 4k-line file of string matches.
   - *Files:* `providers.rs` (~L1667), `providers/*_stream_tests.rs`.
2. **One process per turn, with warm spares only when provably equivalent.**
   - *Why:* a hung CLI cannot poison the next turn, Stop is a group kill, and recovery means only "running becomes interrupted".
   - *Cost:* startup on every turn, background jobs die with the turn, idle spare processes, and reliance on each CLI's resume.
   - *Files:* `providers.rs::run_process_with_tools`, `providers/warm.rs`.
3. **Ask the installed CLI, verify before prompting, never guess.** Catalogs come from init-only calls. Settings are acknowledged before the prompt and permissions are re-applied every turn. Unknowns stay null.
   - *Why:* errors surface early, and downgrading from Full access actually takes effect.
   - *Cost:* extra round trips, and re-verification for each new CLI release.
   - *Files:* `providers.rs` (`list_model_catalog`, `codex_permissions`), `providers/limits.rs`, `providers/goals.rs`.
4. **Instruction economy.** Standing text rides the cached system prompt. Otherwise it is re-sent on a new context and every 8th turn. Team rules and token-saver packs are re-sent only when they change.
   - *Why:* few repeated tokens, and the rules survive compaction.
   - *Cost:* the text must stay constant, because it is part of the warm-spare key.
   - *Files:* `lib.rs::app_instructions`, `architect/briefing.rs`, `src/token-saver.ts`.
5. **App tools on a per-run authenticated loopback MCP server, with an approval boundary owned by the app.** Delegation is simply more tools on that server. Caller identity comes from the bound session. Deploys always ask.
   - *Why:* no user MCP config is needed, and DNS rebinding is blocked.
   - *Cost:* a hand-rolled HTTP server, per-harness shims, and approval policy duplicated for Codex.
   - *Files:* `providers/mcp_host.rs`, `providers/host_tools.rs`, `cloud/deploy.rs`.
6. **Own every child process, use one bounded runner, never force Git.**
   - *Why:* no orphan processes, hangs or option injection, and no silent loss of work.
   - *Cost:* platform-specific unsafe code, a small race when assigning Job Objects, and merge conflicts resolved by hand.
   - *Files:* `providers/windows_job.rs`, `workspace.rs` (`run_bounded`, `run_git_bounded`, `merge_worktree`).
7. **Bound everything at every edge.** Raw provider payloads never cross IPC, and previews come from a writer that stops serializing once full.
   - *Why:* a misbehaving CLI cannot exhaust memory or the webview.
   - *Cost:* many magic constants and truncation notices.
   - *Files:* `providers.rs` (`Preview`, `event_metadata`), `storage.rs::messages`.
8. **Race-proof transitions.**
   - A compare-and-set claim inside the prompt's transaction.
   - Run-scoped IDs.
   - The lock held through `done`.
   - Generation counters.
   - Idempotency keys on actions the model triggers.
   - *Why:* double starts, late callbacks and retried tool calls cannot take effect twice.
   - *Cost:* every entry point must check, and a missed check fails silently.
   - *Files:* `storage.rs::begin_task_turn_with_kind`, `lib.rs::respond_approval`, `architect.rs` (`Admission`, `architect_requests`).
9. **Execution status separate from workflow stage.**
   - *Why:* the board never misstates what the process is doing, and errors never mark work done.
   - *Cost:* two state machines, plus policy written as a SQL `CASE`.
   - *Files:* `storage.rs::finish_task_operation`, `src/task-board.ts`.
10. **A durable queue with derived holds, plus steering as an acknowledged RPC that falls back to the queue.**
    - *Why:* nothing is sent automatically after a problem, and nothing is lost.
    - *Cost:* dispatch lives in the webview, holds are tracked per window, and steering needs per-harness work.
    - *Files:* `message_queue.rs`, `providers/steering.rs`, `src/main.ts::dispatchQueue`.
11. **Persist at semantic boundaries, and reconcile snapshots by prefix digest.**
    - *Why:* no duplicates, no second copy of the text, and little write volume.
    - *Cost:* a crash loses the unflushed tail, and a revised final message is dropped.
    - *Files:* `lib.rs::save_agent_activity`, `providers/text_stream.rs`.
12. **Honest restart, with an acknowledged context handoff.**
    - *Why:* no surprise spend after a crash, and a failed first start retries safely.
    - *Cost:* the user must click Resume, pending approvals are lost, and the handoff excerpt is lossy.
    - *Files:* `storage.rs::open` (~L406), `context_recovery.rs`.
13. **Teams as hidden real tasks, with asynchronous dispatch and an event-driven pump.** The lead gets bounded summaries, changed workers first.
    - *Why:* the task runner is reused, the lead's context stays small, and nothing polls.
    - *Cost:* every listing must exclude workers, summaries are lossy, and the tests are heavy (`architect/tests.rs` is about 2.3k lines).
    - *Files:* `architect.rs` (`dispatch_state`, `next_action_state`, `review_summaries`).
14. **Parallel writers in one checkout.** Overlapping declared scopes run one after another. Change capture omits files that are ambiguous or claimed by two writers.
    - *Why:* parallel work without per-worker merges, and an honest record of what changed.
    - *Cost:* scopes are advisory only, unreported shell writes are missed, and the capture code is about 1.6k lines.
    - *Files:* `architect.rs::overlaps`, `turn_changes.rs`, `turn_changes/team.rs`.
15. **A UI built for many live agents.**
    - Frame-coalesced repaints.
    - Identity-replacing `morph()`.
    - Cached pages drawn first.
    - Agent activity folded under "Worked for …".
    - One approval bar.
    - *Why:* four busy agents cost about one frame of work, and the transcript reads like a dialogue.
    - *Cost:* hand-written diffing with UI state captured and restored around it, a heuristic for picking the final answer, and approvals detached from the timeline.
    - *Files:* `src/main.ts` (`renderStream`, `selectSession`), `src/dom.ts`, `src/turn-activity.ts`, `src/approval-bar.ts`.

## 11. What not to copy, and why

- **The single 275 KB `src/main.ts`, with one mutable global `state` and template-string HTML.**
  - It works only through counters, epoch guards and capture/restore helpers.
  - It is hard to change safely and does not fit a component framework.
- **A 4k-line provider module that matches on provider-name strings.** Copy the sans-IO idea, not the layout. PandaCode's AGENTS.md admits the cost.
- **Full access as the default for new tasks.** It contradicts PandaCode's own design doc and pushes all the risk onto per-tool exceptions.
- **Esc stopping the agent.** The same Esc cascade also closes menus and panels, so one stray press can kill a run.
- **A native child-webview browser.**
  - Native views cannot sit under HTML, so every menu and dialog must hide the browser, and its bounds are pushed by hand.
  - It is fragile, and the platform-support docs are already stale.
  - `browser_type` also fills password fields, guarded only by the tool description.
- **Queue dispatch in the webview.** If the window is closed, nothing drains, and bots needed a second, native dispatcher.
- **Advisory file scopes as the only protection for parallel writers,** unless the risk is accepted knowingly. A misbehaving worker can still write anywhere.
- **The large integration surface.**
  - Simulators with a three.js device model.
  - Tart VMs with an in-house VNC client.
  - Four cloud sandboxes.
  - Five bot channels.
  - CLI self-updaters.

  Each is a Mac- or vendor-specific maintenance load. Copy the `provider:native-id` routing idea, not the integrations.
- **Usage and cost readers built on vendor-internal endpoints and log formats.** They break when vendors change them. Token counts from provider events cover most needs.
- **Overlay polling.** It uses 1.5 s snapshots plus a full refetch on every event. That is acceptable at this scale, but not a model to follow when events already carry deltas.
- **Wallpapers, glass materials, and a 437-line motion library that is switched off.**
