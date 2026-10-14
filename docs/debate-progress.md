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
| 0 Pre-flight | done | (this commit) | docs only; baseline below |
| 1 Debate engine (headless) | todo | | |
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
