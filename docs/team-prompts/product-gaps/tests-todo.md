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

## Phase 3

### Red tests still marked
None (Phase 3 had no Phase 0 red tests). The Gate 3 e2e is owed below.

### To write
| Item | Test to write (what it asserts) | File |
|---|---|---|
| Gate 3 | "One run, three modes": start in Ideate, switch to Forge mid-run, then Domain, finish there, return to Ideate. The same run id, final states and token totals show in all three modes and the footer, with nothing stuck RUNNING. A walk passed on 2026-10-15; this commits it as a test. | `tests/acceptance/product-gaps/pg-3-one-spine.e2e.ts` |
| PG-3.1 | `useWorkflowSubscription`, `useRunEvents`, `useAdoptActiveRun` and `useChatSocket` each mount once across Ideate → Forge → Domain → Ideate | `apps/web/src/workflows/WorkflowLayout.test.tsx` |
| PG-3.1 | A chat reply streaming in Ideate keeps arriving after a switch to Domain and back | `apps/web/src/chat/ChatAside.test.tsx` |
| PG-3.1 | Domain registers no mode shortcuts of its own; the keys fire once from Domain | `apps/web/src/domain/DomainPage.test.tsx` |
| PG-3.2 | `useSelectedRun` default order (this client's live run, the list's live run, the newest); `?run=` wins; `?run=new` gives none | `apps/web/src/runs/selected-run.test.tsx` |
| PG-3.2 | `workflowPath(…, carry)` keeps run and node and drops `run=new`; ModeSwitch, the shortcuts, Domain's Forge link and the footer's Problems button carry them | `apps/web/src/forge/mode.test.ts`, `apps/web/src/app/layout/ModeSwitch.test.tsx` |
| PG-3.2 | Re-adopt on return: overlay RUNNING but record COMPLETE → after a mode switch the overlay is rebuilt and Start is enabled | `apps/web/src/runs/selected-run.test.tsx` |
| PG-3.2 | Adoption never overwrites an armed start and keeps a live overlay's streamed text; `useFollowStartedRun` moves `?run=` to a run this client starts | `apps/web/src/runs/selected-run.test.tsx` |
| PG-3.2 | `adopt` rebuilds `tool.call` frames in time order; Forge attribution survives a reload of a finished run | `apps/web/src/runs/run-store.test.ts`, `apps/web/src/forge/attribution.test.tsx` |
| PG-3.2 | Inspector and header run controls act on the `?run=` run, not the newest | `apps/web/src/inspector/Inspector.test.tsx`, `apps/web/src/app/layout/HeaderRunControls.test.tsx` |
| PG-3.3 | `withRunOverlay` lays the overlay's states and tokens over the snapshot, keeping budget, cost and est. | `apps/web/src/domain/run-overlay.test.ts` |
| PG-3.3 | Domain hears `run.completed`: the pill shows COMPLETE, the "live" pill goes and the composer is read-only, before the record refetches | `apps/web/src/domain/DomainPage.test.tsx` |
| PG-3.3 | `run.blocked` / `run.parked` refetch the run record | `apps/web/src/runs/live-run.test.tsx` |
| PG-3.3 | The SSE pump closes after `run.completed` (live and in backfill), stays open on `run.blocked` and on a parked run; a re-opened run counts as live | `packages/engine/src/domain/__tests__/domain-stream.test.ts` |
| PG-3.3 | Footer tokens and status agree across Ideate, Forge and Domain for the same selected run | `apps/web/src/app/layout/WorkspaceFooter.test.tsx` |
| PG-3.4 | `?node=` and the selection store stay in step: the URL wins on arrival, an Ideate selection writes `?node=` (replace), Domain and Forge never write, no echo loop; `nodePath` carries the run | `apps/web/src/app/follow-node.test.tsx` |
| PG-3.4 | Arriving with `?node=X` selects X and centres it once measured; a click that writes `?node=` does not move the view | `apps/web/src/canvas/Canvas.follow.test.tsx` |
| PG-3.4 | Open in Domain (context menu and More) goes to `/domain?run=<selected>&node=<id>` | `apps/web/src/canvas/Canvas.test.tsx` |
| PG-3.4 | Domain: a message's "Show on canvas", the roster's "Show <name> on canvas" with `aria-current` on the lens card, and the lens pill's button | `apps/web/src/domain/Conversation.test.tsx`, `TeamPanel.test.tsx`, `DomainPage.test.tsx` |
| PG-3.4 | Forge: `useNodeModel` order, `filesWrittenBy`, PathBar name and Domain links in a router (plain text outside), the followed-node bar and Explorer `data-followed` | `apps/web/src/forge/attribution.test.tsx`, `forge/editor/PathBar.test.tsx`, `forge/FollowedNode.test.tsx`, `forge/explorer/FileTree.test.tsx` |
| PG-3.4 | e2e: roster, pill and message → canvas selected and centred; canvas → Domain same run and lens; Forge bar → node. The PathBar attribution link needs a mock model that calls `write_file`. | `tests/acceptance/product-gaps/pg-3-4-follow-node.e2e.ts` |
| PG-3.5 / D363 | Retry on a parked Domain run runs as a turn of the same drive, unblocks BLOCKED successors and parks again; retry while RUNNING is 409; a planned turn the run ends before taking is STOPPED; Restart on an open run ends it and starts a new open run, 409 with no drive held | `packages/engine/src/domain/__tests__/domain-controls-live.test.ts` |
| PG-3.5 | `RunApprovalsDock` renders nothing with none pending, lists pending ones, and Approve/Reject call the API; it shows in Forge and above Domain's composer | `apps/web/src/runs/approvals/RunApprovalsDock.test.tsx`, `forge/ForgePage.test.tsx`, `domain/DomainPage.test.tsx` |
| PG-3.5 | `useOpenRunInPlace` sets `?run=` and keeps the mode path (and `/runs/:id` elsewhere); the header's Restart stays in the mode; "Waiting for you — End run" / "Team working — End run" in the header, RunBar and Forge's Run pipeline | `apps/web/src/runs/useOpenRunInPlace.test.tsx`, `app/layout/HeaderRunControls.test.tsx`, `runs/RunBar.test.tsx`, `forge/editor/PathBar.test.tsx` |
| PG-3.6 | Domain's node lens lists the node's direct threads, each opening Ideate on that thread; the chat column's Run tab shows the selected run's conversation read-only with an Open in Domain link and keeps the composer text | `apps/web/src/domain/NodeChatThreads.test.tsx`, `apps/web/src/chat/ChatAside.test.tsx` |
| PG-3.7 | Mode links on Home (Domain entry; Recent cards), project workflow cards, Run detail (Open in Forge with `?run=`), Timeline, Import's toast, and Onboarding's "Open it in" | `apps/web/src/projects/ProjectsPage.test.tsx`, `ProjectPage.test.tsx`, `runs/RunDetailPage.test.tsx`, `timeline/TimelinePage.test.tsx`, `workflows/ImportWorkflowButton.test.tsx`, `onboarding/OnboardingPage.test.tsx` |
| PG-3.7 | At phone width Domain keeps the lenses on one row and Team opens and closes as a sheet | `apps/web/src/domain/DomainPage.test.tsx` |
| D-058 | A Timeline composer send arms and begins the run store, so the Canvas overlay shows the run without a reload | `apps/web/src/timeline/TimelinePanel.test.tsx`, `apps/web/e2e/timeline.spec.ts` |
| PG-3.5–3.7 | Acceptance walk: approve a WAITING node from Domain and from Forge; Retry a failed turn in an open Domain run | `tests/acceptance/product-gaps/pg-3-controls-everywhere.e2e.ts` |
| PG-1.5 | Domain composer: a post that meets a 409 because the run ended in the meantime keeps its text, says "This run has ended", and offers "Start a new run with this message" (the acceptance test now covers the PG-3.3 path, where the page hears the end first) | `apps/web/src/domain/Composer.test.tsx` |
| D-102 | TC-TOOL-004 timed from the sandbox's start, so load cannot overrun its margin — both the acceptance check and `packages/tools` `runner.test.ts` ("kills `while (true) {}`"), which failed the same way in the Phase 3 gate | `tests/acceptance/round-4/mouli-tests-arhant.test.ts`, `packages/tools/src/sandbox/runner.test.ts` |

### Known gaps carried from Phase 3 (not tests)
- PG-3.2: a mode switch passes `?run=` only when the URL already has one. With none picked, each mode works out the same default, so an unpinned view keeps following new runs.
- PG-3.3: after a D81 retry or re-run of a finished run, Domain's pill stays read-only until a later frame refetches the record.
- PG-3.4: centring keeps the current zoom; it does not zoom in.
