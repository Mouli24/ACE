# ACE UI inventory — re-skin to the "Ace UI" theme

Snapshot of `apps/web` + `packages/ui` on branch `ui/ace-theme` (off `domain` 527f997), 2026-10-10.
Source of truth for the look: `D:\ACE offcl\ace ui\Ace Home.dc.html` and `Ace Canvas.dc.html`.

Buckets:

- **Restyle**: has a counterpart in the theme; rebuilt to match it exactly.
- **Remove**: a control or widget on a themed screen with no theme counterpart. It leaves the UI, and its logic stays. "Moves to" says where the capability is still reachable, when it would otherwise be lost.
- **Uncovered**: a screen, dialog, panel or flow the theme does not show. It stays and is restyled with the theme's tokens and components.

The "…" menu is the theme's `…` button next to the project name in the canvas breadcrumb (theme §6: "wire to a real feature"). It hosts the workspace and app navigation the old top bar carried. Its contents are under §1.4.

---

## 1. Workspace shell (`app/layout/*`, `workflows/WorkflowLayout.tsx`, `workflows/WorkflowTabs.tsx`)

### 1.1 Top bar `TopBar.tsx` → theme workspace header (44px) on Ideate / Forge / Domain

| Current element | Bucket | Disposition |
|---|---|---|
| "ACE" link → `/projects` | Restyle | Logo mark + "ACE". Links to `/projects` (Home). `/` stays `HomeRedirect`, so TC-PRJ-004 is kept. |
| "/ project name" link | Remove (header) | Shown as the canvas breadcrumb project pill. "Project page" moves to the "…" menu. |
| `WorkflowTabs` (tabs, "+ Add workflow", per-tab Rename / Duplicate / Export JSON / Delete) | Remove | Moves to "…" menu → Workflows (switch, New, Import) and This workflow (Rename, Duplicate, Export JSON, Delete). Dialogs and hooks unchanged. |
| `ModeSwitch` (Ideate / Forge / Domain radios, arrows, Ctrl+Shift+1/2/3) | Restyle | Segmented pill. Radios, arrow keys and shortcuts kept. Icons dropped (theme has none). |
| `ProviderStatusBar` (link to `/providers`) | Remove | "…" menu → Providers. Status is still visible on the Providers page. |
| `DayTotalsChip` (link to `/usage`) | Remove | "…" menu → Usage. |
| `RunBar`: socket "reconnecting…" | Restyle | Footer connection status. `socket-reconnecting` testid kept there. |
| `RunBar`: run status chip | Remove | Node states, `CanvasHaltNote` and `PreflightIssues` on the canvas, plus the Run details page. |
| `RunBar`: totals | Restyle | Footer "Xin / Yout". |
| `RunBar`: **Start run** (+ input dialog) | Remove (header) | "…" menu → Start run (same input dialog). Forge path bar "▶ Run pipeline". Domain composer starts team runs. |
| `RunControls` (Pause / Resume / Stop + confirm / Restart / End) | Remove (header) | "…" menu → Run section (same mutations and Stop confirm). Run details page keeps the full controls. Domain keeps End. |
| `ApprovalsBadge` + approvals dialog | Remove (header) | "…" menu → "Approvals (N)" opens the same dialog. Approvals also stay on node cards (`NodeApproval`) and on Run details. |
| Chat toggle (Ctrl+Alt+B) | Restyle | "Split" toggle (CHAT in Ideate/Forge, TEAM in Domain). It also drives the Domain Team aside. |
| Workflow panel (sheet) toggle | Remove | "…" menu → Workflow panel. Also the node context menu "Inspect". |
| Usage / Guardrail policies / Settings / Help icon links, "More" menu | Remove | "…" menu → ACE section (Providers, Settings, Usage, Guardrail policies, Tools, Help). |
| New node button + `NewNodeDialog` | Remove | Theme "Add node" pill on the canvas. Pane context menu "Add Agent" kept. The dialog's palette / drag-to-place goes; name, provider and model are set in the node settings modal. |
| *(new)* agent avatar stack | Restyle | One circle per agent/model node in graph order. Initial; color by agent order. |
| *(new)* theme toggle | Restyle | ☀ / ☾; `ace-theme` in localStorage, default light. |
| Compact top bar ≤640px (`topbar-compact`, `CompactMenu`) | Uncovered | Kept for phones, restyled with tokens. The theme has no phone header. |

### 1.2 Footer (new, 24px) — theme footer

Real data only:

- **Left:**
  - socket status: green "Connected", otherwise "Reconnecting…" or "Offline" in muted;
  - `|`;
  - the project slug, from `slugHandle(project.name)`.
- **Center:** the 28×4 bar.
- **Right:**
  - Forge only: `Ln, Col · Language · unsaved`, from `useEditorStatus` + `languageLabel` + the dirty flag;
  - the mode label;
  - "N messages": the chat aside's open session in Ideate/Forge, the Domain conversation in Domain;
  - "Xin / Yout": the run-store totals for this workflow, Domain usage totals in Domain, or "—" when there is no data.

### 1.3 Layout

| Current | Bucket | Disposition |
|---|---|---|
| `WorkflowLayout` `PanelGroup` (main + resizable chat %) | Restyle | Flex row: main + fixed 340px aside (theme). Resizing goes. |
| `AppShell` (`TopBar` on every route) | Restyle | Workspace routes get the theme header and footer. Every other route gets the Home-style header (logo, ACE, small-caps section label, theme toggle). |
| `app/stores/layout.ts` `chatOpen` | Kept | Also drives Domain's Team aside. |
| `app/theme.ts` `useApplyTheme` (server `Settings.theme`) | Restyle | `ace-theme` localStorage is the source of truth, default light. The toggle and the Settings select write it. The Settings select also patches `Settings.theme`. |

### 1.4 "…" menu (new home for header-only capabilities)

Styled like the theme's custom dropdown menu, with small mono section labels.

| Section | Items |
|---|---|
| Workflows | one row per workflow (✓ current, keeps the mode); New workflow…; Import workflow… |
| This workflow | Rename…; Duplicate; Export JSON; Delete… |
| Run | Start run (or the allowed Pause / Resume / Stop… / Restart / End); Approvals (N)…; Run details |
| Panels | Workflow panel (Inspector · Runs · Memory); Problems & events (the bottom panel); Timeline |
| Project | Project page; Runs; Knowledge; Rename project…; Delete project… |
| ACE | Providers; Settings; Usage; Guardrail policies; Tools; Help |

---

## 2. Ideate — canvas (`canvas/*`, `nodes/*`, `edges/*`, `workflows/WorkflowPage.tsx`)

React Flow (`@xyflow/react`) stays as the engine. Handles, connection validation, loop edges, context menus, selection, keyboard and the about 120 e2e/acceptance selectors depend on it. Its look and its viewport maths are replaced by the theme's.

| Current element | Bucket | Disposition |
|---|---|---|
| `Background` dots | Restyle | Two radial glows + dot grid sized `max(6, 16·z)` and positioned at the pan offset. |
| Viewport: RF wheel/pinch zoom, `panOnScroll`, min zoom 0.1 | Restyle | Theme wheel handler: Ctrl/Cmd+wheel zooms at the cursor with `exp(-deltaY·0.01)`, plain wheel pans; clamp 0.25–2.5. Fit is the theme's (pad 80, clamp 0.25–1.4), on first load. |
| Agent / Model node card (`NodeCard`) | Restyle | Stage node 210×280:
- label chip "STAGE n · NAME" (n = order among agent/model nodes);
- number badges;
- provider orb + logo;
- role = name; sub line "provider · model";
- status dot + text from the live node state. |
| Input / Output / Merge / Transform / Retrieval / Guardrail / Custom cards | Uncovered | The theme's Document-node card style: 200 wide, surface, 13/700 title, mono meta, muted description, "Attached to Stage n" when it feeds a stage. |
| Trigger node | — | Not rendered: ACE has no schedules or triggers. |
| Ports (`Handle` per port, keyboard connect) | Uncovered | Kept as invisible, focusable handles at the theme's anchors (stage in 77,118 / out 133,118; card out 200,44 / in 0,44). Wiring keeps working with no visual addition. |
| `TypedEdge` (bezier + arrow + data-type label) | Restyle | Theme edge (glow + dashed flow + dots + label chip), drawn above the nodes as in the theme. The label is the real data type. |
| `LoopEdge` | Restyle | Same edge style; chip "↩ loop · max N" (+ "i/N" while a run is live). |
| `CanvasZoomPill` (−, %, +, fit) | Restyle | Bottom-left toolbar: + / − / % (reset 100%) / fit / lock / hand / undo-move. |
| Tools pill: Undo, Redo, Auto-arrange, Duplicate | Remove | Undo becomes the toolbar's undo-move; Ctrl+Z / Ctrl+Y stay. Auto-arrange stays in the pane context menu. Duplicate stays in the node context menu and Ctrl+D. |
| `MiniMap` | Restyle | Theme minimap (172×116; `miniGeo` / `miniJump` ported). |
| Node toolbar (Edit / Inspect / @ Chat / Trash) | Remove | Edit: click the node → settings modal. Inspect: node context menu → Workflow panel Inspector. @ Chat: selecting a node already retargets the chat. Trash: modal "Remove node from canvas", the Delete key, or the context menu. |
| Node / pane / edge context menus (Duplicate, Copy, Inspect, Open in Domain, Delete; Paste, Add Agent, Select all, Auto-arrange, Fit; Loop settings, Make loop edge, Delete connection) | Uncovered | Kept, restyled as theme menus. "Inspect" now opens the Workflow panel. "Loop settings" opens the settings modal shell. |
| `MakeLoopEdgeDialog`, `LoopConfigFields` | Uncovered | Theme modal shell + theme fields. |
| `NodeApproval`, `NodeErrorCard`, `NodePreflightIssues`, `InputDropZone` under or on cards | Uncovered | Kept under the card, restyled. |
| `PreflightIssues`, `CanvasHaltNote` overlays | Uncovered | Kept, restyled. |
| Bottom panel (Validation / Events / Errors / Timeline) | Uncovered | Hidden by default. "…" → Problems & events opens it. Restyled. |
| Workflow sheet (Configure / Inspector / Runs / Memory) | Uncovered | Floating panel restyled. Its Configure tab is replaced by the node settings modal (node and loop-edge config). Opened from "…" or "Inspect". |
| TopBar project link | Restyle | Breadcrumb `HOME / PROJECT` + "…". |
| New node button | Restyle | "Add node" pill: creates an agent after the last stage (+320 x, ±50 y), links it with a data edge, selects it, opens its settings and centers on it. |
| Keyboard (F, Esc, Ctrl+A/C/V/D/Z/Y, Delete) | Kept | — |

## 3. Node settings modal (`config-panel/*`) — replaces the sheet's Configure tab

| Theme field | ACE equivalent | Disposition |
|---|---|---|
| Model provider (custom dropdown with orbs) | `providerId`, from the provider registry (`useProviders`) | Restyle |
| Model / "Model name" | `modelId`, from the catalog (`useModels`) | Restyle. Always the dropdown: catalog models exist for every provider type. |
| Custom connection panel (connection type, base URL, API key) | Provider-level fields (`Provider.baseUrl`, key), shared by every node using that provider | Remove. Stays on the Providers page. |
| Effort slider | none | Remove |
| Persona name | `node.name` | Restyle |
| Harness role (+ chip) | none | Remove. The header chip shows the node kind (AGENT, MODEL, …) instead. |
| Workspace permissions | none per node (provider-level `cliPermission`) | Remove |
| Run priority | none | Remove |
| System prompt | `instructions` (agent) / `systemPrompt` (model) | Restyle |
| ✦ Generate / ↺ Use role prompt | no prompt-expansion path, no role prompts | Remove |
| Skills toggles | `tools.enabled`: Web search = web_search + web_fetch; Edit files = write_file + edit_file; Run commands = run_command | Restyle. Shown only when the tools are registered. Citations has no tool → removed. |
| Remove node from canvas | `canvasApi.deleteNodes` (undoable) + reconnect every incoming edge to every outgoing edge when the types allow | Restyle |
| Done / "Changes save automatically" | GraphSync autosave | Restyle. Fields commit as you type (debounced) and on blur or close. |

ACE fields with no theme slot become Uncovered, inside the modal body in theme field styles:

- routing policy + fallback models
- structured output (JSON schema, review contract)
- execution (temperature, max tokens, timeout, retries)
- context budget
- other tools, max tool calls, allowed domains
- memory
- guardrail policy
- knowledge bases
- provider-missing / model-gone / "applies next run" notices

Other node kinds (input, model, merge, transform, retrieval, output) and loop edges use the same modal shell with their existing fields (Uncovered).

## 4. Forge (`forge/*`)

| Current | Bucket | Disposition |
|---|---|---|
| `ActivityBar` (Explorer button) | Remove | Ctrl+B kept. |
| SideBar `PanelGroup` (resizable %) | Restyle | Fixed 248px Explorer. |
| Explorer header "Explorer" | Restyle | "EXPLORER" + "N files" (`useFileList`). |
| Open editors section (+ Save all) | Remove | Ctrl+Alt+S kept. Tabs cover open files. |
| Refresh / Collapse buttons | Remove | The file watcher refreshes. |
| `FileTree` rows | Restyle | 26px rows: ▸/▾ caret, folder square, extension dot, active row, dirty dot. Live-agent badge from run `tool.call` writes by a RUNNING node. Keyboard kept. |
| Git M/A/U/D/R letters and tints | Remove | Logic (`decorations.ts`) stays. |
| *(new)* Filter input | Restyle | Filters `useFileList` paths. |
| `TabsBar` (tabs, close / dirty, keyboard, middle-click) | Restyle | Theme tabs. Preview italic and deleted strike-through are kept (real states). |
| Tab context menu (Close, Close others, Close saved, Copy path) | Uncovered | Kept, theme menu style. |
| *(new)* Path bar | Restyle | Breadcrumb; "{Agent} edited lines a–b · when" from run tool calls (write → whole file; edit → located new text); "▶ Run pipeline" → `useStartRun`. |
| Monaco (`EditorHost`, `forge-theme.ts`) | Restyle | Kept. Themes `ace-light` / `ace-dark` from `PAL_L` / `PAL_D`, backgrounds, line numbers, active line, cursor `#ef6b3f`, JetBrains Mono 13/20, no minimap, top padding 12, gutter bars for agent edits (decorations). |
| `EmptyEditor` (+ shortcut hints) | Restyle | "Open a file from the explorer" only. |
| Conflict / Deleted / Save-error bars, Compare view, Unsaved dialog, File notices, Image preview, before-unload guard | Uncovered | Restyled. |
| Bottom Output panel, Panel toggle | Remove | Warnings and errors from `logOutput` go to the toaster. |
| `StatusBar` (branch, Panel) | Remove | The global footer shows Ln/Col/Language/unsaved. |

## 5. Chat aside — Ideate and Forge (`chat/*`)

| Current | Bucket | Disposition |
|---|---|---|
| `ChatAside` header "Chat · node" | Restyle | "Team chat" + "Live" (socket open) + ✕ (closes the aside). |
| Mention chips (per-node sessions) | Restyle | Theme tabs row: one tab per agent/model node, "More" for overflow. |
| ⚑ Pin, "Actions +", Voice | Remove | No such features in ACE. |
| `ChatThreadList` (New chat, threads, delete) | Uncovered | Compact row under the tabs, restyled. |
| `ChatConversation` turns (`MessageBubble`) | Restyle | Theme message rows:
- 26px avatar (Y / ✳), name + time, 13px text, bullets via Markdown;
- meta line (model · tokens · run) + "Send to Forge →". |
| Streaming / thinking / live-run bubbles | Restyle | Typing row "{name} is typing…" + the growing text in the row. |
| Error turn, verdicts, refusal card, send error, upload error, attachment chips | Uncovered | Restyled. |
| `ChatComposer` (textarea, @ picker, Attach, Send, Enter / Shift+Enter) | Restyle | Theme composer. The "Enter starts a team run" hint is not shown, because Enter sends a direct chat here. |
| `ChatPanel` (phone tab) | Uncovered | Restyled. |

## 6. Domain (`domain/*`)

| Current | Bucket | Disposition |
|---|---|---|
| Header "Domain", "Board" link | Restyle / Remove | "Team chat" + "live" pill (SSE open) + filter pills + "N messages". Board → the Ideate mode pill. |
| Run picker, status, Run details, New run, End run | Uncovered | One theme dropdown pill at the right of the header holding run selection and actions. |
| Lenses (All / @handle) | Restyle | Filter pills (avatar + name). Server lens `?node=` kept. |
| Messages (`Conversation`) | Restyle | 34px avatar, name, @handle chip, time, 14.5px body. |
| "Steps and output" `<details>` | Restyle | "What it did": steps with per-step durations, ▸ show / ▾ hide. The full output (D327) shows in the expanded area. |
| Artifacts list | Restyle | Output card; "Open →" opens the file in Forge when it is inside the project, else the artifact URL. |
| Envelope rows + HELD Approve / Edit / Reject, delivery chips, system messages | Uncovered | Restyled. |
| `Composer` (Ctrl+Enter, autocomplete, preview, Queue/Interrupt, errors) | Restyle | Theme composer:
- Enter sends, Shift+Enter newline;
- mention chips per agent append `@handle`;
- "Enter starts a team run" shown only when it is true (no live run);
- the preview, delivery mode and errors stay (Uncovered).
Attach / Voice removed: the message contract is text-only. |
| `TeamPanel` | Restyle | Theme Team aside (330px, Split-toggled): agent cards (status pill, activity, tokens, bar = budget share) + TOKEN USE (total, budget, stacked bar, Input / Output / Est. cost when known, Per turn). Budget set/remove form (Uncovered) restyled under it. |

## 7. Home (`projects/ProjectsPage.tsx` at `/projects`)

| Current | Bucket | Disposition |
|---|---|---|
| h1 "Projects", "New project" + dialog | Restyle / Remove | Theme hero + Canvas / Forge cards. A card opens the existing new-project dialog (theme modal shell), then creates the project and a first workflow (named after the project), then opens it in Ideate or Forge. |
| Project rows (link, folder path, Rename / Delete menu) | Restyle / Remove | Theme Recent cards. Rename / Delete move to the "…" menu (Project section). `openProject` kept. |
| Empty state + Help link | Restyle | One muted line. |
| Global TopBar on `/projects` | Remove | Theme Home header. |
| *(new)* "Agents ready" pill | Restyle | Socket open and at least one CONNECTED provider. |
| *(new)* All / Live filter | Restyle | Live = a workflow with an active run (RUNNING / PAUSED / PREFLIGHT). |
| *(new)* card footer | Restyle | "N agents · Repository (when the folder is a git repo) · ago". |

## 8. Uncovered screens (restyled with tokens + kit)

Onboarding, ProjectPage, Providers (+ dialogs, models), Settings (+ backup, health), Guardrails (+ editor, test), Usage, Knowledge list / base (+ dialogs, documents, test search), Tools library, Help, Run detail, Project runs, Timeline page, TokenMissing, HomeRedirect, Errors, Inspector, Memory, Approvals.

Each gets the Home-style header with its section label. `packages/ui` is restyled once:

- Button: theme pills
- Input / Textarea: 38px, radius 9
- Select → theme dropdown
- Dialog: modal shell, radius 18
- Tabs: segmented pill
- Badge: mono chip
- Label: mono 9.5px
- Menus: theme menu
- Toaster: follows the theme
- MessageBubble: tokens

Native `<select>`s in Knowledge become theme dropdowns.

## 9. Missing logos

None. `claude`, `openai` (also Codex), `googlegemini`, `ollama` and `custom` (also OpenAI-compatible, Mock and "no provider") are all present.
