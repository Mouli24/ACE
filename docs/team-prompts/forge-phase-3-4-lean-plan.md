# Forge Phases 3 + 4: lean plan (parallel tracks)

> **Why lean.** The owner needs this shown soon. On 2026-10-13 they said: "do phase 3 & 4 now both at once and skip e2e testing". So this plan fixes the decisions and interfaces and leaves the code to the implementers. Each track is built test-first with unit and integration tests. There is **no Playwright/e2e** in this plan.

**Spec:** `docs/team-prompts/ide-workspace-design.md`, mainly §3 (chat column), §4 (D302), §5 (D300 checkpoints), §6.2, §6.4, §6.5, §7, §8, §9, §10, §11 and §12 items 3–4. Decisions D300, D302 and D334 (amended) are in `docs/DECISIONS.md`.

**Base.** The base branch is `feat/forge-phase-3-4`, cut from `feat/forge-phase-2-ui` at 7d155fa. That base already contains:
- Domain (D303–D327);
- the Ace theme (D328–D338);
- Forge phases 1–2.

**Tracks.** Three tracks run in parallel, each in its own worktree and branch. A merge step then joins them, wires the cross-track seams, runs every gate except e2e, and writes the docs.

| Track | Branch / worktree | Scope |
|---|---|---|
| **A: Checkpoints (D300)** | `feat/forge-p34-checkpoints` / `wt/forge3-a` | The private git store, the checkpoint service, routes and frames, run checkpoints, the Changes view, Changes cards, agent-change markers, diff review, keep and revert |
| **B: Chat in the project (D302)** | `feat/forge-p34-chat` / `wt/forge3-b` | Chat workspace mode (CLI preset, API tool loop), the write queue, `@handle` targeting with shared context, speakers, activity, Ask agent and Fix with agent |
| **C: Checks, search, format, types** | `feat/forge-p34-tools` / `wt/forge3-c` | Project settings (check command, format on save), Search, Run checks into Problems, Format and format-on-save, and cross-file TypeScript IntelliSense |

---

## Global constraints (every track)
- **Layering.** Follow CLAUDE.md §3.4 and the Phase 1–2 constraints:
  - The engine imports only `@ace/contracts` and its own ports. `@ace/tools` implements ports, and `apps/server` wires them together.
  - There are no Node APIs in web/ui/sdk and no browser APIs in engine-side code.
  - There is no `any`, `@ts-ignore` or `console.*` in engine-side code.
- **Tests.**
  - Write the failing test first, then make it pass.
  - Use unit tests plus engine/server integration tests where they matter.
  - **Do not write or run e2e.**
  - `pnpm test` must pass with no env vars and no network. Use `describe.skipIf(!hasGit)` where git is needed.
  - Packages resolve to `dist/`, so build a changed package before you test its importers.
- **Commits.**
  - Use Conventional Commits ending in the decision ids: `[D300]`, `[D302]` or `[D339]`.
  - Use FR ids where they apply: FR-GIT-003/004/008, FR-CHAT-*.
  - End every commit with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Formatting.** Hand-format the lines you add to existing files (single quotes, width 100). Run Prettier only on new files, with `--config packages/config/prettier.config.js`.
- **Look and feel.** Every new screen follows the Ace theme (D328–D338): reuse its components and tokens and add no new colours. It must work in light and dark. Look at how Forge's Explorer, Problems and the Terminal are styled.
- **Ports and other worktrees.** Never touch ports 4747/5173. Never touch the other worktrees. Never `git stash`.
- **Privacy (design §7).** Nothing new reaches the DB or event log with file contents in it:
  - chat activity stores tool name, path and a ≤200-char summary only;
  - checkpoint rows store paths and counts only. File contents live only in the private git store under the data dir.
- **Error codes.** New codes go in `IDE_ERROR_CODES` and the status map in `contracts/src/errors.ts`. Only Track A adds codes (see A). The other tracks use `validation_failed`, `not_found`, `invalid_path` and so on.
- **Migration ids**, fixed now to avoid collisions:
  - Track A: `20261014T100000_forge_checkpoints`.
  - Track C: `20261014T110000_forge_project_checks`.
  - Each is appended last on its own branch; the merge step orders them A then C and fixes the chain tests.

---

## Track A: Checkpoints (D300)

### A1. The private store, in `packages/tools/src/checkpoints/`
- **Location.** The store lives at `<dataDir>/checkpoints/<projectId>.git`, created on first use with `git init --bare` plus config. It is outside the project's own `.git`.
- **Its own runner, `runStoreGit(args, opts)`.** Do NOT reuse `runGit`: its env, caps and global config are unsafe here. The runner:
  - takes a `GIT_DIR` (the store), a `GIT_WORK_TREE` (the project root) and a per-call `GIT_INDEX_FILE` (a temp file under the store);
  - sets `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL` (an empty file in the store; on Windows `NUL` does not work, so use an empty file), `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0` and `LC_ALL=C`;
  - passes `-c core.autocrlf=false -c core.safecrlf=false -c core.hooksPath= -c core.fsmonitor=false -c core.quotepath=false -c gc.auto=0`;
  - strips every inherited `GIT_*` variable;
  - has a 60 s timeout;
  - streams stdout to a buffer capped at 64 MB;
  - accepts `stdin` (for `hash-object --stdin` / `update-index --index-info`).
- **Snapshot.** `snapshot(root): Promise<SnapshotRef>`:
  1. Use a fresh temp index.
  2. `git add -A -- .` with an exclude list:
     - `.git` and `.ace` at any depth;
     - the default ignored folders from `createIgnoreRules`/`DEFAULT_IGNORED_FOLDERS`;
     - the project's `.gitignore` rules. Use `--ignore-errors`, and pass excludes via `info/exclude` in the store, regenerated per snapshot from the ignore rules plus a 5 MB size filter. Implementation: list candidate files with `listAllFiles` and the ignore rules, skip files over 5 MB, then `update-index --add --stdin` from that list.
  3. `write-tree`, then `commit-tree` (with a fixed author/committer env: `ACE <ace@localhost>`, plus a date).
  4. Pin it under `refs/ace/<checkpointId>/before` or `…/after`.
  5. Return the commit id and the list of skipped files (over 5 MB).
- **Nested repositories.** Their `.git` folders are excluded and their files are stored as plain files, never as gitlinks. If git refuses, skip the folder and report it.
- **Diff.** `diff(before, after): Promise<CheckpointFile[]>` runs `diff-tree -r --no-renames --numstat -z` plus `--name-status` and returns, per file:
  - `{ path, change: 'added'|'modified'|'deleted', additions, deletions, binary }`.
- **File contents.** `fileAt(commit, path): Promise<Uint8Array | undefined>` runs `cat-file blob <commit>:<path>`. It is used by review and by revert.
- **Revert one file.** `revertFile(root, before, after, path)`:
  - **Guard against later changes.** Read the file on disk now and compare it to its content at `after`. If they differ (the file changed since the checkpoint), throw `CheckpointConflict`.
  - **Restore.** Write the `before` content atomically through the existing `fs-files` write path, or delete the file if it didn't exist before. Recreate parent folders as needed.
  - **Confinement.** Confine every path with `toAbsolute`, and never write into `.git`/`.ace`.
- **Port.** Expose all of this through an engine port, `packages/engine/src/ports/checkpoints.ts`:
  - `CheckpointStore { snapshot, diff, fileAt, revertFile }`;
  - an adapter `createGitCheckpointStore(dataDir)` in tools.
- **Missing git.** `snapshot` throws `CheckpointUnavailable('git_missing')`, and the service records the checkpoint as `failed` with that reason (design §10).

### A2. Contracts (`packages/contracts/src/checkpoints.ts`, a new file) and storage
- **`Checkpoint`:**
  ```
  { id, projectId,
    kind: 'chat'|'run',
    threadId?, messageId?, runId?, nodeId?,
    status: 'recording'|'pending'|'kept'|'reverted'|'partial'|'failed',
    files: CheckpointFile[],
    skipped: string[],
    error?,
    createdAt, updatedAt }
  ```
- **`CheckpointFile`:**
  ```
  { path, change, additions, deletions, binary,
    state: 'pending'|'kept'|'reverted' }
  ```
- **Actions:** `CheckpointAction = { action: 'keep'|'revert', paths?: string[] }`. When `paths` is omitted, the action applies to every pending file.
- **Frame:** a transient `checkpoint.updated { projectId, checkpoint }` on the `project` scope. Add it to all three lists, as Phase 2 did.
- **Errors:** add `checkpoint_conflict` (409, "<path> changed after the agent's edit; review it before reverting") and `checkpoints_unavailable` (503).
- **Storage:**
  - Migration `20261014T100000_forge_checkpoints`, table `checkpoints`:
    `(id TEXT PK, workspace_id, project_id, kind, thread_id, message_id, run_id, node_id, status, files_json, skipped_json, before_ref, after_ref, error, created_at, updated_at)`,
    plus an index on `(workspace_id, project_id, created_at)`.
  - Add a `CheckpointRepository` to the port, the SQLite repo, `GATED_REPOSITORIES` and the fake repository.
  - `before_ref` and `after_ref` are server-only, never on the wire.

### A3. Engine `CheckpointService` (`packages/engine/src/checkpoints/`) and routes
- **`begin`.** `begin(projectId, meta: { kind, threadId?, messageId?, runId?, nodeId? }): Promise<CheckpointRecording>`:
  - snapshots "before";
  - inserts a row with status `recording`;
  - emits the frame;
  - returns `{ id, finish(): Promise<Checkpoint | undefined> }`.
- **`finish`.** It snapshots "after" and diffs:
  - **no changes:** delete the row and refs and return `undefined`;
  - **otherwise:** set status `pending` and the files.

  It emits `checkpoint.updated`.
- **`CheckpointRecorder`.** The service implements this interface, defined in the engine port file so Track B can code against it now:
  ```ts
  export interface CheckpointRecorder {
    begin(projectId: string, meta: CheckpointMeta): Promise<CheckpointRecording>;
  }
  export interface CheckpointRecording {
    readonly id: string;
    finish(): Promise<Checkpoint | undefined>;
  }
  export type CheckpointMeta = {
    kind: 'chat' | 'run';
    threadId?: string;
    messageId?: string;
    runId?: string;
    nodeId?: string;
  };
  ```
  **This interface is binding for Tracks A and B.** Put it in `packages/engine/src/ports/checkpoints.ts` together with the store port. Track B creates the same file with only this interface, and the merge keeps Track A's superset.
- **Other service methods:**
  - `list(projectId)`: newest first, pending first.
  - `get(projectId, id)`.
  - `fileDiff(projectId, id, path)`, returning `{ before?: string, after?: string, binary }`. Text up to 2 MB, else `binary: true`. This is for review in Monaco's diff editor.
  - `act(projectId, id, action)`:
    - **keep:** mark the files kept;
    - **revert:** for each path, call `store.revertFile`. A conflict leaves that file `pending` and reports it.

    The checkpoint status becomes `kept`, `reverted` or `partial`.
  - `recover()`: at engine start, every `recording` row gets its after-snapshot taken now, best effort, or else is marked `failed` with "engine stopped while recording".
- **Run checkpoints.** Hook into `runs/index.ts` `startDriving` (around L2899–2933):
  - `begin({kind:'run', runId})` before `drive(...)`, only when the project has a folder;
  - `finish()` in the drive's settle path, including halt and stop.
  - **Domain's `stayOpen` runs** finish when the run ends (`POST /runs/:id/end`) or settles. While open, the checkpoint stays `recording`, and Changes shows it as "recording".
- **Routes**, under `/api/v1/projects/:pid/checkpoints`, behind the existing middleware:
  - `GET /` (list);
  - `GET /:id`;
  - `GET /:id/diff?path=`;
  - `POST /:id/actions` with a `CheckpointAction` body.
  - When the service is undefined, every route returns 501.
- **Wiring and clients.**
  - **Server:** wire `createCheckpointService({ store: createGitCheckpointStore(dataDir), repository, bus, logger })`. Call `recover()` at startup.
  - **SDK:** `listCheckpoints`, `getCheckpoint`, `checkpointFileDiff`, `checkpointAction`.
  - **Mock engine:** add checkpoints to the mock. A scripted helper `__aceMock.seedCheckpoint(projectId, files)` lets the web tests run.

### A4. Web
- **Changes view** (`apps/web/src/forge/changes/ChangesView.tsx`).
  - It lists checkpoints, pending first. Each one shows:
    - its source: "Chat with <Node>", or "Run <short id>";
    - when it happened;
    - each file with its +/− counts.
  - Actions: **Review** (opens the file diff), **Keep all**, **Revert all**, plus per-file **Keep** and **Revert**.
  - A conflict shows its message on that file.
  - It updates live from `checkpoint.updated`, using the shared `useProjectScope`.
  - Track C adds the `EXPLORER · SEARCH` switch in the Explorer header. The merge step adds `CHANGES` to it, so build ChangesView as a standalone component with `{ projectId }`.
- **Review.** It opens a read-only diff tab in the editor area, using Monaco's diff editor and reusing the existing `CompareView` pattern. Before is on the left, after is on the right, and the tab is titled "<file> (agent change)".
- **Changes card in chat.** A chat message with `checkpointId` (Track B adds the field) renders a compact card under the turn: the files with +/−, Review, Keep all and Revert all. Build the card as `ChangesCard({ projectId, checkpointId })`; Track B renders it.
- **Agent-change markers.**
  - Files in any **pending** checkpoint get an accent marker in the Explorer tree.
  - Use the theme's agent badge style from D334.
  - Clicking the marker opens Changes on that checkpoint.
  - This is separate from git letters.

---

## Track B: Chat in the project (D302)

### B1. Contracts (`contracts/src/chat.ts`, `envelope.ts`)
- **`ChatRequest`** gains `targetNodeId?: Id`.
- **`ChatMessage`** gains:
  - `speakerNodeId?: Id`: the node that replied;
  - `activity?: ActivityItem[]`;
  - `checkpointId?: Id`.
- **`ActivityItem`:** `{ kind: 'read'|'write'|'edit'|'command'|'search'|'other', tool, path?, summary }`. The summary is at most 200 chars, with **no file contents**.
- **`code` part** gains `path?`, `startLine?` and `endLine?`. All of these are additive.
- **`resolveChatTarget`.** A pure function in contracts, `resolveChatTarget(text, roster, mainNodeId)`:
  - It uses Domain's `parseAddressing`, but honours **only `via:'handle'` spans**.
  - Exactly one handle gives `{ targetNodeId }`.
  - No handle gives `{ targetNodeId: mainNodeId }`.
  - `@all`, two or more handles, or an unknown handle gives `{ error }`, with Domain's messages where they fit.
  - The mention text stays in the message. It is not stripped.

### B2. Engine chat service (`packages/engine/src/chat/`)
- **Workspace mode.** When the node's project has a folder, a chat turn runs **in the project folder**:
  - **CLI nodes:**
    - pass `workingDir` (the project folder);
    - the provider's `cliPermission` preset applies, as designed (D302 / D262);
    - the chat timeout gets the run's CLI floor of 600 s (`CLI_SESSION_MIN_TIMEOUT_MS`);
    - `activity` chunks are mapped to `ActivityItem`s, with no contents, and stored on the reply.
  - **API nodes:**
    - run a **bounded tool loop** in a new `chat/tool-loop.ts`, reusing `runs/tool-loop.ts` helpers (`buildToolCall`, `toolResultBlock`, `summariseResult`, `redactArgs`);
    - offer only the **non-destructive project tools**: `list_files`, `read_file`, `write_file`, `edit_file`, `git_status` and `git_diff`. Never offer `run_command`, and never any destructive tool;
    - the cap is the node's `tools.maxToolCalls` (default 10);
    - only offer tools when the model's catalog row allows tools;
    - each call becomes an `ActivityItem`;
    - the tool context uses `projectDir`, plus a per-turn id in place of `runId`;
    - fix the mock adapter's `'no-run'` keying so chat tests don't collide.
  - **No folder:** the turn behaves as today (read-only, temp folder).
- **Write queue.**
  - A **writing turn** is any workspace-mode turn. Per project, use a `createSemaphore(1)` (or equivalent) so writing chat turns run one at a time.
  - Each writing turn is wrapped in `checkpoints?.begin({ kind:'chat', threadId, messageId: <reply id>, nodeId })` … `finish()`.
  - When `finish()` returns a checkpoint, set `checkpointId` on the reply.
  - Add `CheckpointRecorder` as an optional dep, `ChatServiceDeps.checkpoints?`, using the interface in Track A §A3. The server wiring happens at merge.
  - A run running concurrently in the same project is **not** serialised against chat. This is a documented limitation: attribution can mix.
- **Targeting and shared context.**
  - `chat(nodeId, request)` resolves the speaker as `targetNodeId` if given, else the thread's node.
  - `targetNodeId` must be an agent or model node in the **same workflow**. Make `resolveNode` return `workflowId`; otherwise answer 400 `validation_failed`.
  - Relax the thread/node mismatch check accordingly. The thread keeps its `nodeId` as the conversation's main node.
  - Replies carry `speakerNodeId`.
  - The prompt labels each assistant turn with its speaker's name (`renderTurn`), so a mentioned node sees the conversation, its recent turns included, with who said what.
- **Unchanged.** D287 (a reply always ends, and errors are stored) and the guardrails stay as they are.

### B3. Web
- **Composer.**
  - Replace `chat/mentions.ts`'s leading-`@` session switch with `resolveChatTarget`. Typing `@handle` shows a picker, as Domain's composer does.
  - The send preview says "to <Node>". An error disables Send and shows the reason.
  - Sending passes `targetNodeId`, and the **session does not switch**.
  - Remove the old switching path and its tests, and update the tests that relied on it.
- **Messages.**
  - Show the speaker's name and avatar on assistant turns, using `speakerNodeId`.
  - An `activity` list renders collapsed ("What it did: 3 edits, 2 reads"), expandable to the items.
  - A reply with `checkpointId` renders Track A's `ChangesCard`. Until the merge, render it behind a small adapter that Track A's component replaces. Do not render an inert placeholder: before the merge, render nothing.
- **Ask agent.**
  - Selecting code in the editor and pressing **Ctrl/⌘+L**, or choosing **Ask agent** from the editor context menu, adds a reference chip to the chat composer.
  - The chip reads `path:Lstart-Lend` and carries the selected text as a `code` part with `path`, `startLine` and `endLine`.
  - Build this with a small composer-chips store (zustand) that the composer reads.
  - Also offer **Ask agent about this file** in the Explorer context menu. It adds the file reference chip, with path only and no text.
  - Add `SHORTCUTS.askAgent = { code: 'KeyL', mod: true }`.
- **Fix with agent.**
  - Each Problems row gets a **Fix with agent** button.
  - It sends the current chat node a message right away: "Fix this problem: <message> (<source>)", plus a code part holding the file, the line and ±5 surrounding lines.
  - If no node is selected, it puts the message and chip in the composer instead.
  - Track C's check results get the same button. The merge step makes sure both slices have it.

---

## Track C: Checks, search, format, types (Phase 4)

### C1. Project settings
- **`Project`** gains:
  - `checkCommand?: string`, 1..1000 chars;
  - `formatOnSave?: boolean`, where absent means `false`.
- **Plumbing:** update contracts, `UpdateProjectRequest`, the gateway PATCH guard (extend it to include both), graph, the repository port, SQLite, the fake repository and the web mock DB.
- **Migration** `20261014T110000_forge_project_checks`: `ALTER TABLE projects ADD COLUMN check_command TEXT; ADD COLUMN format_on_save INTEGER`. A NULL reads as absent.
- **ProjectPage** gets a **Checks** card after the Terminal card:
  - "Check command" uses `SettingInput`, with placeholder `pnpm tsc --noEmit`;
  - "Format on save" uses an On/Off `SelectField`.

### C2. Search
- **Tools.** `searchFiles(root, query: SearchRequest): Promise<SearchResult>` in `tools/src/workspace/search.ts`:
  - `SearchRequest = { query, regex?, matchCase?, wholeWord?, include?: string (glob), exclude?: string, maxResults?: 2000 }`;
  - it walks with `listAllFiles` plus the ignore rules, so `node_modules` etc. are skipped;
  - it skips binary and >2 MB files;
  - results: `{ files: [{ path, matches: [{ line, column, preview (≤ 240 chars), length }] }], truncated, searchedFiles }`;
  - a regex must compile with a time guard: reject patterns over 1000 chars, and run per line with a per-file deadline;
  - glob matching uses a small dependency-free matcher, or the `ignore` package's glob semantics. **Do not add a new dependency** unless unavoidable; say so in the report if you do.
- **Engine and server.** Add `ProjectFiles.search` to the port and the adapter, plus a workspace service method and the route `GET /projects/:id/files/search` (query params) or `POST …/files/search` (body). Pick POST with a body, because of regex characters. It sits behind the middleware.
- **SDK and mock.** Add `searchFiles` to the SDK, and implement search in the mock engine over the mock files.
- **Web.**
  - Add an Explorer header switch, **EXPLORER · SEARCH**, in the theme's pill/segmented style. Build it so the merge step can add **CHANGES**.
  - **Ctrl/⌘+Shift+F** opens Search and focuses the query.
  - The Search view has a query box with regex (`.*`), match case (`Aa`) and whole word (`ab`) toggles, plus "files to include" and "files to exclude" inputs.
  - Results are grouped by file with match counts and highlighted previews. Clicking a match opens the file at that line and column (`revealAt`). It shows "N results in M files", and "showing the first 2,000" when truncated.
  - The search is debounced at 300 ms.

### C3. Run checks
- **The button.** A **Run checks** button in the Problems panel header is enabled only when `checkCommand` is set; otherwise it reads "Set a check command" and links to the project page. **Ctrl/⌘+Shift+B** does the same.
- **Running.**
  - Run the check as a process through the existing SDK `startProcess`, at the project root, labelled "Checks".
  - Under trust `scripts`, the check command must be a `package.json` script name, run as `{ script }`. Otherwise show the refusal from the engine.
  - Under trust `off`, the button is disabled, with the trust notice.
  - The process appears in the Terminal's Processes list like any other.
- **Parsing.** On `process.exited` for that process, fetch `getProcess` output and parse it in `apps/web/src/forge/panel/check-parser.ts`, a pure, fully table-tested module. It handles:
  - **tsc:**
    - `path(line,col): error TS1234: message`;
    - `path:line:col - error TS1234: message`, including the pretty form;
  - **eslint "stylish":** a file header line, then `  line:col  error|warning  message  rule`;
  - **generic:** `path:line:col: (error|warning)?:? message`, and `path:line: message`.

  It strips ANSI first and normalises paths to project-relative forward slashes. Absolute paths under the root are made relative; others are kept as given.
- **Results.**
  - Results go in a **separate `checks` slice** of the problems store. They are never overwritten by `watchMarkers`.
  - They are shown in Problems under a "Checks" group with the source tool (`tsc`, `eslint`, `check`) and the run time.
  - A new run replaces the slice, and "Clear" empties it.
  - The footer error and warning counts include checks.
  - Each row opens its file at its line.
  - Track B adds Fix with agent to rows, and the merge makes sure check rows have it too.

### C4. Format and format-on-save
- **Format document.**
  - Verify Monaco's built-in formatters work for TS/JS/CSS/HTML/JSON. Shift+Alt+F must not be swallowed by `useShortcuts`, and the editor context menu shows "Format Document".
  - Add a **Format** button in the PathBar's actions (theme style) that runs `editor.action.formatDocument` on the active editor.
- **Format-on-save.**
  - When `formatOnSave` is on, `saveFile` first formats the model **if an editor is attached to it** (the active editor) by running the format action, then saves.
  - Save all formats only the active one. That is a documented limitation.
  - A file type with no formatter saves unchanged.

### C5. Cross-file TypeScript IntelliSense
- **The sources route.** Add a batch-read `ProjectFiles.readSources(root, { exts, maxFiles: 1500, maxBytes: 2 * 1024 * 1024 })`:
  - extensions: ts, tsx, mts, cts, js, jsx, mjs, cjs, d.ts;
  - it ignores via the ignore rules, with `node_modules` excluded;
  - it is ordered by path depth, then name;
  - it stops at the caps and returns `truncated`.
  - Add a service method and the route `GET /projects/:id/files/sources`, plus the SDK and the mock.
- **The web loader** (`apps/web/src/forge/editor/project-types.ts`).
  - When Forge mounts a project, it fetches the sources and registers each file **not open as a model** with `typescriptDefaults.addExtraLib(content, fileUri(projectId, path))` (and `javascriptDefaults` for JS).
  - It keeps the disposables. When a file opens as a model, it disposes that file's extra lib, and re-adds it on close.
  - It refreshes the changed paths on `files.changed`, or everything on `resync`.
  - It disposes everything on a project switch.
  - It reads `tsconfig.json` `compilerOptions.baseUrl`/`paths` when present, rebased under `/<projectId>/`, and merges them into the TS compiler options.
  - Keep `IGNORED_TS_DIAGNOSTICS` for bare-module imports.
  - Problems must not fill with diagnostics from files that aren't open. Extra libs don't produce markers; verify it.

---

## The merge step (after A, B and C are each reviewed)
1. Merge A, then B, then C into `feat/forge-phase-3-4`.
2. **Migrations:** A's comes before C's in `MIGRATIONS`. Update every chain test.
3. **Wiring:**
   - pass `ChatServiceDeps.checkpoints` = the CheckpointService in the server;
   - add `CHANGES` to the Explorer header switch, with ChangesView;
   - render the real `ChangesCard` for `checkpointId` in chat;
   - put Fix with agent on check rows;
   - make the footer counts include checks.
4. **Gates:** packages build, `pnpm typecheck`, `pnpm lint`, `pnpm -r --no-bail test` and the web build. **No e2e.**
5. **Docs:**
   - the D300 and D302 rows refined, with the Phase 3 refinements and limitations;
   - a new **D339**: "Forge's Explorer header switches EXPLORER · SEARCH · CHANGES. Search and Changes live in the left column, as in VS Code, without an activity bar; amends D334";
   - the user guide sections for Changes/checkpoints, Chat in the project, Ask/Fix with agent, Search, Run checks, Format, and Cross-file types;
   - a Feature Log row `IDE | F3+F4`.

## Known limitations to document
- Checkpoints need git on PATH.
- Checkpoints skip files over 5 MB and ignored folders, and the card says so.
- Nested repositories are stored as plain files.
- Chat writing turns are serialised per project, but runs are not serialised against chat.
- A `stayOpen` Domain run's checkpoint spans the whole session.
- Format-on-save formats only the active editor's file.
- Cross-file types are capped at 1,500 files and 2 MB.
- Run checks parses tsc, eslint (stylish) and the generic `file:line:col` formats.
