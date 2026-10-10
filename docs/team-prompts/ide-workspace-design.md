# ACE Forge — IDE workspace design

**Status:** revised 2026-10-09: two modes, Ideate and Forge, switched from the top bar; Forge laid out like VS Code. For review before the implementation plan.
**Branch:** `feat/ide-workspace`, on origin/main a023d45.
**Decisions:** D299–D302.
- Main ends at D289. `ace/parity` holds D267–D284, and `feat/desktop-shell` holds D292–D298.
- D290–D291 stay unused. An earlier draft of this design had numbered its decisions D288–D291, but main has since taken D288–D289 for the round 4–5 gates.

---

## 1. What we are building and why

ACE becomes an AI IDE in the mould of Cursor and Claude Code, with its workflow canvas built in. Inside a workflow a person works in two modes, one click apart:

| Mode | What it is |
|---|---|
| **Ideate** | The workflow canvas that exists today. It is where nodes are created, wired and run. |
| **Forge** | A VS Code–style code editor on the project folder: explorer, Monaco editor tabs, terminal, Problems and Output. |

**The chat column** sits on the right in both modes. It is the same conversation in both, and a switch never reloads it.

**Agents.** Every node is its own coding agent. Chatting with a Claude Code node is like opening a dedicated Claude Code session: told to "write Python code for X", it writes the files into the project. Nodes hand work to each other in two ways: by `@mention` in a chat, or automatically along the canvas edges when the workflow runs. Every change an agent makes to files can be reviewed as a diff and kept or reverted.

**Success means** a person can, without leaving the project:
- open a project;
- explore and edit its real files;
- run its commands and watch the output;
- see errors;
- have agents read and change the code;
- review or revert every AI change;
- switch freely between Ideate and Forge without losing anything.

### Non-goals (v1)
- **A native pseudo-terminal.** Full-screen terminal programs (vim, top) do not render. Line-based programs and prompts work (§6.3).
- **External language servers** (Python, Go, Rust …). Those languages get syntax highlighting and Problems from project checks, not IntelliSense.
- **A git UI** for commit, branch, push or merge. The Explorer shows the repository's status read-only (§6.4). Checkpoints (§5) are ACE's own history and never touch the user's repository.
- **Replace across files.** Search across files is in scope. Find and replace inside one file is Monaco's own.
- **Multi-user editing.**
- **Editing on phones.** At ≤ 640 px Forge is browse-only, consistent with FR-MOB-001.

---

## 2. Navigation: Ideate and Forge (D299)

### 2.1 Modes and routes

| Mode | Route | Scope |
|---|---|---|
| Ideate | `/projects/:pid/workflows/:wid` (today's route) | The workflow |
| Forge | `/projects/:pid/workflows/:wid/forge` | The project's files. The chat talks to this workflow's nodes. |

**The switch**
- It is a segmented control, `Ideate | Forge`, in the top bar right after the project name. It shows whenever a workflow is open.
- Clicking a mode swaps the route's suffix.
- `Ctrl/⌘+Shift+1` selects Ideate and `Ctrl/⌘+Shift+2` selects Forge. The keys are matched on `event.code` (`Digit1`, `Digit2`), so they also work with focus inside Monaco or the terminal.
- Plain `Ctrl/⌘+1…9` is the browser's own tab switcher, and a page cannot take it.

**What else changes, and what does not**
- **The top bar is the same in both modes:** workflow tabs, provider status, the run bar and approvals.
  - **New node** and the **Workflow panel** toggle only make sense on the canvas, so they show in Ideate only.
  - A workflow tab keeps the current mode. In Forge, it opens that workflow's Forge.
- **Opening a project** works as today: the project page and its workflow list. Opening a workflow lands in Ideate.
- **The timeline route** (`…/workflows/:wid/timeline`) is unchanged.

**One parent route holds both modes**
- `WorkflowLayout` is a parent route over both modes. It owns:
  - the workflow subscription, run events and adopting an active run (today these live in `WorkflowPage`);
  - the chat column.
- Switching modes therefore never drops a socket subscription or unmounts the chat. Only the main area changes.
- Ideate's own page is unchanged, except that the chat column moves into the layout. It keeps the test ids `chat-column` and `workflow-page`.
- The other mode is not kept mounted. Everything that must survive a switch lives in stores (§2.3).

**The chat column in both modes**
- It is resizable: 340 px by default, between 280 and 560 px.
- It can be hidden with `Ctrl/⌘+Alt+B` or the top-bar chat button.
- One remembered width and visibility apply to both modes, so the column never jumps when switching.

**At phone width (≤ 640 px)**
- Ideate keeps today's `CompactWorkflowLayout`, with its chat tab.
- Forge is browse-only: the explorer, then a read-only file view, with no terminal.
- The layout renders no chat column at this width.

### 2.2 Forge layout

Forge follows VS Code's layout:

```
┌ ACE / Project  [ Ideate | Forge ]  workflow tabs …     Run · approvals · chat ┐
├──┬──────────────┬──────────────────────────────────────────┬─────────────────┤
│▣ │ EXPLORER     │ app.tsx ●   utils.ts   README.md   ×     │                 │
│⌕ │ ▸ OPEN       │                                          │                 │
│± │   EDITORS    │                                          │      CHAT       │
│  │ ▾ PROJECT    │            Monaco editor                 │  (same column   │
│  │   ▸ src   M  │                                          │   as Ideate)    │
│  │     app.tsx M│                                          │                 │
│  │   README.md  ├──────────────────────────────────────────┤                 │
│  │              │ TERMINAL · PROBLEMS · OUTPUT          ⤢ ×│                 │
│  │              │ > pnpm dev                               │                 │
├──┴──────────────┴──────────────────────────────────────────┴─────────────────┤
│ ⊗ 0 ⚠ 2   ▶ 1 running                          Ln 12, Col 4  Spaces: 2  LF  TS │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Activity bar** (left edge): Explorer, Search and Changes. Changes shows a badge with the number of files waiting for review.
  - Clicking the active icon hides the side bar, as in VS Code. `Ctrl/⌘+B` toggles it too.
- **Side bar:** the view chosen in the activity bar (§6.4). It is 260 px by default, between 180 and 480 px.
- **Editor area:** the tabs, with Monaco beneath.
  - With no file open, it shows real actions with their keys: Quick open, New file and Toggle terminal.
- **Bottom panel:** Terminal · Problems · Output.
  - Showing it or not is the person's choice. It is hidden until first opened.
  - It opens with `` Ctrl+` `` (terminal), `Ctrl/⌘+J` (panel), the status bar, running a script or Run checks.
  - It has maximize and close buttons.
- **Right:** the chat column (§2.1).
- **Status bar:**
  - Error and warning counts; clicking them opens Problems.
  - The number of running processes; clicking it opens Terminal.
  - Cursor line and column, indentation, line endings, BOM, and language.
- **Panels are resizable** with `react-resizable-panels`, already an `apps/web` dependency but unused so far. Every panel's size and visibility are remembered in the browser.

### 2.3 State that survives switching
All of the following live in stores outside the mode components, so a mode switch or a workflow switch never tears them down:
- **The chat sessions** (PR #42), and the chat column itself, which stays mounted (§2.1).
- **The editor workspace, per project:**
  - open tabs, their order and the preview tab;
  - Monaco models and their view state (cursor, scroll, folding);
  - dirty buffers and each file's last-saved version.
- **Terminal sessions, per project,** and their scrollback.
- **The explorer:** expanded folders, selection and the chosen side-bar view.
- **The canvas:** selection and viewport. The viewport is already kept per workflow (`useViewportStore`).
- **Layout:** panel sizes and visibility.

**Unsaved edits**
- Switching modes or workflows never asks anything, because nothing is lost.
- Leaving the project with unsaved buffers asks first. Closing the browser tab does too (`beforeunload`).

### 2.4 Selecting a node
Selecting a node on the canvas makes it the chat's current node, as today. In Forge, the chat's node picker does the same.

---

## 3. The chat column

### 3.1 A conversation and its main node
- **Choosing the main node.** A new conversation starts by choosing its main node from the workflow's Agent nodes. The picker is the first thing shown on an empty chat.
- **Plain messages** go to the main node.
- **Who spoke.** `ChatThread.nodeId` stays the main node. Each agent turn now records which node spoke (`ChatMessage.speakerNodeId`, §8). The UI labels each agent bubble with that node's name and provider colour.

### 3.2 `@mention`: bringing another node in
- **Same conversation.** `@Node message` sends the message to that node inside the same conversation.
  - The mentioned node receives the conversation's recent turns, labelled by role and speaker.
  - They are bounded by its own `contextPolicy.budgetTokens`, oldest dropped first, as today.
  - Its reply lands in the same thread, labelled with its name.
- **The main node does not change.** A later plain message goes back to it, and it sees the mentioned node's reply as part of the conversation.
- **Engine side.** The engine takes the target node in the chat request (`ChatRequest.targetNodeId`, §8). The thread must belong to a node in the same workflow.
- **What this replaces.** PR #42's "an `@mention` switches the chat to that node" goes. Switching the main node is now an explicit choice: the picker, or selecting a node.

### 3.3 A run's results in the conversation
- **Where results land.** Run stays in the top bar in both modes. Each node's result lands in its own session (PR #42, D285).
- **Result cards.** The conversation the person is in also shows each node's result as it settles, as a compact card ("Critic finished · open"). The handoffs along the edges are visible without switching. **open** goes to that node's chat.

### 3.4 What an agent did
- **Activity list.** Each agent turn shows a compact activity list under the reply: files read, files edited, commands run.
  - For CLI nodes it comes from their `activity` chunks.
  - For API nodes it comes from the tool calls the turn made.
- **Changes card.** A turn that changed files ends with a Changes card (§5.3).

---

## 4. Node chats work in the project (D302)

Today a direct chat runs with no tools, and a CLI provider is forced read-only in a throwaway folder. Under D302 a chat turn works in the project folder, the same way a run does.

**CLI nodes** (Claude Code, Codex CLI, Gemini CLI)
- They run with `workingDir = project.folderPath` and the provider's own permission preset: `read_only`, `edit_files` or `full_auto`. The default is `edit_files` (D262).
- Their own tools do the reading, editing and commands within that preset, so no ACE approval cards are involved (D261).
- Their `activity` chunks are kept on the chat turn (§3.4).

**API-model nodes** (Anthropic, OpenAI, Google, OpenAI-compatible, Ollama)
- In chat they get ACE's non-destructive project tools: `list_files`, `read_file`, `write_file`, `edit_file`, `git_status`, `git_diff`.
- The tools run in a bounded loop in the chat service:
  - at most `tools.maxToolCalls` calls per turn;
  - results labelled untrusted (BR-13);
  - paths confined exactly as in runs.
- Their writes are checkpointed and revertible (§5), so no approval card is needed.
- **`run_command` is not offered in chat.** Shell commands belong to three places: CLI nodes (under their preset), workflow runs (with the existing approval card) and the person's terminal (§6.3).

**Rules for every chat turn**
- **Writing turns are queued,** one at a time per project, so two agents' file changes never interleave inside one checkpoint.
  - A turn that can write is any CLI turn whose preset is not `read_only`, and any API turn with tools.
  - Read-only turns run in parallel.
- **Usage and cost** are recorded per turn as today, including the CLI's own reported cost (D263).
- **Guardrails:** the input point and output point on chat stay as they are. Tool calls are logged.

---

## 5. Checkpoints (D300)

### 5.1 The store
- **Location.** Each project gets a private git repository at `<dataDir>/checkpoints/<projectId>.git`, used with `--work-tree=<project folder>`.
  - ACE never reads or writes the project's own `.git`, index, branches or stash. (The read-only status decorations in §6.4 run `git status` in the project, but never through this store.)
  - The project folder does not need to be a git repository.
- **What it skips.** It honours the project's `.gitignore` files. It also has its own excludes:
  - the folders `.git/`, `.ace/`, `node_modules/`, `dist/`, `build/`, `.next/`, `__pycache__/` and `.venv/`;
  - any file over 5 MB.
- **How git runs.** This is the same hygiene X1's git tools use:
  - argument arrays only, no shell;
  - `-c core.fsmonitor=false`, `GIT_CONFIG_NOSYSTEM=1` and `GIT_TERMINAL_PROMPT=0`;
  - an isolated `GIT_INDEX_FILE` inside the store;
  - no hooks.
- **Without git.** If git is not installed, checkpoints are unavailable. Agents still work, and the UI says that changes cannot be reverted.

### 5.2 Lifecycle
1. **Before** a writing turn or run, ACE snapshots the folder: `add -A` into the store's index, `write-tree`, `commit-tree`. The result is the checkpoint's `beforeCommit`. Only changed files cost anything, because git deduplicates.
2. **After** the turn or run, ACE snapshots again (`afterCommit`) and diffs `before..after`. For each changed file it records:
   - the path;
   - whether it was `added`, `modified`, `deleted` or `renamed`;
   - additions and deletions;
   - whether it is binary.
3. **If nothing changed**, the checkpoint is dropped and no card is shown.

**Kinds of checkpoint**
- `chat_turn`, with its thread, message and node.
- `run`, with its run. Each file is attributed to the node whose activity or tool call touched it, when that is known.
- `user_delete` (§6.1).

### 5.3 Review, keep, revert
- **The Changes card** shows the files with +/− counts and three actions: **Review**, **Keep all** and **Revert all**. It appears in the chat and in Forge's Changes view.
- **Review** opens Forge with a Monaco diff editor per file: the `beforeCommit` content on the left, the current disk content on the right. Each file has **Keep** and **Revert**.
- **Revert a file** restores the `before` content, or deletes the file if the agent created it.
  - The file on disk may no longer match `afterCommit`, because the person or another agent has changed it since. Then the revert answers **409 `file_changed_since`**.
  - The UI then offers a three-way choice: show the diff, revert anyway, or cancel.
- **Keep** marks the file accepted. A checkpoint with every file kept or reverted closes.
- **Retention.** Closed checkpoints are kept for history for 30 days, then pruned with `git gc`.

### 5.4 Editing while agents write
FR-GIT-004 says "editor read-only while a run is active". D300 replaces this with conflict-aware editing, because checkpoints already make every agent change reviewable:
- **Clean buffers follow the disk.** A file watcher (§6.1) updates a clean editor buffer when an agent changes the file.
- **Unsaved edits get a choice.** If the buffer has unsaved edits, the editor shows a bar with three choices:
  - **Compare:** a diff of yours against the disk.
  - **Take theirs:** reload from disk.
  - **Keep mine:** your next save wins.
- **No silent overwrites.** Saves carry the version they were based on (§6.1).

---

## 6. Forge

### 6.1 Project files: engine API
A new `WorkspaceService` lives in `packages/engine/src/workspace/`, behind a port implemented in `packages/tools/src/workspace/`. Routes are under `/api/v1/projects/:pid/files`:

| Route | Does |
|---|---|
| `GET /tree?path=` | Lists one folder: name, kind, size, mtime, `ignored`. Folders come first, in natural sort order. Lazy, one level per call. |
| `GET /content?path=` | Answers `{ content, version, eol, bom, size }`. `version` is a content hash. A binary file answers `{ binary: true }`, and a file over 2 MB answers `file_too_large`; either opens as a read-only notice. |
| `PUT /content` | Body `{ path, content, baseVersion }`. Atomic write: a temp file in the same folder, then a rename. Keeps the line endings and BOM it was given. A `baseVersion` that does not match the disk answers **409 `file_changed`** with the current version. |
| `POST /entries` | Body `{ path, kind: file \| folder }`. Creates the entry; an existing path answers **409 `exists`**. |
| `POST /move` | Body `{ from, to }`. Renames or moves, within the project only. The target existing answers **409 `exists`**. |
| `DELETE /entries?path=` | Captures the file or folder in a `user_delete` checkpoint first, so it can be restored from Changes, then deletes it. The UI confirms beforehand. |
| `GET /search?q=&regex=&caseSensitive=&glob=` | Searches files that are not ignored. Skips binary files and files over 2 MB. Capped at 2,000 matches; `truncated` says when the cap was hit. |
| `GET /list` | Every non-ignored file path, capped at 50,000, for quick open (Ctrl/⌘+P). |
| `GET /status` | The project repository's status, read-only, for Explorer decorations: `{ repo: false }`, or `{ repo: true, branch, files: [{ path, status }] }`. `status` is one of `modified`, `added`, `deleted`, `renamed` or `untracked`. It runs `git status --porcelain=v1` through the existing `runGit` hygiene in `@ace/tools`. |

**Rules for every route**
- **Confinement.** Paths go through `assertInsideProject` and `assertWritable` from `@ace/tools`, so absolute paths, `..`, symlink escapes and NTFS stream tricks are refused.
  - `assertWritable` is extended so that **any** `.git` path segment is read-only, not only the top-level one.
- **Writes** are refused into `.git/` and `.ace/` at any depth.
- **Errors** use the existing envelope, with new codes: `file_changed`, `file_too_large`, `binary_file`, `exists`, `not_found` and `outside_project`.
- **Methods.** CORS gains `PUT` in `allowMethods`.

**The watcher**
- **When it runs.** It is started for a project while any client is subscribed to that project's `project` scope (§8). It uses `fs.watch(folder, { recursive: true })`, available on Windows, macOS and Linux on Node 20+.
- **Batching.** Changes are debounced by 100 ms, and ignored paths are skipped.
- **What it sends.** Each burst is emitted as a transient `files.changed { projectId, changes: [{ path, kind: created | changed | deleted }] }`. The web refetches `/status` at most once a second after a burst.
- **What it never sends.** Contents never go over the socket and are never persisted. That also keeps secret-shaped strings out of the event log, which refuses them.

### 6.2 Editor
- **Monaco workers.** `monaco-loader.ts` gains the TypeScript, CSS and HTML workers. Today every language except JSON silently falls back to the plain editor worker.
- **Themes.** Night and Paper Monaco themes are defined from `@ace/ui` tokens and follow the app theme.
- **Models.** There is one model per open file, keyed by the URI `file:///<project-relative path>`.
  - The editor store holds each model with its view state (cursor, scroll, folding) and its last-saved version.
- **Tabs.**
  - A dirty tab shows a dot.
  - Tabs support middle-click close, Close others and Close saved.
  - A preview tab, shown in italics, is replaced by the next single-click open; editing or double-clicking keeps it.
- **IntelliSense** uses Monaco's TS/JS, CSS, HTML and JSON language services.
  - For cross-file TypeScript and JavaScript, the editor loads the project's `.ts`, `.tsx`, `.js`, `.jsx` and `.d.ts` files as models in the background.
  - That load is capped at 1,500 files and 2 MB total, and skips ignored paths.
  - It applies the `compilerOptions` from `tsconfig.json` when present.
- **Diagnostics.** Monaco markers feed the **Problems** panel for open files.
- **Formatting.** Format Document and Format Selection (Shift+Alt+F) use Monaco's built-in formatters. Format-on-save is a per-project toggle.
- **Save.** A 409 opens the conflict bar from §5.4.
- **Unsaved changes.** A confirm guards closing a dirty tab, Close others and leaving the project.
- **Images** open in a preview tab. Other binary files open as a read-only notice.

**Shortcuts**

The browser keeps `Ctrl/⌘+W`, `Ctrl/⌘+T`, `Ctrl/⌘+N`, `Ctrl+Tab` and `Ctrl/⌘+1…9` for itself, and a page cannot take them. Forge never binds them. Every key below prevents the browser's default and also works with focus inside Monaco.

| Action | Keys |
|---|---|
| Ideate / Forge | Ctrl/⌘+Shift+1 / Ctrl/⌘+Shift+2 |
| Save / Save all | Ctrl/⌘+S / Ctrl/⌘+Alt+S |
| Quick open (open editors first, then every file) | Ctrl/⌘+P |
| Search in files | Ctrl/⌘+Shift+F |
| Toggle side bar / bottom panel / chat | Ctrl/⌘+B / Ctrl/⌘+J / Ctrl/⌘+Alt+B |
| Toggle terminal | Ctrl+\` |
| Close editor tab | Alt+W |
| Format document | Shift+Alt+F |
| Ask agent about the selection | Ctrl/⌘+L |
| Rename / delete in the Explorer | F2 / Delete |
| Monaco's own: find, replace, go to line, command palette | Ctrl/⌘+F, Ctrl/⌘+H, Ctrl+G, F1 |

### 6.3 Terminal and processes (D301)
A new `ProcessService` lives in `packages/engine/src/processes/` as a port, with its runner in `packages/tools/src/process/`. Routes are under `/api/v1/projects/:pid/processes`:

| Route | Does |
|---|---|
| `POST /` | Body `{ command, cwd?, label? }`. Starts a supervised process and answers `{ processId }`. |
| `POST /:procId/input` | Body `{ data }`. Writes to the process's stdin, for prompts and REPL lines. |
| `POST /:procId/stop` | Kills the whole process tree: `taskkill /T /F` on Windows, the process group on POSIX. |
| `GET /` | Running and recent processes: label, command, status, exit code, start and end times. |
| `GET /scripts` | The project's own scripts: the `package.json` scripts and the package manager they run with. |

**How a process runs**
- **The shell.** It runs through the platform shell (`cmd.exe /d /s /c` on Windows, `/bin/sh -c` elsewhere), because the person typed it.
- **Where it runs.** Its working folder is confined to the project, and it has no TTY.
- **Environment.** The engine's environment minus anything secret-shaped, using the sandbox's `SECRET_SHAPED` rule.
  - `PATH` and `HOME` are kept so real toolchains work.
  - `FORCE_COLOR=1` is set.
- **Output** streams as transient `process.output { projectId, processId, stream, data }` frames, batched at 50 ms. The last 1 MB per process is kept in memory for late subscribers.
- **Ending.** `process.exited { projectId, processId, exitCode, signal }` is sent when it finishes.
- **Limits.** At most 8 processes run at once per project. Everything is stopped when the engine shuts down.

**Trust levels (the per-project setting `terminal`)**
- `on`, the default: runs project scripts and any typed command, as above.
- `scripts`: runs only the project's own scripts.
- `off`: disables the terminal.

**Agents never use this service.** Their commands keep their existing paths: the CLI preset, and `run_command` with an approval card in runs.

**Web side**
- **Rendering.** `@xterm/xterm` with `@xterm/addon-fit` renders the output, with ANSI colour, links and find.
- **Tabs.** A terminal tab is a line-mode session with its own working folder and line history.
  - When nothing is running, a typed line starts a process.
  - While a process runs, typed lines go to its stdin.
  - Ctrl+C stops the running process.
- **Built-in commands.** The session handles `cd <dir>` itself, confined to the project, and so `cd` persists between commands. It also handles `cls` / `clear`. Other shell state does not carry over between commands (§14).
- **Several terminals.** Several terminal tabs are allowed. A **Processes** list shows running dev servers with Stop.
- **Scripts.** Script buttons in the terminal header run a project script in a new tab.

### 6.4 Side bar, panels and search

**Explorer**

The Explorer has two collapsible sections, as in VS Code:
- **Open editors.** The open tabs, each with a close button; unsaved ones show a dot. Save all sits in the header. These are the files the person is editing.
- **The project's folder tree**, headed with the project's name.
  - **Loading.** It loads lazily. Ignored entries are dimmed.
  - **Header buttons:** New file, New folder, Refresh, Collapse all.
  - **Creating and renaming** happen in an inline input in the tree, as in VS Code.
  - **Context menu:** New file, New folder, Rename (F2), Delete (Delete; it confirms), Copy path, Copy relative path, and Ask agent about this file.
  - **Moving.** Files and folders can be dragged into another folder. The move is confirmed first, and open tabs follow it.
  - **Keyboard:** the arrows move and expand, Enter opens, and typing jumps to a name.

**Decorations: which files are changing, as in VS Code**
- **Repository status.** If the project folder is a git repository, each changed file shows its status letter and colour, from `/status`:
  - **M** modified;
  - **A** added;
  - **U** untracked;
  - **D** deleted;
  - **R** renamed.
- **Folders** that contain changes take the colour.
- **Agent changes.** A file an agent changed that is still waiting for review gets a separate accent marker, which links to Changes. This works whether or not the folder is a git repository.

**Search and Changes**
- **Search:** a query, with regex, match-case and include-glob options. Results are grouped by file, and clicking one opens the file at that line.
- **Changes:** the checkpoints, pending ones first. Each lists its files with +/− counts, **Review**, **Keep all** and **Revert all**, and per-file Keep and Revert (§5.3).

**Bottom panel: Terminal · Problems · Output**
- **Problems** shows two things:
  - the Monaco markers for open files;
  - the results of **Run checks**, which runs the project's check command (a project setting, for example `pnpm tsc --noEmit`) as a process. It parses `file:line:col` diagnostics from the output, in the tsc, eslint and generic formats.
  - Each problem has **Fix with agent**.
- **Output** shows the engine's messages for the workspace: watcher, checkpoint and save errors.

### 6.5 AI from inside the editor
- **Ask agent.** Select code and choose **Ask agent** from the context menu, or press Ctrl/⌘+L.
  - It adds a reference chip to the chat composer, `path:Lstart-Lend`, carrying the selected text as a `code` part.
  - The chat column then talks to the current node.
- **Fix with agent** on a problem sends the current node the error message, with the file, the line and the surrounding lines.
- **The agent's edits** come back as a Changes card. The open editor reflects them through the watcher.

---

## 7. Security

- **Every new route** sits behind the existing token, Origin and request-id middleware.
- **The WebSocket upgrade** now checks `Origin` against the same allow-list as REST. Today it checks only the token. This matters more now that a socket can stream terminal output.
- **File access** is confined to the project folder (FR-GIT-008, NFR-SEC-03), with `.git` and `.ace` protected at any depth.
- **Agents' writes** are always checkpointed. Shell access for agents is unchanged: the CLI preset, or approval in runs.
- **Terminal processes** have a scrubbed environment, a confined working folder, capped output, a process limit and tree kill. The terminal is a person's tool, governed by the per-project trust level (D301).
- **Nothing reaches the database or event log:** no file contents, no terminal output and no environment values. Their events are transient, so the existing secret write-guard never sees them.

---

## 8. Contracts (additive)

**Modified: `packages/contracts/src/chat.ts`**
- `ChatRequest` gains `targetNodeId?`.
- `ChatMessage` gains `speakerNodeId?`, `activity?: ActivityItem[]` and `checkpointId?`.

**New: `packages/contracts/src/workspace.ts`**
- File entry, file content, save request and result, search request and result, file list, repository status.
- `Checkpoint { id, projectId, kind, threadId?, messageId?, runId?, nodeId?, status, files: CheckpointFile[], createdAt }`.
- Checkpoint actions: keep and revert, per file or all.
- Process start, input and stop; process summary; project scripts.

**Modified: `ws.ts` / `events.ts`**
- A new `project` scope, `{ scope: 'project', id: projectId }`.
- Its frames are all transient: `files.changed`, `process.output`, `process.exited` and `checkpoint.updated`.

**Modified: `settings.ts` / `graph.ts`.** The project gains `terminal: 'on' | 'scripts' | 'off'` (default `on`), `checkCommand?` and `formatOnSave?`.

**Storage.** One new migration adds a `checkpoints` table (id, project_id, kind, refs, status, files JSON, timestamps) and the project columns above.

---

## 9. Where the code goes

| Package | New / changed |
|---|---|
| `contracts` | `workspace.ts` (new); `chat.ts`, `ws.ts`, `events.ts`, `graph.ts` (additive) |
| `tools` | `workspace/` (file ops, search, list, status, watcher); `checkpoints/` (shadow-git store); `process/` (supervised runner) |
| `engine` | `workspace/`, `checkpoints/` and `processes/` services and routes; in the chat service, workspace mode, the project tool loop, `@mention` targeting and the write queue; in the run service, run checkpoints; in the WS hub, the `project` scope |
| `storage-local` | The migration and the checkpoint repository |
| `server` | Wiring; the WS Origin check |
| `sdk` | Client methods for the routes above; the `project` subscription |
| `ui` | `TreeView`; Monaco theme tokens |
| `web` | `WorkflowLayout` (the parent route with the subscriptions and chat column), the `ModeSwitch` in the top bar, and `forge/`. `forge/` holds: page and layout, activity bar, Explorer with Open editors, decorations and drag-move, tabs, editor host, diff review, terminal, Problems, Output, Search, Changes, status bar, editor and terminal stores, and shortcuts. Also the mock engine for all of it. |

**New dependencies:** `@xterm/xterm` and `@xterm/addon-fit` in `apps/web`. `react-resizable-panels` is already a dependency. There are no native modules and no new engine or tools dependency: git is the system git, and the watcher is Node's `fs.watch`.

---

## 10. Errors the person sees

Every failure is shown where it happened, in words, never swallowed.
- **A save that fails** (permission, disk full, conflict) keeps the buffer dirty and says why.
- **A refused path** says it is outside the project.
- **A move onto an existing name** says so and changes nothing.
- **A process that fails to start** says so in its terminal tab.
- **A checkpoint that fails** (git missing, or folder unreadable) shows on the turn: "changes were made but can't be reverted: <reason>".
- **No git for decorations.** If git is missing or the folder is not a repository, the Explorer shows no status decorations. It shows no error either. Agent-change markers still show.
- **The agent's own failures** keep PR #42's behaviour: a stored error turn.

---

## 11. Testing

| Level | Covers |
|---|---|
| tools unit | **Confinement**, including nested `.git`, NTFS streams and symlinks.<br>**Saving:** atomic save, EOL/BOM and 409.<br>**Moving:** onto an existing name.<br>**Search:** caps and ignore rules.<br>**Status:** parsing, and the case where the folder is not a repository.<br>**Checkpoints:** snapshot, diff and revert, including created, deleted and renamed files, `.gitignore`, the 5 MB skip and the "changed since" 409.<br>**Process runner:** streaming, stdin, tree kill, environment scrubbing, the process limit.<br>**Watcher:** debounce. |
| engine unit | **Routes and errors:** workspace and process.<br>**Chat workspace mode:** the CLI gets `workingDir` and the preset; the API tool loop and its cap; `@mention` targeting with context; the write queue.<br>**Run checkpoints.**<br>**WS:** `project` scope routing. |
| storage | The migration and the checkpoint repository round-trip. |
| server integration | A real engine, a temp project folder and a scripted CLI that edits files:<br>• a chat turn → its Changes card → revert;<br>• terminal command streaming and stop;<br>• WS Origin refusal. |
| web unit | **Switching keeps state:** an unsaved buffer, an arriving chat reply and a terminal's scrollback survive Ideate ↔ Forge and a workflow-tab switch.<br>**Panels:** they hide, show and resize, and are remembered.<br>**Explorer:** operations with the unsaved-changes guard, inline rename, drag-move with tabs following, decorations.<br>**Editor:** tabs, dirty state and the conflict bar.<br>**Problems, search and Changes review**, with Monaco mocked as today. |
| web e2e (MSW) | Real Monaco in Chromium:<br>• open, edit, save, conflict, quick open;<br>• the shortcuts, with the browser default prevented;<br>• a terminal run;<br>• AI change review and revert;<br>• Ideate ↔ Forge switching by button and by key. |
| acceptance (real engine) | The whole loop on a temp project with the mock coder. |
| live | A real Claude Code node edits a file from chat; the edit is reviewed and reverted in Forge. |

---

## 12. Delivery phases

Each phase ends green (typecheck, lint, all suites) and usable on its own. No phase ships a placeholder: a panel appears in the phase that makes it work.

1. **Forge and files.**
   - `WorkflowLayout` and the `Ideate | Forge` switch.
   - Forge's layout: activity bar, side bar, editor, bottom panel and chat, all resizable and hideable.
   - The file API, watcher and `/status`.
   - Explorer: Open editors, inline create and rename, drag-move, delete, decorations.
   - Tabs, Monaco workers and themes, save and conflicts, quick open, unsaved guards, status bar.
   - Problems (Monaco markers) and Output.
2. **Terminal.** The process service and runner, the `project` WS scope, the xterm terminal with `cd`, scripts, the Processes view, trust levels, the WS Origin check.
3. **Agents in the project, and checkpoints.**
   - Chat workspace mode: the CLI preset and the API tool loop.
   - `@mention` targeting with shared context; the write queue.
   - The checkpoint store, Changes cards and view, the agent-change markers, diff review, keep and revert, run checkpoints.
4. **Checks, search and polish.** The check command in Problems, search, Ask agent and Fix with agent, format and format-on-save, the browse-only phone layout, docs.

---

## 13. Decisions

| # | Decision |
|---|---|
| D299 | Inside a workflow ACE has two modes, switched from the top bar: **Ideate** (the canvas) and **Forge** (a code editor on the project folder).<br>• The chat column is shared by both and stays mounted; switching modes or workflows never loses state.<br>• Forge is laid out like VS Code: activity bar and side bar (Explorer with Open editors and change decorations, Search, Changes), editor tabs, a bottom panel (Terminal, Problems, Output) and the chat on the right.<br>• Every panel can be resized and hidden, and the choice is remembered. |
| D300 | AI file changes are reviewed through checkpoints.<br>• A checkpoint is a private git store per project, outside the project's own `.git`. It is snapshotted before and after each writing chat turn or run, with keep and revert per file.<br>• It replaces FR-GIT-004's "editor read-only during runs" with conflict-aware editing. |
| D301 | The terminal runs a person's commands as supervised processes.<br>• Each has a confined working folder, a scrubbed environment, streamed output, capped buffers and tree kill.<br>• A per-project trust level governs it: `on`, `scripts` or `off`.<br>• Agents never use it. There is no PTY in v1. |
| D302 | A node chat works in the project folder.<br>• CLI nodes use their provider's permission preset. API nodes get the non-destructive project tools in a bounded loop.<br>• Writing turns are queued per project.<br>• `@Node` asks another node inside the same conversation, with its recent turns as context.<br>• This amends FR-CHAT-005: a chat turn may change project files, and the change is always checkpointed. It still never reads or writes runs. |

---

## 14. Known limitations (v1)
- **No PTY.** Full-screen terminal programs do not render: vim, top, htop, and some installers' interactive menus. Line prompts work.
- **Shell state between commands.** A terminal tab keeps its `cd`, but other shell state does not carry from one command to the next, such as `set` / `export` or activating a virtualenv. Chaining in one line works (`venv\Scripts\activate && python app.py`).
- **No tab-cycling shortcut in the browser.** The browser keeps `Ctrl+Tab`. Quick open lists the open editors first.
- **IntelliSense** covers only TS, JS, CSS, HTML and JSON. Other languages get highlighting, plus Problems from the check command.
- **Cross-file TypeScript** IntelliSense is capped at 1,500 files and 2 MB of source.
- **Checkpoints need git** on PATH. They skip files over 5 MB and the excluded folders; changes there are not revertible, and the card says so.
- **Explorer status decorations need git** and a repository.
- **API-model nodes cannot run shell commands from chat.** They can in workflow runs, with approval.
- **No git commit, branch or push UI. No replace across files.**
- **Phones** browse code but do not edit it.
