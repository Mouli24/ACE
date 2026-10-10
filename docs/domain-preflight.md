# Domain — pre-flight (Phase 0)

This is the read-only answer to the pre-flight questions P1–P7 in the Domain build prompt. Each answer cites the file, the function and the line numbers at origin/main `a023d45`, the base of branch `domain`. The decisions these answers led to are D303–D327 in `docs/DECISIONS.md`.

**Verdict.**
- **P1 is yes.**
- **P7 is a partial yes.** There is a kill path for a whole run, but not for a single turn. A scriptable fake provider exists.
- **Contradictions with the locked design.** Five answers contradicted it: there is no Brain, BLOCKED is terminal, cost source, no Code surface, and no handles. The owner settled each one on 2026-10-10: D304, D305, D306, D307, D308. Nothing is left open, so Phase 1 can start.

---

## P1. Is there an append-only event log per run?

**Yes.** The log is per workspace, and every run event carries its run id.

- **Table.** `packages/storage-local/src/schema.ts:95-114`, `events`, created in migration `20260921T120000_initial_schema` (`migrations.ts:117-127`). Columns:
  - `seq INTEGER PRIMARY KEY AUTOINCREMENT`
  - `workspace_id`
  - `type`
  - `workflow_id?`
  - `run_id?`
  - `payload` (JSON)
  - `created_at`

  The indexes are `(workspace_id, workflow_id, seq)` and `(workspace_id, seq)`. There is no `run_id` index yet; D314 adds one.
- **Port.** `packages/engine/src/ports/repository.ts:167-172`, `EventRepository` = `append`, `listAfter(scope, afterSeq, filter)` and `currentSeq`. Its doc comment says "Never updates or deletes".
- **Implementation.** `packages/storage-local/src/repository.ts:786-859`.
  - `append` is an insert … returning.
  - `listAfter` filters with `seq > afterSeq`, ordered by `seq`, with a `runIds` filter.
  - A grep of every `.delete(` in storage-local finds none on `events`.
- **Ordering.** `seq` is one global, monotonic number per workspace; there is no per-run sequence. That is enough for Domain, because a run's events filtered by `run_id` keep their order (D314 uses `seq` as the SSE id).
- **Emitter.** `packages/engine/src/events/index.ts:47-72`, `createEventBus`:
  - `emit` persists the event before it publishes it.
  - `emitTransient` publishes with `seq: 0` and never stores the event. `node.token` and `chat.token` are the only transient events.
- **Delivery to clients today.** The WebSocket hub, `packages/engine/src/events/ws-hub.ts:54-174`, takes `subscribe {scope: workflow|engine|thread}` and `resume {afterSeq}`. There is also REST `GET /runs/:id/events?afterSeq`, at `packages/engine/src/gateway/index.ts:618-637`.
- **No SSE anywhere** in the engine or the server.

## P2. The current envelope schema: a `kind` discriminator? A `to` field?

**No `kind`. There is a `toNodeId`, one per data edge. There is no human-written summary. No event carries an envelope.**

- **Schema.** `packages/contracts/src/envelope.ts:105-118`, `EnvelopeSchema`, a strict object:
  - `id`, `runId`, `fromNodeId`, `toNodeId`, `iteration`
  - `reads: Part[]`
  - `context { summary?, retrieved?, memory?, budgetTokens, trust }`
  - `contract { outputTypes, jsonSchema?, maxTokens? }`
  - `guardrailVerdicts?`, `createdAt`

  `context.summary` is the summariser's untrusted note about earlier work, not a message summary (D310 adds Domain's `summary` on the agent's block instead).
- **Built by:**
  - `packages/engine/src/envelopes/index.ts:208-239`, `buildEnvelope`.
  - `packages/engine/src/runs/index.ts:374-460`, `envelopeBetween`, used by:
    - `deliver` (942-991)
    - drive seeding (~1711)
    - `envelopesFor` (2177-2204)
- **Persistence.** There is no envelope table; envelopes are stored only as JSON in `node_runs.input_envelopes` (`schema.ts:248`). The closest event is `edge.transfer` (`contracts/src/events.ts:125-133`): `{runId, edgeId, fromNodeId, toNodeId, iteration, summary ≤ 120}`, emitted once per edge in `deliver` (977-989). Its `summary` is a part-kind string such as "text · ~120 tokens".

## P3. Events the run engine emits today, mapped to the DATA SHAPES

The source of truth is `packages/contracts/src/events.ts:284-364`. All of them are persisted except `node.token` and `chat.token`.

| Event today | Emitted at | Domain shape it feeds (D303) |
|---|---|---|
| `run.started {run}` | `runs/index.ts` `begin()` 2056, 2085 | system message "run started" |
| `run.completed {runId, status, haltReason?, totals, finalOutput?, budgetHalt?}` | `runs/index.ts` 1847, 2062, 1936; `control/service.ts:331`; `runs/lifecycle.ts:51` | system message; DROPPED is derived for anything still PENDING |
| `node.state {runId, nodeRunId, nodeId, iteration, attempt, status, failureReason?}` | `runs/index.ts` `emitNodeState` 345-365; `control/service.ts:164`; `apps/server/src/server.ts:448-468` | **TURN_STARTED** (RUNNING, + `trigger`) and **TURN_ENDED** (terminal, + `durationMs`) |
| `node.token {runId, nodeRunId, delta}` (transient) | `runs/executor.ts:743-757` | live PROGRESS text over SSE (never persisted) |
| `node.output {runId, nodeRunId, nodeId, output, usage, modelUsed?}` | `executor.ts:470`, `merge/index.ts:149` | the agent message's output (D327 text, expandable) |
| `node.error {…, error, failureReason}` | `executor.ts:427-440`, `runs/index.ts:1420` | TURN_ENDED FAILED detail |
| `edge.transfer {runId, edgeId, fromNodeId, toNodeId, iteration, summary}` | `runs/index.ts:977` | the delivery of a forwarded HANDOFF (+ `envelopeId`) |
| `usage.updated {runId, totals, dayTotals?}` | `runs/index.ts` 1122, 1808, 1890; `control/service.ts:323` | **USAGE** (+ `turn`) |
| `run.paused` / `run.resumed {runId}` | `control/service.ts:247/268` | system messages; `run.resumed` also ends a mid-run BLOCKED |
| `node.approval_required` / `node.approval_decided` | `approvals/index.ts:224/171` | system messages (WAITING on approval) |
| `guardrail.verdict {runId, nodeRunId, verdict}` | `guardrails/evaluator.ts:226/662` | system messages |
| `loop.iteration {runId, edgeId, targetNodeId, iteration, stop?}` | `runs/index.ts:1281` | system message |
| `tool.call {runId, nodeRunId, toolCall}` | `executor.ts:1162` | PROGRESS / the turn's `steps[]` |
| `message.created` (workflow timeline, no runId), `chat.message`/`chat.token` (direct-chat threads) | `chat/timeline.ts:122`, `chat/service.ts:179/279/422` | not part of a run, so not projected (Option A, below) |

**What is missing, and the new events that fill it (D303):**

| Missing | New event |
|---|---|
| HUMAN_MESSAGE | `human.message` |
| INSTRUCTION_STATE | `instruction.state` |
| ENVELOPE_SENT | `envelope.sent` |
| ENVELOPE_ROUTED | `envelope.routed` |
| BUDGET | `run.token_budget` |
| Run config | `run.config` |
| Mid-run BLOCKED | `run.blocked` |
| Partial output of an interrupted turn | `node.interrupted` |

## P4. How does each adapter start a second turn for the same node?

**It rebuilds the context, every time, for every adapter, including all three CLIs. Nothing resumes a CLI session.**

- **CLI adapters.**
  - `packages/providers/src/adapters/cli/adapter.ts:131-227`, `createCliAdapter`, spawns a fresh process per call through `cli/runner.ts:96-166`, `runCli`. The prompt goes in on stdin.
  - **Claude Code** (`cli/claude-code.ts:23-34, 240-246`): `claude -p --output-format stream-json --verbose --include-partial-messages --setting-sources "" --strict-mcp-config --permission-prompts none <preset> [--model] --append-system-prompt <system>`
  - **Codex** (`cli/codex.ts:22-28, 180-185`): `codex exec --json --skip-git-repo-check --color never --sandbox … [-m] -`
  - **Gemini** (`cli/gemini.ts:26-32, 190-195`): `gemini -o stream-json --skip-trust --approval-mode … [-m]`
  - None passes `--resume`, `--continue` or a session id. The parsers drop `session_id` and `thread_id` even though the recorded fixtures contain them.
  - `GenerateRequest` (`engine/src/ports/model-provider.ts:68-100`) has no session field.
- **HTTP adapters.** `providers/src/adapters/ai-sdk.ts:342-410` makes a stateless `streamText` call.
- **Every attempt rebuilds its prompt.** The executor calls `assemblePrompt` on each `execute()` (`runs/executor.ts:590-601`). Retries, reruns (`control/service.ts:375-410`) and loop iterations all get a fresh prompt from their envelopes.
- **Consequence for Domain.** The one clean way to deliver an instruction, with no assumption that a CLI accepts input mid-turn, is a new section in the next turn's rebuilt prompt: `## Human instructions` (D309, D311).

## P5. Does each node have a stable id and a role usable as a default handle?

**It has a stable id. It has no role.**

- **Id.** `packages/contracts/src/graph.ts:14-16`, `IdSchema` (Crockford ULID). The shared node fields are at 260-267.
- **Name.** `NodeNameSchema` (`graph.ts:28`) is 1–80 characters, **not unique**, and may contain spaces. Every new Agent is called "Agent" (`apps/web/src/nodes/factory.ts:89-98`).
- **No role and no handle field.** The web's `@Name` routing is client-side only (`apps/web/src/chat/mentions.ts:34-52`) and, with duplicate names, it picks the first match.
- **Settled by D308 and D324.** D308 adds a stored, unique `handle` that defaults to a slug of the name. D324 adds addressing by plain name, with duplicates refused.

## P6. Can the human resume a run that is in BLOCKED?

**No.** BLOCKED is reached only at pre-flight, and it is terminal.

- **The only write.** `runs/index.ts` `begin()` 2040-2073 is the only place a run becomes BLOCKED.
- **No way out except restart.** `allowedRunActions('BLOCKED') = ['restart']` (`contracts/src/runs.ts:71-92`), and restart creates a new run (`control/service.ts:347-373`).
- **Treated as ended.** `ENDED_STATES` (`runs/index.ts:306-310`) and `TERMINAL_RUN_STATES` (`contracts/src/events.ts:64`) treat it as finished.
- **Budgets end the run.** A USD budget halt is HALTED `budget_exceeded` (`engine/src/budgets/index.ts`, `runs/index.ts:1821-1859`), not BLOCKED.
- **Settled by D305.** It adds a resumable mid-run BLOCKED with a reason; BLOCKED at pre-flight stays terminal.

## P7. A kill path for an in-flight turn? A fake provider, and what can it script?

**Kill path: per run only.**

- **The chain.**
  1. `POST /runs/:id/stop` calls `controls.stop` (`runs/control/service.ts:279-345`).
  2. That calls `gate.stop()` and then `AbortController.abort()` (`runs/control/gate.ts:77-104`).
  3. `drive()` hands `gate.signal` to the executor (`runs/index.ts:525`, 1576-1594).
  4. The executor's `generateTurn` combines it with a timeout (`executor.ts:926-929`).
  5. For CLIs, `cli/runner.ts:50-63, 105-110` runs `killTree` (`taskkill /T /F` on Windows) and settles within `KILL_SETTLE_MS = 1500`. TC-CTL-003 (`runs/control/__tests__/stop-latency.test.ts`) asserts that this takes under 2 s.
- **Gaps:**
  - There is **no per-node or per-turn abort**: one gate per run (`runs/index.ts:1950-1952`).
  - A killed turn's partial output is not kept: `fail()` returns `output: []` (`executor.ts:442-449`).
  - A killed CLI turn records 0 tokens, because usage arrives only in `parser.finish`.
- **Settled by D309.** It adds a per-turn controller combined with the run's signal, keeps the partial output in `node.interrupted`, and estimates its usage.

**Fake provider: yes, three of them.**

1. **The run harness, best for engine gates.** `packages/engine/src/__tests__/run-driver-harness.ts`, `createRunDriverHarness`.
   - It runs the real run service, controls, gates and provider semaphore on a scripted adapter.
   - Scripts are keyed by node name: "Act as <name>." appears in the prompt.
   - A `Step` has `text`, `throws`, `usageFirst`, `hold` (held open until the signal aborts) and `afterFinish`.
   - Phase 2 widens `Step` to arbitrary chunks.
2. **The mock adapter.** `packages/providers/src/adapters/mock.ts`, with 27 fixed models (`mock-text`, `mock-slow`, `mock-timeout`, `mock-json`, the tool users, and others).
   - Output is deterministic per prompt hash.
   - There is no per-call scripting; D315 adds `mock-script`.
3. **The fake CLI.** `packages/providers/src/adapters/cli/__tests__/fixtures/fake-cli.mjs`.
   - Modes include `echo-stdin`, `replay` (plays back a JSONL file), `hang`, `hang-with-child` and `print`.
   - Recorded real Claude Code 2.1.282 output: `claude-plain.jsonl`, `claude-read-tool.jsonl`.

---

## The D285 node chat sessions, and how Domain uses them (Option A)

The owner asked whether Domain should extend the D285 per-node chat sessions instead of building something parallel.

**What D285 has**
- **Storage.** `chat_threads` (one node per thread, `ChatThread.nodeId`) and `chat_messages`:
  - `role: user|agent`, `content`, `verdicts`
  - `usage`, including the cost a CLI reports
  - `runId`, `error`, `modelId`

  (`packages/contracts/src/chat.ts:110-152`)
- **Sending.** `POST /nodes/:id/chat` answers 202. The reply streams as `chat.token`, then `chat.message` is stored (`packages/engine/src/chat/service.ts:438-510`, `generateReply` 242-370).
- **Prompt.** A `## Conversation` section, trimmed newest-first to the node's token budget (`chat/prompt.ts:52-132`).
- **Guardrails** on input and output.
- **Failed turns** are stored and never replayed.
- **Run results in chat.** `recordRunTurn` (526-585) writes a graph run's goal and result into the node's latest thread.
- **Web.** The Chat column (`apps/web/src/chat/ChatAside.tsx`, `useChat.ts`, `session-store.ts`) has:
  - a session per node in zustand;
  - a thread list;
  - a composer with an `@` picker over node names;
  - a streaming bubble.

**What it lacks for Domain**
- **More than one participant.** `chat()` refuses a thread owned by another node (`ChatThreadNodeMismatchError`), and a message records no speaker node.
- **Server-side addressing.** There is none. The client's `@Name` only switches the column to that node's own session.
- **Agent-to-agent messaging.** There is none.
- **A run.** This is by design: FR-CHAT-005 and D285 say direct chat never reads or writes runs. `generateReply` calls the adapter directly, so a chat turn has:
  - no node run and no run events;
  - no snapshot;
  - no tools;
  - no project folder (a CLI runs read-only in a temp folder);
  - no cancel and no budget;
  - and its spend is missing from `/usage`.

**Decision: Option A (owner, 2026-10-10).** The Chat column stays the quick one-node chat, unchanged. Domain's turns are node runs through the existing executor, so the event log, usage, budget, snapshot, replay, tools and cancellation all apply. Domain is projected from run events, with no shared chat store (D1, D303).

From D285, Domain reuses:
- the web composer's `@` picker pattern;
- the message bubble (`@ace/ui` `MessageBubble`), where it fits.

The D285 bridge `recordRunTurn` keeps writing graph-run results into node sessions, as it does today.
