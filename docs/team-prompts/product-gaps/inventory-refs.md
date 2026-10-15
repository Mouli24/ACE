# Product gaps — Phase 0 inventory: file references and open work

Phase 0 items 1 and 2 of `docs/team-prompts/product-gaps-fix-prompt.md`, read against `main` at `17467f9` (the base of `fix/pg-0-inventory`). Items 3–5 (browser repro, visibility audit, red tests) are not in this file.

Paths are written as in the prompt. A web path with no prefix is under `apps/web/src/`, an engine path under `packages/engine/src/`.

Status values:
- **CONFIRMED**: the cited lines say what the prompt claims.
- **CORRECTED**: the claim holds, but the lines are elsewhere or the range is off.
- **WRONG CLAIM**: the code does not behave as the prompt says.
- **PARTLY WRONG**: part of the claim holds and part does not.

## 1. File references

### X1–X8 (decision table)

| Item | Prompt ref | Status | Real location | Note |
|---|---|---|---|---|
| X1 | D332, ports invisible | CONFIRMED | `docs/DECISIONS.md:261`; `packages/ui/src/theme.css:293-313` | D332 says "handles stay, invisible, at the theme's anchor points". |
| X2 | `canvas/graph-plans.ts:97`, D332 | CONFIRMED (line); D-row PARTLY WRONG | `canvas/graph-plans.ts:97` | Line 97 picks the first CONNECTED provider, else `providers[0]`. D332's text covers Add node's placement, link, select, open settings and centre. It says nothing about which provider. The provider choice is only in the code comment (`graph-plans.ts:70-75`, "as the New node dialog defaulted"). |
| X3 | D335, "Actions +" dropped | CONFIRMED | `docs/DECISIONS.md:264` | — |
| X4 | D285, no output-type picker | CONFIRMED | `config-panel/panels.tsx:184-187` cites D285 | The D285 row (`DECISIONS.md:223`) does not mention type pickers. The rule is in the code comment that cites it. |
| X5 | D303, Domain is a sibling route | PARTLY WRONG | `app/routes.tsx:45-47` | The D303 row (`DECISIONS.md:232`) defines Domain as a projection of the event log and says nothing about routing. The sibling route is in `routes.tsx`, whose comment cites D303. D336 ("The Team aside follows Split") and D330 also shape it. Record X5 as amending the route comment's reading, and name D336 too. |
| X6 | `contracts/src/providers.ts:57` | CONFIRMED | `packages/contracts/src/providers.ts:57` | `CLI_PERMISSIONS = ['read_only','edit_files','full_auto']`. |
| X6 | `claude-code.ts:39` | CONFIRMED | `packages/providers/src/adapters/cli/claude-code.ts:39` | `full_auto: ['--permission-mode','bypassPermissions']`. |
| X6 | `codex.ts:30` | CONFIRMED | `packages/providers/src/adapters/cli/codex.ts:30` | `--dangerously-bypass-approvals-and-sandbox`. |
| X6 | (missing) | CORRECTED, add | `packages/providers/src/adapters/cli/gemini.ts:34` | `full_auto: 'yolo'`. The third CLI is not named in the prompt. PG-2.3's "no bypass" test must also cover `yolo`. |
| X6 | (missing) | CORRECTED, add | `providers/provider-meta.ts:41,47`; `providers/ProviderDialogs.tsx:100` | These are where the UI offers and warns about `full_auto`. |
| X6 | D342 "no Full auto" | WRONG CLAIM (D-row) | `DECISIONS.md:271` (D342), `DECISIONS.md:218` (D262) | D342 sets agentic nodes' workspace access levels. It does not cover a CLI provider's preset. The CLI `full_auto` preset is **D262**: "`read_only` / `edit_files` (default) / `full_auto` … no mid-run approval for CLI actions". X6 changes D262, so the D-row must say so. |
| X7 | D330/D336, one Split toggle | CONFIRMED | `domain/DomainPage.tsx:57-58,260-268` (`useLayoutStore.chatOpen`/`toggleChat` drives TeamPanel) | — |
| X8 | FR-GIT-004 / TC-GIT-002 | PARTLY WRONG | `docs/ACE-FRS.md:890`; `DECISIONS.md:229` (D300), `:269` (D340) | D300 already says "It replaces FR-GIT-004's 'editor read-only during runs'". D340 repeats it ("FR-GIT-004/BR-09's lock stays replaced by D300"). The DECISIONS record X8 recommends **already exists**. There is also **no test named TC-GIT-002** anywhere in `apps`, `packages` or `tests`: it exists only in the FRS table. "Rename TC-GIT-002's test" has nothing to rename. Only a spec-first test written from the FRS would hit it. |

### Phase 1

| Item | Prompt ref | Status | Real location | Note |
|---|---|---|---|---|
| PG-1.1 | `packages/ui/src/theme.css:297-307` | CONFIRMED | `packages/ui/src/theme.css:297-307` (focus/armed ring 308-313) | 12×12 px, `background: transparent`, `opacity: 0`. |
| PG-1.1 | `nodes/NodeCard.tsx:88-140` | CONFIRMED | `nodes/NodeCard.tsx:87-143` (`PortHandle`) | There is no other visible port dot on the card: `portAnchor` is used only to place the invisible handle (line 110). |
| PG-1.1 | `canvas/Canvas.tsx:1036-1043` | CONFIRMED (lines); mechanism UNVERIFIED | `canvas/Canvas.tsx:1036-1044` (`onNodeClick`), `onCard` at `:180-186` | `onCard` already ignores a target inside `.react-flow__handle`. The modal opens only for a click whose target is the card. The prompt's scenario is a drag aimed at a port that misses the 12 px hit area and lands on the card. Whether React Flow then fires `onNodeClick` after a card drag is not shown by these lines. Phase 0 item 3 must reproduce it before PG-1.1's "no accidental settings" test is called red for the right reason. |
| PG-1.2 | `app/layout/SettingsMenu.tsx:22` | CONFIRMED | `app/layout/SettingsMenu.tsx:21-22` | `const GEAR = '⚙︎'` (U+2699 + VS15). |
| PG-1.2 | `canvas/Canvas.tsx:262`, "run controls only in Ideate's … menu" | PARTLY WRONG | `canvas/Canvas.tsx:262` mounts `WorkspaceMenu`; Run section at `app/layout/WorkspaceMenu.tsx:374-419` | True at desktop width. But `runs/RunBar.tsx` (with `RunControls`) is mounted in `app/layout/CompactTopBar.tsx:66` at phone width in every mode, and `runs/RunDetailPage.tsx:170` has `RunControls`. Forge has "▶ Run pipeline" (D334), which is start only. |
| PG-1.3 | `canvas/graph-plans.ts:73-104` | CONFIRMED | `canvas/graph-plans.ts:76-105` (`planNewStage`), provider pick at `:97-104` | — |
| PG-1.3 | "drop … can create a node with no provider" | CONFIRMED | `canvas/Canvas.tsx:1059-1069` (`onDrop` → `addNodeAt(kind, position, readDropInit(event))`, init optional); `readDropInit` `:157-173` | Duplicate copies the source's config, so it is providerless only if the source was. Paste, templates and import were not traced. |
| PG-1.3 | `graph/validate.ts` / `runs/preflight.ts`, new issue `missing_provider` | WRONG CLAIM | `packages/engine/src/graph/validate.ts:167-184`; `runs/preflight.ts:99` calls `validateGraph` | The engine **already** returns a named **error** for this. `missing_model` ("has no provider and model chosen yet") covers an Agent/Model with no `providerId` or `modelId`. `provider_missing` covers a provider id that no longer exists. Both are in `packages/contracts/src/validation.ts:77,90`, and pre-flight already BLOCKs on them. A new `missing_provider` code would be a contract change the prompt does not describe, and it duplicates both (stop condition 1). Reuse `missing_model` / `provider_missing`. The "Choose a provider" card state can key off them. |
| PG-1.4 | `providerGroup(provider)` in contracts | CORRECTED (context) | `packages/contracts/src/providers.ts:35-54` (`PROVIDER_ROUTES`, `routeOf`) | A route already exists: `api` / `local` / `cli` / `mock`. `openai_compatible` is always `local` there, even when remote. `providerGroup` should sit beside `routeOf` and say how it differs. `mock` has no group in the prompt. |
| PG-1.4 | "each model's size … from the catalogue" | WRONG CLAIM | `packages/contracts/src/models.ts:28-52` | `Model` has `supportsTools`, `supportsJson` and `contextWindow`, but **no size field**. Showing size is a contract change the prompt does not describe. |
| PG-1.4 | "unpriced remote models as unknown, never $0" | CONFIRMED (the gap) | `packages/engine/src/runs/cost.ts:13-19` | `estimateCostUsd` returns `0` when `pricing` is undefined, and `Usage.costUsd` is a plain number. Showing "unknown" needs a contract field. That is not described for PG-1.4: PG-4.3 describes `unknown` only for the estimate route. |
| PG-1.5 | `chat/ChatConversation.tsx:314-319` | CONFIRMED | same | "not sent" (`chat-send-error`). |
| PG-1.5 | `chat/ChatConversation.tsx:245-258` | CONFIRMED | same | "{name} could not answer · {code}". |
| PG-1.5 | `chat/service.ts:823-825`, "if `generateReply` throws after 202 the engine only logs; no failed turn is stored" | PARTLY WRONG | `packages/engine/src/chat/service.ts:821-825` (the `.catch` that only logs); `produceReply` `:379-646`; `store` `:234-239` | Lines 823-825 do only log. But D287 ("fix F-M4") already wraps the part most likely to throw in a try (`:456-588`): history read, catalogue read, adapter lookup, model call and tool loop. A failure there is stored as a failed turn and emitted as `chat.message` (`:609-617`). What still escapes to the log-only `.catch`:<br>• `evaluateChatReply` (`:626-633`)<br>• `usageFor` (`:606`)<br>• `store()` itself, a repository or bus failure (`:234-238`)<br>• `takeRevertedPaths` / `createBatcher` before the try (`:384-394`)<br>• the write queue (`:376`)<br>Checkpoint begin and finish are caught separately (`:398-408`, `:592-598`). The red test must throw from one of those paths. A provider failure is already handled and would pass. Restart recovery of open turns does not exist (confirmed: nothing marks a chat turn failed on startup). |
| PG-1.5 | "Domain never reads `failureReason`" | CONFIRMED | no match for `failureReason` or `haltReason` in `apps/web/src/domain/**` | — |
| PG-1.6 | `domain.ts:999`, `chat.update` shape | CONFIRMED (line); fit WRONG | `packages/contracts/src/domain.ts:993-1011` (`DomainStreamFrameSchema`, `chat.update` at `:998-1001`) | It is an SSE frame of `GET /runs/:runId/chat/stream` carrying a `DomainMessage`. Per its doc comment it never joins `ServerFrameSchema`. Node chat runs over the WebSocket (`chat.message` persisted, `chat.token` transient: `packages/contracts/src/events.ts:359-360,431`) and carries `ChatMessage`. The shape does not fit, so a new WS thread frame is needed. |
| PG-1.6 | "DELETE … kept in the event log" | CONFIRMED | `packages/contracts/src/events.ts:359` (`chat.message` is a persisted frame); `chat/service.ts:237` | — |

### Phase 2

| Item | Prompt ref | Status | Real location | Note |
|---|---|---|---|---|
| PG-2.1 | `config-panel/panels.tsx:186-215` | CONFIRMED | `config-panel/panels.tsx:184-214` | Only `outputContract.jsonSchema` is set. "Use standard review contract" is at `:198-213`. |
| PG-2.1 | `nodes/factory.ts:68` | CONFIRMED | `nodes/factory.ts:68` | `outputTypes: ['text']` for an Agent. A Model node is the same (`:77`). |
| PG-2.1 | `runs/executor.ts:1422` | CONFIRMED | `packages/engine/src/runs/executor.ts:1422` | `const wantsJson = outputTypes.includes('json')`. Also `:565` gates memory on `outputTypes.includes('json')`. |
| PG-2.1 | `contracts/src/envelope.ts:300-306` | CONFIRMED | `packages/contracts/src/envelope.ts:300-306` | The schema is checked only on `json` parts. The type check at `:287-298` would also refuse a `json` part under a `['text']` contract. |
| PG-2.1 | `contracts/src/graph.ts:514-518` | CONFIRMED | `packages/contracts/src/graph.ts:513-520` | `loop_source_not_json` is decided by the source's output **ports** (`port.dataType === 'json'`), which come from `outputTypes`. |
| PG-2.1 | `providers/src/adapters/ai-sdk.ts:355-366` | CONFIRMED | `packages/providers/src/adapters/ai-sdk.ts:355-367` | `streamText` gets no schema. Note: the executor **already** sends `jsonSchema: providerSchema` on every `generate` (`executor.ts:571-574, 983`), even for a text node. The drop is only in the AI-SDK adapter. |
| PG-2.1 | `executor.ts:755, 977`, "drops these silently" | CORRECTED / PARTLY WRONG | `executor.ts:755` (`modelTakesTools`), `:974-976` (`offerTools`); `:977` is the `generate` call | The tools half is right: tools are silently not offered when `supportsTools === false`. For JSON there is no drop to point at. `supportsJson` is never read in `packages/engine/src` outside the port type (`ports/model-provider.ts:36`) and the catalogue mapping (`providers/index.ts:430`). |
| PG-2.2 | `chat/service.ts:422-423, 515` | CORRECTED | `chat/service.ts:513-515` (no `runId`, "a chat belongs to no run"); `:422-423` is `maxToolCalls`, not cost | No cost cap: no `dailyBudget` or `maxCost*` anywhere in `packages/engine/src/chat`. |
| PG-2.2 | `runs/index.ts:747`, `evaluateTool` runs only | CONFIRMED | `packages/engine/src/runs/index.ts:747` | The chat tool loop (`chat/tool-loop.ts`, called at `chat/service.ts:564-579`) never calls `evaluateTool`. It offers only six non-destructive tools (`chat/tool-loop.ts:29-36`). A CLI chat turn uses the provider's preset. |
| PG-2.2 | "the same `ask_user` approvals as runs" | CONFLICT with contract | `packages/contracts/src/guardrails.ts:308-312` | `ApprovalRequest` requires `runId` and `nodeRunId`, and a chat turn has neither (FR-CHAT-005, D302). This is a contract change the prompt does not describe (stop condition 1). |
| PG-2.3 | `providers/provider-meta.ts` | CONFIRMED | `providers/provider-meta.ts:41,47`; dialog `providers/ProviderDialogs.tsx:100` | — |
| PG-2.4 | `runs/index.ts:2918-2927` | CONFIRMED | `packages/engine/src/runs/index.ts:2916-2928` (`beginRunCheckpoint`) | The doc comment says "never a reason the run fails". Chat: `chat/service.ts:396-408`. |

### Phase 3

| Item | Prompt ref | Status | Real location | Note |
|---|---|---|---|---|
| PG-3.1 | `app/routes.tsx:37-47` | CONFIRMED | `app/routes.tsx:37-47` | WorkflowLayout's children are index and `forge` (`:37-44`). Domain is a sibling at `:47`, and so is Timeline (`:48-51`). |
| PG-3.1 | `domain/DomainPage.tsx:52-56` | CONFIRMED | `domain/DomainPage.tsx:52-56` | — |
| PG-3.1 | hooks to keep mounted | CORRECTED (where) | `workflows/WorkflowLayout.tsx:27-29` (`useWorkflowSubscription`, `useRunEvents`, `useAdoptActiveRun`); `useChatSocket` at `chat/ChatAside.tsx:121` and `chat/ChatPanel.tsx:39` | `useChatSocket` is mounted by ChatAside, not by WorkflowLayout. PG-3.1 also hides ChatAside on Domain, so the chat socket would unmount there unless it moves up into the layout. |
| PG-3.2 | `forge/mode.ts:9-12` | CONFIRMED | `forge/mode.ts:9-12` | `workflowPath` carries no query. |
| PG-3.2 | `DomainPage.tsx:236` | CONFIRMED | `domain/DomainPage.tsx:236` | `navigate(workflowPath(…,'forge'))` with no `?run=`. |
| PG-3.2 | `runs/hooks.ts:160-176` | CONFIRMED | `runs/hooks.ts:151-189` (effect `:160-188`) | Adopts only a newest run in RUNNING/PAUSED/PREFLIGHT (`:169-174`). A `useRef` guard per workflow id (`:158-162`) means it never re-asks, and it never resets. |
| PG-3.2 | `run-store.ts:195-238` | CONFIRMED | `runs/run-store.ts:195-258` (`adopt`) | It synthesises only `node.state`, `node.output` and `node.approval_required`. There are no `tool.call` frames, so Forge attribution (`run-store` `tool.call` writes) is lost after a reload. |
| PG-3.3 | `DomainPage.tsx:91-96` | CONFIRMED | `domain/DomainPage.tsx:91-97` | Node states come from `conversation.usage.perNode`. |
| PG-3.3 | `engine/src/domain/chat-stream.ts:134-153` | CONFIRMED | `packages/engine/src/domain/chat-stream.ts:134-153` | `while (!signal.aborted)` with a keep-alive. There is no exit on a terminal run state. |
| PG-3.3 | `WorkspaceFooter.tsx:119-129` | CONFIRMED | `app/layout/WorkspaceFooter.tsx:116-129` (`useFooterTokens`) | Domain publishes through `useWorkspaceStatus.setTokens` (`DomainPage.tsx:99-118`). Ideate and Forge read `useRunStore.totals`. |
| PG-3.4 | `Canvas.tsx:188-200` | CONFIRMED | `canvas/Canvas.tsx:188-201` (`OpenInDomainItem`) | Carries `?node=` only. |
| PG-3.4 | `forge/editor/PathBar.tsx:116-130` | CONFIRMED | `forge/editor/PathBar.tsx:116-132` | A plain `<span>`, not a link, with no model shown. |
| PG-3.5 | `WorkspaceMenu.tsx:402` | CONFIRMED | `app/layout/WorkspaceMenu.tsx:402` | `navigate('/runs/' + result.id)` on restart. |
| PG-3.5 | `ApprovalStack` not in Domain/Forge | CONFIRMED | mounted only in `runs/NodeRunAttachments.tsx:142`, `runs/RunDetailPage.tsx:185`, `runs/approvals/ApprovalsBadge.tsx:82` (badge only in `CompactTopBar.tsx:52`) | — |
| PG-3.6 | `useChat.ts:83` vs `DomainPage.tsx:251` | CONFIRMED | `chat/useChat.ts:83` (`postNodeChat`); `domain/DomainPage.tsx:251` (`usePostRunMessage`) | — |
| PG-3.7 | `ProjectsPage.tsx:17` | CONFIRMED | `projects/ProjectsPage.tsx:16-17` (`EntryMode = 'ideate' \| 'forge'`), entries `:20-45` | These are Home's two hero entry cards. The Recent cards are `projects/ProjectCard.tsx`. |
| PG-3.7 | `TimelinePage.tsx:34` | CONFIRMED | `timeline/TimelinePage.tsx:33-38` | The only link is "open the Canvas". Timeline is also outside WorkflowLayout (`routes.tsx:48-51`). |
| PG-3.7 | D-058 | CONFIRMED OPEN | `docs/defect-log.md:87` | — |

### Phase 4

| Item | Prompt ref | Status | Real location | Note |
|---|---|---|---|---|
| PG-4.1 | `envelope.ts:89` | CONFIRMED | `packages/contracts/src/envelope.ts:89` | `CONTEXT_BUDGET_SHARES = { retrieved: 0.5, memory: 0.25 }`. |
| PG-4.1 | `envelopes/index.ts:65-69` | CONFIRMED | `packages/engine/src/envelopes/index.ts:64-70` | `readsBudgetFor` is engine-only. The web cannot import it (CLAUDE.md §3.4 rule 3), so the Reads section needs it moved to contracts or exposed by the API. |
| PG-4.1 | `Inspector.tsx:316-332` | CONFIRMED | `inspector/Inspector.tsx:316-334` | `from {envelope.fromNodeId.slice(-6)}` at `:320`. |
| PG-4.1 | `teamEnvelopeId` | CONFIRMED (exists) | `packages/contracts/src/envelope.ts:131` | — |
| PG-4.2 | `apps/web/src/theme/format.ts:38-48` | CONFIRMED | same | IDLE, READY, WAITING, PAUSED and STOPPED share `#a39d97`. BLOCKED and FAILED share `#c94c27`. |
| PG-4.2 | `domain/looks.ts:73-83` | CONFIRMED | same | IDLE, READY, WAITING and PAUSED all map to "Waiting". |
| PG-4.2 | `DomainPage.tsx:374-375` | CONFIRMED | `domain/DomainPage.tsx:369-377` | Shows `status` and `blockedReason`, never `haltReason`. |
| PG-4.2 | `Conversation.tsx:326-332` | CONFIRMED | `domain/Conversation.tsx:325-332` | Every outcome that is not OK, RUNNING or WAITING gets ✕. `INTERRUPTED` is a real outcome (`packages/contracts/src/domain.ts:765`). |
| PG-4.2 | `RunBar.tsx:36` | CONFIRMED | `runs/RunBar.tsx:36` | `HALTED` that is not `stopped` is coloured FAILED, including `budget_exceeded`. `RunBar` renders only in the phone bar. |
| PG-4.2 | `Canvas.tsx:635-636` | CONFIRMED | `canvas/Canvas.tsx:635-637` | `runIsLive` means only `status === 'RUNNING'`. It drives edge animation (`:651`), not the cards. |
| PG-4.4 | `Canvas.tsx:124,144` | CONFIRMED | `canvas/Canvas.tsx:124` (`useWorkflowGraph`), `:144` (`nodes={graph.data.nodes}`) | — |
| PG-4.4 | `run-store.ts:318-333` | CONFIRMED | `runs/run-store.ts:318-338` (`useNodeOverlay`) | Keyed by the live node id. |
| PG-4.4 | `Inspector.tsx:70` | CONFIRMED | `inspector/Inspector.tsx:70` | `?? 'this node'`, from the live graph (`:56`). |
| PG-4.5 | `memoryOps`, `reusedFromNodeRunId` | CONFIRMED (exist) | `packages/contracts/src/runs.ts:270,275` | — |
| PG-4.5 | `Envelope.guardrailVerdicts` never filled | CONFIRMED | `packages/contracts/src/envelope.ts:125` | No engine code writes it. Verdicts go to `repository.guardrailVerdicts` (`guardrails/store.ts:73`). |

### Phase 5

| Item | Prompt ref | Status | Real location | Note |
|---|---|---|---|---|
| PG-5.1 | `runs/index.ts:2923` | CONFIRMED | `packages/engine/src/runs/index.ts:2923` | `{ kind: 'run', runId: run.id }`, one per run, with no `nodeId`. `Checkpoint.nodeId` already exists in the contract (D300). |
| PG-5.2 | `tools/src/builtins/project-files.ts:245-271` | PARTLY WRONG | `packages/tools/src/builtins/project-files.ts:244-246` (`underLock`), `:254-274` (`assertSeenCurrent`); used at `:303-304` and `:357-361` | "An agent's seen-current check and write happen under the lock" is **already true**: `write_file` and `edit_file` call `assertSeenCurrent` inside `underLock`. The gap is real in two places:<br>• the lock is the **run session's** (`context.session.locks`), so a user save and a chat turn don't take it, and a call without a session takes no lock at all;<br>• two runs don't share it either. |
| PG-5.2 | `docs/user-guide/forge.md:279-283` | CONFIRMED | `docs/user-guide/forge.md:279-283` | — |
| PG-5.3 | AN1 "not yet" `process.*` | CONFIRMED | `CLAUDE.md:283` (AN1 row, "Not yet: … `process.*` events for agent commands") | — |
| PG-5.3 | `config-panel/SkillsField.tsx:28` | CONFIRMED | `config-panel/SkillsField.tsx:27-29` | "Run shell commands in the project folder; each one asks first". It does not say commands can reach outside (D346). Since D342 an allowlisted command does not ask. |
| PG-5.4 | `runs/control/service.ts:379-394` | CONFIRMED | `packages/engine/src/runs/control/service.ts:377-405` | `restart` re-drives the same snapshot with live provider calls. |
| PG-5.5 | `contracts/src/export.ts:12-18` | CONFIRMED | `packages/contracts/src/export.ts:12-18` | — |
| PG-5.7 | D-093 | CONFIRMED OPEN | `docs/defect-log.md:122`; `packages/providers/src/adapters/cli/adapter.ts:132` | Also `cli/claude-models.ts:152` and `cli/resolve.ts:76` pass `options.env ?? process.env`. |
| Ground rules | `docs/domain-progress.md` Phase 0 | CONFIRMED | `docs/domain-progress.md:27` | — |
| Phase 0 | output file | NOTE | — | The prompt names `docs/team-prompts/product-gaps-inventory.md`. This file, for items 1–2, is `docs/team-prompts/product-gaps/inventory-refs.md`. |

## 2. Open work

`gh pr list --state open` returns **nothing**. Every `feat/*`, `fix/*`, `x1/*` and `domain` branch on `origin` has a merged PR:

| Branch | PR | Merged | Note |
|---|---|---|---|
| `x1/model-gateway` | #39 (design), #41 closed | 2026-10-06 | — |
| `x1/model-gateway-impl` | #40 | 2026-10-09 | X1 |
| `fix/goal-node-chat-sessions-cli-models` | #42 | 2026-10-09 | D285–D287 |
| `feat/forge-phase-1` | #44 | 2026-10-10 | F1 |
| `ui/ace-theme` | #46 | 2026-10-12 | D328–D338 |
| `feat/forge-phase-1-rest` | #47 | 2026-10-14 | — |
| `feat/forge-phase-3-4` | #48 | 2026-10-14 | F3+F4 |
| `domain` | #45 | 2026-10-14 | D303–D327 |
| `fix/ollama-model-discovery` | #49 | 2026-10-14 | D-095 |
| `fix/rerun-one-node` | #50 | 2026-10-15 | D-096–D-098 |
| `feat/agentic-nodes` | #51 | 2026-10-15 | AN1 |
| `feat/forge-phase-2-ui` | no PR of its own | — | F2. Its content is on `main` through #48, which carries "merge: Forge phase 2's engine side (terminal, D301)" (`8e13893`) and its fix commits (`aaf2906` 1013 close, `d57fbd6` docs). `git cherry` lists 10 unmatched commits. They are rebased copies of Domain, theme and terminal commits whose content is on main (for example `WS_CLOSE_TRY_AGAIN_LATER = 1013` at `packages/engine/src/events/ws-hub.ts:34`, and `apps/web/src/forge/terminal/`). |

`ahead` counts against `origin/main` (e.g. `feat/forge-phase-3-4` 89, `feat/agentic-nodes` 22) come from rebase-and-merge rewriting SHAs. They are not unmerged work. The local `worktree-agent-*` branches are leftovers of rounds 3–5 and the agentic-nodes waves. Their tips that were checked are on `main` by subject (`46126c5`, `f80f20d`, `134288b`, `0f8345e`). None is a candidate base.

The only unmerged branch is `fix/pg-0-inventory` itself, 2 ahead of `main`:
- `fecceca` adds the prompt.
- `4d98901` adds `ACE_ACCEPTANCE_PORT` and the `product-gaps` folder to both acceptance configs.

**Stale Feature Log rows (CLAUDE.md §9).** These read IN REVIEW but are merged:
- X1: PR #40.
- F1: PR #44.
- F2: through #48.
- F3+F4: #48.
- AN1: #51 (`CLAUDE.md:283`).

The owner should update them to MERGED with SHAs. Any phase that reads §9 to decide what is in flight would otherwise be misled.

**Overlap with work that is decided but not built.** No branch exists for these:

| Pending work | Source | Overlaps |
|---|---|---|
| Agentic nodes Phase 2: access levels, allowlist approvals, **per-step checkpoints**, envelope `workspace`, thinking passthrough, **`process.*` events for agent commands** | AN1 row "Not yet"; `docs/team-prompts/agentic-nodes-prompt.md`; D341, D342 | PG-5.1 and PG-5.3 are the same work, so build each once and say which prompt owns it. PG-2.3 touches the same "no Full auto" theme as D342, but on CLI providers (D262), not node access levels. |
| D-058 | `defect-log.md:87` | PG-3.7 |
| D-093 | `defect-log.md:122` | PG-5.7 |

**Rebase recommendation.** There is nothing to rebase on beyond `main`. Every phase branches from `main` after `fix/pg-0-inventory` merges, so it picks up the acceptance-port change and this inventory. Phase 5 should start only after agentic-nodes Phase 2 is either built or explicitly folded into PG-5.1/5.3.

## Conflicts with D-rows

These D-rows are not in the prompt's X1–X8 table. Each conflict is a stop condition ("an item here conflicts with a D-row not listed") and needs a `DECISION NEEDED` before the phase that hits it.

| PG item | D-row | Conflict |
|---|---|---|
| PG-2.3 (X6) | **D262** (`DECISIONS.md:218`) | D262 created the CLI `full_auto` preset. X6 cites D342, which governs agentic-node access levels, not CLI providers. The X6 D-row must name D262 as the decision it changes. |
| PG-1.2 run controls in the header | **D330** (`:259`), **D331** (`:260`) | D330: the run bar "(start, status, controls, totals)" and the approvals badge leave the header. D331 puts Run controls in the "…" menu. |
| PG-1.2 "Problems & events gets a visible footer button" | **D332** (`:261`), D330 | D332: "The bottom panel is hidden until '…' → Problems & events". D330 fixes the footer's contents. X1/X2 amend D332 only for ports and Add node. |
| PG-1.2 contrast "fix the tokens", PG-4.2 new state colours, PG-1.2 lucide icons | **D328** (`:257`) | D328: every colour and size "is the theme's, copied verbatim". Where a theme colour is below 4.5:1, "the theme wins and `tokens.test.ts` records the measured floor". PG-1.2's axe gate and token fixes reverse that rule. PG-4.2's per-state colours and glyphs replace theme colours. |
| PG-1.2 settings gear as an SVG icon | D338 (`:267`) | Minor. D338 specifies "A ⚙". An icon swap keeps the control, so this probably needs only a note, not a decision. |
| PG-2.4 a run or turn stops when its checkpoint can't begin | **D300** (`:229`), **D302** (`:231`) | D300: "A snapshot that cannot be taken … makes the checkpoint `failed` with its reason while the agent still works". D302: "a checkpoint that cannot begin or finish is logged and the reply still lands". |
| PG-5.2 Forge-terminal edits attributed to the person | **D300** (`:229`) | D300's known limitations say edits from Forge's own terminal "count as the agent's". The user guide repeats this (`forge.md:279-281`). |
| PG-5.1 per-node run checkpoints | D300 (`:229`) | D300: "a run's [checkpoint] begins before its drive … and finishes when the run settles; a Domain `stayOpen` run's spans the whole session". D341 points toward per-step checkpoints, so this is an amendment to record, not a contradiction. |
| PG-1.6 Domain "Retry on a failed node turn, using the existing node retry"; PG-3.5 Restart from any mode | **D323** (`:252`) | D323: restart, rerun and retry are "Refused (409) on a running or parked Domain run". A failed turn inside a parked Domain run cannot use node retry. |
| PG-2.2 chat tool guardrails with "the same `ask_user` approvals as runs" | D302 (`:231`), FR-CHAT-005; contract `guardrails.ts:308-312` | `ApprovalRequest` requires `runId` and `nodeRunId`. D302 keeps a chat turn free of runs and node runs. This needs a contract change the prompt does not describe. |
| PG-1.3 `missing_provider` issue | D287 (`:225`); contract `validation.ts:77,90` | Not a D-row conflict but a contract one. `missing_model` and `provider_missing` already exist. D287 already refuses a chat with no model (400). |
| X8 | D300, D340 | Already resolved in DECISIONS (see X8 above). The remaining question is only whether to add a TC-GIT-002 test that asserts the D300 behaviour. |

Checked with no new conflict: D285 (X4), D303 (X5, see note), D335 (X3), D336 (X7), D341 (PG-5.1 follows it), D342 (except the D262 misattribution), D346 (PG-5.3 implements its "UI must say so plainly").
