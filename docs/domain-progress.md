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
| 0 Pre-flight | done | (this commit) | docs only; baseline below |
| 1 Projection core | not started | — | — |
| 2 Human → node | not started | — | — |
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

## Open decisions

None. The five contradictions pre-flight found were settled by the owner on 2026-10-10: D304, D305, D306, D307, D308.

## Later (not in this build)

- **Debate** isn't implemented, and no debate fields are added. When it is built, its turns must be exempt from the loop guard, bounded by their own round limit instead, and grouped in Domain by debate id and round.
