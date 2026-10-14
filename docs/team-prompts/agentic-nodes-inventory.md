# Agentic Nodes: Phase 0 inventory

Answers the 13 questions of `agentic-nodes-prompt.md`, against `main` at c83a0bb (2026-10-14). Paths are repo-relative. No behaviour was changed.

**Headline.** Much of what the prompt asks for already exists, built under X1 (D260–D266), D299–D302 and D334–D339:

- agent nodes already run a tool loop through guardrails and approvals;
- seven project tools exist, including `run_command`;
- Forge has a file watcher, conflict bar, checkpoints with Keep/Revert, a terminal panel, a live agent badge and gutter attribution.

Phases 1–3 are therefore mostly **gap-filling on existing seams**, not new modules. Four of the prompt's locked-spec defaults (C1, C4, C5, C6) do not match the repo or its decisions, and D302 conflicts with the proposed default access level. These are listed under §13 and must be decided before Phase 1 code.

---

## 1. Node execution path

1. **Run button.**
   - The button is `apps/web/src/forge/editor/PathBar.tsx:150` and calls `useStartRunFlow` (`apps/web/src/runs/useStartRunFlow.ts:37`).
   - That calls `useStartRun` (`apps/web/src/runs/hooks.ts:83`), which calls `api().startRun` (`packages/sdk/src/client.ts:469`).
   - The request is `POST /api/v1/workflows/:id/runs`.
2. **Route.** `packages/engine/src/gateway/index.ts:658` parses `StartRunRequestSchema` and calls `runs.beginRun` (D65: it answers 201 after pre-flight).
3. **Run service.** `createRunService` is at `packages/engine/src/runs/index.ts:388`.
   - `begin()` (:2974) writes the run row and the frozen `snapshot` in one transaction (:3131–3155, BR-04), then runs `runs/preflight.ts`.
   - `drive()` (:601) schedules from `run.snapshot`.
   - Envelopes are built in `envelopeBetween` (:451), which calls `buildEnvelope` (`packages/engine/src/envelopes/index.ts:208`).
4. **Executor.** `createNodeExecutor` is at `packages/engine/src/runs/executor.ts:428`.
   - `executeAgent` (:527) runs, in order: context hook, `assemblePrompt`, `router.resolve` with a fallback chain, then `attemptWith`.
   - The model call is `generateTurn` (:950), which calls `adapter.generate(req, signal)` (:977).
   - Adapters come from the model gateway (`packages/engine/src/models/gateway.ts`, wired at `apps/server/src/server.ts:462`).
5. **Output.**
   - Success: `succeed()` (:485) emits `node.output`. Failure: `fail()` (:439) emits `node.error`.
   - `node.token` is transient and batched every 50 ms.
   - The `node_runs` row is updated by the scheduler.
   - D285: `handTurnToChat` (`runs/index.ts` ~1383) calls `chatService.recordRunTurn` (`packages/engine/src/chat/service.ts:844`).
6. **Brain (D304).** It is not a dispatcher.
   - `packages/engine/src/domain/brain.ts` is a pure envelope router (`routeEnvelope`: FORWARDED or HELD, loop guard).
   - A designated agent (`AgentConfig.brain`, `@brain`) hears unaddressed messages.
   - Nodes are dispatched by the graph scheduler.
7. **Existing tool loop.** `executor.ts:846–1213`.
   - `for(;;)` calls `takeTurn`, which calls `generateTurn`.
   - Every `tool_call` of a turn runs in order through `runToolCall` (:1056), which does:
     1. registry check;
     2. `guardrails.beforeTool` (`ToolGuardStep` allow/block/reject, `runs/tool-loop.ts:118`; `ask_user` means `approvals.request`);
     3. `registered.run(args, { runId, sandboxDir, signal, projectDir })`;
     4. `judgeToolResult` (context-point sanitising);
     5. `recordToolCall` plus the `tool.call` event.
   - Results go back as `toolResults` and are labelled `UNTRUSTED_TOOL_RESULT_LABEL` (`tool-loop.ts:162`).
   - Tools are offered only when `catalogRow.supportsTools !== false` (:755).
8. **Per-node tools.**
   - The config is `node.config.tools = { enabled: string[], maxToolCalls: 0..50, allowedDomains }` (`packages/contracts/src/graph.ts:175`). `DEFAULT_MAX_TOOL_CALLS = 10` (:135).
   - The offered set is the `enabled` names found in the registry (`executor.ts:663`).
   - The registry is `createBuiltinTools` (`packages/tools/src/builtins/factory.ts:39`), 13 tools: `echo`, `code_sandbox`, `sandbox_delete`, `http_request`, `web_search`, `web_fetch`, `list_files`, `read_file`, `write_file`, `edit_file`, `git_status`, `git_diff`, `run_command`. MCP tools are added on top.
9. **Limits.**
   - `toolCallLimit = min(tools.maxToolCalls, policy max_tool_calls)` (`executor.ts:658`; `toolCallCapOf` in `guardrails/evaluator.ts:631`).
   - At the cap, one more turn runs without tools. A further tool call fails the node with `agent/tool_call_limit`.
   - **There is no "max turns" setting and no per-step token budget**; there is a run-level token budget (D313).

## 2. Providers

`PROVIDER_TYPES` (`packages/contracts/src/enums.ts:81`); factory at `packages/providers/src/factory.ts:44`.

| Type | Wire format | Tool calling | Streaming |
|---|---|---|---|
| `anthropic` | Anthropic Messages via `@ai-sdk/anthropic` | yes | yes |
| `openai` | Chat Completions (`provider.chat`, `openai.ts:41`); Responses API **not** used | yes | yes |
| `google` | Gemini `v1beta` via `@ai-sdk/google` | yes | yes |
| `openai_compatible` | Chat Completions (`openai-compatible.ts:71`) | yes | yes |
| `ollama` | the openai-compatible adapter with a default base URL | yes | yes |
| `claude_code` | CLI child process, `--output-format stream-json` | **no ACE tools** — its own, as `activity` chunks logged as `cli_<tool>` ToolCalls | yes |
| `codex_cli` | CLI child process, `exec --json` | same as `claude_code` | yes |
| `gemini_cli` | CLI child process, `-o stream-json` | same as `claude_code` | yes |
| `mock` (+ `mock-rag`, `mock-media`) | in-process | scripted (`requestTool`, `mock.ts:648`: `mock-tool`, `mock-tool-loop`, `mock-destructive`, `mock-sandbox`, …); `mock-script` (D315) is text-only | yes |

- **Shared API adapter.** The five API types share `createAiSdkAdapter` (`packages/providers/src/adapters/ai-sdk.ts:342`).
  - `streamText`, tools offered without `execute` (`toToolSet`, :279).
  - `continuationMessages` (:305) rebuilds the tool-call/result messages.
  - `maxRetries: 0`.
- **Capability flags.** `ModelSchema.contextWindow` and `ModelSchema.supportsTools` exist (`packages/contracts/src/models.ts:36–37`; table columns `context_window` and `supports_tools`).
  - The manifest sets `supportsTools` per entry.
  - **Discovered models default to `contextWindow 8192, supportsTools false`** (`ai-sdk.ts:39`), so every Ollama model is offered no tools today (see D-095's sibling: llava and embedding models are mis-typed too).
- **Thinking/reasoning blocks: not handled.** There is no reasoning chunk type and no `providerMetadata` passthrough, so thinking blocks are dropped between tool turns. This is the `provider_opaque` gap.
- **Stream port.** `StreamChunk` (`packages/engine/src/ports/model-provider.ts:131`) has the types text, json, tool_call, part, usage, activity, model, finish. `GenerateRequest` (:68) has `tools` and `toolResults`.

## 3. Send to Forge

- The button is `apps/web/src/chat/ChatConversation.tsx:146–155` (`data-testid="chat-send-to-forge"`).
- Its handler is `apps/web/src/chat/ChatAside.tsx:150–153`: `navigate(workflowPath(projectId, workflowId, 'forge'))`.
- **It only changes the route.** It makes no SDK call, no engine route is hit, and no content is carried. Nothing is written.

## 4. Forge workspace

- **Root.** `Project.folderPath` (`packages/contracts/src/graph.ts:60`), typed into a text field (`apps/web/src/projects/ProjectDialogs.tsx`).
  - The engine reads it in `folderOf()` (`packages/engine/src/workspace/service.ts:85–90`).
  - Runs receive it as `projectDir` (`executor.ts:1128`).
  - It is one root per project; nothing requires it to be a git repo.
- **File API.** `packages/engine/src/workspace/routes.ts`, base `/projects/:id/files`:
  - `GET tree | content | raw | list | status | sources`
  - `PUT content` (save, hash-checked, answers 409 `file_changed`, D299)
  - `POST entries | move | search`
  - `DELETE entries`
  - The fs adapter is `packages/tools/src/workspace/fs-files.ts` (atomic write).
  - SDK methods: `packages/sdk/src/client.ts:815–871`.
- **Change detection.** `packages/tools/src/workspace/watcher.ts` (`watchProject`) uses recursive `fs.watch` with a 100 ms debounce.
  - It is active only while a WS client subscribes to the `project` scope.
  - It emits a transient `files.changed` event, with a `resync` on bursts.
  - Client: `apps/web/src/forge/files/project-socket.ts` invalidates queries.
  - Buffers: `apps/web/src/forge/editor/useEditorSync.ts`, with `ConflictBar.tsx` offering Compare / Take theirs / Keep mine.
- **Git.**
  - The `git` binary is spawned; there is no simple-git.
  - `packages/tools/src/builtins/git.ts:38` `runGit` hardens it: `core.fsmonitor=false`, `GIT_TERMINAL_PROMPT=0`, a timeout and an output cap. `git_status` and `git_diff` are read-only.
- **Checkpoints (D300).** A private bare repo per project at `<dataDir>/checkpoints/<projectId>.git` (`packages/tools/src/checkpoints/git-store.ts:26–38`).
  - Refs are `refs/ace/<id>/before|after`, author `ACE <ace@localhost>`.
  - It **never touches the project's own `.git`**.
  - `begin`/`finish` are in `packages/engine/src/checkpoints/service.ts:299`, called per run (`runs/index.ts:2919`) and per writing chat turn (`chat/service.ts:400`).
  - Routes: `/projects/:id/checkpoints` (list, get, diff, `actions` keep/revert).
  - **No code runs `git add`/`git commit` against the user's repo; there is no stage-commit convention.**
- **Hooks/signing.** Irrelevant today, since nothing commits to the user repo.
- **Editor lock.** There is none: the main editor (`apps/web/src/forge/editor/EditorHost.tsx`) is writable during runs. D300 replaced the lock.
- **Already built.**
  - Terminal panel (`apps/web/src/forge/terminal/`, xterm, processes list, trust notice, D301).
  - Changes view with "Recording…", Keep/Revert all (`apps/web/src/forge/changes/ChangesView.tsx`).
  - Pulsing agent badge in the Explorer (`FileTree.tsx:493–512`).
  - Gutter attribution bars from `tool.call` writes (`EditorHost.tsx:73–78`, `forge/attribution.ts`, D334).

## 5. Engine → UI events

- **Transport.** WebSocket `/ws` (`packages/contracts/src/ws.ts:21`; hub `packages/engine/src/events/ws-hub.ts`). The only SSE is `GET /runs/:runId/chat/stream` (Domain, D314).
- **Events** (`packages/contracts/src/events.ts:325–379`):
  - **Run** (persisted, `seq`): `run.*`, `node.state`, `node.output`, `node.error`, `node.approval_required`, `node.approval_decided`, `tool.call`, `envelope.sent`, `envelope.routed`, … (`node.token` is transient).
  - **Thread:** `chat.message`, `chat.token`.
  - **Engine:** `provider.status`, `mcp.status`, `kb.ingest`, `memory.updated`.
  - **Project** (transient): `files.changed`, `process.output`, `process.exited`, `checkpoint.updated`.
- **Naming.** `domain.verb`, snake_case.
- **Subscribing.** `WS_SCOPES = ['workflow','engine','thread','project']`. Client frames are `subscribe`/`unsubscribe`/`resume {afterSeq}`. SDK: `createAceSocket` (`packages/sdk/src/socket.ts:72`).
- **Consequence for the prompt.** The prompt's `fs.changed`, `cmd.*`, `node.tool_call`, `node.tool_result`, `approval.*` overlap existing names: `files.changed`, `process.*`, `tool.call`, `node.approval_required`/`_decided`. Extend those rather than adding parallel ones.

## 6. State

- **Machines.** `packages/engine/src/runs/machines/index.ts` uses XState v5 `createMachine`, "transcribed from Arch §19.1 and §19.2".
  - Node: IDLE READY RUNNING WAITING COMPLETED PAUSED STOPPED BLOCKED FAILED.
    - `RUNNING → WAITING` (ASK_USER), `WAITING → RUNNING` (APPROVE), `WAITING → FAILED` (REJECT).
  - Run: PREFLIGHT RUNNING PAUSED COMPLETE BLOCKED HALTED.
    - D305 adds RUNNING → BLOCKED mid-run.
  - **The machines are only exercised in `__tests__/machines.test.ts`; the scheduler sets state strings directly.**
- **Lifecycle document.** `docs/ARCHITECTURE.md` §19 (line 734).
- **Approvals.** `createApprovalService` (`packages/engine/src/approvals/index.ts:134`; `request` :199 sets WAITING).
  - Table `approvals` (`packages/storage-local/src/schema.ts:374`).
  - Routes `GET /runs/:id/approvals`, `POST /node-runs/:id/approve`, `POST /node-runs/:id/reject` (`approvals/routes.ts`).
- **Written once.** `runs.snapshot` (`schema.ts:207`, inserted at `repository-runs.ts:366`) and `price_tables`.
- **Append-only.** `events` (AUTOINCREMENT `seq`), `tool_calls` (`schema.ts:439`), `guardrail_verdicts`.
- **Updated.** `node_runs`, which is created per attempt/iteration and then updated.

## 7. Handoff envelope

- `EnvelopeSchema`, a strict object (`packages/contracts/src/envelope.ts:114`):
  - `id`, `runId`, `fromNodeId`, `toNodeId`, `iteration`
  - `reads: Part[]`
  - `context { summary?, retrieved?, memory?, budgetTokens, trust }`
  - `contract { outputTypes, jsonSchema?, maxTokens? }`
  - `guardrailVerdicts?`, `createdAt`, `teamEnvelopeId?`
- It is built as a typed literal in `buildEnvelope` and never `parse`d at runtime. Output is checked by `validateAgainstContract` (`envelope.ts:279`).
- **There is no `workspace` block.** `contracts/src/workspace.ts` exists but the envelope does not use it.
- Team envelopes (D310, `ace-envelope` blocks, `EnvelopeSentPayloadSchema.artifacts: { path, bytes, commit }`) are separate.

## 8. Engine auth

- All in `packages/engine/src/gateway/index.ts`: `bearerToken` :193, `isOriginAllowed` :208, `originGuard` :250, `authGuard` :284 (`deps.auth.verifyToken`).
- They are applied with `app.use('*', …)` at :432–435.
- Feature routers mount with `api.route('/', createXRoutes(...))` (:846–867), which **inherits auth and the Origin check automatically**.
- WebSocket: the Origin is checked at `apps/server/src/server.ts:1119`, and the token in `ws-hub.ts:165`.

## 9. Process spawning today

- **`killTree(pid)`** is at `packages/tools/src/sandbox/runner.ts:40–57`: `taskkill /pid N /T /F` with `windowsHide`, or `process.kill(-pid)` on POSIX. Test: `kill-tree.test.ts`.
  - The CLI runner has its own copy (`packages/providers/src/adapters/cli/runner.ts:48–53`).
- **Sandbox.** `ChildProcessSandbox.run` (`sandbox/runner.ts:66`): no shell, scrubbed env, `windowsHide`.
- **`run_command`** (`packages/tools/src/builtins/run-command.ts`):
  - shell `cmd.exe /d /s /c` or `/bin/sh -c`;
  - **env is the full `process.env`, unscrubbed (:79)**;
  - cwd is inside the project;
  - timeout 120 s, max 600 s;
  - abort calls `killTree`;
  - `destructive: true`, so the default policy asks on every call;
  - there are **no background processes** and no `command_output`/`kill_command`.
- **Terminal runner.** `packages/tools/src/process/runner.ts`: `scrubSecrets` env (:125), `killTree`, at most 8 processes per project (D301).
- **Shutdown.** `apps/server/src/server.ts:1192` calls `runs.shutdown()`, `workspace.stopAll()`, `processes.stopAll()`, closes WS, closes sqlite.
- **Git Bash detection: none.**

## 10. DECISIONS

- File: `docs/DECISIONS.md`. The row format is `| D<n> | title | decision | affects | date | who |`.
- **Last used: D339.**
  - D267–D284 are reserved for `ace/parity` and D292–D298 for `feat/desktop-shell` (`ide-workspace-design.md:6–7`).
  - **Next free: D340.**
- **D-083** (defect, CLOSED) said `python`/`shell` sandbox code had no filesystem confinement without Docker. It was closed by **D288**: `code_sandbox` runs JavaScript only. D288 also states "`run_command` is unchanged: it is not sandboxed and already asks on every call (D266)".
- **Decisions this feature must respect:**
  - D266 — project tools; `run_command` asks every call.
  - D299 — Forge; hash-checked saves.
  - D300 — checkpoints in a private store; this **replaces the editor lock**.
  - D301 — terminal: supervised processes, scrubbed env, trust level.
  - D302 — a node chat works in the project folder; **API nodes get the six non-destructive tools, never `run_command`**.
  - D334 — agent badge and gutter bars from `tool.call`.
  - D339 — Explorer CHANGES.

## 11. UI tokens

- There is no `ACE-UI-redesign-prompt.md`. The implemented theme is "Ace UI" (D328; `ACE-UI-inventory.md` at the repo root).
- Tokens:
  - `packages/ui/src/tokens.ts` (`STATUS_RING`, `PROVIDER_ACCENT`, `THEME_COLORS`, accent `#ef6b3f`);
  - `packages/ui/src/theme.css` (the `livePulse` keyframe at :202, `LIVE_PULSE_CLASS` in `packages/ui/src/components/status.tsx:16`);
  - `apps/web/src/theme/constants.ts:209` `AGENT_COLORS = ['#ef6b3f','#7a62d6','#1f97a3']` with `agentColor(i)`, which is the node colour.

## 12. ACE Bench

- It is not built: FRS §3.20 (BEN), Phase 13, rounds 6+ (CLAUDE.md §9.2).
- The only code is `resolveForBench` (`packages/engine/src/ports/model-router.ts:64`, enforcing FR-RTR-007 fixed routing).
- **Versioning (spec):**
  - FR-BEN-004 records workflow and prompt snapshots and the build version.
  - Arch §12.5: prompts are versioned and node runs record versions.
  - **Arms (spec):** FR-BEN-003 ("experiments with tasks, arms and a repetition count"); OI-04 (third arm) is open.
- **There is no single-agent baseline arm anywhere.** C3's constraint can only be written down as a requirement on the future Bench, not checked.

## 13. Locked-spec conflicts

| # | Prompt says | What the repo says | Status |
|---|---|---|---|
| C1 | Keep the editor read-only during runs | FR-GIT-004, TC-GIT-002, BR-09 and US-030 did say it, but **D300 replaced it** with conflict-aware editing (Compare / Take theirs / Keep mine), and the editor is writable during runs today | **Contradicts D300 — stop condition.** Proposed: follow D300 and drop the lock; the prompt's "Keep mine" bar already exists (`ConflictBar`) |
| C2 | Envelope = reads + bounded context + contract | Confirmed: ADR-008 (locked), Arch §12.4, glossary. BR-02's actual text is "envelopes only; raw history never passed" | OK. Workspace reads are already logged per call in `tool_calls` |
| C3 | "Outer loop beats a single agent's inner loop" thesis | The wording is in no spec. The nearest is PRD:306 "prove whether orchestration beats simpler setups" and Arch G5. Bench is unbuilt | Record as a requirement for the future Bench; nothing to check now |
| C4 | Records written at **node dispatch** | BR-04 and ADR-009: **one snapshot at run start** (`runs.snapshot`); `events` and `tool_calls` are append-only; `node_runs` is mutable | **Wording wrong.** Proposed: per-node settings are already in the run snapshot; new facts (approvals, commands, commit/checkpoint ids) go to append-only tables or events, never the snapshot |
| C5 | Add `awaiting_approval` as an XState state | **WAITING already is that state** (Arch §19.1: RUNNING→WAITING ask_user → APPROVE/REJECT), and approvals already use it. The XState machines exist but the scheduler doesn't drive them | **Adding a new state would duplicate WAITING.** Proposed: reuse WAITING and the existing approval service |
| C6 | Extend the "stage-commit" convention with per-node commits in the workspace repo | There is **no stage-commit convention**. The spec has FR-GIT-001/002 (project is a git repo; a commit after each node that changes files; Phase 12, rounds 6+). **D300 deliberately keeps checkpoints in a private store that never touches the user's `.git`** | **Contradicts D300 — stop condition.** Committing to the user's repo is a product change |

**Other conflicts the prompt didn't list:**

- **D302 and the access default.** D302 gives API nodes in chat "never `run_command`", and D266/BR-14/FR-GRD-006 require approval for destructive tools. The prompt's "Full auto" (no approval except the denylist) **contradicts BR-14**, and the default "Edit + commands" for new nodes reverses D302.
- **Tool names and argument shapes.** The existing tools use camelCase (`oldString`, `newString`, `replaceAll`). The prompt asks for snake_case (`old_string`). Renaming breaks recorded `tool_calls` and the mock scripts. Proposed: keep the existing names.
- **Event names.** See §5: extend `files.changed`, `process.*`, `tool.call` and `node.approval_*` rather than adding `fs.changed`, `cmd.*`, `node.tool_call` and `approval.*`.

## What is genuinely missing (the real work, once the conflicts are decided)

1. A read-before-edit **content-hash rule** on `write_file`/`edit_file`, plus a per-path write mutex. `edit_file` today has no hash check and doesn't preserve CRLF explicitly.
2. A **`search`** tool (a content search route exists, `POST /files/search`; it is not exposed as a tool). The path guard must be hardened for Windows: UNC, `\\?\`, ADS, device names, junction realpath. `assertInsideProject` exists; its coverage needs checking.
3. **`run_command`:**
   - env allowlist (it is unscrubbed today, unlike the terminal's `scrubSecrets`);
   - Git Bash on Windows;
   - `stdin: 'ignore'`;
   - background processes with `command_output`/`kill_command`, tracked per run;
   - streamed output (`process.output`);
   - compound-command classification for allowlist and denylist;
   - a per-node "always allow" prefix.
4. Command-made change detection and attribution (`git status` before and after, plus the existing watcher). Tool writes are already attributed via `tool.call`.
5. A per-node **access level** that maps onto `tools.enabled`, **max turns** (today: `maxToolCalls ≤ 50`, counted per call), and a per-step token budget.
6. **Thinking-block round-tripping** (`provider_opaque`) in `ai-sdk.ts` continuations, and correct `supportsTools`/`contextWindow` for discovered models, which today default to false/8192, so no Ollama model gets tools.
7. Context elision at ~70 % of the context window.
8. An envelope `workspace` block (needs a contracts change).
9. UI: the access selector in node settings; a node card sub-status; **Open in Forge** to replace the route-only Send to Forge; approval cards for commands in the Terminal panel; per-node Revert (via D300 checkpoints).
