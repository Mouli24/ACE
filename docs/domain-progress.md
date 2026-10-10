# Domain — build progress

Domain is the team-chat view of a run. This file is the resume point: read it first in a new session.
- Design: the owner's build prompt of 2026-10-10, with decisions D303–D327 in `docs/DECISIONS.md`. D317–D322 are withdrawn.
- Pre-flight answers: `docs/domain-preflight.md`.

## Conventions (and where they differ from the build prompt)

- **Branch.** `domain` (the owner named it), in worktree `D:\ACE offcl\wt\domain`, off origin/main `a023d45`. The prompt said `feat/domain`.
  - One commit per phase, Conventional Commits with D-numbers. Nothing is pushed.
- **Gates follow CLAUDE.md §7.** Every phase gate records real `pnpm typecheck`, `pnpm lint` and `pnpm test` output. Tests run with zero env vars on the fake provider (the run-driver harness, the mock adapter, `mock-script`).
- **Live-only work.** Anything that needs a real CLI lives in `scripts/live/` and never runs in `pnpm test`.
- **Captured CLI output.** It goes in `packages/providers/src/adapters/cli/__tests__/fixtures/cli-output/`, not the prompt's root `fixtures/cli-output/`, because the parser tests import it from there (D316).
- **Ownership.** `apps/web/**` and `packages/sdk/**` are Mouli's paths (CLAUDE.md §3.2). With one developer (§6.3), and on the owner's instruction, Domain edits them here.

## Status

| Phase | State | Commit | Gate |
|---|---|---|---|
| 0 Pre-flight | done | e3138fa | docs only; baseline below |
| 1 Projection core | done | 2785cdf | green — see Phase 1 |
| 2 Human → node | done | e86808f | green — see Phase 2 |
| 3 Node → node | done | a732df2 | green — see Phase 3 |
| 4 Usage, cost, budget | done | (this commit) | green — see Phase 4 |
| 5 Domain surface | not started | — | — |

## Phase 0 — pre-flight

**Done**
- Worktree and branch created; `pnpm install`; packages built.
- `docs/domain-preflight.md`: P1–P7 with evidence, plus the D285 analysis and Option A.
- `docs/DECISIONS.md`: D303–D327 appended.
- `docs/defect-log.md`: D-093 (the CLI adapters don't scrub the environment).

**Baseline at a023d45, before any Domain code** (pre-existing failures, so later gates aren't blamed for them):

- `pnpm --filter "./packages/**" build`: exit 0.
- `pnpm typecheck`: exit 0.
- `pnpm lint`: exit 0.
- `pnpm test`, the stock parallel `pnpm -r test`: **the engine package crashed, not failed.** Its vitest workers ran out of memory: V8 "Committing semi space failed" (exit 134), and Windows `STATUS_COMMITMENT_LIMIT` (3221225773) while several packages forked about 16 workers each at once on this 16-thread, 16 GB machine. Before pnpm stopped it, 96 of 97 files and 1518 of 1524 tests had passed; none failed on an assertion. This is a property of the machine, not of the code.
- **Gate command from here on:** `pnpm -r --workspace-concurrency=1 --no-bail test`. One package at a time, all green, exit 0:

| Package | Files | Tests |
|---|---|---|
| contracts | 24 | 1095 |
| engine | 102 | 1561 |
| sdk | 11 | 135 |
| ui | 13 | 316 |
| web | 109 | 868 |
| context | 4 | 52 |
| guardrails | 18 | 357 |
| providers | 21 | 437 + 1 skipped + 3 todo |
| storage-local | 19 | 301 |
| tools | 25 | 190 + 1 skipped |
| server | 26 | 158 |

## Phase 1 — projection core

**Done**

- **Contracts.** `packages/contracts/src/domain.ts` holds:
  - **Roster and handles (D308):** `rosterFor`, `slugHandle`, the reserved handles `brain` and `all`.
  - **One addressing parser for the server and the composer (D324, D326):** `parseAddressing` returns the recipients and the matched spans. `resolveAddressing` gives the final recipients and the Brain fallback, enforces the `@all` rules, and applies `exclude`.
  - **Schemas:** every Domain event payload, `DomainMessage`, `DomainUsageSnapshot`, the HTTP bodies, the SSE frames, and `PricingTable`.
- **Additive changes to existing contracts:**
  - `Node.handle` and `NodePatch.handle`; `AgentConfig.brain`.
  - `node.state` gains `trigger` and `durationMs`; `usage.updated` gains `turn`; `edge.transfer` gains `envelopeId`.
  - `UsageSchema` gains `source`, `costSource` and `cachedTokensIn`.
  - `Envelope.teamEnvelopeId`.
  - `Run.blockedReason` and `Run.domain`; `StartRunRequest` gains `goal` and `domain`.
  - The `end` run action, with `allowedRunActions(status, {blockedReason, stayOpen})`.
  - Nine new run event types, each with a trace kind.
- **Engine.** `packages/engine/src/domain/`:
  - `projection.ts`: one incremental fold, run events → messages + chat ops. It also tracks node states, activity, per-turn usage and the budget.
  - `project-chat.ts`: `projectChat` and `filterForNode`.
  - `project-usage.ts`: `projectUsage`, `usageSnapshot`.
  - `pricing.ts`: D306 cost order.
  - `context.ts`: the run's roster and node names, from its snapshot.
  - Exported from `@ace/engine`.
- **Script.** `scripts/replay-transcript.ts` (`--list`, `--run`, `--node`, `--usage`, `--check`, `--json`). It reads the engine database read-only and runs the same projection.
- **Kept compiling because of the new run action and event types:**
  - `runs/control/actions.ts`: the actions now read the run's blocked reason and stay-open flag. `end` is "ended".
  - The web Events tab and its mock trace word the nine Domain events.
  - The SDK has `endRun`.
  - The web run controls have an End button. It shows only when the engine allows `end`.

**Tests-first note.** For the contracts, the tests were written first and seen red: 4 of 32 addressing tests failed, and 12 of 21 domain tests. The engine projection was written **before** its tests, which breaks the rule for that module. To check that its 37 tests are meaningful, I injected three mutations: dropping the DROPPED derivation, always reporting outcome OK, and ignoring `to` in `filterForNode`. Each turned tests red.

**Fixture coverage.** These are the cases the prompt asks for, in `engine/src/domain/__tests__/`:
- a plain run;
- a handoff chain (and a pre-Domain one);
- a direct instruction (PENDING → DELIVERED → DONE, streamed as updates);
- an interrupted turn;
- mixed reported + estimated usage;
- a missing price (null, never 0, never the catalog's);
- a handle collision (`@review-2`, lens isolation).

In contracts: the owner's eight addressing cases, word for word.

**Gate 1 evidence**

- `pnpm typecheck`: exit 0.
- `pnpm lint`: exit 0.
- `pnpm -r --workspace-concurrency=1 --no-bail test`: exit 0, all green.

| Package | Tests (baseline → now) |
|---|---|
| contracts | 1095 → **1166** |
| engine | 1561 → **1599** |
| sdk | 135 |
| ui | 316 |
| web | 868 |
| context | 52 |
| guardrails | 357 |
| providers | 437 + 1 skipped + 3 todo |
| storage-local | 301 |
| tools | 190 + 1 skipped |
| server | 158 |
- **Real recorded run replayed:** `pnpm exec tsx scripts/replay-transcript.ts --run 01M48JE9J9F6VEPF2T9Q4NTYXR --usage --check` (the 2026-10-06 "Tagline face-off", 7 nodes):

```
Run 01M48JE9J9F6VEPF2T9Q4NTYXR · COMPLETE · started 2026-10-06T12:19:00.808Z
Roster: @gemini-copywriter (Gemini copywriter) · @openai-copywriter (OpenAI copywriter) · @judge (Judge)
45 events → 16 messages

[12:19:02] — Run started.
[12:19:02] Brief turn (dispatch, attempt 1) OK 0.0s: "Write a punchy one-line tagline for ACE: …" [auto]
[12:19:02] Brief → @gemini-copywriter  HANDOFF: "Write a punchy one-line tagline for ACE: …" [auto]
[12:19:02] Brief → @openai-copywriter  HANDOFF: "Write a punchy one-line tagline for ACE: …" [auto]
[12:19:02] @gemini-copywriter turn (dispatch, attempt 1) OK 128.1s: "Draw your AI workflows. Compare multiple models side-by-side, locally." [auto]
[12:19:02] @openai-copywriter turn (dispatch, attempt 1) OK 1.3s: "ACE: Draw. Connect. Run AI models side by side—locally." [auto]
[12:19:03] @openai-copywriter → Merge both  HANDOFF: "ACE: Draw. Connect. Run AI models side by side—locally." [auto]
[12:21:10] @gemini-copywriter → Merge both  HANDOFF: "Draw your AI workflows. …" [auto]
[12:21:10] Merge both turn (dispatch, attempt 1) OK 0.0s: "{"inputs":[…" [auto]
[12:21:10] Merge both → Side by side  HANDOFF: … [auto]
[12:21:10] Side by side turn (dispatch, attempt 1) OK 0.0s: "Option A (Gemini): … Option B (OpenAI): …" [auto]
[12:21:10] Side by side → @judge  HANDOFF: … [auto]
[12:21:10] @judge turn (dispatch, attempt 1) OK 8.7s: "{"final_tagline":"ACE: Draw your AI workflows — …","reason":"B wins because …" [auto]
[12:21:19] @judge → Verdict  HANDOFF: … [auto]
[12:21:19] Verdict turn (dispatch, attempt 1) OK 0.0s: … [auto]
[12:21:19] — Run COMPLETE.

Usage: in 917 · out 1841 · cached 0 · estimated 0% · cost —
  @gemini-copywriter    COMPLETED in     232 out   1340 reported  done
  @openai-copywriter    COMPLETED in     232 out     16 reported  done
  @judge                COMPLETED in     453 out    485 reported  done

Check — what Track shows that this transcript does not:
  node runs: all 7 are narrated.
  usage.updated ×8: shown in the team panel (--usage), not as messages
```

**What Track shows that the transcript is missing.** From replaying four real runs: the 7-node COMPLETE run above, a HALTED run with retries and blocked nodes, a Claude Code coding run with CLI tool calls, and a run BLOCKED at pre-flight.

1. **Pre-flight issues of a run BLOCKED at pre-flight.** They are on the run row (`preflightIssues`), not in any event. Track lists them (`provider_missing` ×2 on run `01M4HYKY5R6R67APRZ8G7VN4GS`); the transcript can only say "Run BLOCKED at pre-flight." **Fix in Phase 2:** `run.completed` carries the issues when it is BLOCKED, and the projection words them.
2. **Cost of runs from before Domain.** Track shows the catalog price (or Claude Code's reported cost). Domain shows "—", because those rows carry no `costSource` and `ace.pricing.json` is empty. This is by design (D306); runs recorded after Phase 4 carry `costSource`.
3. **`usage.updated`.** Shown in the team panel, not as messages, by design.
4. **The node-name label of a handoff into a non-addressable node** (Merge, Output). It is narrated by its name, not a handle; there is nothing to fix.
5. **Fixed while replaying:**
   - CLI tool steps carried the whole result (a file's full text). A step is now one line of at most 120 characters, with a test.
   - The check counted never-started BLOCKED node runs as missing, though they are narrated as system lines.

## Phase 2 — human → node

**Done**

- **The message endpoint.** `POST /runs/:runId/messages` (`engine/src/domain/{service,routes}.ts`).
  - Parse and resolve use the shared contracts parser. Any refusal is a 400 `validation_failed` with `details.errors` (an `AddressingError[]`), and **zero events are written**.
  - A run that has ended, or is closing, is a 409 `invalid_run_state`.
  - A message is one `human.message` (final recipients in `mentions`) and one `instruction.state` PENDING per recipient. Both are written under the run's lock, so a message can never land after the drive has decided to close.
- **Routing (D304, D324–D326).**
  - Names and `@handles` reach only those nodes.
  - `@all` reaches the nodes that haven't finished, rides their next or first turn, and never starts one.
  - A message with no address goes to the Brain; with no Brain designated it is 400 `no_brain`.
  - `exclude` subtracts matched recipients; an entry that wasn't a match is a 400.
- **Per-run live state (`domain/run-domain.ts`, `domain/registry.ts`).**
  - It holds the per-node queues and each turn's own `AbortController`.
  - It provides the wake-up a parked drive waits on, `requestEnd`, and `close`, which DROPs everything still pending.
  - It is rebuilt from the run's event log when a run is driven again, so pending messages survive a restart.
- **Delivery (D309) in `runs/index.ts`.**
  - A node with nothing in flight (COMPLETED, FAILED, STOPPED, BLOCKED) gets an `instruction` turn at once.
  - An IDLE, READY or PAUSED node carries the message into its first dispatch.
  - A busy node gets it on its next turn; automatic retries pick up what arrived meanwhile.
  - A further turn is a new node run at the same iteration, attempt + 1 (attempts tracked per node and iteration, seeded from recorded rows).
  - DELIVERED is emitted when the turn goes RUNNING, and DONE when it ends.
- **Interrupt.**
  - The turn's own abort fires with `{domain: 'interrupt', messageId}`.
  - The executor keeps the streamed text as `partialOutput` and estimates usage (chars ÷ 4, `source: 'estimated'`).
  - The drive records the row with the partial output, emits `node.interrupted` and then STOPPED, and hands nothing on. Nothing downstream is blocked and no chat turn is written.
  - The cut-short turn's messages go back to PENDING and ride the next turn.
- **Re-turns (D309).** A turn started by a message, or a node completing an iteration again, hands off a *fresh* envelope.
  - It replaces that sender's earlier envelope, including merge arrivals.
  - Its COMPLETED or BLOCKED successors run again; a successor busy at that moment runs again once its turn ends.
  - Loop decisions are skipped for non-dispatch turns.
- **Park, End, restart (D323).**
  - A run started with `domain.stayOpen` parks when it has nothing in flight. The run stays RUNNING, and `run.parked {graph: complete|failed}` is said once per idle spell.
  - **End** (`POST /runs/:runId/end`, run action `end`) cuts the turns in flight, DROPs what is pending, and ends the run COMPLETE when the graph's finish line is complete, else HALTED `failure`. A turn End cut short leaves its node's state as it was before the turn.
  - **Engine restart:** `recoverAfterCrash({keepOpen})` re-opens such runs. Their in-flight turns end FAILED with code `crash` (`node.error` + `node.state`). `RunService.resumeOpenRun` drives them again from their rows and log, and they park at once.
  - Board-started runs complete normally. A board run closes under the lock when idle, so a message after that is a 409.
- **Goal and config (D312).**
  - `StartRunRequest.goal` and `.domain` are stored on the run (new columns).
  - `run.config` and the goal (as `human.message` with addressing `goal`) are recorded at start.
  - With no inputs given, Input nodes get the goal. Restart copies both.
- **Prompt (D311).** `## Team goal` and `## Human instructions` (`prompts/team.ts`) come after `## Instructions`, only when they have content. `DOMAIN_PROMPT_VERSION` joins the hash only then, so every existing prompt is byte-identical.
- **Controls.**
  - Stop DROPs pending messages before its `run.completed`.
  - Rerun and retry on a RUNNING, PAUSED or parked run are a 409. This closes the double-drive hazard; it is a deliberate change to one round-3 test (`service.test.ts`), per D309.
  - `allowedActions` carry `end` for runs that stay open.
- **Graph (D304, D308).** `update_node` sets or clears (`null`) a handle. A batch is refused when its finished graph has a duplicate or reserved handle (`domainGraphIssues` in contracts) or a second Brain.
- **Storage.** Migration `20261010T120000_domain`:
  - `nodes.handle`, `node_runs.trigger`, `runs.blocked_reason/domain/goal`, and the index `events_run_idx`.
  - `listActive` now includes a run BLOCKED mid-run with a reason.
- **Gate 1 gap 1 fixed.** `run.completed` for a run BLOCKED at pre-flight carries `preflightIssues`, and the projection words them.

**Implementation details worth knowing** (within D303/D323; not new decisions):

- `run.parked` is a tenth Domain event. D323 needs the parked state to be visible in the conversation, and no event existed for it.
- A plain dispatch's RUNNING frame carries no `trigger`, so existing frames are unchanged; the projection reads "absent" as `dispatch`.
- The run harness's scripted model now declares JSON output, so a JSON-contract node can be scripted into a CONTRACT_VIOLATION.

**Gate 2 evidence** (`engine/src/domain/__tests__/domain-delivery.test.ts`, 22 scenarios on the scripted provider; plus `domain-surface-p2.test.ts`, the storage round-trip and the server wiring test):

| Gate item | Test |
|---|---|
| An idle node runs immediately | "a node that is not busy gets a turn now" (PENDING → DELIVERED → DONE) |
| A busy node gets it on its next turn | "a busy node gets the instruction on its next turn, not the one already running" |
| Interrupted → INTERRUPTED, never handed off | "an interrupted turn keeps its partial output, is INTERRUPTED and never handed off" |
| Run end drops pending | "run end drops pending instructions" (DROPPED before `run.completed`) |
| Fan-out to two nodes | "a fan-out to two nodes reaches both" |
| CONTRACT_VIOLATION node gets a fresh turn | "an instruction to a node that ended in CONTRACT_VIOLATION starts a fresh turn" |
| Instruction to A never in B's or the Brain's prompt | "an instruction to one node never appears in another node's prompt, or the Brain's" |
| Unaddressed reaches the Brain only | "an unaddressed message reaches the Brain only" |
| `exclude` removes; a non-match is 400 with zero events | two tests |
| `@all` on a 3-node chain (running → next turn, pending → first turn, finished skipped) | "mid-run on a chain: …" |
| `@all` all finished → 400 `all_finished`, zero events | yes |
| `@all` + interrupt → 400, zero events | yes |
| Domain run parks, RUNNING, zero calls while parked | "parks instead of completing …" |
| Naming a finished node while parked → turn, successors re-run, parks again | yes |
| End → COMPLETE, pending → DROPPED | yes |
| Board run completes normally | yes |
| Restart: parked run continues; in-flight → FAILED crash | "after an engine restart a parked run carries on …" |
| HTTP: 201 / 400 with suggestions / 409 after End / 501 without Domain | `domain-surface-p2.test.ts` |
| Real engine over HTTP (park → message → End) | `apps/server/src/__tests__/domain-wiring.test.ts` |

**Gate 2 run** (`pnpm --filter "./packages/**" build`; `pnpm typecheck`: exit 0; `pnpm lint`: exit 0; `pnpm -r --workspace-concurrency=1 --no-bail test`):

| Package | Tests |
|---|---|
| contracts | 1166 |
| engine | 1632 (1599 at Gate 1; +33 Domain) |
| sdk | 135 |
| ui | 316 |
| web | 868 |
| context | 52 |
| guardrails | 357 |
| providers | 437 + 1 skipped + 3 todo |
| storage-local | 303. On the first run, 7 older migration tests failed: they pin the exact list of migrations applied after theirs, and those lists now end with the Domain migration. Fixed by appending it; re-run 303/303. |
| tools | 190 + 1 skipped |
| server | 159 (+1, `domain-wiring.test.ts`) |

**Deliberate changes to existing tests**, each following from a decision:
- `service.test.ts` "leaves a run that is already RUNNING where it is" now asserts the D309 409.
- The `lifecycle` and `crash-recovery-approvals` tests expect the new `reopened: []` in the recovery result.
- The migration-list tests include the Domain migration.

## Phase 3 — node → node

**Done**

- **Envelope blocks (D310), `engine/src/domain/envelope-block.ts`.**
  - `extractEnvelopeBlocks` takes every fenced ```` ```ace-envelope ```` block out of an answer. Other fences, and an answer with no block, are left exactly as they were.
  - `judgeEnvelopeBlocks` checks each block against the team and the graph. Any refusal is a CONTRACT_VIOLATION, with the reason handed to the single contract-repair retry:
    - not JSON, or not a valid envelope (the reason names the field);
    - an unknown handle (with the closest ones), `@all`, or the sender itself;
    - a HANDOFF to a node the sender does not feed (the reason lists the ones it does);
    - an ANSWER with no `inReplyTo`, with no QUERY open to this node, or not back to the asker;
    - a turn that sends a QUERY or a FLAG and also a HANDOFF;
    - a turn that was handed a QUERY and does not answer it.
  - The executor takes the blocks out before the JSON parse, so a JSON node can write them too and its contract judges only what is left. The summaries then pass through the output point (with no contract) and are secret-masked.
- **The Brain's router (D304, D310), `engine/src/domain/brain.ts`.**
  - Every envelope is announced (`envelope.sent`) and routed `by: 'brain'` (`envelope.routed`). That covers the blocks an agent wrote and the implicit HANDOFF of an answer that wrote none (`textSource: 'auto'`, the 280-character excerpt).
  - Supervised mode forwards with no model call. Manual mode holds every envelope.
  - A forwarded HANDOFF travels the edges as before; its `edge.transfer` and edge envelope carry the team envelope's id. A forwarded QUERY, FLAG or ANSWER waits for each recipient's turn and reaches its prompt under `## Team messages`.
- **The loop guard (D305, D310).**
  - QUERY and FLAG envelopes are counted per unordered pair. The one over `loopGuardLimit` is HELD with reason `LOOP_GUARD`.
  - The run goes BLOCKED: the gate is paused, the row gets `blockedReason: 'LOOP_GUARD'` and actions `[resume, stop]`, and `run.blocked` names the pair.
  - Resume clears the reason, resets that pair's count, and forwards what the guard held (`by: 'human'`, reason "released by resume"). To drop it instead, reject it before resuming.
- **QUERY and ANSWER.**
  - The asker's node run ends WAITING (Track agrees). Its next turn closes that row COMPLETED and reads the ANSWER.
  - The addressee gets a turn at once, even before the graph has dispatched it.
  - If the addressee's turn fails, the Brain answers for it: an ANSWER note (`textSource: 'auto'`, "@x could not answer: …") is sent to the asker, so it never waits for ever.
- **FLAG.** The flagging turn hands nothing on. The flagged node gets a turn with the FLAG, and its revised output is a fresh HANDOFF (D309), so what it feeds runs again.
- **The human's decision (D310).** `POST /runs/:runId/envelopes/:id/route` with `{ decision: approve | reject | edit, reason?, edit? }`:
  - **approve** forwards it;
  - **edit** forwards the edited version. `envelope.sent` keeps the original and `envelope.routed` (EDITED) carries the edit, so both versions are logged, and the projection shows the original beside the edit. An edit is checked as a block is: known handles, not the sender, a HANDOFF only to nodes the sender feeds. A QUERY or ANSWER keeps its kind;
  - **reject** drops it, and tells the sender why as a message addressed to it (trusted, in its `## Human instructions`).
  - Errors: 400 for a bad decision or edit, 404 for no such envelope, 409 once it has been routed or the run has ended. A refusal writes nothing.
  - The server wires it (`apps/server`). A board run with an envelope held for the human waits for the decision instead of closing.
- **Prompt (D311), `prompts/team.ts`.** `DOMAIN_PROMPT_VERSION` is now `ace-domain-2`. Each section appears only when it has content:
  - `## Team`: one line per addressable node (handle, name, Brain, you — never another node's instructions), plus the envelope format in six lines. Only when there are two or more.
  - `## Team messages`: each envelope as `[KIND id] from @x: summary`, its body quoted with `> `. It is labelled as information from other agents, not instructions (BR-13). A QUERY says how to answer it.
  - `## Envelope digest`: the Brain's prompt only, one line per envelope routed so far.
- **Restart (D323).**
  - `DomainRegistry.open` rebuilds the envelope state from the log: what is held, forwarded envelopes that no turn has taken yet (with their bodies), open QUERYs, the loop counts (a resume after LOOP_GUARD resets its pair) and the Brain's digest.
  - A run re-opened while BLOCKED mid-run or PAUSED starts with its gate held, as it was.

**Implementation details worth knowing** (within D310; not new decisions):

- **Side turns.** An envelope turn that only answers QUERYs, or that reaches a node the graph hasn't dispatched yet, is a side turn.
  - It hands nothing on unless it writes an explicit HANDOFF, and the node goes back to the state it was in.
  - A failure there blocks nothing downstream.
  - Without this, a QUERY to a node that hasn't run would make it hand off before its inputs arrive.
- **An explicit HANDOFF also feeds non-addressable successors**, an Output or a merge, which no block can name.
- **`envelope.sent` carries no artifact refs (`artifacts: []`).** D307's ref has a `bytes` size field, and FR-MM-004's guard (server `D-082 …` test) refuses any `"bytes":` key in the event log. Gate 3's first run caught exactly that.
  - The projection reads a HANDOFF's files off its turn's `node.output` instead: new test "a HANDOFF's files come from its turn's output …".
  - D307 and the guard both stand unchanged.
- **Envelope deliveries emit no `instruction.state`.** They show on the RUNNING frame's `trigger.envelopeIds`. `instruction.state` stays the human messages' delivery record.
- **A turn that took an envelope and then crashed has used it.** The envelope isn't handed out again after a restart. A crashed asker's WAITING row ends FAILED `crash`, but its QUERY stays open, so the ANSWER still gives it a turn.

**Gate 3 evidence** (`engine/src/domain/__tests__/domain-envelopes.test.ts`, 13 scenarios on the scripted provider; `envelope-block.test.ts`, 13 pure; `team-prompt.test.ts`, 5; `registry-restore.test.ts`, 5; server `domain-wiring.test.ts` +1):

| Gate item | Test |
|---|---|
| A reviewer FLAG reaches the writer, and the writer's revised HANDOFF completes | "a reviewer FLAG reaches the writer, and the revised HANDOFF completes the run" |
| A QUERY gets an ANSWER linked by `inReplyTo` | "a QUERY gets an ANSWER linked by inReplyTo while the asker waits" (frames `1:WAITING` → `1:COMPLETED` → `2:RUNNING`) |
| Forced ping-pong → LOOP_GUARD → BLOCKED | "ping-pong past the limit holds the envelope and blocks the run; resume carries on" |
| A malformed envelope → CONTRACT_VIOLATION | "a malformed envelope is a CONTRACT_VIOLATION, repaired once with the reason"; "a HANDOFF to a node it does not feed fails the node …" |
| A manual-mode edit is forwarded, and both versions are logged | "an edited envelope is forwarded as edited, and both versions are logged" |
| Reject → dropped, and the sender told why | "a rejected envelope is dropped, and its sender gets a turn with the reason" |
| The addressee fails → the asker gets a note | "an addressee that cannot answer sends the asker a note …" |
| An `@` in prose or code triggers nothing (D324) | "a handle written in prose or code addresses nobody" |
| The Brain digest | "the Brain reads a digest of what was routed …" |
| Restart keeps what is held | "what is held, and what is forwarded but not yet taken, survive an engine restart"; `registry-restore.test.ts` |
| HTTP 200 / 400 / 404 / 409 | "POST /runs/:runId/envelopes/:id/route"; real engine: "manual routing holds the handoff until the human approves it over HTTP" |

**Gate 3 run** (`pnpm build`, `pnpm typecheck`, `pnpm lint`: exit 0; `pnpm -r --workspace-concurrency=1 --no-bail test`: exit 0):

| Package | Tests |
|---|---|
| contracts | 1167 (+1) |
| engine | 1669 (1632 at Gate 2; +37 Domain) |
| sdk | 135 |
| ui | 316 |
| web | 868 |
| context | 52 |
| guardrails | 357 |
| providers | 437 + 1 skipped + 3 todo |
| storage-local | 303 |
| tools | 190 + 1 skipped |
| server | 160 (+1, `domain-wiring.test.ts`) |

The first full run had one failure: server `D-082 stores the real PNG/MP3/MP4/ZIP mock-media …`. Its FR-MM-004 guard found `"bytes":` in the event log, which came from the artifact refs the first cut put on `envelope.sent`. Fixed as described above, and the re-run was all green. No existing test was changed in this phase.

## Phase 4 — usage, cost, budget

**Step 1: real CLI output, captured.** `scripts/live/capture-usage.ts` was written and run (live; it never runs in `pnpm test`).

How it runs each CLI: exactly as its adapter does. Same dialect arguments, stdin, environment, read-only preset and throwaway folder.

What it saves: raw stdout, to `packages/providers/src/adapters/cli/__tests__/fixtures/cli-output/<type>-tiny.jsonl`, scrubbed before writing:
- the home folder becomes `<HOME>`, the throwaway folder `<CWD>`, and the user name `<USER>`;
- anything key-shaped is masked.

The prompt was "Reply with exactly the word: ok".

| CLI | Installed | Captured | Where its output reports usage |
|---|---|---|---|
| Claude Code 2.1.282 (`haiku`) | yes | `claude_code-tiny.jsonl`, 16 lines, exit 0 | The final `result` event: `usage.input_tokens` 10, `cache_read_input_tokens` 4,570, `cache_creation_input_tokens` 4,808, `output_tokens` 35, and `total_cost_usd` 0.011222. The same `usage` shape also rides `message_start`, each `assistant` message and `message_delta`. |
| Codex CLI | no | skipped | unknown — never seen |
| Gemini CLI | no | skipped | unknown — never seen |

What the capture also showed:
- **Two token counts, one cost.** Claude Code's `result.modelUsage` counts every model call of the session, including one the CLI makes on its own (909 uncached input and 48 output, against `usage`'s 10 and 35). `total_cost_usd` is that whole session's cost.
  - ACE reads the tokens from `result.usage`, as it already did, so Track's numbers do not move (D313).
  - So for Claude Code the reported cost covers a little more than the tokens shown. See "Later".
- **D-093 evidence.** The CLI's `init` event says `entrypoint: "claude-vscode"`: it inherited the VS Code terminal's environment. It also lists the user's installed skills despite `--setting-sources ""`. Recorded against D-093, not fixed here.

**Step 2: the usage parsers (D313).**
- **Claude Code** reads `result.usage` and `total_cost_usd`, which the captured output confirms. It now also reports `cachedTokensIn`, the cache reads, only when there were any.
- **Codex and Gemini** are estimated-only.
  - Their parsers read no usage field, because none has been seen in real output, and yield no usage chunk.
  - Codex's turn still completes on `turn.completed`.
  - Their two "reports usage" tests were changed deliberately, per D313.
- **The AI SDK adapters (HTTP providers)** report the SDK's `totalUsage` and its `inputTokenDetails.cacheReadTokens`. A stream with no usage at all yields no usage chunk instead of a reported 0.
- **The port's usage chunk** gains `cachedTokensIn?`.
- **The executor estimates** when a provider that answered reported nothing.
  - Characters ÷ 4 on the prompt and on what it wrote, `source: 'estimated'`, on the node run, so Track and Domain agree.
  - A provider-reported cost is marked `costSource: 'reported'`.
- **`usage.updated` carries `turn`** for every agent or model turn: `{ nodeRunId, nodeId, providerType, modelId, usage }`, with the provider type from the provider row and the resolved model id when the provider names one.

**Step 3: `ace.pricing.json` (D306), `apps/server/src/pricing.ts`.**
- It ships empty: a data folder without the file gets `{ "models": [] }`.
- It is re-read whenever its mtime changes, so an edit needs no restart.
- A file that cannot be read, or doesn't match the shape, prices nothing and logs the reason once per version.
- Domain uses it through `GET /runs/:runId/usage`. A turn's cost there is the provider's reported cost, else this table, else `null`.

**Step 4: the budget (D7, D305, D313), `engine/src/domain/budget.ts` and the drive.**
- Counts input + output, cached included.
- `run.token_budget` WARN once at 80 % and EXCEEDED once at 100 %. A turn that jumps past both says EXCEEDED alone.
- At 100 %: no new turn starts, turns in flight finish, and the run goes BLOCKED `BUDGET_EXCEEDED`.
- `PUT /runs/:runId/budget { limit | null }` records `run.token_budget` SET and writes the run's `domain.tokenBudget`. A new limit's thresholds start fresh.
  - Raising the limit above what was used, or removing it (`null`), resumes the run through the controls' resume.
  - Lowering it under what was used blocks the run at once.
- A plain resume while still over blocks again at once, calling nothing. End still ends a blocked run.
- `GET /runs/:runId/usage` serves the usage snapshot, for an ended run too. CORS allows PUT.
- After a restart, the limit, what was used and which thresholds were said come back from the run row and the log.

**Implementation details worth knowing** (within D306/D313; not new decisions):
- **Only what differs is written.** `source` is written only as `estimated`: absent means reported, which is what every usage before Domain was. `costSource` is written only as `reported`, and `cachedTokensIn` only when above 0. So no existing usage row or test changes shape.
- **A call that failed before answering is not estimated.** There is nothing to count, so it keeps what the provider reported, if anything. The estimate is for a call that answered without saying what it used.
- **Test-first gap.** The pricing loader's tests were written with the module rather than run red first. Mutation-checked instead: a loader that never re-reads fails two tests, and one that doesn't ship the file fails one.

**Gate 4 evidence:**

| Gate item | Test |
|---|---|
| Parsers green against the captured fixtures | `claude-code.test.ts` "reads the tokens, the cached input and the cost the CLI reported" (`cli-output/claude_code-tiny.jsonl`), "counts cache reads as cached input …"; `codex.test.ts` / `gemini.test.ts` "reports no usage (D313)"; `http-adapters.test.ts` "a stream that reports no usage …", "carries the cached prompt tokens …" |
| The estimate fallback, and Track = Domain | `domain-usage.test.ts` "a provider that reports nothing: the turn is estimated …", "a reported turn keeps the provider's own numbers …" |
| Reported → pricing file → null (D306) | `domain-usage.test.ts` "reported cost, a missing price shown as null, and an estimate once the price is added" |
| Budget thresholds | `budget.test.ts` (5, pure); `domain-budget.test.ts` "warns once at 80 %", "at 100 % no new turn starts, the turn in flight finishes, and the run is BLOCKED", "raising the budget … resumes", "a resume while still over blocks again …", "lowering the budget … blocks a parked run, and End still ends it" |
| HTTP | `domain-budget.test.ts` "200 with the usage snapshot; 400 a bad limit; 409 once the run has ended"; real engine: `domain-wiring.test.ts` "serves the usage snapshot, takes a budget, and ships an empty ace.pricing.json" |
| Restart | `registry-restore.test.ts` "the limit the run had, what it has used, and which thresholds were said", "a limit set after the budget was exceeded starts fresh" |
| The pricing file | `pricing.test.ts` (3) |

**Provider → usage source:**

| Provider type | Tokens | Cost in Domain |
|---|---|---|
| `claude_code` | **reported**: `result.usage`, verified against captured 2.1.282 output | **reported**: `total_cost_usd` |
| `codex_cli` | **estimated-only** (not installed, never captured) | `ace.pricing.json` estimate, else — |
| `gemini_cli` | **estimated-only** (not installed, never captured) | `ace.pricing.json` estimate, else — |
| `anthropic`, `openai`, `google`, `openai_compatible`, `ollama` (AI SDK) | **reported** by the SDK's `totalUsage`; **estimated** when a stream carries none | `ace.pricing.json` estimate, else — (no reported cost) |
| `mock` | **reported** (word counts) | `ace.pricing.json` estimate, else — |

**Gate 4 run** (`pnpm build`, `pnpm typecheck`, `pnpm lint`: exit 0; `pnpm -r --workspace-concurrency=1 --no-bail test`: exit 0, first run):

| Package | Tests |
|---|---|
| contracts | 1167 |
| engine | 1685 (1669 at Gate 3; +16) |
| sdk | 135 |
| ui | 316 |
| web | 868 |
| context | 52 |
| guardrails | 357 |
| providers | 441 + 1 skipped + 3 todo (+4) |
| storage-local | 303 |
| tools | 190 + 1 skipped |
| server | 164 (+4: `pricing.test.ts` 3, `domain-wiring.test.ts` +1) |

**Deliberate changes to existing tests**, per D313: `codex.test.ts` and `gemini.test.ts` no longer expect a usage chunk, because both providers are estimated-only.

## Open decisions

None. The five contradictions pre-flight found were settled by the owner on 2026-10-10: D304, D305, D306, D307, D308.

## Later (not in this build)

- **Claude Code's cost covers a little more than its tokens.** `total_cost_usd` prices the whole session, which `result.modelUsage` counts: it includes a call the CLI makes on its own (909 uncached input tokens against `usage`'s 10 in the capture). ACE shows `usage` (D313: Track's numbers do not move) beside the reported cost. If the two should match, read the tokens from `modelUsage` instead. That is an owner's call, because Track's numbers would move.

- **Debate** isn't implemented, and no debate fields are added. When it is built, its turns must be exempt from the loop guard, bounded by their own round limit instead, and grouped in Domain by debate id and round.
