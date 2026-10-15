# ACE — Product gaps: one connected product, not three screens

> Build prompt for Claude Code. Save as `docs/team-prompts/product-gaps-fix-prompt.md` and run it from the repo root. Each phase is its own branch and PR (names below), rebased on `main`. Read `CLAUDE.md` first, all of it.

## Goal

ACE is judged here as a **finished product**, not a POC. "Deferred to a later round" does not excuse a gap in this prompt.

Today the engine is sound: envelopes are built and checked on every handoff, runs execute from a snapshot, and budgets are enforced. What a user meets is not sound:

- **Building is blocked.** A node can't be connected by dragging a line.
- **Controls are hidden.** Settings and other buttons can't be seen.
- **Nodes can be broken from birth.** A node is created with no provider chosen.
- **Local models are buried.** Ollama and other local or open models are mixed into one flat list.
- **Failures vanish.** A failed message never shows.
- **Chat is bare.** There is no resend, retry, edit or copy.
- **Contracts aren't enforced.** A JSON contract set in the UI is never checked.
- **The modes don't connect.**
  - Ideate, Forge and Domain each hold their own idea of "the current run".
  - The canvas sticks on RUNNING after a visit to Domain.
  - Nodes can't be followed from one mode to another.

After this work, one workflow and one run are seen consistently through three modes. Every control a user needs is visible. Every node has a provider. Every failure is shown with a way to retry. Every contract the user sets is enforced.

## Ground rules

- **`CLAUDE.md` §7 applies in full.**
  - Exact enum names from `packages/contracts`.
  - TDD on the mock provider. `pnpm test` stays green with zero env vars.
  - Never weaken a test or threshold.
  - Never claim done without pasting the real gate output.
- **Reproduce before you fix.** Every item starts as a **red test** that shows the user's symptom.
  - Use a Playwright test against the real engine (mock provider) for anything a user sees.
  - Use Vitest for engine and contract behaviour.
  - The test name cites the item ID below (e.g. `describe("PG-1.1 drag a line from an output to an input")`).
  - **This prompt requires e2e for Phases 1–3.** The no-e2e choice of Forge 3+4 does not apply here.
- **One developer (D94, §6.3).** You may edit every path this prompt names. Any change to `packages/contracts` lands **first**, in its own commit at the start of the phase, and its PR body quotes the contract section below that it implements.
- **Numbering.** New decisions start at **D350**. New defects start at **D-099**. Append only.
- **Windows first.** Gate command on Windows: `pnpm -r --workspace-concurrency=1 --no-bail test` (see `docs/domain-progress.md` Phase 0 for why).
- **No demo data.** Every new UI element shows real engine state, or it is not built.
- **File references in this prompt are starting points** from a read of `main` at `17467f9`. Phase 0 confirms each one. If a reference is wrong, use what you find and say so in the inventory.
- **Spec conflicts are flagged, never resolved quietly.** The table below lists every locked decision this prompt changes. The owner has decided each row: record it as a D-row in the same commit as the first code that relies on it. Anything else that conflicts → `DECISION NEEDED` (CLAUDE.md §7) and stop.

---

## Decisions this prompt changes (owner's decisions — record as D350+)

| # | Locked today | Change | Why |
|---|---|---|---|
| X1 | **D332** — port handles stay invisible | Ports are visible: on hover and on a selected node at least, always while a connection is being dragged | Users can't find where to drag from (PG-1.1) |
| X2 | **D332** — "Add node" adds an Agent with the first CONNECTED provider (`canvas/graph-plans.ts:97`) | No node is created until the user picks a provider and model | A node with no or the wrong provider is broken from birth (PG-1.3) |
| X3 | **D335** — the chat aside drops "Actions +" | Every message gets actions: Copy, Retry, Edit & resend, Delete; plus Stop while streaming | Users need to recover from failures (PG-1.6) |
| X4 | **D285** — no output-type picker on Agent | A JSON schema on a node **implies** `json` output. The engine treats `outputContract.jsonSchema` as `outputTypes ⊇ ['json']`, and the UI says so | The contract is never enforced today (PG-2.1) |
| X5 | **D303** — Domain is a sibling route of WorkflowLayout | Domain becomes a child of WorkflowLayout. It keeps its full-screen look by hiding the chat column, but the sockets, the run store and the chat socket live in the layout | One spine for all three modes (PG-3.1) |
| X6 | **D342** says "no Full auto", but CLI presets still have `full_auto` (`contracts/src/providers.ts:57`, `claude-code.ts:39`, `codex.ts:30`) | Remove `full_auto` from what the UI offers. Existing providers on it migrate to `edit_files`, with a notice. The contract keeps the value only so old rows still parse | It bypasses every ACE approval, budget and guardrail (PG-2.3) |
| X7 | **D330/D336** — one Split toggle means Chat in Ideate/Forge and Team in Domain | Two toggles, labelled Chat and Team, each remembered on its own | Closing one shouldn't close the other (PG-3.8) |
| X8 | **FR-GIT-004 / TC-GIT-002** still say "editor read-only during runs"; D300 and D340 replaced that | Post `DECISION NEEDED`: amend the FRS wording, or record in DECISIONS that D300 supersedes it and rename TC-GIT-002's test. Recommend the second, since the FRS is read-only mid-build | A spec-first test would fail today |

---

## Phase 0 — Inventory and red tests (no behaviour changes)

Branch `fix/pg-0-inventory`. Write `docs/team-prompts/product-gaps-inventory.md`:

1. **Confirm or correct** every file reference in this prompt, with the real file and line.
2. **Open work.** List open PRs and branches (F1–F4, X1, AN1 / PR #51, `fix/*`). Say which items below they already touch, and whether each phase should rebase on them.
3. **Reproduce the six user-reported symptoms** in a real browser against `pnpm dev` (mock provider and a local Ollama if one is installed). Record exactly what is seen, with screenshots saved under `docs/team-prompts/product-gaps/` in light and dark, at 1440 px and 380 px wide.
4. **Visibility audit.** Walk every route: Home, Project, Ideate, Forge, Domain, Run detail, Timeline, Providers, Settings, Onboarding. List every control that is:
   - icon-only
   - a unicode glyph (e.g. `⚙︎ ⛶ ⌕ ⌁ ✳ ✎ ◦ 🔒︎`; there are about 22 glyph types across `apps/web/src`)
   - opacity-0 until hover
   - under WCAG AA contrast: 4.5:1 for text, 3:1 for icons and borders, on `--surface`, `--panel` and `--canvas`
   - reachable only by double-click or a context menu
5. **Commit the red tests** for every PG item in Phases 1–2, marked `test.fail()` or `it.fails` with the item ID. They turn green as each fix lands.

Gate 0: the inventory is committed, the red tests run and fail for the right reason, and the existing suites are still green.

---

## Phase 1 — The six things users hit first

Branch `fix/pg-1-canvas-chat-ux`. Split into parallel worktrees (D88): **A** canvas (1.1–1.3), **B** providers (1.4), **C** chat (1.5–1.6). Wire the seams by hand.

### PG-1.1 Draw a connection by hand

**Today**
- Ports are 12 px handles with `opacity: 0` (`packages/ui/src/theme.css:297-307`, `nodes/NodeCard.tsx:88-140`), so there is nothing visible to drag from.
- A click on the card opens settings (`canvas/Canvas.tsx:1036-1043`). A drag that starts near a port may land on the card and open the modal instead.

**Build**
- **Visible ports.** Show port dots (8 px visual, at least 20 px hit area) on hover, on the selected node, and on every compatible port while a connection is being dragged.
  - Incompatible ports dim, with the reason in a tooltip.
  - Colour comes from the data type.
  - Ports sit above the edge layer.
- **No accidental settings.** Settings open on click only when the pointer didn't move (>4 px = drag) and the target isn't a port.
- **Drop on the card.** Dropping a line anywhere on a card connects to that card's first compatible input. If more than one fits, show a small chooser.
- **Menu route.** The node's ⋯ menu gets "Connect to…" (pick a node), for trackpads and touch.
- **Keep what works.** Keep keyboard connect (NFR-USE-02) and the refusal toasts (FR-CON-002/003/005).

**Tests**
- Playwright, real engine: drag out→in creates an edge (assert via `GET /workflows/:id`).
- Drop on a card body connects.
- A refused drop shows its reason.
- A drag that starts on a port never opens settings.
- Also the light and dark theme at 100% and 50% zoom.

### PG-1.2 Every control visible

**Build**
- **Real icons.** Add one SVG icon set to `packages/ui` (`lucide-react`, tree-shaken) and replace every unicode glyph used as a control, including the settings gear (`app/layout/SettingsMenu.tsx:22`). Glyphs depend on the font and render as boxes or not at all on some Windows setups.
- **Node card buttons.** Each card gets always-visible buttons: ⚙ Settings and ⋯ More (Open in Domain, Connect to…, Duplicate, Delete, Run from here), each with an aria-label.
- **Run controls in the header** in all three modes: Run / Pause / Stop / Restart, enabled from `allowedRunActions`.
  - Today they live only in Ideate's "…" menu (`canvas/Canvas.tsx:262`).
  - Problems & events gets a visible footer button.
- **Contrast.** Every audited control meets the Phase 0 contrast bar in both themes. Fix the tokens, not single components.

**Tests**
- An axe-core Playwright scan of every route in both themes: no contrast or name violations.
- A test that fails on any unicode glyph inside a `<button>` (lint rule or unit test over the source).

### PG-1.3 No node without a provider

**Today**
- `planNewStage` silently picks the first CONNECTED provider, else `providers[0]`, else nothing (`canvas/graph-plans.ts:73-104`).
- Drop, paste, duplicate, templates and import can all create Agent/Model nodes with no provider.

**Build**
- **Add node opens a picker first:** provider, then model, grouped as in PG-1.4. No `add_node` op is sent until both are chosen. Cancel creates nothing.
- **No connected provider.** The picker shows "Connect a provider" (→ Providers page), plus Ollama detection (FR-PRV-007) inline.
- **Every other path that makes a node:**
  - Palette drop and duplicate use the picker.
  - Paste and import keep the source's provider. If it isn't present, the node lands in a visible **"Choose a provider"** state, a red card that the run can't start past.
  - Templates ask once for a provider to use for every node.
- **Engine.** `packages/engine/src/graph/validate.ts` / `runs/preflight.ts` return a named issue (`missing_provider`) for any Agent/Model node with no provider or model. Graph ops are **not** refused, so old workflows still load.

**Tests**
- The Add node flow creates nothing on cancel.
- It creates a node with the chosen provider and model.
- Pre-flight blocks a providerless node with that issue.
- An imported workflow with an unknown provider shows the "Choose a provider" state.

### PG-1.4 Local and open models get their own section

**Build**
- Group every provider picker (node settings, Add node, Providers page, Models tab) into:
  - **Cloud APIs:** anthropic, google, openai.
  - **Local & open models:** `ollama`, plus `openai_compatible` whose base URL is loopback or LAN (LM Studio, llama.cpp, vLLM).
  - **CLI agents:** claude_code, codex_cli, gemini_cli.
  - **Custom endpoints:** remote `openai_compatible`.
  - The grouping is a pure function in `packages/contracts` (`providerGroup(provider)`), so the engine and web agree.
- The Local & open section shows:
  - the models found on the machine (`ollama` tags)
  - each model's size and whether it supports tools or JSON (from the catalogue)
  - "Free · runs on your machine" instead of a price
  - a "Pull a model" hint with the exact `ollama pull <name>` command when the list is empty
- Cost displays treat local models as $0 by rule, and unpriced remote models as **unknown**, never $0.

**Tests**
- Unit tests for `providerGroup`.
- A component test for the grouped picker.
- An e2e that a detected Ollama appears under Local & open with its models (MSW for the Ollama tags).

### PG-1.5 A failed message always shows

**Today**
- The UI has error paths: "not sent" (`chat/ChatConversation.tsx:314-319`) and "could not answer" turns (`:245-258`).
- But if `generateReply` throws after the gateway answered 202, the engine only logs (`packages/engine/src/chat/service.ts:823-825`). No failed turn is stored and no `chat.message` is sent, so the client shows "typing…" forever.
- Domain never reads `failureReason`, and a failed post's message can be lost on navigation.

**Build**
- **Engine.** Every accepted chat turn ends in exactly one stored message, a reply or a failed turn with `error`, and one `chat.message` frame. Wrap the whole reply path. A crash or restart marks open turns failed on startup (`shutdown` / `crash`).
- **Client stall rule.** If no `chat.token` or `chat.message` arrives within the node's timeout plus 10 s, the turn shows "No answer — Retry" (and re-reads the thread first).
- **Domain.**
  - A failed turn shows its `failureReason` in words: contract violation, provider failure or guardrail block.
  - A failed post keeps its text in the composer with a Resend button.
  - A 409 "run has ended" says so and offers "Start a new run with this message".

**Tests**
- Vitest: a throw anywhere after acceptance stores a failed turn and emits it.
- Playwright: a mock model set to fail shows the failure in Ideate chat and in Domain, with Retry.

### PG-1.6 Message actions in chat

**Contract** (lands first)
- `POST /chat/threads/:id/messages/:messageId/retry` — re-runs the turn that produced this agent message, or the failed one. It appends a new turn and keeps the old one marked `superseded`.
- `POST /chat/threads/:id/messages/:messageId/edit { content }` — for a user message.
  - Messages after it are marked `superseded`, and the edited text is sent as a new turn.
  - If a checkpoint covers the superseded turns, the UI offers to revert their file changes.
- `DELETE /chat/threads/:id/messages/:messageId` — hides one message. It is kept in the event log and never sent to the model again.
- `POST /chat/threads/:id/stop` — aborts the turn in flight. The turn is stored as `user_cancelled`.
- New frame `chat.update` for superseded or deleted rows. Reuse the existing `domain.ts:999` shape if it fits, otherwise make a new one.

**UI**
- On hover, and always on touch, each message offers:
  - Copy (text, code blocks separately)
  - Retry (agent or failed messages)
  - Edit & resend (user messages)
  - Delete
- The composer gets Stop while a reply streams.
- Superseded turns collapse into "Earlier version".
- **Domain** (a projection of the log, D303, so no edit or delete there):
  - Copy on every message.
  - Retry on a failed node turn, using the existing node retry (FR-EXE retry).
  - Resend on a failed post.

**Tests**
- Contract tests for each route.
- An engine test that a superseded or deleted message never reaches the next prompt.
- Playwright for each action.

Gate 1: all PG-1 tests green, Phase 0 red tests for PG-1 flipped, full gate output pasted.

---

## Phase 2 — Correctness the user can't see

Branch `fix/pg-2-contracts-safety`.

### PG-2.1 Output contracts are enforced

**Today**
- The Agent modal sets `outputContract` only (`config-panel/panels.tsx:186-215`).
- Agents default to `['text']` (`nodes/factory.ts:68`).
- The engine parses and validates JSON only when `outputTypes` has `json` (`runs/executor.ts:1422`, `contracts/src/envelope.ts:300-306`).
- So the schema is ignored, and Review→Fix loops are refused with `loop_source_not_json` (`contracts/src/graph.ts:514-518`).

**Build**
- **Engine:** a schema implies JSON output (X4), in one helper used by the executor, envelope building and graph validation.
- **UI:** the contract section says "Output will be JSON and checked against this schema", and shows the last run's verdict.
- **Provider support:** pass `jsonSchema` to providers that support structured output (`providers/src/adapters/ai-sdk.ts:355-366` drops it today); prompt-only enforcement stays the fallback.
- **Blocked combinations,** each with a reason in the model picker, in `validate.ts` and in pre-flight:
  - a CLI or any model with `supportsJson:false` together with a schema
  - tools or skills on a model with `supportsTools:false`
  - Today the executor drops these silently (`executor.ts:755, 977`).

**Tests**
- TC-EXE-005 path from the UI: set a schema in the modal, the run returns non-conforming JSON, and the node shows `CONTRACT_VIOLATION`.
- The Review→Fix loop can be built from the UI.

### PG-2.2 Chat obeys budgets and tool guardrails

Chat turns have no `runId` and no cost cap (`chat/service.ts:422-423, 515`), and they skip `evaluateTool` (used by runs only, `runs/index.ts:747`).

**Build**
- Chat spend counts toward `dailyBudgetUsd`.
- A per-turn cap comes from the project's `maxCostPerRunUsd`, unless a new `maxCostPerChatTurnUsd` is added (contract).
- Tool-point guardrails run on every chat tool call, with the same `ask_user` approvals as runs.
- The chat UI shows a turn's cost, and refuses with the budget reason.

### PG-2.3 No silent Full auto

Apply X6:
- Remove the option from `providers/provider-meta.ts` and the provider dialog.
- Add a startup migration that moves `full_auto` rows to `edit_files` and leaves one notice.
- Add a test that no code path builds `bypassPermissions` or `--dangerously-bypass-approvals-and-sandbox`.

### PG-2.4 No silent loss of undo

A failed checkpoint start is only logged, and the run or turn goes on (`runs/index.ts:2918-2927`, and the same in chat).

**Build:** a writing run or turn whose checkpoint can't begin stops before its first write. It shows "Can't record changes for undo — Run without undo / Cancel". "Run without undo" is a one-time choice, written to the run's events.

Gate 2: as Gate 1.

---

## Phase 3 — One spine across the three modes

Branch `fix/pg-3-one-spine`.

### PG-3.1 Domain inside WorkflowLayout

Apply X5:
- Move `/domain` under the layout's children (`app/routes.tsx:37-47`).
- Hide `ChatAside` on Domain.
- Remove Domain's own registration of the mode shortcuts (`domain/DomainPage.tsx:52-56`).
- `useWorkflowSubscription`, `useRunEvents`, `useAdoptActiveRun` and `useChatSocket` must stay mounted across all three modes. Test that each mounts **once** across Ideate → Forge → Domain → Ideate.

### PG-3.2 One selected run

**Build**
- `selectedRunId` lives in the URL (`?run=`) and is read through one hook, `useSelectedRun()`, by all three modes, the footer and the Inspector.
- Default: the live run, else the newest.
- `workflowPath()` (`forge/mode.ts:9-12`) and every mode switch (ModeSwitch, shortcuts, `DomainPage.tsx:236`) carry `?run=` and `?node=`.
- **Re-adopt on return.** Coming back to a mode re-adopts the selected run, whether finished or live (`runs/hooks.ts:160-176` adopts only a live newest run and never resets). This fixes the canvas stuck on RUNNING and the disabled Start / Run pipeline buttons.
- **Rebuild attribution.** `adopt` rebuilds `tool.call` writes (`run-store.ts:195-238`), so Forge attribution survives reloads and finished runs.

### PG-3.3 One source of node state

- Domain's TeamPanel reads node state and tokens from the run store, not `conversation.usage` (`DomainPage.tsx:91-96`).
- Domain's reducer keeps messages only.
- Domain hears the run end (`run.completed` / `run.halted` / `run.blocked`): the pill updates and the live composer turns off.
- The engine closes the SSE pump on a terminal state (`engine/src/domain/chat-stream.ts:134-153`).
- The footer's token count reads one source in every mode (`WorkspaceFooter.tsx:119-129`).

### PG-3.4 Follow a node anywhere

- **Domain → canvas.** A Domain message, roster row or filter pill gets "Show on canvas": go to Ideate with `?node=`, then select it and centre the view on it.
- **Canvas → Domain.** Its "Open in Domain" (`Canvas.tsx:188-200`) carries `?run=`.
- **Forge → node.** The Forge attribution (`forge/editor/PathBar.tsx:116-130`) becomes a link to the node in Ideate and in Domain, and shows the model used.
- **Shared selection.** `useSelectionStore` holds the focused node for all three modes. Selecting in one highlights it in the others on arrival.

### PG-3.5 Controls and approvals in every mode

- Mount `ApprovalStack` in Domain and Forge.
- A WAITING-for-approval node is approvable from any mode.
- The header run controls from PG-1.2 sit in all three modes. Restart keeps the mode (`WorkspaceMenu.tsx:402` jumps to `/runs/:id` today).
- A Domain-started run parked open (D323) shows "Waiting for you — End run" in Ideate and Forge instead of a silently disabled Start.

### PG-3.6 Chats you can find

Ideate's direct node chat and Domain's run messages are separate channels (`useChat.ts:83` vs `DomainPage.tsx:251`).

- Domain's node lens lists that node's direct chat threads (read-only, with a link).
- The chat aside shows a "Run" tab with the selected run's conversation.
- If you'd rather merge the channels, post `DECISION NEEDED` (recommend keeping two channels, linked both ways).

### PG-3.7 Every entry point offers every mode

Mode links on all of these:
- Home cards (`ProjectsPage.tsx:17`)
- project workflow cards
- Run detail (adds Forge)
- Timeline (`TimelinePage.tsx:34`)
- Import
- Onboarding's finish

Also:
- Domain gets a compact layout (`useIsCompact`).
- Close **D-058**: a Timeline-started run lights the canvas.

### PG-3.8 Separate Chat and Team toggles

Apply X7.

Gate 3: an e2e "one run, three modes" walk:
1. Start a run in Ideate.
2. Switch to Forge mid-run, then to Domain.
3. Let it finish in Domain.
4. Return to Ideate.

Assert the same run id, final states and token totals in all three modes and the footer, with nothing stuck RUNNING.

---

## Phase 4 — Make the thesis visible

Branch `fix/pg-4-envelopes-states-cost`.

### PG-4.1 Envelopes on screen

**Before a run**, the settings modal gets a **Reads** section:
- upstream nodes by name and port
- the context budget split (`CONTEXT_BUDGET_SHARES`, `envelope.ts:89`)
- the computed reads budget (`readsBudgetFor`, `envelopes/index.ts:65-69`)
- the output contract

**After a run**, the Inspector shows:
- the source **node names**, not `fromNodeId.slice(-6)` (`Inspector.tsx:316-332`)
- `contract`, `maxTokens`
- used vs budget
- `resolvedModelId`

**In Domain,** each delivered message gets "View envelope", linked by `teamEnvelopeId`.

### PG-4.2 States you can tell apart

- **Canvas** (`apps/web/src/theme/format.ts:38-48`): IDLE, READY, WAITING, PAUSED and STOPPED share one grey today; BLOCKED and FAILED share red. Give each state its own colour and glyph.
- **Domain** (`domain/looks.ts:73-83`): stop collapsing four states into "Waiting".
  - Read `failureReason`.
  - Show `haltReason` on the run pill (`DomainPage.tsx:374-375`).
  - Use a different mark for FAILED, STOPPED and INTERRUPTED (`Conversation.tsx:326-332`).
- **RunBar:** a `budget_exceeded` halt is no longer coloured as a failure (`RunBar.tsx:36`).
- **Overlay:** counts PAUSED and WAITING as live (`Canvas.tsx:635-636`).

### PG-4.3 Cost before you run

**Contract:** `POST /workflows/:id/estimate` returns per-node and total `{ minUsd, maxUsd, unknown: boolean }` from the price table and `maxTokens`. Local models count as 0; unpriced models count as unknown.

**UI**
- The start-run flow shows the estimate and the remaining budget.
- Each card shows its node's estimate.
- A per-node cost cap is added (contract plus engine enforcement at post-node).

### PG-4.4 The overlay matches what is running

While a run is live:
- the overlay draws from the run's **snapshot graph**, not the live graph (`Canvas.tsx:124,144`, `run-store.ts:318-333`)
- a node deleted after dispatch shows as a ghost card
- an edited node shows "changed since this run started"
- the Inspector never falls back to "this node" (`Inspector.tsx:70`)

### PG-4.5 Nothing the engine records is hidden

**Surface in the Inspector and Domain:**
- `NodeRun.memoryOps` — what was remembered or forgotten.
- `reusedFromNodeRunId` — "reused from run …", not a fresh $0 run.

`Envelope.guardrailVerdicts` is never filled by the engine. Fill it from the input checks, or post `DECISION NEEDED` to drop the field.

Gate 4: as Gate 1, plus the e2e walk from Gate 3 asserting the envelope, state and cost displays.

---

## Phase 5 — Forge safety, replay, export, bench

Branch `fix/pg-5-forge-replay-bench`.

- **PG-5.1 Per-node checkpoints.**
  - Run checkpoints become `{ kind: 'run', runId, nodeId }` per writing node step (`runs/index.ts:2923`), as D341 promised.
  - Changes can revert one node's work.
  - Run detail links to its checkpoints, and Changes links back to the run.
- **PG-5.2 Close the save race.**
  - User saves take the same per-path write lock as agents (`tools/src/builtins/project-files.ts:245-271`).
  - An agent's "seen current" check and write happen under the lock.
  - Add a test for the interleaving.
  - Edits from Forge's own terminal during a recording are attributed to the person (`docs/user-guide/forge.md:279-283`).
- **PG-5.3 Agent commands are visible.**
  - Add `process.*` events for agent commands (AN1 "not yet").
  - Add D346's plain-language UI text that `run_command` can reach outside the project. Fix `config-panel/SkillsField.tsx:28`.
- **PG-5.4 Replay and compare.**
  - "Replay run" re-executes a snapshot from its recorded provider outputs, with zero provider calls. It is distinct from Restart (`runs/control/service.ts:379-394`).
  - "Compare runs" shows two runs side by side: per-node output diff, tokens, cost, time.
  - New routes go in the contract first.
- **PG-5.5 Run export for judging.**
  - A run export bundle: the outputs, the run record and the event log.
  - An option to anonymise it (strip node names, model and provider) for blind judging.
  - `WorkflowExportSchema` has no runs today (`contracts/src/export.ts:12-18`).
- **PG-5.6 ACE Bench, minimum.**
  - Arms: this workflow vs a single-node baseline that gets the **same tool layer**.
  - Frozen task list.
  - N repetitions.
  - Export through PG-5.5.
  - Pre-registered outcome notes stored with the bench.
  - Write `docs/team-prompts/ace-bench-plan.md` first, and get it approved before building.
- **PG-5.7 Prove the providers.**
  - Codex CLI, Gemini CLI and the API tool loop each get a `@provider` test in `pnpm test:providers`. Today Codex and Gemini are tested with fake CLIs only.
  - Close **D-093** (CLI env not scrubbed).

Gate 5: as Gate 1.

---

## Stop conditions

Stop and post `DECISION NEEDED` if:
- a fix needs a contract change not described here
- a red test from Phase 0 turns green before its fix (the symptom was misread)
- a change would edit an existing Drizzle migration
- you'd need to break an existing workflow's ability to load
- an item here conflicts with a D-row not listed in the table above

## Done means

- [ ] Every PG item has a test named by its ID, red in Phase 0 and green now.
- [ ] Gates 0–5 green on Windows with the pasted output; coverage ≥ 80 % engine-side and ≥ 60 % web/ui/sdk.
- [ ] The Gate 3 "one run, three modes" e2e passes.
- [ ] The axe scan is clean in both themes.
- [ ] D350+ rows recorded for X1–X8 and anything decided on the way.
- [ ] Defects found on the way logged from D-099.
- [ ] CLAUDE.md §9 has one row per phase.
- [ ] `docs/user-guide/` is updated for:
  - connecting nodes
  - provider-first Add node
  - local models
  - chat actions
  - mode switching
  - replay and compare
  - bench
- [ ] Each PR body is the Deliverable report (CLAUDE.md §8.6).
