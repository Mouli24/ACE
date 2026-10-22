# ACE vs PandaCode — evidence-based gap analysis

**Date:** 2026-10-21 · **ACE:** `feat/agentic-nodes-p2` at e167f305 (the newest code; `main` is behind it) · **PandaCode:** e86dae6 (v0.3.11)
**Companion docs:** [pandacode-analysis.md](pandacode-analysis.md) (how PandaCode works) · [pandacode-integration-plan.md](pandacode-integration-plan.md) (what we build, in what order)

Both codebases were read at source level. Nothing from PandaCode was built or run. Every ACE claim below was checked in code on the branch above. A path starting `src-tauri/` or `src/` is PandaCode; anything else is ACE.

---

## 1. The short version

PandaCode and ACE solve different problems. PandaCode is a **task-centric cockpit** for coding CLIs: one conversation is one task, which may run in its own worktree, and an "architect" model can spawn workers at runtime. ACE is a **graph-centric orchestrator**: the person draws the team on a Canvas, typed envelopes carry work between nodes, and guardrails, budgets, checkpoints and an append-only event log surround every step.

So the comparison is not "what PandaCode has that ACE lacks". It is "which of PandaCode's engineering decisions make agent work more *reliable and controllable*, and how do those decisions look on a Canvas".

**Where ACE is already stronger:**
- **What crosses between agents.** ACE hands off typed, bounded envelopes, labelled untrusted (Arch §12.4, `packages/engine/src/envelopes/index.ts`). PandaCode passes a worker's last message, cut to 512–6000 bytes (`src-tauri/src/architect.rs`).
- **Explicit dependencies.** ACE draws them as graph edges, with merge and loop nodes. PandaCode has scheduler-side `dependsOn` lists the person never sees.
- **Undo for AI writes.** ACE checkpoints every writing step in a private git store, with per-file keep and revert and per-step revert (`packages/engine/src/checkpoints/service.ts`, D300/D341). PandaCode saves turn diffs, but its `turn_changes.rs` has no revert.
- **Guardrails and budgets.** ACE has seven guardrail points plus run, node, turn and daily cost caps. PandaCode has permission modes, and new tasks default to **Full access** (`storage.rs` `DEFAULT_PERMISSION_MODE = "full"`, contradicting its own `docs/design.md`).
- **Replayability.** Immutable run snapshots plus the event log support replay, compare and Bench. PandaCode has no events table.

**Where PandaCode is clearly ahead:**
- **Conversation continuity.** It persists native session IDs and resumes them (Claude `--resume`, Codex `thread/resume`, ACP `session/load`), with a bounded history replay when that isn't possible (`src-tauri/src/context_recovery.rs`). ACE rebuilds every CLI turn from a flattened text transcript (D309: "every CLI is stateless").
- **Per-task reasoning effort.** Each task sets its own effort, validated against the CLI's own catalog (`validate_reasoning_effort`, `providers.rs` ~L430). ACE has no effort setting at all.
- **Execution control while busy.**
  - A durable, visible queue with exactly-once delivery (`message_queue.rs`).
  - Acknowledged steering (`providers/steering.rs`).
  - Explicit "interrupted → Resume" recovery after a restart.
- **Agent permissions honoured everywhere.** A task's permission mode is applied on every turn of every harness. In ACE, a node's chat ignores the node's CLI access level (§3, gap P0-1).
- **Workspace conveniences:**
  - One approval bar with Approve all (`src/approval-bar.ts`).
  - A ⌘K palette.
  - Find in thread.
  - A real PTY terminal.
  - Git staging, commits and worktrees.
  - An embedded browser preview.

**What we should not copy:**
- the single 275 KB `main.ts` with global state;
- the Full-access default;
- Esc stopping a running agent;
- the native child-webview browser;
- the per-vendor peripheral integrations (simulators, Tart VMs, four cloud-sandbox vendors, five bot channels, CLI self-updaters, usage readers built on vendor-internal endpoints).

The reasons are in §6.

---

## 2. How to read the comparison tables

Each row gives the feature, how PandaCode does it, how ACE does it, the gap, the fit with ACE's architecture, the effort (**S** ≤ 1 day, **M** 2–4 days, **L** a week or more), the impact, and a class:

- **Adopt:** a proven capability that fits ACE directly.
- **Adapt:** a useful idea that needs redesign for ACE.
- **Improve:** an existing ACE feature that PandaCode shows how to make better.
- **Avoid:** adds complexity or fights ACE's direction.

---

## 3. Comparison by area

### A. Multi-agent execution and the provider layer

| Feature | PandaCode | ACE today | Gap | Fit · effort · impact | Class |
|---|---|---|---|---|---|
| Normalized harness interface | One sans-IO `Protocol::receive(Value) -> Step` (`providers.rs` ~L1667) with string matches per provider; I/O in one generic loop (`run_process_with_tools` ~L2761) | `ProviderAdapter.generate(req, signal) → AsyncIterable<StreamChunk>` (`packages/engine/src/ports/model-provider.ts:218`); API types share `createAiSdkAdapter` (`packages/providers/src/adapters/ai-sdk.ts:462`); CLIs share `createCliAdapter(dialect)` (`adapters/cli/adapter.ts:143`) | None structurally. ACE's dialect objects are cleaner than PandaCode's provider-name matches. PandaCode's lesson worth taking is **frame-replay tests**: recorded real frames fed to the parser, no process needed. | High · S · reliability | Improve (tests only) |
| Per-node model | Per task, switchable mid-thread when idle | Per node (`contracts/src/graph.ts:196`), fallback chain in runs (`runs/executor.ts:851-905`) | — | — | parity |
| **Per-node reasoning effort** | `RunConfig.reasoning_effort`; Claude `--effort`, Codex `turn/start.effort`, ACP `set_config_option`; checked against the live catalog before the prompt (`providers.rs` ~L430, ~L1791) | **None.** Not in `ExecutionSettingsSchema` (`contracts/src/graph.ts:125`) or `GenerateRequest`. `apps/web/src/theme/constants.ts` defines `EFFORT` but nothing uses it. | Missing. AI SDK 7 already has a unified `reasoning` call option that each provider maps itself (`node_modules/ai/dist/index.d.ts` ~L582). Claude Code 2.1.304 on this machine takes `--effort low\|medium\|high\|xhigh\|max`. | High · S–M · quality/cost control per node | **Adopt** |
| **CLI session resume** | Native IDs saved from the `session` event (`sessions.resume_id`). One process per turn, resumed. A bounded replay (200 entries / 64 KiB) when the ID can't be used (`context_recovery.rs`) | None. No session ID is captured and no `--resume` is passed. Chat flattens the whole thread into one `## Conversation` block capped at the node's budget, oldest turns dropped first (`engine/src/chat/prompt.ts`). D309: "Every CLI is stateless." | Missing. A Claude Code chat loses its own tool context every turn and pays for the transcript again. | High · M · large UX and cost win | **Adapt** (needs an owner decision: amends D302/D309) |
| Process-tree ownership | Job Object on Windows with `taskkill /T` fallback; process groups elsewhere (`providers/windows_job.rs`) | `taskkill /pid /T /F`; process-group SIGKILL elsewhere (`providers/src/adapters/cli/runner.ts` `killTree`). libuv already puts children in a kill-on-close job. | — | — | parity |
| npm `.cmd` shim handling | Reads the package `bin` entry and runs `node <script>` (`providers/launch.rs::resolve`) | Unwraps `.cmd` shims to the real target (`adapters/cli/resolve.ts`) | — | — | parity |
| CLI permission prompts surfaced to the person | `--permission-prompt-tool stdio` turns Claude's `can_use_tool` into a PandaCode approval; Codex and ACP approval requests are answered | Headless. Commands outside the node's allowlist are refused, not asked (`adapters/cli/claude-code.ts`, D383: "headless can't ask") | A CLI node can't ask mid-turn. Adapting needs stream-json input mode for Claude. | Medium · L · fewer refusals for CLI nodes | Adapt (P2) |
| App tools for CLI agents | A per-run authenticated loopback MCP server (`providers/mcp_host.rs`) carries PandaCode's app tools to every harness (change tracking, titles, preview, deploy, VM/simulator); the task/browser/UI catalog is attached only to non-team Codex runs (`lib.rs` ~L1692) | CLI nodes run `--strict-mcp-config` with no ACE tools: Claude Code gets only its own Read/Edit/Write/Grep/Glob | ACE's knowledge bases, web search and "ask another node" are out of reach for CLI nodes | Medium · L | Adapt (P2/P3) |
| Warm spare processes | After a Claude turn, the next process is pre-started (max 2, 10 min), adopted only on an exact launch fingerprint (`providers/warm.rs`) | Spawns per call | Saves about 1.4 s per turn (per a code comment), at the cost of idle processes and subtle invalidation rules | Low · M | Avoid for now (P3) |
| Usage and cost | Account limits from vendor endpoints; cost from local Claude/Codex logs priced with LiteLLM (`agent_usage*.rs`, `usage_ledger/`) | `GET /usage` by provider, model, day or workflow; run and chat spend separate; a local model costs $0 and an unpriced model's cost is unknown (`contracts/src/usage.ts`, `storage-local/src/repository-usage.ts`). **Runs estimate tokens (chars ÷ 4) when a provider reports none (D313); chat does not**, so a Codex or Gemini chat turn records 0 tokens. | Data bug in chat. No rate-limit-until display. | High (bug) · S | **Improve** (P0) |
| CLI version/update management | Checks vendor feeds and installs updates when idle (`agent_updates*.rs`) | Shows the version only (`adapters/cli/detect.ts`) | A large maintenance surface for one user | Low · M | Avoid (P3) |

### B. Conversations and execution control

| Feature | PandaCode | ACE today | Gap | Fit · effort · impact | Class |
|---|---|---|---|---|---|
| Persistent thread per agent | One task = one thread; switcher in the sidebar | Per-node threads with New chat / pick / delete (`apps/web/src/chat/ChatThreadList.tsx`, `ChatAside.tsx`); `chat_threads`/`chat_messages` (`storage-local/src/schema.ts:533-582`) | — | — | parity |
| **Agent permissions honoured in chat** | Mode re-applied on every turn of every harness | **Not for CLI chat.** The chat's CLI call carries no `cliAccess` (`engine/src/chat/service.ts` ~L1012). A Read-only node is *told* it is read-only (`folderAccess`, ~L866), but Claude Code still launches with the provider preset, e.g. `acceptEdits`. Runs do pass the node's level (`runs/executor.ts:1342`). | **A Read-only node's chat can edit files.** A safety and consistency defect. | Critical · S | **Improve (P0-1)** |
| **Message queue while busy** | Durable `queued_messages`; exactly-once `take`, `restore` to the front; held, not drained, after a failure, stop or restart (`message_queue.rs`, `src/message-queue.ts`) | The engine runs writing chat turns one at a time per project (`chat/service.ts` `writeQueue` ~L477). In the UI the session keeps **one** `pending`; the first agent reply runs `settleThread`, which clears it for the whole thread, so a second queued turn loses its waiting state and its Stop button (`apps/web/src/chat/session-store.ts`, `useChat.ts`). The Domain composer has a real Queue mode. | Queued work becomes invisible; Stop disappears for a turn that is still coming | High · S–M | **Improve (P0-4)** |
| Steering a running agent | Claude: an extra stream-json user message counted through `--replay-user-messages`; Codex: `turn/steer`; otherwise queued. Acknowledged within 15 s, falls back to the queue (`providers/steering.rs`) | Domain "Interrupt" kills the turn and re-runs it with the message (`domain/service.ts:386`, D309). Node chat: Stop, then resend. | No mid-turn injection | Medium · L (needs stream-json input) | Adapt (P2) |
| Cancel | Interrupt frame, 3 s grace, then kill the group | `POST /chat/threads/:id/stop` → `stopThread`; tree kill (`chat/service.ts:1373`); run Stop aborts at once (`runs/control/service.ts`) | — | — | parity |
| **Recovery after a restart** | Running → `interrupted`; queues held; nothing auto-resumes; the person presses Resume (`storage.rs` ~L406, `lib.rs::reconcile_inactive_task`) | `recoverAfterCrash` (`runs/lifecycle.ts`, `apps/server/src/server.ts:1087`): active runs → HALTED `crash`, in-flight nodes STOPPED, agentic nodes BLOCKED `engine_restarted`/`approval_lost` (D379). **No one-step continue:** the node menu offers Retry only for FAILED (`apps/web/src/runs/NodeRunMenu.tsx:56`), although `retryNodeRun` accepts any status (`runs/control/service.ts:517`). The first retry reopens the run to RUNNING, so retrying a *second* interrupted node gets 409 `invalid_run_state` (`assertNotLive`). | A crash in a parallel workflow can't be recovered without re-running work by hand. **D-055** (OPEN): partial drives count only the new attempts in the run totals. | Critical for reliability · M | **Adopt + Adapt (P0-3)** |
| Per-turn timeout | 90 s startup timeout only; a 20-min silence watchdog for team turns | `execution.timeoutMs` per turn (120 s; CLI at least 600 s); no whole-node or whole-run timeout | Comparable | — | parity |
| Rate-limit handling | `limited_until` taken only from what the provider reports; optional "resume at reset" (`providers/limits.rs`, `src/usage-limit.ts`) | A 429 becomes retryable `provider`/`http_429`; no reset time is shown | Nice to have | Low · M | Adapt (P2) |
| Fork a conversation | `conversation_fork::at_message` | None | — | Low · M | P3 |
| Find in thread | ⌘F with the CSS Custom Highlight API (`src/thread-find.ts`) | None | — | Medium · S | Adopt (P2) |
| Folded tool activity and visible answer | "Worked for …" fold plus Markdown answer (`src/turn-activity.ts`) | Chat shows activity and a Changes card per turn | Comparable | — | parity |

### C. Agent teams and delegation

| Feature | PandaCode | ACE today | Gap | Fit · effort · impact | Class |
|---|---|---|---|---|---|
| Who decides the team | The architect *model* spawns 1–12 workers per call through MCP tools (`dispatch_workers`, …) on a per-run loopback server (`architect.rs`, `providers/mcp_host.rs`) | The *person* draws it: agent nodes, typed edges, merge/loop nodes; Domain mode routes HANDOFFs at runtime (`engine/src/domain/*`) | Different by design. ACE's static graph is its identity. A *dynamic* fan-out (one node spawning N workers it chooses) is the one PandaCode idea worth adapting later. | Medium · L | Adapt (P3) |
| Passing results | A worker's last message cut to 512–6000 bytes; the architect pulls more with `read_worker` | Envelopes: reads + bounded context + output contract + `workspace` summary (D378); over-budget reads summarised by the receiving model | ACE is stronger | — | — |
| Dependencies | `dependsOn` in the scheduler; a failed dependency fails dependents | Edges; `isReady` (`runs/index.ts:645`); `blockDownstream` (1352) | ACE is stronger and visible | — | — |
| **Parallel writers** | Shared checkout; every assignment declares a `files` scope; overlapping writers never run together; read-only workers run freely (`architect.rs::next_action_state`). Advisory: not enforced by the filesystem. | Writing nodes in one run take turns (`writeTurns = createSemaphore(1)`, `runs/index.ts:792`) **so each checkpoint holds only its own node's changes** (comment at 786); one engine-wide lock per file (`tools/src/agent/locks.ts`); read-before-edit hash check (`tools/src/builtins/project-files.ts` `assertSeenCurrent`) | ACE is safe but serial. Declared write scopes could let non-overlapping writers run together, **but** checkpoints snapshot the whole tree, so they must become path-scoped first, or two writers' changes mix into each other's undo. CLI nodes can't be confined to a scope (D383: their file tools bypass ACE's path guard). | Medium · L | Adapt (P2) |
| Stale-callback guards | Generation counters on every launch and tool call; idempotency keys on model-issued side effects | Run gates, `assertNotLive`, `assertNodeFree` | Comparable for ACE's scope | — | — |
| Watching a worker | Each worker is a hidden real task with its own transcript | Each node has an inspector, run history and live card activity (D381) | Comparable | — | — |

### D. Git, worktrees and review

| Feature | PandaCode | ACE today | Gap | Fit · effort · impact | Class |
|---|---|---|---|---|---|
| Undo / review of AI changes | Per-turn snapshots attributed to tool writes (SHA-256 baselines, Myers diffs in SQLite, leases that drop shared files); unified/split view; **no revert** (`turn_changes.rs`) | A checkpoint per writing step in a private bare repo outside `.git`; keep/revert per file and per step; review tabs; Changes card in chat (`checkpoints/service.ts`, `tools/src/checkpoints/git-store.ts`, `apps/web/src/forge/changes/*`) | ACE is stronger | — | — |
| Per-task worktrees | `<project>-worktrees/<branch>`, a `pandacode/` branch prefix, a local "Merge into main" that aborts on conflict, cleanup that never forces (`workspace.rs`, `src/worktrees.ts`) | None. Every node writes the real project folder (D341, D385). | An *opt-in* "run this workflow in an isolated worktree, then review and merge" would give full isolation for risky runs. It touches checkpoints, the explorer and the run snapshot. | Medium · L | Adapt (P3) |
| Git status/stage/commit/branch UI | Staging, commit, branch chip, push and open PR via `gh` | Read-only status letters in the Explorer (`forge/explorer/decorations.ts`); the branch is in the contract but never shown; commit UI is a design non-goal (`docs/team-prompts/ide-workspace-design.md` l.36, l.513) | A common daily need | Medium · M | Adopt (P2; reverses a non-goal) |
| Bounded process runner | `workspace::run_bounded`: null stdin, byte caps, deadline, tree kill, `GIT_*` stripped, hooks off for reads | The checkpoint store's own runner is bounded the same way (D300: 60 s, 64 MB, `GIT_*` stripped, hooks off) | — | — | parity |
| GitHub issues/PRs | `gh`-based hub, PR linking after a run | None | — | Low · M | P3 |

### E. Workspace UI/UX

| Feature | PandaCode | ACE today | Gap | Fit · effort · impact | Class |
|---|---|---|---|---|---|
| **Run state on the Canvas's edges** | n/a (no canvas) | Edges always draw the same flowing dashed line (`apps/web/src/canvas/EdgeLayer.tsx:52-95`). `TypedEdge` sets `data-transferred`/`data-animating`, but it is an invisible hit band and no CSS reads those attributes (`nodes/TypedEdge.tsx:72-77`). | You can't see on the graph where data has flowed, what is waiting, or what was cut off by a failure | High (identity) · S–M | **Improve (P1)** |
| **Approvals: one place, Approve all** | One slim bar above the prompt, Approve all / Deny all (`src/approval-bar.ts`) | Approvals under the node, in a Forge dock, a Domain dock, the "…" dialog and inline in chat; **no approve-all** (`apps/web/src/runs/approvals/*`) | Bursts of command approvals mean many clicks | Medium · S | **Adopt (P1)**, but never for destructive calls (BR "destructive always asks") |
| Command palette | ⌘K: static commands plus 12 tasks | None. `cmdk` is in the locked stack (CLAUDE.md §2) but not installed. Quick Open (Ctrl+P) covers files only (`forge/quick-open/QuickOpen.tsx`). | Navigation across nodes, runs and actions | Medium · M | Adopt (P2) |
| Terminal | PTY via portable-pty + xterm.js (`terminal.rs`) | Line discipline in the browser, one engine process per command (`forge/terminal/line-discipline.ts`) | No interactive programs (REPLs, prompts, TUIs) | Medium · M (native `node-pty` build on Windows) | Adapt (P2) |
| Browser / app preview | Native child webview, `pandacode-run.sh` convention, loopback readiness probe (`browser.rs`, `run_script.rs`, `run-project.ts`) | None: no iframe anywhere; Forge previews only images | Agents build web apps the person can't see inside ACE | Medium · M | Adapt (P2): an iframe to a loopback URL, not a native webview |
| Per-node Stop | Stop per task | Run-level Stop only; `NodeRunActions` is exported but never used (Inspector) | Stopping one runaway node stops the whole run | Medium · M (needs a per-node abort in the scheduler) | Improve (P2) |
| Keyboard shortcut list | Shortcuts documented and shown in menus | `apps/web/src/app/shortcuts.ts`; shown only in tooltips | — | Low · S | P2 |
| Rendering under load | Per-frame batching, Markdown cache, `morph()` | React plus a 50 ms token batch (`chat.token`) | No observed problem | — | — |

### F. Additional capabilities

| Capability | PandaCode | Suitable for ACE? | Class |
|---|---|---|---|
| Token-saver response styles (`src/token-saver.ts`) | Style packs appended only when they change and every 8 messages | ACE already bounds every handoff by envelope budget. Terse styles risk answer quality on judge or contract nodes. | Avoid (P3 at most, per node, opt-in) |
| Provider usage and limits | Vendor endpoints plus log readers | Keep ACE's provider-event usage. Fix chat estimates (P0-2). Show `limited_until` only when a provider reports it (P2). | Improve |
| CLI version management | Updaters per install route | One user, one machine: a "how to update" hint is enough | Avoid |
| Browser previews and app testing | Embedded browser with agent tools | Iframe preview in Forge (P2). Agent browser tools come only after D-083's runner exists. | Adapt (P2/P3) |
| Cloud sandboxes / VMs / simulators | Daytona, Cloudflare, AWS, Tart, iOS/Android | The real ACE need is D-083/D13's confined command runner (Docker), not vendor sandboxes | P3 (via D-083) |
| Bots | Telegram/Slack/Discord/WhatsApp/web | Off-direction for a canvas workspace; a webhook *Input node* would be the ACE-shaped version | Avoid now (P3) |
| Deploys with approval gates | Always-ask `pandacode_cloud_cli` with credential scrubbing (`cloud/deploy.rs`) | ACE already has the always-ask class (destructive tools). A deploy is a workflow template plus a tool marked destructive. | P3 |
| Resource limits, persistence, privacy | Bounded buffers everywhere; keychain; loopback servers with Host/Origin checks | ACE has 127.0.0.1 bind, session token, Origin allow-list, keychain, env allowlist (D-093). PandaCode's lesson worth taking is **bounding every buffer at the trust edge** (frames, previews, pages). | Improve (opportunistic) |

---

## 4. Ranked opportunities

Ranking weighs user value, architectural fit, reliability gain, effort, regression risk and prerequisites. "Build now" means it is in this change set; everything else is planned in [the integration plan](pandacode-integration-plan.md).

### P0 — broken or missing foundations

| # | Opportunity | Why it is P0 | Effort | Build now? |
|---|---|---|---|---|
| P0-1 | **Chat honours the node's CLI access level** | A Read-only node's chat can change files through the CLI's preset: a permission promise the UI makes and the engine breaks | S | Yes |
| P0-2 | **Chat estimates usage when a CLI reports none** | Codex and Gemini chat turns record 0 tokens, so usage, budgets and cost views under-count (runs already estimate, D313) | S | Yes |
| P0-3 | **Continue an interrupted run in one action**, with Retry offered on interrupted nodes, and **D-055** fixed (partial drives count the whole run) | After a crash or Stop, a parallel workflow can't be recovered without re-running work, and its totals are wrong | M | Yes |
| P0-4 | **Chat queue state per message**: a queued turn keeps its waiting state and Stop; the composer shows what is queued | Queued work vanishes from the UI, and a turn that is still coming can't be stopped | S–M | Yes |

### P1 — high impact on orchestration and the core experience

| # | Opportunity | Effort | Build now? |
|---|---|---|---|
| P1-1 | **Per-node reasoning effort** (API through AI SDK 7 `reasoning`; Claude Code `--effort`; Codex `model_reasoning_effort`; not applied, and shown as not applied, where a provider has no control) | S–M | Yes |
| P1-2 | **Edges show run state**: data delivered, data in flight, waiting, and cut off by an upstream failure | S–M | Yes |
| P1-3 | **Approve all** for pending non-destructive approvals of a run | S | Yes |
| P1-4 | **Claude Code session resume for node chat**, with a bounded-history fallback | M | **No.** Amends D302/D309, so the owner decides first (design in the plan) |
| P1-5 | **Steering for Claude Code chat** (stream-json input, acknowledged, with a queue fallback) | L | No; after P1-4, which it builds on |

### P2 — valuable once the foundations are stable

- Approval gate and condition nodes on the Canvas.
- Per-node Stop.
- Command palette (cmdk).
- Find in thread.
- Git status/stage/commit/branch UI.
- Browser preview (iframe plus a run script).
- PTY terminal.
- Declared write scopes with path-scoped checkpoints (parallel writers).
- CLI permission prompts surfaced as ACE approvals.
- A loopback MCP server giving CLI nodes ACE tools.
- `limited_until` display.
- Frame-replay tests for CLI dialects.

### P3 — future

- An opt-in worktree per run, with review-and-merge.
- A dynamic fan-out node (an architect that spawns workers).
- Conversation fork.
- GitHub hub.
- A webhook Input node instead of bots.
- Deploy templates.
- Warm processes.
- Token saver.
- Sandboxes via D-083's runner.

---

## 5. Compatibility constraints any change must respect

- **The shared `~/.ace` database.** Several checkouts (main, wt/agentic, older worktrees) open the same SQLite file. An older engine that meets an enum value it does not know dies at startup (this happened 2026-10-13 with `allowedActions: ['end']`). So:
  - **no new values in persisted enums** (run actions, node kinds, statuses) without a migration story;
  - new *optional object fields* are safe, because Zod `z.object` strips unknown keys by default.
- **Contracts are the seam** (CLAUDE.md §3.4): every API shape goes into `packages/contracts` first, then engine and SDK, then web.
- **Destructive always asks** (Arch §13.1). No bulk action may approve a destructive call.
- **No silent behaviour change in runs.** Reasoning effort is absent by default, which means the provider's own default, exactly as today.

---

## 6. Rejected or deferred, with reasons

| PandaCode feature | Decision | Reason |
|---|---|---|
| Task board (Pending → In progress → Review → Completed) | Avoid | ACE's unit of work is a node in a workflow. Node states (IDLE…COMPLETED) and run states already are the board, drawn on the Canvas. A second state machine would duplicate them. |
| Full-access default | Avoid | ACE's D342 (no Full auto; new nodes Edit files) is the safer, already-decided rule |
| Esc stops the running agent | Avoid | Esc closes menus in the same cascade, so one stray press kills a run. ACE's Stop asks first (`HeaderRunControls.tsx`). |
| Single-file UI with global mutable state | Avoid | ACE's React + Zustand + TanStack Query split (BR-01, "engine owns truth") is the better structure |
| Native child-webview browser | Avoid | It must be hidden under every menu and dialog. An iframe to a loopback URL with the same guards does the job in a web app. |
| Simulators, Tart VMs, four cloud-sandbox vendors | Avoid | Mac- and vendor-specific surface. ACE's real need is the confined runner of D-083. |
| Bots on five chat channels | Avoid | Not the canvas workspace's job. An Input node fed by a local webhook covers it if ever needed. |
| CLI self-updaters; usage readers on vendor-internal endpoints and log files | Avoid | They break whenever a vendor changes formats, for one user's benefit |
| Warm spare processes | Defer (P3) | About 1.4 s per turn, against idle processes and fingerprint invalidation. Revisit after session resume (P1-4), which shares the launch key. |
| Token saver | Defer (P3) | Envelope budgets already bound handoffs. Terse styles risk contract and judge nodes. |
| String-matched provider branches | Avoid | ACE's dialect objects are better; keep them |
