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

## Phase 2

### Red tests still marked
None. All 27 Phase 0 red tests for PG-2.1 to PG-2.4 pass.

### To write
| Item | Test to write (what it asserts) | File |
|---|---|---|
| PG-2.1 | `outputTypesWithSchema`/`effectiveOutputTypes`/`hasJsonOutput`; `validateLoopConfig` accepts a loop from a schema node's text port and still refuses one with no schema | `packages/contracts/src/__tests__/graph.test.ts` |
| PG-2.1 | `validateAgainstContract` with `['text']` + schema needs a json part and checks it | `packages/contracts/src/__tests__/envelope.test.ts` |
| PG-2.1 | `capabilityGaps`: CLI + schema, `supportsJson:false` + schema, tools or skills + `supportsTools:false`, and no gaps for a capable model | `packages/contracts/src/__tests__/validation.test.ts` |
| PG-2.1 | validate names `schema_unsupported` for a CLI provider and `tools_unsupported` for skills alone; an unavailable model gives no capability issue | `packages/engine/src/runs/__tests__/pg-2-1-output-contract.test.ts` |
| PG-2.1 | `contractFor(['text'], schema)` gives `['text','json']` | `packages/engine/src/__tests__/envelopes.test.ts` |
| PG-2.1 | AI SDK adapter: a schema plus tools still sends `responseFormat` | `packages/providers/src/__tests__/pg-2-1-ai-sdk-json-schema.test.ts` |
| PG-2.1 | Agent modal: the JSON copy shows only with a schema; Last run shows Passed or CONTRACT_VIOLATION with its reason | `apps/web/src/config-panel/panels.test.tsx` |
| PG-2.1 | Pickers: a blocked model is disabled with a short reason and a title; `config-model-capability` shows for a chosen blocked model | `apps/web/src/config-panel/ProviderAndModel.test.tsx`, `apps/web/src/providers/ProviderModelPicker.test.tsx` |
| PG-2.1 | e2e: the picker marks a CLI or non-JSON model once a schema is set; the Review→Fix loop runs to its exit through the UI | `tests/acceptance/product-gaps/pg-2-1-contracts.e2e.ts` |
| PG-2.1 / D-100 | Ollama discovery: every model `supportsJson`; `tools`/`vision` from `/api/show`; a failing `/api/show` keeps the defaults | `packages/providers/src/__tests__/pg-1-4-ollama-sizes.test.ts` |
| PG-2.2 | Chat turn cost follows PG-1.4 (local $0, unpriced remote `costKnown:false`), and an unknown cost is never refused by the per-turn cap | `packages/engine/src/chat/__tests__/pg-2-2-chat-budgets-tools.test.ts` |
| PG-2.2 | A day already at `dailyBudgetUsd` refuses a chat turn with zero calls; a `warn` or `pass` `daily_budget` check does not | same |
| PG-2.2 | Approve resumes the waiting turn and the tool runs; reject feeds back "rejected" and the turn goes on; Stop ends the wait and emits `chat.approval_decided` reject | same |
| PG-2.2 | `GET /chat/threads/:id/approvals` and approve/reject: 404 for an unknown request, 200 with the decision | `packages/engine/src/__tests__/` (gateway chat approvals) |
| PG-2.2 | `chatMessages.dailyCostUsd` sums a day's direct turns and leaves out run-written turns | `packages/storage-local/src/__tests__/repository-round4*.test.ts` |
| PG-2.2 | SDK `listChatApprovals`, `approveChatToolCall`, `rejectChatToolCall`, and the `retryChatMessage` body | `packages/sdk/src/__tests__/` |
| PG-2.2 | Chat meta line shows a `$` cost or "cost unknown"; the approval card's Approve/Reject call the SDK | `apps/web/src/chat/ChatPanel.test.tsx` |
| PG-2.3 | Migration posts one system Timeline message per affected workflow, none when unused, and a second start does nothing | `apps/server/src/__tests__/pg-2-3-full-auto-migration.test.ts` |
| PG-2.3 | An old `full_auto` row shows "Edit project files" on the Providers page and saves as `edit_files` | `apps/web/src/providers/pg-2-3-no-full-auto.test.tsx` |
| PG-2.3 | e2e: the migration notice is in a workflow's Timeline after restart | `tests/acceptance/product-gaps/pg-2-3-no-full-auto.e2e.ts` |
| PG-2.4 | A `withoutUndo` run whose checkpoint fails runs, with a `running_without_undo` warning and `run.started.withoutUndo`; a CLI node on `edit_files` counts as writing, `read_only` does not | `packages/engine/src/checkpoints/__tests__/pg-2-4-checkpoint-start.test.ts` |
| PG-2.4 | Chat retry `{withoutUndo:true}` after `checkpoint_unavailable` writes; a turn that is not writing still runs | same |
| PG-2.4 | A reading run's `POST /runs` does not wait for the checkpoint (D65 with a project folder) | `apps/server/src/__tests__/server.test.ts` |
| PG-2.4 | Canvas/Forge undo card: Run without undo starts a run with `withoutUndo` and the same inputs and goal; Cancel resets the run store; the chat turn's buttons retry without undo or dismiss | `apps/web/src/runs/UndoChoice.test.tsx`, `apps/web/src/chat/ChatPanel.test.tsx` |
| PG-2.4 | e2e: Run without undo actually runs, for a run and for chat | `tests/acceptance/product-gaps/pg-2-4-undo-loss.e2e.ts` |

### Known gaps carried from Phase 2 (not tests)
- PG-2.2: chat approvals are held in memory. After a restart an old `chat.approval_required` frame stays in the log, but no card shows.
- PG-2.2: in chat, `ask_user` on any tool-point check opens an approval. In runs, only `destructive_action` does.
- PG-2.2: the Usage dashboard and day totals do not include chat spend yet; only the `daily_budget` check does.
- PG-2.1: tools on a model the catalogue marks `supportsTools:false` now block at pre-flight. Before, they were silently dropped. That includes CLI models and discovered models not in the manifest (D-100 fixed Ollama).
- PG-2.3: a migrated provider that no workflow uses gets only the engine log line, not a Timeline notice.
