# Product gaps — Phase 0, items 3 and 4

Part of the Phase 0 inventory for `docs/team-prompts/product-gaps-fix-prompt.md` (branch `fix/pg-0-inventory`, base `4d98901`). This covers item 3 (the user symptoms, reproduced) and item 4 (the visibility audit). Nothing in product code was changed.

**How it was run.** A real engine (`tests/acceptance/helpers/start-for-playwright.ts`, temp data dir, mock provider) on port 47610 and the production web build (`vite build` with `VITE_ACE_URL`, `vite preview`) on 47611. The recorder is `tests/acceptance/product-gaps/audit.e2e.ts` with `in-page-audit.ts`. It is skipped unless `ACE_PG_AUDIT=1`:

```
ACE_PG_AUDIT=1 ACE_ACCEPTANCE_PORT=47610 pnpm exec playwright test \
  --config tests/acceptance/playwright.config.ts product-gaps/audit
```

It asserts nothing about the product. It seeds data over REST, drives the UI, saves PNGs here, and writes what it measured to `<os tmpdir>/ace-pg-audit.json`. The tables below were built from that file.

**Local models.** No local Ollama was running: `GET http://127.0.0.1:11434/api/tags` gave `fetch failed`. To still show where local models land, the recorder starts a loopback stub on 47612 that answers `/v1/models` the way Ollama and LM Studio do (`llama3.2:3b`, `qwen2.5-coder:7b`, `phi4-mini:latest`). Two providers point at it: `ollama` "Ollama (local stub)" and `openai_compatible` "LM Studio (local stub)". Both reached CONNECTED. The run also has an `anthropic` provider with a fake key (AUTH_FAILED) and a remote `openai_compatible` (UNREACHABLE). No real model was called.

**Screenshots.** They are named `s<N>-<slug>-<theme>-<width>.png`: light and dark, 1440 × 900 and 380 × 760, viewport only. The theme is forced through the app's own key, `localStorage['ace-theme']` (`apps/web/src/theme/mode.ts:12`). `a-<route>-light-1440.png` is one view per audited route. Twelve 1440 px shots of the canvas or chat are 300–380 KB. The canvas's radial glow and dot grid do not compress well, and no PNG quantiser is installed in the workspace (sharp, pngjs and PIL are all missing), so these were left as they are.

**At 380 px, editing is off by design.** The phone layout says "Editing is available on a larger screen". Add node, the node settings modal and the provider picker therefore do not exist at 380 px. Where a symptom needs them, the 380 px shot shows the compact layout as it is.

---

## 3. Reproduced symptoms

| # | Symptom | Reproduced? |
|---|---|---|
| 1 | Can't connect nodes by dragging | **Yes, mostly.** The ports cannot be seen. Only a drag that starts within about 6 px of an invisible 7.7 px dot connects. A drag from where a port would be expected moves the card, and a drop on a card body does nothing. |
| 2 | Settings and other controls not visible | **Yes.** The settings gear is 18 × 18 px with an 11 px glyph. On a phone it is gone. Desktop Ideate has no run controls in its header, and on a phone they overflow off the screen. |
| 3 | Node created with no provider | **Yes, both ways.** With no provider, Add node makes "no provider · no model". With providers, it picks the first CONNECTED one without asking. |
| 4 | Local models in one flat list | **Yes.** One ungrouped list of 5 providers, and one 37-row model table. |
| 5 | A failed message never shows | **Yes, for a reply that never ends.** It stays "typing…" for good and blocks every later chat turn in the project. A provider error (503) *does* show. Domain shows the error text but no failure state and no Retry. |
| 6 | Chat has no resend / retry / edit / copy | **Yes.** No message has any action. |
| M1 | Canvas stuck on RUNNING after visiting Domain | **Yes.** The engine says COMPLETE, while Ideate still shows "Running" and offers Pause / Stop with no Start. |
| M2 | Nodes can't be followed across modes | **Yes.** Neither `?node=` nor `?run=` is carried. Domain has nothing that leads back to the Canvas. |

### S1 — A node can't be connected by dragging a line

**Steps.** Import a workflow with two unconnected Agents, Writer and Review (mock-text). Open Ideate at 1440 px; the Canvas fits to 64 %. Each drag below ran on a board of its own, so a card moved by one drag could not affect the next. The mouse moves in 20 steps between down and up. The result was then read with `GET /workflows/:id`.

**Seen.**

- **The port.** It is the React Flow handle at the left or right edge of the round icon, inside the card, not at the card's edge. At 64 % zoom it is 7.7 × 7.7 px with `opacity: 0` and a transparent background. Hovering the card changes nothing: its opacity stays `0`. Nothing marks where to start a drag (`s1-connect-*`).
- **Four drags:**

  | Drag | A line follows the pointer? | Edge created | Side effect |
  |---|---|---|---|
  | a) From the card's right edge, at the port's height, to the next card's left edge (where a user aims) | no | **no** | **Writer card moved** (`s1-drag-a-card-edge-light-1440.png`) |
  | b) From the exact output handle to the middle of the Review card | yes | **no** | the line just vanishes (`s1-drag-b-handle-to-body…`) |
  | c) From 6 px beside the output handle to the exact input handle | yes | yes | — |
  | d) From the exact handle to the exact handle | yes | yes | — |

- **Settings did not open** at the end of any of the four drags. The worry that "a drag lands on the card and opens the modal" did not show up with a real mouse drag, because `onNodeClick` only fires on a click without movement. A pure click still opens settings, by design (D332).
- **At 380 px** the Canvas is read-only and fits to 25 %, so there is nothing to drag (`s1-connect-*-380`).

**Screenshots.** `s1-connect-light-1440.png` · `s1-connect-dark-1440.png` · `s1-connect-light-380.png` · `s1-connect-dark-380.png` (pointer resting exactly on Writer's output port). Plus `s1-drag-a-card-edge-light-1440.png`, `s1-drag-b-handle-to-body-light-1440.png`, `s1-drag-c-near-miss-light-1440.png` and `s1-drag-d-exact-light-1440.png`.

**Root cause.**

- `packages/ui/src/theme.css:296-307` sets `.react-flow__handle.ace-port` to `opacity: 0`, 12 px. The prompt cited `:297-307`.
- It is visible only on `:focus-visible` or `[data-armed]` (`:308-313`). Nothing reveals it on hover.
- `apps/web/src/nodes/NodeCard.tsx:91-142` (`PortHandle`) places it from `portAnchor`. That is `apps/web/src/nodes/anchors.ts:20-21`: stage in `(77,118)`, out `(133,118)`, which is the icon circle and not the card edge.
- A drop on the card body is not handled: React Flow only accepts a drop on a handle or within the connection radius.

### S2 — Settings and other controls can't be seen

**Steps.** Open Ideate at each width and theme. Measure the settings trigger (`data-testid="settings-menu"`) and look for run controls in the header.

**Seen.**

| Look | Settings gear | Run / Pause / Stop / Restart buttons |
|---|---|---|
| light 1440 | visible, **18 × 18 px**, glyph `⚙︎` at **11 px**, bottom-left of the 24 px footer | **0 in the header.** They exist only inside the "…" workspace menu |
| dark 1440 | same: 18 × 18 px, 11 px | 0 |
| light 380 | **absent** (no footer). Settings is reachable only through the compact "…" Menu | 4. With no run, a disabled Pause / Resume / Stop / Restart / End column plus "the engine did not say which controls this run allows" **overflows off the right edge** |
| dark 380 | absent | same overflow |

- The theme toggle's moon `☾` renders as a "C"-like mark at 10 px on this Windows setup.
- The gear's border is `--line` on `--canvas` at 1.15:1 in light and 1.32:1 in dark (see §4.4).

**Screenshots.** `s2-controls-light-1440.png` · `s2-controls-dark-1440.png` · `s2-controls-light-380.png` · `s2-controls-dark-380.png`.

**Root cause.**

- `apps/web/src/app/layout/SettingsMenu.tsx:22` is the glyph. `:26-27` is the footer trigger class, 18 px and 11 px. The prompt cited `:22`, and that is correct.
- The run controls sit only in `apps/web/src/app/layout/WorkspaceMenu.tsx:212-250`. The prompt cited `canvas/Canvas.tsx:262`, which is where `CanvasBreadcrumb` mounts that menu.
- At 380 px, `apps/web/src/runs/controls/RunControls.tsx:45` (`UNKNOWN_ACTIONS`) renders inside `apps/web/src/app/layout/CompactTopBar.tsx:62-66`.

### S3 — A node is born with no provider, or with one picked for the user

**Steps.**

- **(a) With providers.** The engine has PG mock (CONNECTED), two local stubs (CONNECTED), Anthropic (AUTH_FAILED) and Remote endpoint (UNREACHABLE). On a one-node board, click **Add node**.
- **(b) With no providers.** Use the harness's `POST /engine/fresh` (a new, empty data dir). Create a project and an empty workflow over REST, open Ideate and click **Add node** twice. The original engine is restored afterwards.

**Seen.**

- **(a)** The node is written at once with `providerId` = PG mock, `modelId` = `mock-text`: the first CONNECTED provider and its first model. Only after that does the settings modal open on it (`s3-add-node-*`). There is no step where the user chooses.
- **(b)** Two nodes are made with **no `providerId` and no `modelId`** in their config. The card reads "no provider · no model" in the normal muted style, as an ordinary Idle card. It is not red and has no warning, and the second node is linked to it.
  - The engine's `POST /workflows/:id/validate` does flag the problem, with `missing_model` ("has no provider and model chosen yet") and `missing_input`.
  - The prompt's new issue code is `missing_provider`. Today the code is `missing_model`, which Phase 1 should reuse or rename.
- At 380 px there is no Add node at all (editing is off).

**Screenshots.** `s3-add-node-light-1440.png` · `s3-add-node-dark-1440.png` · `s3-add-node-light-380.png` · `s3-add-node-dark-380.png` · `s3-no-provider-light-1440.png` · `s3-no-provider-dark-1440.png` · `s3-no-provider-light-380.png` · `s3-no-provider-dark-380.png`.

**Root cause.** `apps/web/src/canvas/graph-plans.ts:97` reads `providers.find(status === 'CONNECTED') ?? providers[0]`, and with no providers both are `undefined`, so the node is made without one (`:73-111`; the prompt cited `:73-104` and `:97`). The engine's check is `missing_model`, in `packages/contracts/src/validation.ts`.

### S4 — Local models are buried in one flat list

**Steps.** Open Writer's settings at 1440 px and open the **Model provider** select. Then go to Providers → **Models**.

**Seen.**

- The provider select is one flat list with **0 groups**: `PG mock`, `Ollama (local stub)`, `LM Studio (local stub)`, `Anthropic`, `Remote endpoint`.
  - Local, cloud, mock and remote entries are mixed in creation order.
  - The two local providers carry no "local" or "free" mark.
  - The Ollama entry has its own logo. LM Studio and Remote endpoint share the generic `{ }` mark with the mock.
- The Models tab is one table of **37 rows** (27 mock, 3 Ollama, 3 LM Studio, 4 Anthropic catalogue rows), ordered by provider, with no section for local models. The default view shows 12 mock rows before anything local.

**Screenshots.** `s4-provider-picker-light-1440.png` · `s4-provider-picker-dark-1440.png` · `s4-provider-picker-light-380.png` · `s4-provider-picker-dark-380.png` (380: no settings, so the compact view is shown) · `s4-models-tab-light-1440.png` · `s4-models-tab-dark-1440.png` · `s4-models-tab-light-380.png` · `s4-models-tab-dark-380.png`.

**Root cause.**

- `apps/web/src/config-panel/ProviderAndModel.tsx:84-104` has one `SelectContent` mapping `providers` straight to `SelectItem`, with no `SelectGroup`.
- `apps/web/src/providers/ModelsTab.tsx` builds the flat table.
- There is no `providerGroup` in `packages/contracts` yet.

### S5 — A failed message never shows

**Steps.** Ideate chat, picking a node in the Team chat chips. On a phone: the Canvas tab, select the card, then the Chat tab.

- **(a)** The node "Failing" runs on `mock-503` (the adapter throws a 503). Send "Summarise the brief" and wait 6 s.
- **(b)** The node "Silent" runs on `mock-timeout` (it yields nothing until aborted). Send "Are you there?" and wait **45 s**.
- **(c)** Ask Writer (`mock-text`, normally instant) in the same project and wait 20 s.
- **(d)** Domain: a board with Writer and Failing. Type "Write a tagline" and press Start team run, then wait 15 s.

**Seen.**

- **(a) Shows correctly.** "Failing could not answer · http_503 — Provider responded 503: mock service unavailable", rendered as an error turn (`chat-error-turn`). This path works today.
- **(b) Never ends.** After 45 s it still reads "● Silent is typing…". There is no failed turn, no deadline and no Retry. The node's `execution.timeoutMs` is 120 000, but chat does not apply it.
- **(c) Worse.** Writer never answers, still "Writer is typing…" after 20 s. The turn from (b) holds the project's chat write queue, so **one hung turn blocks every later chat turn in that project**.
- **(d)** The failing node's message in Domain is the raw error text, "Provider responded 503: mock service unavailable", shown as if the agent had said it.
  - The node run is `FAILED` / `RUN_FAILED`, after 3 attempts.
  - Domain shows no failed mark, no failure reason in words and no Retry.
  - The run stays `RUNNING` (parked open, D323).
- At 380 px the Domain team panel lies over the conversation and composer (`s5-domain-*-380`). Typing needed a forced click.

**Screenshots.** `s5-failed-reply-{light,dark}-{1440,380}.png` (a) · `s5-no-answer-{light,dark}-{1440,380}.png` (b) · `s5-queue-blocked-light-1440.png` (c) · `s5-domain-{light,dark}-{1440,380}.png` (d).

**Root cause.**

- `packages/engine/src/chat/service.ts:374-377`: `generateReply` runs every reply with a workspace inside `writeQueue(projectId)`. `produceReply` (`:379` on) has no deadline, so a stream that never ends holds the queue for good.
- `:820-825`: the gateway's 202 branch only logs a rejection. The prompt cites `:823-825`, which is correct. That throw path did not fire here, because the provider error is caught inside the turn (`:447` on) and stored as a failed reply.
- The client has no stall rule (`apps/web/src/chat/ChatConversation.tsx:167`, the typing indicator).
- Domain does not read `failureReason`: `apps/web/src/domain/looks.ts` and `Conversation.tsx:326-332`.

### S6 — Chat messages have no copy / retry / edit / delete

**Steps.** Use a fresh project (S5's hung turn blocks `free`'s queue). Chat to Writer with "Draft a tagline for ACE", wait 3 s and hover the last message.

**Seen.**

- No message has a Copy, Retry, Edit / Resend, Delete or Regenerate control, on hover or otherwise. The count is 0 in every look.
- The only button inside the conversation is "Send to Forge →" on an agent reply.
- No Stop appears in the composer while a reply streams. The "Stop" counted at 380 px is the run-control column in the top bar, not chat.

**Screenshots.** `s6-chat-actions-light-1440.png` · `s6-chat-actions-dark-1440.png` · `s6-chat-actions-light-380.png` · `s6-chat-actions-dark-380.png`.

**Root cause.**

- D335 dropped "Actions +" (decision X3 in the prompt).
- `apps/web/src/chat/ChatConversation.tsx` renders a message's body only.
- `packages/ui/src/components/message-bubble.tsx` has no action slot.

### M1 — The Canvas sticks on RUNNING after a visit to Domain

**Steps.**

1. Import Draft → Edit → Polish, all on `mock-slow` (about 2 s each).
2. Open Ideate and use "…" → **Start run**. Draft shows "Running".
3. Click **Domain** in the mode switch.
4. Poll `GET /runs/:id` until it leaves RUNNING. It became `COMPLETE`.
5. Click **Ideate** and wait 2.5 s.

**Seen.**

- **Ideate.** Draft still shows "● Running — running — answer in Chat". Edit and Polish show "Idle", although all three COMPLETED.
- **The "…" menu.** It offers **Pause** and **Stop…**, and **Start run is missing**, for a run the engine has finished.
- **The footer.** It reads "0 in / 0 out".
- **Domain.** It showed the finished run correctly while it was open (`s7-domain-after-run-light-1440.png`).
- **Phone (380 px).** The same walk through the compact top bar leaves the same stale state.

**Screenshots.** `s7-stuck-running-light-1440.png` · `s7-stuck-running-dark-1440.png` · `s7-stuck-running-light-380.png` · `s7-stuck-running-dark-380.png` · `s7-domain-after-run-light-1440.png`.

**Root cause.**

- Domain is a sibling route of `WorkflowLayout` (`apps/web/src/app/routes.tsx:46`; the prompt cited `:37-47`), so Ideate's run subscription unmounts while Domain is open and misses `run.completed`.
- On return, `useAdoptActiveRun` (`apps/web/src/runs/hooks.ts:151-182`; the prompt cited `:160-176`) adopts only a run that is RUNNING, PAUSED or PREFLIGHT (`:168-172`). A finished run is never adopted again, so the run store keeps its stale RUNNING copy.

### M2 — Nodes can't be followed from one mode to another

**Steps.** In Ideate, click the Edit card (it is selected and settings opens), then press Escape. Switch to **Forge**, then **Domain**, and read the URL each time.

**Seen.**

- **The URLs:**
  - Ideate: `…/workflows/<wf>`
  - Forge: `…/workflows/<wf>/forge`
  - Domain: `…/workflows/<wf>/domain`
- None carries `?node=` or `?run=`, and Domain opens on "All", not on Edit.
- Domain has **0** "Show on canvas" buttons and **0** links back to the Canvas or Ideate.
- The only way across is the Canvas card's **right-click** menu → "Open in Domain", which sets `?node=` but not `?run=`.

**Screenshots.** `s7-follow-node-light-1440.png` · `s7-follow-node-dark-1440.png` · `s7-follow-node-light-380.png` · `s7-follow-node-dark-380.png`.

**Root cause.**

- `apps/web/src/forge/mode.ts:9-12` (`workflowPath`) and `ModeSwitch` drop query params.
- `apps/web/src/canvas/Canvas.tsx:188-200` (`OpenInDomainItem`) builds `?node=` only. The prompt cited this correctly.

---

## 4. Visibility audit

**Method.**

- **Routes.** Every route in the prompt, plus three states that hold many controls: Ideate with node settings open, Ideate with a chat open, and Providers → Models.
- **Looks.** Light and dark, at 1440 and 380 px. That is 13 routes × 4 looks = 52 pages, on a board with a finished run.
- **Measured in the page.** No axe: `@axe-core/playwright` is not installed, and Phase 0 adds no dependency. `in-page-audit.ts` checks each visible control (button, link, tab, radio, menuitem, combobox, field) and each visible text node.
- **Contrast.** WCAG 2.x luminance on the effective background, with ancestor backgrounds composited and ancestor opacity folded in. Disabled controls are excluded, as WCAG excludes them.
- **Token table.** §4.4 was computed from `packages/ui/src/theme.css` (`:root`, `:root[data-theme='dark']`).
- **Static checks.** A source grep for glyphs, `opacity-0` and double-click or context-menu handlers.

**Counts per page.** These are unique controls per page. The 380 px "ideate-node-settings" row equals plain ideate, because settings cannot open on a phone.

| Route | Light 1440 controls / icon-only / glyph / hidden / < 24 px / text < AA / boundary < 3:1 | Dark 1440 (same order) |
|---|---|---|
| Home `/projects` | 12 / 2 / 4 / 0 / 0 / 6 / 11 | 12 / 2 / 4 / 0 / 0 / 6 / 11 |
| Project | 13 / 2 / 4 / 0 / 2 / 0 / 10 | 13 / 2 / 4 / 0 / 2 / 0 / 10 |
| Ideate | 32 / 12 / 11 / 6 / 4 / 11 / 9 | 32 / 12 / 11 / 6 / 4 / 9 / 8 |
| Ideate + node settings | 48 / 13 / 16 / 6 / 7 / 4 / 20 | 48 / 13 / 16 / 6 / 7 / 2 / 19 |
| Ideate + chat | 37 / 13 / 13 / 6 / 7 / 11 / 11 | 37 / 13 / 13 / 6 / 7 / 9 / 10 |
| Forge | 27 / 8 / 8 / 0 / 10 / 4 / 10 | 27 / 8 / 8 / 0 / 10 / 2 / 9 |
| Domain | 18 / 4 / 7 / 0 / 3 / 4 / 8 | 18 / 4 / 7 / 0 / 3 / 3 / 7 |
| Run detail | 10 / 2 / 4 / 0 / 1 / 1 / 5 | 10 / 2 / 4 / 0 / 1 / 0 / 5 |
| Timeline | 9 / 3 / 7 / 0 / 1 / 0 / 6 | 9 / 3 / 7 / 0 / 1 / 0 / 6 |
| Providers | 16 / 7 / 7 / 0 / 1 / 0 / 12 | 16 / 7 / 7 / 0 / 1 / 0 / 12 |
| Providers → Models | 12 / 2 / 8 / 0 / 1 / 0 / 8 | 12 / 2 / 8 / 0 / 1 / 0 / 8 |
| Settings | 13 / 2 / 5 / 0 / 1 / 0 / 12 | 13 / 2 / 5 / 0 / 1 / 0 / 12 |
| Onboarding | 12 / 2 / 2 / 0 / 4 / 1 / 7 | 12 / 2 / 2 / 0 / 4 / 0 / 7 |

At 380 px every page loses its desktop header and footer and gains the compact top bar. Its "…" Menu (`apps/web/src/responsive/CompactMenu.tsx:23`, 44 × 44 px) is icon-only on every route. The phone also adds the `▶ Run` button (`apps/web/src/runs/RunBar.tsx:137`), whose label begins with a glyph.

### 4.1 Icon-only controls (25 unique; all have an accessible name, none has visible text)

| Route | Control (accessible name) | Shows | File:line | Problem | Measured value |
|---|---|---|---|---|---|
| all routes | Switch theme | `☀☾` | apps/web/src/theme/primitives.tsx:36 (glyphs :53, :64) | icon-only, glyph; ☾ draws as a "C" at 10 px | 56×28 px |
| all routes (footer on Ideate/Forge/Domain, corner elsewhere) | Settings menu | `⚙︎` | apps/web/src/app/layout/SettingsMenu.tsx:43 (glyph :22) | icon-only, glyph, tiny in the footer | **18×18 px** in the footer, 34×34 in the corner; glyph 11 px |
| Ideate | Workspace menu (holds the run controls) | `…` | apps/web/src/app/layout/WorkspaceMenu.tsx:119 | icon-only; the only desktop route to Start/Pause/Stop/Restart | 27×24 px |
| Ideate | Zoom in | `+` | apps/web/src/canvas/CanvasToolbar.tsx:49 | icon-only | 28×28 px |
| Ideate | Zoom out | `−` | apps/web/src/canvas/CanvasToolbar.tsx:58 | icon-only, glyph U+2212 | 28×28 px |
| Ideate | Fit to view | `⛶` | apps/web/src/canvas/CanvasToolbar.tsx:77 | icon-only, glyph | 28×28 px |
| Ideate | Lock nodes | `🔓︎`/`🔒︎` | apps/web/src/canvas/CanvasToolbar.tsx:87 (glyph :96) | icon-only, emoji-range glyph | 28×28 px |
| Ideate | Hand tool | `✋` | apps/web/src/canvas/CanvasToolbar.tsx:102 (glyph :111) | icon-only, emoji-range glyph | 28×28 px |
| Ideate | Undo move | `↶` | apps/web/src/canvas/CanvasToolbar.tsx:117 (glyph :123) | icon-only, glyph | 28×28 px |
| Ideate, Forge | Close chat | `✕` | apps/web/src/chat/ChatAside.tsx:238 (glyph :246) | icon-only, glyph | 28×28 px |
| Ideate, Forge | Attach a file | `⌁` | apps/web/src/artifacts/AttachmentPicker.tsx:85 (glyph :89) | icon-only, glyph with no common meaning | 30×30 px |
| Ideate, Forge | Send message | `↑` | apps/web/src/chat/ChatComposer.tsx:321 (glyph :331) | icon-only, glyph | 30×30 px |
| Ideate (chat open) | Delete chat "<title>" | `✕` | apps/web/src/chat/ChatThreadList.tsx:84 (glyph :92) | icon-only, glyph, under 24 px | **16×16 px** |
| Forge | New File | `+` | apps/web/src/forge/explorer/ExplorerView.tsx:106 | icon-only; two identical `+` side by side | 27×20 px |
| Forge | New Folder | `+` | apps/web/src/forge/explorer/ExplorerView.tsx:111 | icon-only; same `+` as New File | 27×20 px |
| Forge | Close <tab> | `×` | apps/web/src/forge/editor/TabsBar.tsx:129 | icon-only, glyph | 20×20 px |
| Domain | Start team run / Send | `↑` | apps/web/src/domain/Composer.tsx:313 (glyph :320) | icon-only, glyph | 36×36 px |
| Domain | Close (team panel) | `✕` | apps/web/src/domain/TeamPanel.tsx:125 (glyph :129) | icon-only, glyph | 28×28 px |
| Timeline | Send to workflow | `↑` | apps/web/src/timeline/TimelineComposer.tsx:65 (glyph :70) | icon-only, glyph | 36×36 px |
| Providers | Actions for <provider> (one per row) | `…` | apps/web/src/providers/ProvidersPage.tsx:128 | icon-only | 28×24 px |
| all routes at 380 | Menu | `…` | apps/web/src/responsive/CompactMenu.tsx:23 | icon-only | 44×44 px |

The recorder's locator put New File, New Folder and Close tab at `ForgeWorkbench.tsx:100`. That is where they mount; the lines above are where the buttons are defined.

### 4.2 Unicode glyphs used as controls

**Census.** A source scan of `apps/web/src` and `packages/ui/src`, skipping tests, mocks and comments, for U+2190–U+2BFF, U+1F300–U+1FAFF, `×` and `⋯`. It found **39 code points**. The prompt's "about 22" matches the glyphs that sit in a control or in a status mark; the rest are typography such as arrows in labels and `≥`.

**Glyphs inside a control** (a `<button>`, menu trigger, link or tab, by reading each hit; 24 glyph types):

| Glyph | Uses in a control (file:line) | Role |
|---|---|---|
| ✕ U+2715 | AttachmentList.tsx:59, AttachmentPicker.tsx:158, InputDropZone.tsx:123, bottom-panel/BottomPanel.tsx:119, chat/ChatAside.tsx:246, chat/ChatComposer.tsx:205, :229, chat/ChatThreadList.tsx:92, config-panel/AgentToolsSection.tsx:234, config-panel/ProviderAndModel.tsx:244, domain/Composer.tsx:226, domain/TeamPanel.tsx:129, forge/layout/StatusBar.tsx:44, forge/panel/BottomPanel.tsx:96, forge/terminal/TerminalView.tsx:216, guardrails/PolicyEditor.tsx:280, knowledge/DocumentsPanel.tsx:152, library/McpServersPanel.tsx:130, memory/MemoryTab.tsx:185, workflows/WorkflowSheet.tsx:69; ui/components/dialog.tsx:54 | close / remove / delete (20 + 1) |
| × U+00D7 | forge/editor/TabsBar.tsx:129, :199, forge/terminal/TerminalTabs.tsx:126 | close tab |
| ↑ U+2191 | chat/ChatComposer.tsx:331, domain/Composer.tsx:320, timeline/TimelineComposer.tsx:70, config-panel/ProviderAndModel.tsx:227, forge/terminal/TerminalView.tsx:198 | send; move up |
| ↓ U+2193 | config-panel/ProviderAndModel.tsx:236, forge/terminal/TerminalView.tsx:207 | move down |
| → U+2192 | chat/ChatConversation.tsx:153, domain/Conversation.tsx:472, runs/RunDetailPage.tsx:127, :133, timeline/TimelinePage.tsx:37; projects/ProjectsPage.tsx:184 (Home mode cards) | link suffix |
| ← U+2190 | forge/CompactForge.tsx:93, knowledge/KnowledgeBasePage.tsx:50, knowledge/KnowledgeListPage.tsx:32 | back |
| ▶ U+25B6 | forge/editor/PathBar.tsx:160, forge/layout/StatusBar.tsx:83, forge/terminal/ScriptButtons.tsx:44, runs/RunBar.tsx:138 | run |
| ↺ U+21BA | errors/ErrorCard.tsx:92, knowledge/DocumentsPanel.tsx:66, library/McpServersPanel.tsx:120, providers/ModelsTab.tsx:307, usage/HealthMetricsPanel.tsx:64 | retry / refresh |
| ↶ U+21B6 | canvas/CanvasToolbar.tsx:123 | undo move |
| − U+2212 | canvas/CanvasToolbar.tsx:62 | zoom out |
| ⛶ U+26F6 | canvas/CanvasToolbar.tsx:81, bottom-panel/TimelineTab.tsx:29, forge/panel/BottomPanel.tsx:87 | fit / maximise |
| 🔒 U+1F512 / 🔓 U+1F513 | canvas/CanvasToolbar.tsx:96 | lock toggle |
| ✋ U+270B | canvas/CanvasToolbar.tsx:111, runs/approvals/ApprovalsBadge.tsx:38 | hand tool; approvals badge |
| ⌁ U+2301 | artifacts/AttachmentPicker.tsx:89, chat/ChatComposer.tsx:316 | attach |
| ⚙ U+2699 | app/layout/SettingsMenu.tsx:22 (rendered at :53) | settings |
| ☀ U+2600 / ☾ U+263E | theme/primitives.tsx:53, :64 | theme toggle |
| ✓ U+2713 | app/layout/WorkspaceMenu.tsx:147, domain/DomainPage.tsx:391, ui/components/code-block.tsx:117 | checked item; copied |
| ▾ U+25BE / ▸ U+25B8 | forge/search/SearchView.tsx:128 (as text); domain/Conversation.tsx:369, domain/DomainPage.tsx:379, forge/explorer/FileTree.tsx:459, ui/components/json-tree.tsx:91, ui/components/select.tsx:31 (inside triggers: every Select shows `▾`) | disclosure |
| ● U+25CF | forge/editor/TabsBar.tsx:125 | unsaved-tab dot, which doubles as close |
| ✳ U+2733 | domain/DomainPage.tsx:171 ("✳ All" lens pill) | filter pill icon |
| … U+2026 (as a label) | WorkspaceMenu.tsx:123, ProvidersPage.tsx:128 area, responsive/CompactMenu.tsx | "more" menu |

**Glyphs as status or decoration, not controls** (they still depend on the font):

- `○ ◎ ● ◷ ✓ ■ 🔒 ✕` in `packages/ui/src/components/status.tsx:33-41`, the node/run status marks. `● ✦ ✋ ↺ ▶ ⌁` in `trace-timeline.tsx:19-24`. `✓ ▬ ✋ ✕` in `verdict-badge.tsx:15-19`.
- `✎ ◦ ⌕` in `chat/ChatActivity.tsx:7-11`.
- `✳` as the agent avatar: `chat/ChatConversation.tsx:41`, `domain/Conversation.tsx:94`.
- `⋮⋮` as the card grip: `nodes/NodeCard.tsx:234`.
- `◇` on the Home Canvas card: `projects/ProjectsPage.tsx:30`.
- `■ 🔒` in `errors/NodeOutcome.tsx:35, :60`.
- `↩` in `canvas/EdgeLayer.tsx:89`.
- `⌘ ⌥ ⇧` in shortcut hints: `app/shortcuts.ts:73`.

On the rendered pages the recorder found **53 unique controls whose text contains a glyph**. That includes every Select trigger (`▾`), the `→` links and `▶ Run`. Per page it is 2–16 (table above).

### 4.3 Hidden until hover or focus (opacity 0)

| Route | Control | File:line | Problem | Measured value |
|---|---|---|---|---|
| Ideate (all states), both themes, both widths | every port handle, "text input “text”" / "text output “text”, accepts many" (2 per agent, 6 on the 3-node board) | packages/ui/src/theme.css:305 (`opacity: 0`), apps/web/src/nodes/NodeCard.tsx:91-142 | invisible; **not revealed on hover** either, only on `:focus-visible` / keyboard-armed (`theme.css:308-313`) | opacity 0, 11×11 px at the fitted zoom (7.7×7.7 at 64 %) |

**Grep.** `opacity-0`, `group-hover:`, `hover:opacity-100`, `invisible` and `opacity: 0` in `apps/web/src` and `packages/ui/src`. Nothing else is opacity-0-until-hover:

- `trace-timeline.tsx:116` is `invisible` on a row without detail.
- `part-renderer.tsx:175` is a `group-hover` background change only.

The edge hit bands (`TypedEdge.tsx:39`, `LoopEdge.tsx:38`) are deliberately invisible, and their visible curves are drawn by `EdgeLayer`.

### 4.4 Contrast below WCAG AA

**Tokens** (computed from `packages/ui/src/theme.css:66-158`, the workspace palette). The bar is 4.5:1 for text and 3:1 for icons and boundaries.

| Theme | Token | Value | on --surface | on --panel | on --canvas | Bar | Verdict |
|---|---|---|---|---|---|---|---|
| light | --ink | #1f1d1b | 16.80 | 15.74 | 14.82 | 4.5 | pass |
| light | --muted | #6f6a65 | 5.35 | 5.01 | 4.72 | 4.5 | pass (4.48 on the orange-tinted header chip, below) |
| light | **--line** (every control border) | #e6e0da | **1.31** | **1.23** | **1.15** | 3 | **fail** |
| light | **--iconLine** | #cfc9c3 | **1.64** | **1.54** | **1.45** | 3 | **fail** |
| light | --frameLine | #e0d9d2 | 1.40 | 1.31 | 1.23 | 3 | fail |
| light | --pillOffLine | #e4dfda | 1.32 | 1.24 | 1.17 | 3 | fail |
| light | --sendOff (disabled send) | #c9c4bf | 1.73 | 1.62 | 1.53 | 3 | fail (exempt while truly disabled) |
| light | **accent #ef6b3f** (selection ring, focus ring, Add-node dot) | #ef6b3f | 3.07 | **2.87** | **2.71** | 3 | **fail** on panel and canvas |
| light | white on accent (avatars, badges) | #fff / #ef6b3f | 3.07 | | | 4.5 | fail as text |
| light | status READY / RUNNING | #1f97a3 / #e8572e | 3.49 / 3.60 | 3.27 / 3.37 | 3.08 / 3.17 | 3 (4.5 as text) | icon ok, **text fail** |
| light | status WAITING / BLOCKED / FAILED / danger | #7a62d6 / #c94c27 | 4.62 | 4.33 | 4.07 | 4.5 as text | **text fail** on panel and canvas |
| light | **status COMPLETED** | #2f9e63 | 3.39 | 3.18 | **2.99** | 3 | **fail on canvas even as an icon** |
| light | provider anthropic / openai | #c2603f / #0a8048 | 4.17 / 5.01 | 3.90 / 4.69 | 3.68 / 4.42 | 4.5 as text | text fail |
| dark | --ink / --muted | #f2eee9 / #a39d97 | 15.61 / 6.72 | 16.33 / 7.03 | 16.92 / 7.28 | 4.5 | pass |
| dark | **--line** | #2a2725 | **1.22** | **1.27** | **1.32** | 3 | **fail** |
| dark | **--iconLine** | #4a4541 | **1.91** | **1.99** | **2.06** | 3 | **fail** |
| dark | --frameLine / --pillOffLine / --sendOff | #2e2a27 / #2e2b28 / #3a3633 | 1.27–1.51 | 1.33–1.58 | 1.37–1.63 | 3 | fail |
| dark | accent | #ef6b3f | 5.88 | 6.15 | 6.37 | 3 | pass |
| dark | status WAITING / BLOCKED / FAILED / danger | #7a62d6 / #c94c27 | 3.90 | 4.08 | 4.23 | 4.5 as text | text fail |
| dark | status READY / RUNNING / COMPLETED / IDLE | — | 5.0–6.7 | 5.2–7.0 | 5.4–7.3 | | pass |

**Text measured in the page** (28 unique failures; the bar is 4.5:1, since all of them are under 18.66 px):

| Route | Text | File:line | Problem | Measured value |
|---|---|---|---|---|
| Ideate | stage label "STAGE 1 · DRAFT" (9 px, `--color-status-WAITING` purple) | apps/web/src/nodes/NodeCard.tsx:207 | text < 4.5:1 | light 4.07:1 (#7a62d6 on #f4f0ec); dark 4.23:1 (on #0d0c0b) |
| Ideate, Forge, Domain | header chip "CHAT" / "TEAM" (9 px) | apps/web/src/app/layout/WorkspaceHeader.tsx:62 | text < 4.5:1 | light 4.48:1 (#6f6a65 on #f8e8e0) |
| Ideate, Forge | "Live" (10 px) | apps/web/src/chat/ChatAside.tsx:227 | text < 4.5:1 | light 3.18:1 (#2f9e63 on #faf7f4) |
| Ideate, Forge, Domain | avatar initials on node colours (8–9 px) | apps/web/src/chat/ChatAside.tsx:167, apps/web/src/domain/DomainPage.tsx:147 | text < 4.5:1 | 3.07:1 (#fff on #ef6b3f), 3.49:1 (#fff on #1f97a3), both themes |
| Home | project-card agent initials (6.5 px) | apps/web/src/projects/ProjectCard.tsx:98 | text < 4.5:1, and 6.5 px | 1.89:1 (#fff on #ebb34d), 2.23:1 (#fff on #f59570), 3.39–3.89:1 others; both themes |
| Ideate + settings | "IDLE" state chip (8.5 px) | apps/web/src/config-panel/NodeSettingsModal.tsx:94 | text < 4.5:1 | light **2.43:1** (#a39d97 on #f4f3f3) |
| Domain | team panel "Done" (10.5 px) | apps/web/src/domain/TeamPanel.tsx:171 | text < 4.5:1 | light **2.91:1** (#2f9e63 on #e2f1e9); dark 4.47:1 |
| Run detail | status pill "COMPLETE" (8.5 px) | apps/web/src/runs/RunDetailPage.tsx:114 | text < 4.5:1 | light **2.65:1** (#2f9e63 on #dce6dc) |
| Onboarding | "Add a provider with a key" link (13 px) | apps/web/src/onboarding/OnboardingPage.tsx:287 | text < 4.5:1 | light **2.97:1** (#e8623a on #f4f0ec) |

**Control boundaries below 3:1** (148 unique control and background pairs). Nearly all of them are one token, `--line`, used as the only boundary of a control that has no fill of its own or a fill that matches the page:

| Theme | Border on background | Ratio | Controls | Routes | Examples (file:line) |
|---|---|---|---|---|---|
| light | --line #e6e0da on --surface #fff | 1.31:1 | 28 | Project, Ideate settings and chat, Forge, Timeline, Providers, Settings | Selects (`packages/ui/src/components/select.tsx:23`), inputs (`input.tsx:9`), textarea (`textarea.tsx:9`), Close (`ChatAside.tsx:238`) |
| light | --line on --canvas #f4f0ec | 1.15:1 | 25 | every route | Settings gear (`SettingsMenu.tsx:26`), Workspace menu (`WorkspaceMenu.tsx:119`), **Add node** (`Canvas.tsx:1296-1300`), project Runs and Knowledge links |
| light | --line on --panel #faf7f4 | 1.23:1 | 8 | Ideate, Forge, Domain (chat aside) | chat chips (`ChatAside.tsx:167`), New chat, Send to Forge (`ChatConversation.tsx:149`), Close chat |
| light | --line on header #faf6f2 | 1.21:1 | 2 | all | theme toggle (`primitives.tsx:40`), settings gear |
| light | accent #ef6b3f on header #faf6f2 | 2.84:1 | 2 | Ideate, Forge, Domain | the CHAT / TEAM Split toggle (`WorkspaceHeader.tsx:62`) |
| light | Home --line #e9e3dd on #f4f0ec | 1.12:1 | 8 | Home | the Canvas and Forge mode cards, project cards |
| dark | --line #2a2725 on --surface #181615 | 1.22:1 | 28 | as light | as light |
| dark | --line on --canvas #0d0c0b | 1.32:1 | 26 | every route | as light, plus Onboarding's "Continue with …" cards (`OnboardingPage.tsx:262`) |
| dark | --line on --panel #121110 | 1.27:1 | 8 | Ideate, Forge, Domain | as light |
| dark | Home --line #2e2b28 on #0d0c0b | 1.39:1 | 9 | Home | as light |

WCAG 1.4.11 applies to a boundary only where it is what identifies the control. Many of these controls also have a text label, so they are not all strict failures. Inputs, selects and textareas on a same-colour panel, and the icon-only buttons in §4.1, have nothing else to show where they are, so for those the boundary is the control. This supports the prompt's instruction to fix the tokens (`--line`, `--iconLine`), not single components.

Icon colour itself (the glyph's foreground on its ground) passed 3:1 on every icon-only control, because they use `--ink` or `--muted`. Their problem is size, font dependence and the boundary, not ink.

**Targets under 24 × 24 px (WCAG 2.5.8).** The recorder also flagged three visually hidden file inputs at 1×1 px (`ImportWorkflowButton.tsx:28`, `WorkspaceMenu.tsx:99`, `AttachmentPicker.tsx:85`). Those are false positives: their visible buttons carry the click. The real ones:

| Route | Control | File:line | Problem | Measured value |
|---|---|---|---|---|
| Ideate, Forge, Domain | Settings menu (footer) | apps/web/src/app/layout/SettingsMenu.tsx:43 | target < 24 px | 18×18 |
| Ideate (chat) | Delete chat ✕ | apps/web/src/chat/ChatThreadList.tsx:84 | target < 24 px | 16×16 |
| Ideate (chat) | thread title tab | apps/web/src/chat/ChatThreadList.tsx:68 | target < 24 px | 85×13 |
| Ideate (chat) | Send to Forge → | apps/web/src/chat/ChatConversation.tsx:149 | target < 24 px | 98×22 |
| Forge | EXPLORER / SEARCH / CHANGES tabs | apps/web/src/forge/explorer/SideViewSwitch.tsx:15 | target < 24 px | 59–72×22 |
| Forge | New File / New Folder `+` | apps/web/src/forge/explorer/ExplorerView.tsx:106, :111 | target < 24 px | 27×20 |
| Forge | Close tab × | apps/web/src/forge/editor/TabsBar.tsx:129 | target < 24 px | 20×20 |
| Forge | Problems count "✕0 !0" | apps/web/src/forge/layout/StatusBar.tsx:36 | target < 24 px | 46×14 |
| Domain | "✓ What it did ▸ show" | apps/web/src/domain/Conversation.tsx:134 | target < 24 px | 764×17 |
| Onboarding | "Add a provider with a key", help links | apps/web/src/onboarding/OnboardingPage.tsx:287 | target < 24 px | 151×16, 912×13 |
| every route at 380 | "ACE" home link, project name link | apps/web/src/app/layout/CompactTopBar.tsx:27, :45 | target < 24 px | 53×19, 130×16 |

### 4.5 Reachable only by double-click or a context menu

| Route | Action | Only via | File:line | Visible alternative today |
|---|---|---|---|---|
| Ideate | **Duplicate node** | right-click a card | apps/web/src/canvas/Canvas.tsx:1369-1371 | keyboard Ctrl+D only |
| Ideate | **Inspect node** | right-click a card | Canvas.tsx:1386-1394 | "…" → Panels → Workflow panel (not node-scoped) |
| Ideate | **Open in Domain** (for a node) | right-click a card | Canvas.tsx:189-201, :1393-1398 | none |
| Ideate | **Delete node** | right-click a card | Canvas.tsx:1400-1405 | Delete key only |
| Ideate | Copy node | right-click a card | Canvas.tsx:1373-1375 | Ctrl+C |
| Ideate | **Add Input / Output / Merge / … (every kind but Agent)** | the pane's right-click "Add <kind>" | Canvas.tsx:1422-1427 (`PALETTE_NODE_KINDS` in `nodes/factory.ts:44` is `['agent']`) | none; the "Add node" pill makes Agents only |
| Ideate | Paste, Select all, **Auto-arrange** | the pane's right-click | Canvas.tsx:1414-1442 | Ctrl+V / Ctrl+A; Auto-arrange has none |
| Ideate | **Edit or delete a connection, make a loop** | right-click an edge | Canvas.tsx:1135-1149 (`onEdgeContextMenu`), 1330-1360 | Delete key on a selected edge |
| Forge | **New File / New Folder in a folder, Rename, Delete, Copy Path, Ask Agent About This File** | right-click in the tree | apps/web/src/forge/explorer/FileTree.tsx:553-605 | header `+` buttons create where the selection is (D299); F2 / Del keys |
| Forge | Open a file pinned (not preview) | double-click a tree row | FileTree.tsx:452-454 | none |
| Forge | Pin a preview tab | double-click the tab | apps/web/src/forge/editor/TabsBar.tsx:93 | none |
| Forge | Close others / Copy relative path (tab) | right-click a tab | TabsBar.tsx:65-151 | none |
| Forge | **Rename a terminal tab** | double-click the tab | apps/web/src/forge/terminal/TerminalTabs.tsx:102-106 | none (a `title` tooltip says so) |

The node actions that §1.2 of the prompt asks to move onto the card (Settings, Open in Domain, Duplicate, Delete) are all reachable today only through the right-click menu or a keyboard shortcut. On a trackpad or touch screen, Settings is reachable by a click, and the rest are not reachable at all.

---

## What did not reproduce, or reproduced differently

- **S1, settings on drag.** A drag that starts on a card moves the card. It did not open settings, because `onNodeClick` fires only on a click without movement. The real blockers are the invisible, interior port and the card body refusing a drop.
- **S5, provider error.** A failing provider shows "could not answer" correctly in Ideate chat. The symptom is a reply that never ends, and the queue it then blocks. The prompt's specific throw-after-202 path (`service.ts:823`) did not fire in these runs.
- **Local Ollama.** Not available on this machine, so the loopback stub stood in for it.
