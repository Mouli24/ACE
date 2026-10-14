# Debate — build progress

Debate is debater nodes arguing a topic over a few rounds, then a judge whose verdict flows downstream like any node output. This file is the resume point: read it first in a new session.
- **Design:** the owner's build prompt of 2026-10-14 (DB1–DB13, locked), with decisions D340–D359 in `docs/DECISIONS.md`.
- **Pre-flight answers:** `docs/debate-preflight.md`.
- **Plan:** approved 2026-10-14; Phases 0–5, with a hard stop after Phase 2.

## Conventions (and where they differ from the build prompt)

- **Branch.** `feat/debate`, in worktree `D:\ACE offcl\wt\debate`, off origin/main `c83a0bb`.
  - One commit per phase, Conventional Commits with D-numbers. Nothing is pushed. The upstream is unset, so a stray `git push` cannot reach `main`.
  - Never build or test in `wt/forge3`: the owner runs ACE from it.
- **Gates follow CLAUDE.md §7, with the Domain build's command.** The stock parallel `pnpm -r test` runs out of memory on this machine (`docs/domain-progress.md`, Phase 0). The gate is:
  `pnpm --filter "./packages/**" build && pnpm typecheck && pnpm lint && pnpm -r --workspace-concurrency=1 --no-bail test`.
  - Tests run with zero env vars, on fakes only.
- **Live-only work** goes in `scripts/live/` and never runs in `pnpm test`.
- **Ownership.** `apps/web/**` and `packages/sdk/**` are Mouli's paths (CLAUDE.md §3.2). With one developer (§6.3), and on the owner's instruction, Debate edits them here, as Domain did.
- **`bench/`.** CLAUDE.md §4 reserves it for a later round. `bench/debate/` is created because the owner's brief names it (Phase 2).
- **Prettier:** `--config packages/config/prettier.config.js` (there is no root config).

**DB → decision mapping**

| Brief | Decision |
|---|---|
| DB1 debate is one node | D340 |
| DB2 debaters are real nodes | D341 |
| DB3 protocol | D342 |
| DB4 stateless turns, bounded context | D343 |
| DB5 anti-conformity contract | D344 |
| DB6 anonymity | D345 |
| DB7 judge | D346 |
| DB8 never writes to the workspace | D347 |
| DB9 built-in baseline | D348 |
| DB10 stopping | D349 |
| DB11 failures and violations | D350 |
| DB12 Domain | D351 |
| DB13 events are the source of truth | D352 |

**Decided during planning:**
- Node states: D353.
- Owner's choices: D354 (budget estimate), D355 (guardrails), D356 (drawer over Ideate).
- Repo names: D357.
- Log additions: D358.
- Scratch folder, read-only: D359.

**Renames (brief → repo)**, D357:

| Brief | Repo |
|---|---|
| `debate.round.started` | `debate.round_started` |
| `debate.turn.started` | `debate.turn_started` |
| `debate.turn.delta` | `debate.turn_delta` (transient, D358) |
| `debate.turn.completed` | `debate.turn_completed` |
| `debate.turn.failed` | `debate.turn_failed` |
| `debate.turn.violation` | `debate.turn_violation` |
| `debate.instruction.delivered` | `debate.instruction_delivered` |
| `debate.round.completed` | `debate.round_completed` |
| (not in the brief) | `debate.control` (D358) |
| debate hub node type | node kind `debate` |
| role "debater" | `AgentConfig.debater?: {stance?, reads?}` |
| participant edge | edge kind `participant` |
| `HubConfig` | `DebateHubConfig` |
| `DebaterConfig` | `DebaterConfig` (unchanged) |
| `Verdict` | `DebateVerdict` (`Verdict` is the guardrail type) |
| 400 `debate_finished` | 400 `validation_failed`, `details.errors[].code: 'debate_finished'` |
| judge call ids | `judge`, `judge-openings` (D358) |

## Status

| Phase | State | Commit | Gate |
|---|---|---|---|
| 0 Pre-flight | done | 7db5412 | docs only; baseline below |
| 1 Debate engine (headless) | done | (this commit) | green — see Phase 1 |
| 2 Falsification script, then STOP | todo | | |
| 3 Canvas and run engine | todo | | |
| 4 Domain | todo | | |
| 5 Debate drawer | todo | | |

## Phase 0 — pre-flight

**Done**
- Worktree and branch created; `pnpm install`; packages built.
- `docs/debate-preflight.md`: Q1–Q10 with evidence.
- `docs/DECISIONS.md`: D340–D359 appended.

**Baseline at c83a0bb, before any Debate code** (so later gates aren't blamed for pre-existing failures). All green on 2026-10-14:
- `pnpm --filter "./packages/**" build`: exit 0.
- `pnpm typecheck`: exit 0.
- `pnpm lint`: exit 0.
- `pnpm -r --workspace-concurrency=1 --no-bail test`: exit 0.

| Package | Files | Tests |
|---|---|---|
| contracts | 29 | 1256 |
| engine | 126 | 1866 |
| sdk | 16 | 167 |
| ui | 13 | 278 |
| web | 186 | 1636 |
| context | 4 | 52 |
| guardrails | 18 | 357 |
| providers | 21 | 447 + 1 skipped + 3 todo |
| storage-local | 24 | 319 |
| tools | 42 | 382 + 4 skipped |
| server | 32 | 191 |

## Phase 1 — the debate engine (headless)

**Done**

- **`packages/contracts/src/debate.ts`:**
  - the schemas: hub config, debater config, turn, verdict, stats;
  - the 13 event payloads, plus `debate.failed` (D358: a hub that ends without a verdict);
  - the limits;
  - the pure fold `createDebateFold` / `foldDebates` / `foldDebate` (D352).
  - The events are appended to the run-event union, with the delta transient. The trace-kind map files each one as a `run_event`.
- **`packages/engine/src/debate/`:**
  - `runner.ts`: protocol, stopping, failures and repair, budget, guardrails, controls;
  - `prompts.ts`: the templates verbatim;
  - `contract.ts`: `lastJsonBlock`, the turn and verdict validators;
  - `baseline.ts`: openings majority, `changedFromOpenings`;
  - `budget.ts`: the D354 estimate;
  - `caller.ts`: router → concurrency gate → adapter, the CLI timeout floor, and an estimate when usage is not reported;
  - `control.ts`: Judge now, pause, resume, interrupt;
  - `ports.ts`: workspace, guardrails, budget, hooks.
  - The record the runner returns is the fold of exactly the events it wrote.
- **`GenerateRequest.readOnly`** (D359) is honoured by the CLI adapter: the read-only preset in the folder it is given.
- **`packages/tools/src/debate/workspace.ts`:** the workspace port. Reads are confined by `resolveInsideSandbox`; the sha and dirty flag come from git; each turn gets a scratch folder from `mkdtemp`.
- **Web:** the Events tab words every debate event and links it to its node, and the observability mock files them. A contract change makes exhaustive switches fail to compile, so these had to go in.

**Test fakes (pre-flight Q5):**
- `engine/src/debate/__tests__/fake-debate-provider.ts` scripts by call id × attempt. The call id rides `GenerateRequest.turnId` as `<debateId>/<callId>`, so no name is needed.
- It can reply, fail, hold until aborted, write a file into `workingDir`, and report or withhold usage. It records every prompt, folder, `readOnly` flag and abort.

**Brief tests → where they are** (all in `packages/engine/src/debate/__tests__/` unless noted):

| Brief | Test |
|---|---|
| free 3×2 → 11 calls; choice → 10 | protocol.test.ts |
| converged after round 1; earlyStop off runs all | protocol.test.ts |
| no opening sees another's; round k holds k−1 only; no names; instruction only in A's next prompt | isolation.test.ts |
| zero rebuttals → repair → accepted; two invalid → violation, sits out, back next round | contract.test.ts |
| choice answer not an option; positionChanged without changedBecause; own / missing / wrong-round target (6 cases) | contract.test.ts |
| choice: engine positionChanged wins (both directions) | contract.test.ts |
| verdict citing a missing turn → repair → hub CONTRACT_VIOLATION; model stats ignored | contract.test.ts |
| openingsMajority in code incl. tie; changedFromOpenings both ways; openingsVerdict; baseline prompt openings only | baseline.test.ts |
| retry then success; two failures → out; 1 left → RUN_FAILED, partial record | stopping.test.ts |
| Judge now mid-round; budget stop; refusal before start; USD caps; pause → zero calls | stopping.test.ts |
| temp cwd per turn, read-only, deleted; snapshot unchanged by an edit; >100,000 refused, zero calls; truncation | workspace-record.test.ts |
| replay reproduces the record exactly | workspace-record.test.ts |
| git status unchanged after a debater writes a file | `apps/server/src/__tests__/debate-workspace.test.ts` (real git, real tools workspace) |
| D355 guardrails (mask input, mask reply, block a turn, block the verdict, block material) | workspace-record.test.ts |
| D353 node states; usage per node | protocol.test.ts, contract.test.ts |

- **Mutation checks**, each reverted afterwards. Every mutation turned exactly the expected tests red:
  - turning off the truncation broke 2 tests;
  - letting a debater cite its own turn broke 2;
  - turning off the early stop broke 2;
  - running the turn in the project folder broke the server workspace test.

**Choices made while building** (all inside D343–D359):
- A rebuttal prompt restates "You are debater X." The brief's template leaves the label to "as above", and a stateless call cannot know its own turn otherwise.
- The rebuttal and judge prompts repeat the `Answer:` format line, because choice mode is invalid without it.
- **What the judge sees:**
  - its FINAL ROUND is each debater's latest valid turn (which covers a partial round after "Judge now");
  - everything else goes in EARLIER ROUNDS;
  - reasoning shown to the judge is capped at 6000 characters too, since the judge is one of the "others".
- **When the last round also converged,** `converged` wins over `max_rounds`.
- **The baseline judge runs after the verdict.** If it fails, only `openingsVerdict` is lost, never the verdict.
- **When the openings tie,** `changedFromOpenings` is left out.
- **The routing fallback chain is not walked** by a debate call. A CLI failure is retried once on the same model (DB11).
- **Refusals before any call** use these codes:
  - `debate_reads_too_large`, `debate_read_failed` and `debate_reads_without_folder` (BLOCKED);
  - `debate_budget_too_low` (BLOCKED);
  - `debate_input_blocked` (GUARDRAIL_VIOLATION).

**Gate 1, 2026-10-14.** All green:
- `pnpm --filter "./packages/**" build`: exit 0.
- `pnpm typecheck`: exit 0.
- `pnpm lint`: exit 0. It was rerun after two Debate lint fixes and one comment move in the web mock.
- `pnpm -r --workspace-concurrency=1 --no-bail test`. The engine was rerun after adding the debate types to `trace-usage.test.ts`'s every-event script, and tools and web after the lint fixes.

| Package | Files | Tests | vs baseline |
|---|---|---|---|
| contracts | 30 | 1304 | +48 |
| engine | 133 | 1946 | +80 |
| sdk | 16 | 167 | — |
| ui | 13 | 278 | — |
| web | 186 | 1637 | +1 |
| context | 4 | 52 | — |
| guardrails | 18 | 357 | — |
| providers | 21 | 448 + 1 skipped + 3 todo | +1 |
| storage-local | 24 | 319 | — |
| tools | 43 | 388 + 4 skipped | +6 |
| server | 33 | 192 | +1 |

**Engine coverage:** all files 92.98 statements / 85.12 branches / 94.31 functions / 95.24 lines. `src/debate` is 90.96 / 80.13 / 93.93 / 94.84.

**Deliberate changes to existing tests:**
- `events.test.ts`: the event-type list and the transient list, with one fixture per debate frame (`debate-frames.ts`).
- `trace-usage.test.ts`: the every-event script and its labels.
- `EventsTab.test.tsx`: one entry per debate type, and the Reviewer filter now also shows debater B's three debate rows.

## Open decisions

None. The three gaps pre-flight found were settled by the owner on 2026-10-14: D354, D355, D356.

## Later (not in this build)

From the brief's out-of-scope list:
- the Brain starting debates by itself;
- debate presets;
- automated scoring of free-form answers;
- debates that write code;
- judge panels;
- more than 5 debaters;
- memory across debates.
