# Product gaps — tests still to write (D362)

The owner chose to build each phase's features first and write the tests afterwards (D362). This file lists every test that is owed. Nothing is marked VERIFIED until its rows here are written and green.

- **Red tests still marked:** Phase 0 tests (`test.fail(NOT_BUILT…)` / `it.fails`) whose feature has landed but which do not pass yet.
- **To write:** tests the prompt asks for that do not exist yet.

When a test is written and green, delete its row.

## Phase 1

### Red tests still marked
| Item | File | Test | Fails at |
|---|---|---|---|

### To write
| Item | Test to write (what it asserts) | File |
|---|---|---|
| D-101 | `useProjects` follows `nextCursor`: with 51 projects, Home lists the 51st | `apps/web/src/projects/ProjectsPage.test.tsx` |
| PG-1.1 | The drop chooser appears when several inputs fit, and connects the one picked | `apps/web/src/canvas/Canvas.connect.test.tsx` |
| PG-1.1 | `PortDotLayer`/`shownPorts`: dots show for selected, armed and connect states only | `apps/web/src/canvas/EdgeLayer.test.tsx` |
| PG-1.1/1.2 | Below 45% zoom, `data-far` hides the card buttons and handle dots | `apps/web/src/canvas/Canvas.theme.test.tsx` |
| PG-1.2 | More → Run from here posts `startFromNodeId` | `apps/web/src/canvas/Canvas.connect.test.tsx` |
| PG-1.2 | More → Open in Domain navigates with `?node=` | `apps/web/src/canvas/Canvas.connect.test.tsx` |
| PG-1.2 | The header run controls render in Forge and Domain in the MSW e2e suite | `apps/web/e2e/` |
| PG-1.6 | Stop aborts a turn still waiting in the project write queue | `packages/engine/src/chat/__tests__/pg-1-6-message-actions.test.ts` |
| PG-1.6 | A stop holds when the adapter ignores its signal (61a87dc) | same |
| PG-1.6 | Edit with "Also revert the file changes" calls checkpoint revert for each replaced turn's checkpoint, and shows a conflict | `apps/web/src/chat/MessageActions.test.tsx` |
| PG-1.6 | SQLite round-trip of `superseded_at` / `deleted_at` through `append` and `mark` | `packages/storage-local/src/__tests__/repository-round4.test.ts` |
| PG-1.6 | MSW handlers for retry, edit, delete and stop | `apps/web/src/mocks/handlers-round4.test.ts` |
| PG-1.6 | MSW e2e for each action (Copy, Retry, Edit & resend, Delete, Stop, Earlier version) | `apps/web/e2e/chat.spec.ts` |
| PG-1.4 | Chat turns record local $0 / unknown cost (lands with PG-2.2) | `packages/engine/src/chat/__tests__/` |
| PG-1.4 | Models tab: grouped sections, and "unknown" price for an unpriced remote model | `apps/web/src/providers/ModelsTab.test.tsx` |
| PG-1.4 | Inspector shows "Free · runs on your machine" and "unknown" cost | `apps/web/src/inspector/Inspector.test.tsx` |
| PG-1.3 | Onboarding: the step-1 provider is applied to every template node | `apps/web/src/onboarding/OnboardingPage.test.tsx` |
| PG-1.3 | Card "Choose a provider" → picker → `update_node` | `apps/web/src/nodes/ChooseProvider.test.tsx` |
| PG-1.3 | Paste of a node whose provider is unknown lands red, not refused | `apps/web/src/canvas/Canvas.productivity.test.tsx` |

### Known gaps carried from Phase 1 (not tests)
- PG-1.1/1.2: below 45% canvas zoom, the card buttons and port dots hide. Without that, a 200-node pan misses TC-NFR-001's 20 ms frame budget: 33 ms, against 18–21 ms with it. This is a deviation from "always visible" that keeps NFR-PERF.
- PG-1.4: the Usage page's day totals cannot show "unknown", because `UsageSummary` has no `costKnown`. That needs a contract field, planned with PG-4.3's estimate work.
- PG-1.6 / D360: Domain's Retry on a live parked run still gets 409 from `assertNotLive` (`runs/control/service.ts`). It belongs to PG-3.5.
- PG-1.3: Duplicate opens the picker only when the copy would have no usable provider. A copy on a valid provider keeps it. This reads D351 narrowly.
