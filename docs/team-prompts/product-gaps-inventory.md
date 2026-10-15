# Product gaps — Phase 0 inventory

Phase 0 of `docs/team-prompts/product-gaps-fix-prompt.md`, on `fix/pg-0-inventory`. No behaviour changes. The detail is in four files under `docs/team-prompts/product-gaps/`; this page is the index and the summary.

| Item | File | What it holds |
|---|---|---|
| 1. File references | [inventory-refs.md](product-gaps/inventory-refs.md) §1 | Every file:line in the prompt, CONFIRMED / CORRECTED / WRONG CLAIM, with the real location |
| 2. Open work | [inventory-refs.md](product-gaps/inventory-refs.md) §2 | Open PRs and branches, overlap with PG items, D-row conflicts |
| 3. Symptoms | [inventory-audit.md](product-gaps/inventory-audit.md) §3 | The six user symptoms and the two mode symptoms, reproduced against a real engine, screenshots light/dark at 1440 and 380 px |
| 4. Visibility audit | [inventory-audit.md](product-gaps/inventory-audit.md) §4 | Icon-only, glyph, hover-only, sub-AA and right-click-only controls, every route, both themes |
| 5. Red tests | [inventory-red-e2e.md](product-gaps/inventory-red-e2e.md), [inventory-red-unit.md](product-gaps/inventory-red-unit.md) | 40 Playwright tests (real engine) and 49 Vitest tests, each failing on the symptom |

## What Phase 0 changed in the plan

- **Open work:** none. Every `feat/*`, `fix/*`, `x1/*` and `domain` branch is merged (#40, #44–#51). Each phase branches from `main` (or from the previous phase while it waits for merge).
- **Decisions recorded:** D350–D357 for X1–X8, and D358–D361 for what Phase 0 found and the owner decided on 2026-10-15:
  - D358: a new `missing_provider` code beside the existing `missing_model` and `provider_missing`.
  - D359: optional `Model.sizeBytes`, `Usage.costKnown`, and `ApprovalRequest.threadId` with `runId`/`nodeRunId` optional.
  - D360: the prompt wins over D328, D330/D331, D332 and D323 where they clash.
  - D361: a writing run or turn stops when its checkpoint cannot begin (amends D300/D302). PG-5.1 and PG-5.3 are owned here, not by agentic-nodes Phase 2.
- **X8:** already recorded by D300 and D340, and no TC-GIT-002 test exists. D357 notes it; nothing is renamed.
- **Causes that differ from the prompt:**
  - **PG-1.1.** A drag never opened settings in the browser. The ports are invisible, sit inside the icon circle rather than at the card edge, and connect only within about 6 px of the dot. A drag from the card edge moves the card.
  - **PG-1.5.** A 503 already shows "could not answer" (D287). The real gaps:
    - A reply that never ends shows "typing…" forever. Replies are serialised per project (`chat/service.ts:376`), so it blocks every later turn in that project.
    - Domain shows a raw error as if the agent said it.
    - The escaping throws are `takeRevertedPaths`, `evaluateChatReply`, `usageFor` and `store()`.
  - **PG-1.2.** Run controls already exist at phone width (`RunBar` in `CompactTopBar`) and on Run detail. At desktop width they are only in the "…" menu.
  - **PG-3.1.** `useChatSocket` is mounted by `ChatAside`, so hiding ChatAside on Domain needs the socket hoisted into the layout.
  - **PG-5.2.** An agent's check and write already happen under the lock. The gap is that the lock belongs to the run's session, so user saves and chat turns never take it.
- **Phase 1 split:** the prompt's track A had PG-1.1 to PG-1.3. PG-1.3's Add node picker moved to track B, with PG-1.4, because it is built on PG-1.4's grouped picker. Track A keeps PG-1.1 and PG-1.2.

## Gate 0

- `pnpm typecheck && pnpm lint`: exit 0.
- `pnpm -r --workspace-concurrency=1 --no-bail test` per package:

  | Package | Result |
  |---|---|
  | contracts | 1256 passed + 15 expected fail |
  | engine | 1881 + 27 expected fail |
  | sdk | 167 |
  | ui | 279 |
  | web | 1636 + 2 expected fail |
  | context | 52 |
  | guardrails | 357 |
  | providers | 450 + 4 expected fail, 1 skipped, 3 todo |
  | storage-local | 319 |
  | tools | 594, 5 skipped |
  | server | 187 + 1 expected fail, **4 failed** |

- **The server failures.** `checkpoints.integration.test.ts` timed out at 5 s while four agents were running tests on the machine. The same file passed 7/7 when re-run alone. Logged as D-099 (Low).
- **Red tests.** The product-gaps Playwright folder reports 40 expected-fail. With `PG_PROVE_RED=1` all 40 fail, each on its symptom assertion.
- **Not run in Phase 0:** the rest of the acceptance suite (rounds 1–5 and Domain). Phase 0 changes no product code. Phase 1's gate runs the whole acceptance suite.
