# PandaCode → ACE integration plan

**Date:** 2026-10-21 · **Branch:** `feat/pandacode-evolve` (off `feat/agentic-nodes-p2` e167f305) · **Inputs:** [pandacode-analysis.md](pandacode-analysis.md), [ace-gap-analysis.md](ace-gap-analysis.md)

This plan turns the ranked gaps into changes in ACE's real code. **Wave 1** is built in this change set. Everything after it is designed here and waits for an owner decision or a later round.

Ground rules for every change, from the gap analysis:
- **Contracts first.** Every new shape goes into `packages/contracts`, then the engine and SDK, then the web app (CLAUDE.md §3.4).
- **No new values in persisted enums.** The shared `~/.ace` database is opened by older checkouts, which die on an enum value they don't know. New optional object fields are safe, because `z.object` strips unknown keys.
- **Destructive always asks.** No bulk action approves a destructive call.
- **Defaults never change behaviour.** Every new setting is absent by default, and absent means exactly what happens today.

---

## Wave 1: built in this change set

Decision rows D386–D391 are appended to `docs/DECISIONS.md` with the code.

### W1-1 (P0-1): chat honours the node's CLI access level, D386

**Problem.** `packages/engine/src/chat/service.ts` builds the CLI call (~L1012) without `cliAccess`. The node is *told* it is read-only (`folderAccess`, ~L866), but Claude Code launches under the provider preset (for example `acceptEdits`), so a Read-only node's chat can write files. Runs already pass the level (`runs/executor.ts:1342`, D383).

**Change** (engine only, `chat/service.ts`):
- When the node is an agentic agent node (`isAgentic(config)`, access ≠ `off`), the adapter is a CLI (`isCliProviderType`) and the turn has a project folder, the chat call sends:
  `cliAccess: { access, allowedCommands: agentWorkspaceOf(config).allowedCommands }`
  This is the same mapping runs use (D383).
- `folderAccess` and the D385 rules the turn is told are derived from the same level, so what the model is told and what the CLI may do agree.
- The "writes" judgement for the checkpoint gate (~L916) follows the level: a Read-only CLI chat turn is not a writing turn.
- An Off node keeps the provider preset, exactly as today.

**Provider compatibility.** The adapter already maps `cliAccess` per dialect:
- Claude Code: `dontAsk` plus Read/Grep/Glob for Read only; `acceptEdits` for Edit files; `dontAsk` plus `Bash(prefix:*)` for Edit + commands.
- Codex: `read-only` / `workspace-write`.
- Gemini: has no allowlist, so its Edit + commands is disabled (D383).

**Security.** This closes a privilege gap. Nothing is widened.

**Tests.** In the engine chat service tests:
- a Read-only agentic CLI node's chat call carries `cliAccess.access === 'read_only'`;
- an Off node's call carries none;
- the allowlist rides along for Edit + commands.

### W1-2 (P0-2): chat estimates usage a provider did not report, D387

**Problem.** Runs estimate characters ÷ 4 when a provider reports no usage (D313), but chat does not. A Codex or Gemini chat turn records 0 tokens, so usage, the turn cap and the daily cap under-count.

**Change** (`chat/service.ts`): when a call ended with no `usage` chunk, estimate tokens from the prompt (system + prompt text) and the reply text (characters ÷ 4) and mark the reply's usage `source: 'estimated'`.
- The estimate also feeds `checkBudget`, so the caps see it.
- A reported zero stays a reported zero. Only a *missing* usage chunk is estimated.

**Data.** None new: `UsageSchema.source` already exists (D313).

**Tests:**
- a mock call with no usage chunk yields `source: 'estimated'` and non-zero tokens;
- a call with usage keeps `source: 'reported'`, or the field absent, as before.

### W1-3 (P0-3): Continue an interrupted run; fix D-055, D388

**Problem.**
- After a crash, shutdown or Stop, `recoverAfterCrash` (`runs/lifecycle.ts`) leaves the run HALTED with in-flight nodes STOPPED, and agentic ones BLOCKED `engine_restarted` / `approval_lost`.
- The web node menu offers Retry only for FAILED (`apps/web/src/runs/NodeRunMenu.tsx:56`).
- The first retry reopens the run to RUNNING (`reopen`, `runs/control/service.ts:631`), so a second interrupted node gets 409.
- D-055: `drivePartialRun` starts a fresh usage list, so a partial drive's totals count only the new attempts.

**Engine** (`packages/engine/src/runs/control/service.ts`, `routes.ts`, `runs/index.ts`):
- New control `continueRun(runId)`, route `POST /runs/:id/continue` → the reopened `Run`.
  - **Allowed when** the run is HALTED with `haltReason` ∈ {`crash`, `shutdown`, `stopped`}. Otherwise 409 `invalid_run_state`. A `failure` halt is a Retry of the failed node, and a `budget_exceeded` halt would only halt again.
  - **Interrupted node runs.** For each `(nodeId, iteration)`, take the latest attempt. It counts as interrupted when it is STOPPED, or BLOCKED with `error.code` ∈ {`engine_restarted`, `approval_lost`}. None found → 409 `nothing_to_continue`.
  - **For each interrupted row**, create a retry row: attempt + 1, READY, with the delivered envelopes copied exactly as `retryNodeRun` does (FR-ERR-003).
  - **Downstream:** BLOCKED rows downstream of any of them, blocked by an upstream rather than interrupted themselves, are cleared to IDLE as `retryNodeRun({withDownstream:true})` does.
  - **Then one reopen** with every retry row and `withDownstream: true`, so a single drive carries the run on. Completed nodes are never re-run.
  - An open Domain run is already re-driven automatically (D323), so it is out of scope here.
- **D-055:** the partial drive seeds its running totals with the usage already recorded on the run's earlier node runs, so the run's end-of-drive totals cover the whole run. This applies to retry, re-run and continue alike.
- **No contract enum change.** `continue` is **not** added to `RUN_ACTIONS` (the shared-DB rule). The client works out when Continue applies, using the same predicate the engine enforces; the predicate is exported from contracts.

**Contracts** (`packages/contracts/src/runs.ts`):
- `canContinueRun(run, nodeRuns)` and `isInterruptedNodeRun(nodeRun)`, pure functions shared by the engine and the web.
- `INTERRUPTED_ERROR_CODES = ['engine_restarted', 'approval_lost']`.

**SDK** (`packages/sdk/src/client.ts`): `continueRun(runId) → Run`.

**Web:**
- The header run controls (`apps/web/src/app/layout/HeaderRunControls.tsx`) show **Continue**, with the tooltip "Run the nodes that were cut off; keep what finished", when `canContinueRun` holds for the selected run.
- `NodeRunMenu` offers **Retry** for an interrupted node too, not only FAILED.

**Tests:**
- Engine control tests:
  - HALTED `crash` with two STOPPED parallel nodes: one call makes two READY retries and one drive, and both reach COMPLETED on the mock provider;
  - a COMPLETED node is not re-run;
  - HALTED `failure` gets 409;
  - nothing interrupted gets 409.
- D-055: totals after a retry include the first attempt's tokens.
- Contracts: predicate unit tests.

### W1-4 (P0-4): chat queue state per message, D391 (part)

**Problem.**
- `apps/web/src/chat/session-store.ts` keeps one `pending` per session. The first agent `chat.message` on the thread calls `settleThread`, clearing it for the whole thread.
- So a second turn, which the engine is still holding in its per-project write queue (`chat/service.ts` `writeQueue`), loses its waiting state and its Stop button.

**Change** (web only):
- Pending is tracked per sent user message. A reply settles only the message it answers, matched by the reply's link to its user message, falling back to the oldest pending.
- The composer shows "N queued" above the box while more than one turn is outstanding.
- Stop stays visible while any turn on the thread is outstanding.

**Tests:** session-store unit tests:
- two sends, then one reply: one still pending;
- two replies: none pending.

### W1-5 (P1-1): per-node reasoning effort, D389

**Contract** (`packages/contracts/src/graph.ts`):
- `REASONING_EFFORTS = ['low','medium','high','xhigh','max']`.
- `ExecutionSettingsSchema.reasoningEffort: z.enum(REASONING_EFFORTS).nullable().optional()`. Absent or `null` means the provider's own default (today's behaviour); `null` is how a patch clears it, as with `maxCostUsd` (D72).
- Older engines strip the unknown key, so the shared-DB rule holds.

**Engine:**
- `GenerateRequest.reasoningEffort?` (`ports/model-provider.ts`).
- Runs (`runs/executor.ts`) and chat (`chat/service.ts`) pass the node's setting when it is set.

**Providers** (mapping table, applied per adapter):

| Provider | How it is applied | Notes |
|---|---|---|
| anthropic, openai, google, openai_compatible, ollama (AI SDK adapter, `adapters/ai-sdk.ts`) | AI SDK 7's own `reasoning` call option, with `max` sent as `xhigh` (its top level) | The SDK maps per provider (Anthropic adaptive or budgeted thinking, OpenAI `reasoningEffort`, Google `thinkingConfig`). A model that cannot reason gets an SDK warning and runs as before, never an error. |
| Claude Code (`adapters/cli/claude-code.ts`) | `--effort <level>` | 2.1.304 here accepts low/medium/high/xhigh/max |
| Codex (`adapters/cli/codex.ts`) | `-c model_reasoning_effort="<level>"`, with `max` sent as `xhigh` | Codex's own config key |
| Gemini CLI (`adapters/cli/gemini.ts`) | not applied | It has no effort flag; the UI says so |
| mock | ignored | |

**Web** (`apps/web/src/config-panel/panels.tsx`, or the execution section of `NodeSettingsModal.tsx`):
- A "Reasoning effort" select: Default / Low / Medium / High / Extra high / Max.
- A one-line hint per provider type, and disabled with the reason for Gemini CLI.
- This uses the existing `EFFORT` labels in `apps/web/src/theme/constants.ts` where they fit.

**Why not validate against a live catalog, as PandaCode does?** ACE's catalog has no effort field yet. Adding one is a contract change to `Model`, which waits for a later wave. Until then, the AI SDK warns rather than fails, and the CLIs reject an unknown level loudly.

**Tests:**
- contracts parse and strip;
- the CLI args for Claude Code and Codex, including `max`→`xhigh` for Codex;
- the AI SDK adapter passes `reasoning`;
- the executor passes the node setting.

### W1-6 (P1-2): edges show run state on the Canvas, D390

**Problem.** Every edge draws the same flowing dashed line, whatever the run did (`apps/web/src/canvas/EdgeLayer.tsx` `EdgeStroke`).

**Change** (web only):
- `EdgeLayer` derives a `flow` state per data edge from the selected run's overlay (`apps/web/src/runs/run-store.ts`: node states plus `useEdgeTransfer`):

| State | When | Drawn |
|---|---|---|
| `none` | no run selected | as today |
| `delivered` | an envelope crossed the edge in this run | solid line |
| `flowing` | the source is RUNNING, or the transfer is under 2 s old | animated dashes |
| `waiting` | the source has not finished | dim, static dashes |
| `cut` | the source ended FAILED, STOPPED or BLOCKED without delivering | danger colour, static dashes |

- The state is exposed as `data-flow` for tests and accessibility, and the title says it ("delivered: <summary>", "cut off: <node> failed").
- Loop and order edges keep their own look.

**Tests:** `EdgeLayer` unit tests that map node states and transfers to `data-flow`.

### W1-7 (P1-3): Approve all for a run's non-destructive approvals, D391

**Change** (web only):
- `apps/web/src/runs/approvals/RunApprovalsDock.tsx` and `ApprovalStack.tsx` show **Approve all (n)** when two or more approvals are pending and at least two are not destructive.
- It approves each non-destructive one through the existing per-approval SDK call, in order.
- A destructive one (guardrail check `destructive_action`) is skipped, stays pending, and is named in the button's tooltip.
- There is no Deny all. Rejecting needs a reason, and the per-card Reject keeps it.

**Security.** Arch §13.1's "destructive always asks" holds. Nothing is approved that the person can't see in the stack.

**Tests:** component test: three pending (one destructive) → Approve all calls approve twice and leaves the destructive one.

---

## Wave 2: P1 items that need an owner decision first

### W2-1 (P1-4): Claude Code session resume for node chat

**Why.** A Claude Code chat today pays for, and loses the structure of, its whole conversation on every turn. ACE flattens history into one `## Conversation` block capped by the node's budget (`engine/src/chat/prompt.ts`). PandaCode resumes the CLI's own session (`--resume=<id>`) and keeps its tool context and prompt cache (`src-tauri/src/providers.rs` `configure_command`).

**Decision needed.** This amends D302/D309 ("every CLI is stateless") for chat. Runs stay stateless: they execute from a snapshot and must be reproducible (BR-04).

**Design:**
- **Contract:** `ChatThread.cliSession?: { providerId, modelId, sessionId, access, lastMessageId }` (optional, so it is safe in the shared DB).
- **Migration:** add a nullable `cli_session` JSON column to `chat_threads`. It is additive and never edited (CLAUDE.md §3.4.5).
- **Adapter:**
  - Claude Code's parser already sees the `system`/`init` and `result` events, which carry `session_id`. It surfaces them as a new `StreamChunk` `{ type: 'session', id }`.
  - `GenerateRequest.resumeSessionId?` adds `--resume <id>`.
  - Codex is the next candidate (`codex exec resume <id>`). Gemini has none, so it stays stateless.
- **Chat service.** It resumes only when all of these hold:
  - same provider, model and access level;
  - the thread has had no edit, delete or retry since `lastMessageId`;
  - the previous turn succeeded.

  Otherwise it starts fresh with today's flattened history. That is PandaCode's `context_recovery` idea, which ACE already has as its default path. The session ID is saved only after a successful turn (PandaCode's "acknowledge after success").
- **Invalidation.** Editing, deleting or retrying a message, changing model, provider or access level, or a reverted checkpoint all clear `cliSession`.
- **Tests:**
  - parser frame-replay with recorded Claude `init`/`result` frames;
  - the service resumes on an unchanged thread;
  - the service starts fresh after an edit.

### W2-2 (P1-5): steering a Claude Code chat turn

This builds on W2-1. Claude Code is launched with `--input-format stream-json --replay-user-messages`, so a follow-up typed during a turn is written to stdin and acknowledged by the echo (PandaCode `providers/steering.rs`). If no acknowledgement arrives within 15 s, or the provider can't steer, the message stays in the queue (W1-4).

This is a bigger change to `adapters/cli/runner.ts`, which today closes stdin after the prompt. **Effort L.**

---

## Wave 3: P2

| Item | Design sketch | Files | Effort |
|---|---|---|---|
| Approval gate node and condition node | Two node kinds. **New enum values** in `NODE_KINDS`: this needs the shared-DB story first, either a migration that older checkouts can't open, or retiring the older checkouts. A gate makes the node WAITING with an approval that carries the upstream envelope (D343 reuses WAITING). A condition routes on a JSON-path predicate over its input and marks the untaken branch's edges `cut` (W1-6's look). | `contracts/src/graph.ts`, `engine/src/runs/index.ts` (`isReady`, `blockDownstream`), `apps/web/src/nodes/*` | L |
| Per-node Stop | A per-node `AbortController` in the drive (Domain's `turnAbort` already exists), `POST /runs/:id/nodes/:nodeId/stop` → node STOPPED and its downstream BLOCKED; wire the unused `NodeRunActions` | `runs/index.ts`, `runs/control/*`, `apps/web/src/inspector/*` | M |
| Command palette | `cmdk` (already in the locked stack): nodes, runs, modes, actions (Run, Stop, Continue, Open in Forge), threads | `apps/web/src/app/CommandPalette.tsx`, `app/shortcuts.ts` | M |
| Find in thread | CSS Custom Highlight API over the chat transcript, as PandaCode's `thread-find.ts`: never rewrite the DOM | `apps/web/src/chat/*` | S |
| Git stage/commit/branch | Engine routes over a bounded git runner (the checkpoint store's runner rules, D300); a branch chip in the Forge header; stage and commit in Changes. Reverses the non-goal in `ide-workspace-design.md`. | `packages/tools` (git), `apps/server` routes, `apps/web/src/forge/*` | M |
| Browser preview | An iframe in Forge to a **loopback** URL only, plus an `ace-run` script convention the agents are told about (like `pandacode-run.sh`), and a readiness probe on 127.0.0.1 | `apps/web/src/forge/preview/*`, engine probe route | M |
| PTY terminal | `node-pty` in `packages/tools` behind the existing process supervisor; xterm already in web | `packages/tools/src/processes/*`, `apps/web/src/forge/terminal/*` | M |
| Parallel writers by declared scope | `workspace.writeScope?: string[]` (optional field); the drive lets writers with disjoint scopes run together instead of `writeTurns` (`runs/index.ts:792`); **checkpoints become path-scoped first** (git pathspec in the store), or undo mixes nodes; CLI nodes always take the whole-folder scope (they can't be confined, D383) | `contracts/src/agent.ts`, `runs/index.ts`, `checkpoints/*`, `tools/src/checkpoints/git-store.ts` | L |
| CLI permission prompts as ACE approvals | Claude `--permission-prompt-tool stdio` over stream-json input (shares W2-2's runner change); answers come from ACE's approval cards | `adapters/cli/*`, `engine/src/approvals/*` | L |
| ACE tools for CLI nodes | A per-run loopback MCP server (bearer token, Host check, Origin rejected, POST only, body caps: PandaCode `providers/mcp_host.rs`) exposing knowledge search, web search and ask-a-node | `packages/tools/src/mcp-host/*`, CLI dialect args | L |
| `limited_until` display | Parse the reset time only when a provider reports one; never guess | `providers/src/adapter.ts`, provider status UI | M |
| Frame-replay tests for CLI dialects | Record real Claude/Codex/Gemini stream frames from the installed CLIs and replay them through each dialect's parser | `adapters/cli/__tests__/fixtures/*` | S |

## Wave 4: P3 (future)

Each item is listed with what it needs first:

- **Opt-in worktree per run, with review and merge** (PandaCode's `merge_worktree`: refuse when dirty, abort on conflict, never force). Needs path-scoped checkpoints and the Git UI from Wave 3.
- **Dynamic fan-out node.** An architect node that spawns N worker turns through team tools, with file scopes. Needs Wave 3 scopes.
- **Conversation fork.**
- **GitHub hub.**
- **Webhook Input node.** ACE's version of bots.
- **Deploy templates.** A workflow plus a destructive-marked deploy tool, with credential scrubbing.
- **Warm processes.** Needs W2-1's launch key.
- **Token-saver styles.** Opt-in, per node.
- **Confined command runner.** D-083/D13 Docker, which is also where "cloud sandboxes" belong.

---

## Order and dependencies

```
Wave 1 (now)      W1-1 ─┐
                  W1-2 ─┼─ engine/chat ──┐
                  W1-5 ─┘ (+providers)   │
                  W1-3 ── engine/control ┼── merge → build/typecheck/lint/tests → live run
                  W1-4, W1-6, W1-7, web parts of W1-3/W1-5 ── web ┘
Wave 2 (decide)   W2-1 session resume ── W2-2 steering ── (W3) CLI permission prompts
Wave 3            per-node Stop · palette · find · git UI · preview · PTY · scoped checkpoints → parallel writers
Wave 4            worktree per run · fan-out node · …
```

## Acceptance criteria for Wave 1

1. **Read-only chat.** A Read-only agentic Claude Code node asked in chat to create a file does not create it, and the CLI is launched with `--permission-mode dontAsk` plus read tools.
2. **Usage estimate.** A chat turn on a provider that reports no usage shows non-zero tokens marked est.
3. **Continue.** A run with two parallel nodes, stopped mid-way, offers **Continue**. One click runs both interrupted nodes and their downstream; nodes that had completed keep their single attempt; the run ends COMPLETE with totals that include the first attempts.
4. **Chat queue.** Two chat messages sent back to back both show as waiting until their own replies land, and Stop stays until the last.
5. **Reasoning effort.** A node set to High sends `--effort high` to Claude Code, `-c model_reasoning_effort="high"` to Codex, and `reasoning: 'high'` to the AI SDK. With the setting at Default, nothing is sent: the call is identical to today's.
6. **Edges.** During a run, a delivered edge is solid, a waiting edge dim, a running source's edge animated, and a failed source's edge drawn as cut.
7. **Approve all.** It approves only the non-destructive approvals and leaves a destructive one pending.
8. **Gates:** `pnpm build`, `pnpm typecheck` and `pnpm lint` pass; the new and touched tests pass; the app launches and the changes are seen working in it.
