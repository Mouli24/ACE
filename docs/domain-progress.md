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
| 2 Human → node | done | (this commit) | green — see Phase 2 |
| 3 Node → node | not started | — | — |
| 4 Usage, cost, budget | not started | — | — |
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

## Open decisions

None. The five contradictions pre-flight found were settled by the owner on 2026-10-10: D304, D305, D306, D307, D308.

## Later (not in this build)

- **Debate** isn't implemented, and no debate fields are added. When it is built, its turns must be exempt from the loop guard, bounded by their own round limit instead, and grouped in Domain by debate id and round.
