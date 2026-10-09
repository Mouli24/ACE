# ACE IDE workspace — design

**Status:** approved in conversation on 2026-10-09; this spec is for review before the implementation plan.
**Branch:** `feat/ide-workspace`, stacked on PR #42 (`fix/goal-node-chat-sessions-cli-models`).
**Decisions:** D288–D291. They continue after PR #42's D285–D287 and `ace/parity`'s D267–D284.

---

## 1. What we are building and why

ACE becomes an AI IDE in the mould of Cursor and Claude Code, with ACE's workflow canvas built in. A person works in three places that are always one click apart:

| Surface | What it is |
|---|---|
| **Chat** | The main place to work: a conversation with one agent node, which can bring other nodes in. |
| **Canvas** | The workflow editor that exists today. It is where nodes are created, wired and run. |
| **Code** | A VS Code–style workspace: file explorer, Monaco editor tabs, terminal, Problems and Output. |

Every node is its own coding agent. Chatting with a Claude Code node is like opening a dedicated Claude Code session: told to "write Python code for X", it writes the files into the project. Several nodes hand work to each other by `@mention` in a chat, or automatically along the canvas edges when the workflow runs. Every change an agent makes to files can be reviewed as a diff and kept or reverted.

**Success means** a person can, without leaving the project:
- open a project;
- explore and edit its real files;
- run its commands and watch the output;
- see errors;
- have agents read and change the code;
- review or revert every AI change;
- switch freely between Chat, Canvas and Code without losing anything.

### Non-goals (v1)
- A native pseudo-terminal. Full-screen terminal programs (vim, top) do not render; line-based programs and prompts work (§6.3).
- External language servers (Python, Go, Rust …). Those languages get syntax highlighting and Problems from project checks, not IntelliSense.
- A git UI: commit, branch, push, merge. Checkpoints (§5) are ACE's own history and never touch the user's repository.
- Multi-user editing.
- Editing on phones. At ≤ 640 px the workspace is browse-only, consistent with FR-MOB-001.

---

## 2. Navigation: everything from everything (D288)

### 2.1 Surfaces and routes

| Surface | Route | Scope |
|---|---|---|
| Chat | `/projects/:pid/workflows/:wid/chat` | A workflow: its nodes are the chat's agents |
| Canvas | `/projects/:pid/workflows/:wid` (today's route) | A workflow |
| Code | `/projects/:pid/code` | The project: files belong to the project folder |

- **Opening a project** (`/projects/:pid`) goes to the Chat surface of the project's most recently used workflow. That workflow is remembered per project in the browser; without one, it is the project's first workflow. A project with no workflow gets one created, named "Main".
- **The current project page** (workflow list, import, budget) moves to `/projects/:pid/settings`, linked from the breadcrumb.
- **The Code surface** remembers the active workflow per project, so its docked chat and canvas preview show that workflow's nodes.
- **The top bar always shows a switcher** `Chat · Canvas · Code` inside a project, with keyboard shortcuts Ctrl/⌘+1, 2, 3.
- **The workflow tabs stay.** They choose the workflow for Chat and Canvas.

### 2.2 The right dock

Each surface has a right dock: resizable, collapsible to an icon rail, with its size and open tab remembered. The dock shows the two surfaces that are not the main one:

| Main | Dock tabs |
|---|---|
| Chat | **Canvas** (live mini canvas) · **Code** (Changes + recent files) |
| Canvas | **Chat** (the full conversation, today's chat column) · **Code** |
| Code | **Chat** · **Canvas** |

- **The canvas preview** is a read-only miniature of the workflow. It shows nodes, edges and each node's live state (RUNNING glows, COMPLETED, FAILED) and fits to the panel. Clicking it opens the Canvas surface. Clicking a node in it selects that node for the chat.
- **The Code tab of the dock** lists checkpoints with their changed files, and recently opened files. Clicking a file opens it in the Code surface; clicking a checkpoint opens its diff review.
- **The Chat tab of the dock** is the same conversation component as the Chat surface. The thread, a reply still arriving and the last error are the same object (PR #42's session store).

### 2.3 State that survives switching

The following live in stores outside the surface components, and are therefore never torn down by a route change:
- the chat sessions (PR #42);
- the editor workspace: open tabs, Monaco models, view state and dirty buffers;
- terminal sessions and their scrollback;
- the canvas selection;
- dock layout.

Leaving a project with unsaved editor buffers asks first. Closing the browser tab does too (`beforeunload`).

### 2.4 Selecting a node

Selecting a node anywhere makes it the chat's current node: on the canvas, in the canvas preview, or in the chat's node picker.

---

## 3. Chat with nodes

### 3.1 A conversation and its main node
- A new conversation starts by choosing its **main node** from the active workflow's Agent nodes. The picker is the first thing shown on an empty chat.
- A plain message goes to the main node.
- `ChatThread.nodeId` stays the main node. Each agent turn now records which node spoke (`ChatMessage.speakerNodeId`, §8), and the UI labels each agent bubble with that node's name and provider colour.

### 3.2 `@mention`: bringing another node in
- `@Node message` sends the message to that node **inside the same conversation**. The mentioned node receives the conversation's recent turns, labelled by role and speaker, bounded by its own `contextPolicy.budgetTokens` (oldest dropped first, as today). Its reply lands in the same thread, labelled with its name.
- The conversation's main node does not change. A later plain message goes back to it, and it sees the mentioned node's reply as part of the conversation.
- The engine takes the target node in the chat request (`ChatRequest.targetNodeId`, §8). The thread must belong to a node in the same workflow.
- This replaces PR #42's "an `@mention` switches the chat to that node". Switching the main node is now an explicit choice: the picker, or selecting a node.

### 3.3 Running the workflow from chat
- The chat header carries **Run**, which starts the active workflow, exactly as the run bar does.
- Each node's result lands in its own session (PR #42, D285). The conversation the person is in also shows each node's result as it settles, as compact cards ("Critic finished · open"), so the handoffs along the edges are visible without switching.

### 3.4 What an agent did
- Each agent turn shows a compact activity list under the reply: files read, files edited, commands run. For CLI nodes this comes from their `activity` chunks; for API nodes it comes from the tool calls the turn made.
- A turn that changed files ends with a **Changes card** (§5.3).

---

## 4. Node chats work in the project (D291)

Today a direct chat runs with no tools, and a CLI provider is forced read-only in a throwaway folder. Under D291 a chat turn works in the project folder, the same way a run does:

- **CLI nodes** (Claude Code, Codex CLI, Gemini CLI) run with `workingDir = project.folderPath` and the provider's own permission preset (`read_only` / `edit_files` / `full_auto`, default `edit_files`, D262).
  - Their own tools do the reading, editing and commands within that preset, so no ACE approval cards are involved (D261).
  - Their `activity` chunks are kept on the chat turn (§3.4).
- **API-model nodes** (Anthropic, OpenAI, Google, OpenAI-compatible, Ollama) get ACE's non-destructive project tools in chat: `list_files`, `read_file`, `write_file`, `edit_file`, `git_status`, `git_diff`.
  - They run in a bounded tool loop in the chat service: at most `tools.maxToolCalls` calls per turn, results labelled untrusted (BR-13), path-confined exactly as in runs.
  - Their writes are checkpointed and revertible (§5), so no approval card is needed.
  - **`run_command` is not offered in chat.** Shell commands belong to CLI nodes (under their preset), to workflow runs (with the existing approval card) and to the person's terminal (§6.3).
- **Writing turns are queued**, one at a time per project, so two agents' file changes never interleave inside one checkpoint. A turn that can write is any CLI turn whose preset is not `read_only`, and any API turn with tools. Read-only turns run in parallel.
- **Usage and cost** are recorded per turn as today, including the CLI's own reported cost (D263).
- **Guardrails:** the input point and output point on chat stay as they are. Tool calls are logged.

---

## 5. Checkpoints (D289)

### 5.1 The store
- **Location.** A private git repository per project at `<dataDir>/checkpoints/<projectId>.git`, used with `--work-tree=<project folder>`. ACE never reads or writes the project's own `.git`, index, branches or stash. The project folder does not need to be a git repository.
- **What it skips.** It honours the project's `.gitignore` files, plus its own excludes: `.git/`, `.ace/`, `node_modules/`, `dist/`, `build/`, `.next/`, `__pycache__/`, `.venv/`, and any file over 5 MB.
- **How git runs.** It is invoked with argument arrays only (no shell), with `-c core.fsmonitor=false`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, an isolated `GIT_INDEX_FILE` inside the store, and no hooks. This is the same hygiene X1's git tools use.
- **Without git.** If git is not installed, checkpoints are unavailable. Agents still work, and the UI says that changes cannot be reverted.

### 5.2 Lifecycle
1. **Before** a writing turn or run, ACE snapshots the folder: `add -A` into the store's index, `write-tree`, `commit-tree`. The result is the checkpoint's `beforeCommit`. Only changed files cost anything, because git deduplicates.
2. **After** the turn or run, ACE snapshots again (`afterCommit`) and diffs `before..after`. It records the changed files: path, `added | modified | deleted | renamed`, additions, deletions, binary.
3. **If nothing changed**, the checkpoint is dropped and no card is shown.

**Kinds:** `chat_turn` (with thread, message and node), `run` (with run; each file attributed to the node whose activity or tool call touched it, when known), and `user_delete` (§6.1).

### 5.3 Review, keep, revert
- **The Changes card**, in the chat and in the Code dock, shows the files with +/− counts and three actions: **Review**, **Keep all** and **Revert all**.
- **Review** opens the Code surface with a Monaco diff editor per file: `beforeCommit` content on the left, current disk content on the right. Each file has **Keep** and **Revert**.
- **Revert a file** restores the `before` content, or deletes the file if the agent created it.
  - If the file on disk no longer matches `afterCommit` (the person or another agent has since changed it), the revert answers **409 `file_changed_since`**. The UI then offers a three-way choice: show the diff, revert anyway, or cancel.
- **Keep** marks the file accepted. A checkpoint with every file kept or reverted closes.
- **Retention.** Closed checkpoints are kept for history for 30 days, then pruned with `git gc`.

### 5.4 Editing while agents write
FR-GIT-004 says "editor read-only while a run is active". D289 supersedes this with conflict-aware editing, because checkpoints already make every agent change reviewable:
- A file watcher (§6.1) updates clean editor buffers when an agent changes a file.
- If the buffer has unsaved edits, the editor shows a bar: **Compare** (diff of yours against disk), **Take theirs** (reload) or **Keep mine** (your next save wins).
- Saves carry the version they were based on (§6.1), so an overwrite is never silent.

---

## 6. The Code surface

### 6.1 Project files: engine API
A new `WorkspaceService` lives in `packages/engine/src/workspace/`, behind a port implemented in `packages/tools/src/workspace/`. Routes are under `/api/v1/projects/:pid/files`:

| Route | Does |
|---|---|
| `GET /tree?path=` | Lists one folder: name, kind, size, mtime, `ignored`. Folders first, natural sort. Lazy, one level per call. |
| `GET /content?path=` | `{ content, version, eol, bom, size }`. `version` is a content hash. A binary file, or a file over 2 MB, answers `{ binary: true }` / `file_too_large` and opens as a read-only notice. |
| `PUT /content` | Body `{ path, content, baseVersion }`. Atomic write: temp file in the same folder, then rename. Keeps the line endings and BOM it was given. A `baseVersion` that does not match disk answers **409 `file_changed`** with the current version. |
| `POST /entries` | Body `{ path, kind: file \| folder }`. Creates; an existing path answers **409 `exists`**. |
| `POST /move` | Body `{ from, to }`. Rename or move, within the project only. |
| `DELETE /entries?path=` | Captures the file or folder in a `user_delete` checkpoint first, so it is restorable from Changes, then deletes it. The UI confirms beforehand. |
| `GET /search?q=&regex=&caseSensitive=&glob=` | Searches files that are not ignored. Skips binary and files over 2 MB. Capped at 2,000 matches; `truncated` says when the cap was hit. |
| `GET /list` | Every non-ignored file path, capped at 50,000, for quick open (Ctrl+P). |

**Rules for every route**
- **Confinement.** Paths go through `assertInsideProject` and `assertWritable` from `@ace/tools`, so absolute paths, `..`, symlink escapes and NTFS stream tricks are refused. `assertWritable` is extended so **any** `.git` path segment is read-only, not only the top-level one.
- **Writes** are refused into `.git/` and `.ace/` at any depth.
- **Errors** use the existing envelope, with new codes: `file_changed`, `file_too_large`, `binary_file`, `exists`, `not_found`, `outside_project`.
- **Methods.** CORS gains `PUT` in `allowMethods`.

**The watcher**
- Started for a project while any client is subscribed to its `project` scope (§8). It uses `fs.watch(folder, { recursive: true })`, available on Windows, macOS and Linux on Node 20+.
- Changes are debounced by 100 ms. Ignored paths are skipped.
- Each burst is emitted as a transient `files.changed { projectId, changes: [{ path, kind: created | changed | deleted }] }`.
- Contents are never sent over the socket and never persisted. That also keeps secret-shaped strings out of the event log, which refuses them.

### 6.2 Editor
- **Monaco workers.** `monaco-loader.ts` gains the TypeScript, CSS and HTML workers. Today every language but JSON silently falls back to the plain editor worker.
- **Themes.** Night and Paper Monaco themes are defined from `@ace/ui` tokens and follow the app theme.
- **Models.** One model per open file, keyed by URI `file:///<project-relative path>`, held in the editor store with its view state (cursor, scroll, folding) and its last-saved version. Tabs show a dirty dot and support middle-click close, Close others and Close saved. A preview tab (italic) is replaced by the next single-click open.
- **IntelliSense.** Monaco's TS/JS, CSS, HTML and JSON language services. For cross-file TypeScript and JavaScript, the editor loads the project's `.ts`/`.tsx`/`.js`/`.jsx`/`.d.ts` files in the background as models, capped at 1,500 files and 2 MB total, skipping ignored paths. It applies `compilerOptions` read from `tsconfig.json` when present.
- **Diagnostics** from Monaco markers feed the **Problems** panel for open files.
- **Formatting.** Format Document / Selection (Shift+Alt+F) uses Monaco's built-in formatters. Format-on-save is a per-project toggle.
- **Save.** Ctrl/⌘+S saves; Save all is available. A 409 opens the conflict bar from §5.4.
- **Unsaved changes.** A confirm guards closing a dirty tab, closing others and leaving the project.
- **Shortcuts.** The workspace takes Ctrl/⌘ + S, P (quick open), Shift+F (search), \` (toggle terminal), B (toggle explorer), W (close tab), Tab / Shift+Tab (next and previous tab), and 1, 2, 3 (surfaces). Inside Monaco, F1 opens Monaco's command palette. Browser defaults such as save-page are prevented.
- **Images** open in a preview tab. Other binary files open as a read-only notice.

### 6.3 Terminal and processes (D290)
A new `ProcessService` lives in `packages/engine/src/processes/` (port), with its runner in `packages/tools/src/process/`. Routes are under `/api/v1/projects/:pid/processes`:

| Route | Does |
|---|---|
| `POST /` | Body `{ command, cwd?, label? }`. Starts a supervised process and answers `{ processId }`. |
| `POST /:procId/input` | Body `{ data }`. Writes to the process's stdin, for prompts and REPL lines. |
| `POST /:procId/stop` | Kills the whole process tree (`taskkill /T /F`, or the POSIX process group). |
| `GET /` | Running and recent processes: label, command, status, exit code, start and end times. |
| `GET /scripts` | The project's own scripts: `package.json` scripts and the package manager they run with. |

**How a process runs**
- It runs through the platform shell (`cmd.exe /d /s /c` on Windows, `/bin/sh -c` elsewhere) because the person typed it. Its working folder is confined to the project, and it has no TTY.
- **Environment.** The engine's environment minus anything secret-shaped, using the sandbox's `SECRET_SHAPED` rule. `PATH` and `HOME` are kept so real toolchains work, and `FORCE_COLOR=1` is set.
- **Output** streams as transient `process.output { projectId, processId, stream, data }` frames, batched at 50 ms. The last 1 MB per process is kept in memory for late subscribers.
- **Ending.** `process.exited { projectId, processId, exitCode, signal }` is sent when it finishes.
- **Limits.** At most 8 running processes per project. Everything is stopped when the engine shuts down.

**Trust levels (per-project setting `terminal`)**
- `on` (default) runs project scripts and any typed command, as above.
- `scripts` runs only the project's own scripts.
- `off` disables the terminal.

**Agents never use this service.** Their commands keep their existing paths: the CLI preset, and `run_command` with an approval card in runs.

**Web side**
- `@xterm/xterm` with `@xterm/addon-fit` renders the output (ANSI colour, links, find).
- The input line is xterm's own: typed lines are sent on Enter, Ctrl+C stops the process, and the line history is per session.
- Several terminal tabs are allowed. A **Processes** list shows running dev servers with Stop.
- Script buttons in the terminal header run a project script in a new tab.

### 6.4 Panels and search
- **Bottom panel:** **Terminal · Problems · Output**.
  - **Problems** shows Monaco markers for open files plus the results of **Run checks**. Run checks executes the project's check command (a project setting, e.g. `pnpm tsc --noEmit`) as a process and parses `file:line:col` diagnostics from its output, in the tsc, eslint and generic formats. Each problem has **Fix with agent**.
  - **Output** shows engine messages for the workspace: watcher, checkpoint and save errors.
- **Left sidebar:** **Explorer · Search · Changes**.
  - **Explorer** shows the tree from §6.1, with ignored entries dimmed. Its context menu offers New file, New folder, Rename, Delete, Copy path, and Reveal in chat ("ask about this file").
  - **Search** shows results grouped by file; clicking one opens the file at that line.
  - **Changes** lists checkpoints (§5.3).

### 6.5 AI from inside the editor
- Selecting code and choosing **Ask agent** (context menu, or Ctrl/⌘+L) adds a reference chip to the chat composer, `path:Lstart-Lend`, carrying the selected text as a `code` part. The docked chat then talks to the current node.
- **Fix with agent** on a problem sends the error message with the file, line and surrounding lines to the current node.
- The agent's edits come back as a Changes card, and the open editor reflects them through the watcher.

---

## 7. Security

- **Every new route** sits behind the existing token, Origin and request-id middleware.
- **The WebSocket upgrade** now checks `Origin` against the same allow-list as REST. Today it checks only the token. This matters more now that a socket can stream terminal output.
- **File access** is confined to the project folder (FR-GIT-008, NFR-SEC-03), with `.git` and `.ace` protected at any depth.
- **Agents' writes** are always checkpointed. Shell access for agents is unchanged: the CLI preset, or approval in runs.
- **Terminal processes** have a scrubbed environment, a confined working folder, capped output, a process limit and tree kill. The terminal is a person's tool, governed by the per-project trust level (D290).
- **Nothing reaches the database or event log:** no file contents, no terminal output and no environment values. Their events are transient, so the existing secret write-guard never sees them.

---

## 8. Contracts (additive)

**Modified:** `packages/contracts/src/chat.ts`.
- `ChatRequest` gains `targetNodeId?`.
- `ChatMessage` gains `speakerNodeId?`, `activity?: ActivityItem[]` and `checkpointId?`.

**New:** `packages/contracts/src/workspace.ts`.
- File entry, file content, save request/result, search request/result, file list.
- `Checkpoint { id, projectId, kind, threadId?, messageId?, runId?, nodeId?, status, files: CheckpointFile[], createdAt }`.
- Checkpoint actions: keep and revert, per file or all.
- Process start / input / stop, process summary, project scripts.

**Modified:** `ws.ts` / `events.ts`.
- A new `project` scope, `{ scope: 'project', id: projectId }`.
- Its frame family is all transient: `files.changed`, `process.output`, `process.exited`, `checkpoint.updated`.

**Modified:** `settings.ts` / `graph.ts`. The project gains `terminal: 'on' | 'scripts' | 'off'` (default `on`), `checkCommand?` and `formatOnSave?`.

**Storage.** One new migration: a `checkpoints` table (id, project_id, kind, refs, status, files JSON, timestamps) and the project columns above.

---

## 9. Where the code goes

| Package | New / changed |
|---|---|
| `contracts` | `workspace.ts` (new); `chat.ts`, `ws.ts`, `events.ts`, `graph.ts` (additive) |
| `tools` | `workspace/` (file ops, search, list, watcher); `checkpoints/` (shadow-git store); `process/` (supervised runner) |
| `engine` | `workspace/`, `checkpoints/`, `processes/` services and routes; the chat service's workspace mode, project tool loop, `@mention` targeting, write queue; the run service's run checkpoints; the WS hub's `project` scope |
| `storage-local` | migration and checkpoint repository |
| `server` | wiring; WS Origin check |
| `sdk` | client methods for the routes above; `project` subscription |
| `ui` | `ResizableLayout`, `TreeView`, `DockTabs`, and Monaco theme tokens |
| `web` | surfaces switcher, `ChatSurface`, `CanvasPreview`, `RightDock`; `ide/` (explorer, tabs, editor host, diff review, terminal, problems, search, changes, editor store, shortcuts); mock engine for all of it |

New dependencies: `@xterm/xterm` and `@xterm/addon-fit` in `apps/web`. No native modules. No new engine or tools dependency: git is the system git, and the watcher is Node's `fs.watch`.

---

## 10. Errors the person sees

Every failure is shown where it happened, in words, never swallowed.
- **A save that fails** (permission, disk full, conflict) keeps the buffer dirty and says why.
- **A refused path** says it is outside the project.
- **A process that fails to start** says so in its terminal tab.
- **A checkpoint that fails** (git missing, or folder unreadable) shows on the turn: "changes were made but can't be reverted: <reason>".
- **The agent's own failures** keep PR #42's behaviour: a stored error turn.

---

## 11. Testing

| Level | Covers |
|---|---|
| tools unit | Confinement, including nested `.git`, NTFS streams and symlinks. Atomic save, EOL/BOM and 409. Search caps and ignore rules. Checkpoint snapshot/diff/revert, including created, deleted and renamed files, `.gitignore`, the 5 MB skip and "changed since" 409. Process runner: streaming, stdin, tree kill, environment scrubbing, process limit. Watcher debounce. |
| engine unit | Workspace and process routes and errors. Chat workspace mode: CLI gets `workingDir` and the preset; API tool loop with the cap; `@mention` targeting with context; the write queue. Run checkpoints. `project` WS scope routing. |
| storage | Migration and checkpoint repository round-trip. |
| server integration | A real engine, a temp project folder and a scripted CLI that edits files: chat turn → Changes card → revert. Terminal command streaming and stop. WS Origin refusal. |
| web unit | Surface switching keeps state. Dock. Explorer operations with the unsaved-changes guard. Tabs, dirty state and the conflict bar. Problems. Search. Changes review (Monaco mocked, as today). |
| web e2e (MSW) | Real Monaco in Chromium: open, edit, save, conflict, quick open, terminal run, AI change review and revert, three-surface navigation. |
| acceptance (real engine) | The whole loop on a temp project with the mock coder. |
| live | A real Claude Code node edits a file from chat; review and revert in the editor. |

---

## 12. Delivery phases

Each phase ends green (typecheck, lint, all suites) and usable on its own.

1. **Surfaces and dock.** Switcher, Chat surface, canvas preview, right dock, project routes and settings page, shared state.
2. **Files and editor.** File API, watcher, explorer, tabs, Monaco workers and themes, save and conflicts, quick open, unsaved guards.
3. **Terminal.** Process service and runner, `project` WS scope, xterm terminal, scripts, Processes view, trust levels, WS Origin check.
4. **Agents in the project, and checkpoints.** Chat workspace mode (CLI preset and API tool loop), `@mention` targeting with shared context, write queue, checkpoint store, Changes cards, diff review, keep and revert, run checkpoints.
5. **Problems, search and polish.** Problems panel and check command, search, Ask agent / Fix with agent, format and format-on-save, browse-only phone layout, docs.

---

## 13. Decisions

| # | Decision |
|---|---|
| D288 | ACE has three surfaces per project: Chat, Canvas and Code. Each docks the other two on the right, and switching never loses state. Opening a project lands in Chat. The former project page becomes `/projects/:pid/settings`. |
| D289 | AI file changes are reviewed through checkpoints: a private git store per project outside the project's own `.git`, snapshotted before and after each writing chat turn or run, with keep and revert per file. It supersedes FR-GIT-004's "editor read-only during runs" with conflict-aware editing. |
| D290 | The terminal runs a person's commands as supervised processes, with a confined working folder, scrubbed environment, streamed output, capped buffers and tree kill, governed by a per-project trust level (`on` / `scripts` / `off`). Agents never use it. There is no PTY in v1. |
| D291 | A node chat works in the project folder. CLI nodes use their provider's permission preset; API nodes get the non-destructive project tools in a bounded loop. Writing turns are queued per project. `@Node` asks another node inside the same conversation, with its recent turns as context. Amends FR-CHAT-005: a chat turn may change project files, always checkpointed. It still never reads or writes runs. |

---

## 14. Known limitations (v1)
- **No PTY.** Full-screen terminal programs (vim, top, htop, some installers' interactive menus) do not render; line prompts work.
- **IntelliSense** only for TS/JS/CSS/HTML/JSON. Other languages get highlighting, plus Problems from the check command.
- **Cross-file TypeScript** IntelliSense is capped at 1,500 files and 2 MB of source.
- **Checkpoints need git** on PATH, and skip files over 5 MB and the excluded folders. Changes there are not revertible, and the card says so.
- **API-model nodes cannot run shell commands from chat** (they can in workflow runs, with approval).
- **No git commit, branch or push UI.**
- **Phones** browse code but do not edit it.
