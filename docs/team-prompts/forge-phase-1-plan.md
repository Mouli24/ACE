# Forge, Phase 1 — Ideate | Forge switch, project files and the editor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inside a workflow, a person flips between **Ideate** (the canvas) and **Forge** (a VS Code–style editor) from the top bar. In Forge they can browse, create, rename, move, delete, open, edit and save the project's real files. Forge also gives them:
- conflict-safe saves;
- git status decorations;
- quick open;
- Problems and Output;
- panels they can show, hide and resize, which stay as they left them.

**Architecture:**
- **Engine.** The engine gets a `WorkspaceService`, which maps a project id to its folder. It sits over a new `ProjectFiles` port. `packages/tools/src/workspace/` implements that port on the real file system:
  - confinement, with `.git`/`.ace` protected at any depth;
  - `.gitignore` rules;
  - atomic saves, with content-hash versions and a 409 on a stale base;
  - read-only `git status`;
  - a debounced recursive `fs.watch`.
- **Routes** live under `/api/v1/projects/:id/files/*`.
- **The watcher** runs while a WebSocket client subscribes to the new `project` scope, and emits transient `files.changed` frames that carry paths, never contents.
- **Web.** A `WorkflowLayout` parent route owns the run subscriptions and the chat column for both modes. `apps/web/src/forge/` holds:
  - the Forge page;
  - its stores: layout, explorer, editor, problems, output;
  - the Monaco host and the Explorer tree.
- **Mock engine.** The MSW mock engine gets an in-memory file system, so unit and e2e tests run with zero env vars.

**Tech Stack:**
- Language and runtime: TypeScript ESM, Node 20+ (24 here).
- Engine side: Hono 4.13, Zod 4.6, `ignore` 5.3 (new in `@ace/tools`).
- Web: React 18, react-router-dom 6.30 (data router), zustand 4.5 (with `persist`), TanStack Query 5, react-resizable-panels 3.0.6 (sizes are percentages), monaco-editor 0.55 + @monaco-editor/react 4.7, lucide-react.
- Testing: MSW 2, Vitest 5, Testing Library, Playwright 1.63.

**Spec:** `docs/team-prompts/ide-workspace-design.md`. Read it first. This phase implements:
- §2 (D299), all of it;
- §6.1, §6.2 and §6.4, without Search and Changes;
- §7's file rules;
- §10;
- §11, the rows for this phase;
- §12 phase 1.

**Repo:** `D:\ACE offcl\ACE`.
- Work happens in the worktree `D:\ACE offcl\wt\forge` on branch `feat/forge-phase-1`, cut from `feat/ide-workspace` (which carries the spec and this plan).
- The main checkout `D:\ACE offcl\ACE` stays as it is, because the launcher runs it.

**Later phases** get their own plans, written against the code this phase leaves:
- **Phase 2:** the terminal and the process service (D301).
- **Phase 3:** agents in the project and checkpoints (D300, D302), including `user_delete` checkpoints.
- **Phase 4:** checks in Problems, Search, Ask/Fix with agent, format-on-save, cross-file TypeScript IntelliSense, and the phone polish.

## Global Constraints

**Branch and commits**
- **One branch, `feat/forge-phase-1`.** Commits go in task order, contracts first (CLAUDE.md §3.4 rule 2). Nothing is pushed or opened as a PR without the user's word (Task 21).
- **Commit messages** are Conventional Commits ending in `[D299]` plus FR ids. Each ends with the trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. The FR ids for this phase:
  - FR-GIT-003: browse files;
  - FR-GIT-004: view and edit files;
  - FR-GIT-008: confinement.

  Example: `feat(tools): project files on disk — confined, ignore-aware, atomic saves [D299] [FR-GIT-003] [FR-GIT-008]`.

**Code rules**
- **Never** use `any`, `@ts-ignore` or `console.*` in engine-side code (`packages/engine|tools|contracts`, `apps/server`).
- **No Node APIs** (`fs`, `path`, `child_process`, `process.env`, `node:*`) in `apps/web`, `packages/ui` or `packages/sdk`. **No browser APIs** in engine-side code.
- **Dependency rule** (CLAUDE.md §3.4 rule 3):
  - `packages/engine` imports only `@ace/contracts` and its own files. It never imports `@ace/tools`.
  - `packages/tools` implements the engine's `ProjectFiles` port.
  - `apps/server` wires the two together.

**Tests and builds**
- **`pnpm test` passes with zero env vars and no network.** Tests that need git use `describe.skipIf(!hasGit)`, the same way `packages/tools/src/builtins/git.test.ts` does.
- **Workspace packages resolve to their `dist/`.** After changing a package that another package imports, run `pnpm --filter <that package> build` before testing the importer. For example, contracts → engine → tools → server.
- **Coverage gates** (NFR-MAIN-02): at least 80 % for engine-side packages, and at least 60 % for `apps/web`, `packages/ui` and `packages/sdk`.

**Exact values, copied from the spec**
- **Size limits:**
  - editable text ≤ 2 MB (`2 * 1024 * 1024` bytes);
  - `GET /files/list` caps at 50,000 paths;
  - image preview ≤ 20 MB (this plan's addition).
- **Watcher and status:**
  - the watcher batches over 100 ms;
  - a burst of more than 500 changes arrives as one `resync`;
  - the web refetches `/files/status` at most once a second.
- **What the file listing and git status skip:**
  - `.git` is never listed;
  - the default-ignored folders are `node_modules`, `.ace`, `dist`, `build`, `.next`, `__pycache__` and `.venv`;
  - `.gitignore` files are honoured at any depth.
- **Protected paths:** writes are refused into `.git` and `.ace` at any depth, however they are spelled: case, trailing dots or spaces, NTFS streams.

**Wire and UI conventions**
- **Paths on the wire** are project-relative, use forward slashes, and never start with one. `''` is the root and names a folder only. Absolute paths never cross the API.
- **Browser-reserved keys are never bound:** `Ctrl/⌘+W`, `Ctrl/⌘+T`, `Ctrl/⌘+N`, `Ctrl+Tab`, `Ctrl/⌘+1…9`.
- **Nothing reaches the DB or the event log:** `files.changed` is transient and carries paths only.
- **Prettier:** run `npx prettier --write --config packages/config/prettier.config.js <files>` on the files you create or rewrite only.

**Phase-1 refinements of the spec.** Each is stated in the code comments and in Task 21's DECISIONS row:
1. **Delete is permanent, behind a confirm** that says so. Phase 3 adds the `user_delete` checkpoint (D300) and changes the wording.
2. **Unsaved buffers survive in-app navigation,** because the editor store outlives routes. So only closing or reloading the browser tab asks (`beforeunload`). Switching modes, workflows or projects never loses a buffer.
3. **Cross-file TypeScript IntelliSense** needs a batch-read route and moves to Phase 4. Phase 1 has Monaco's per-file TS/JS, CSS, HTML and JSON services.
4. **The activity bar and the bottom panel only show views that work in this phase:** Explorer; Problems and Output. Search, Changes and Terminal arrive with their phases.
5. **New error codes:** `file_changed`, `exists`, `file_too_large`, `outside_project` and `protected_path`. The spec's `binary_file` is not needed, because a binary file answers `kind: 'binary'`.
6. **`GET /files/raw`** serves image bytes for the image preview (§6.2 "Images open in a preview tab").
7. **The Explorer's tree component lives in `apps/web/src/forge/explorer/`,** not `@ace/ui`, because only Forge uses it.
8. **`ignore` is the one new engine-side dependency.** It is pure JS, already in the lockfile transitively, and used for `.gitignore` semantics.

## Review Focus

1. **Case-only renames on Windows and macOS.** Renaming `readme.md` to `README.md` targets a path that "exists", because it is the same file on a case-insensitive disk. Expect it to rename, not answer `exists`. Pinned by Task 3's test "renames a file to another case of its own name".
2. **A file that changes under an open buffer.** This happens when an agent, another editor or `git checkout` writes the file. Expect:
   - a clean buffer reloads;
   - an unsaved buffer gets the conflict bar;
   - a save on a stale base answers 409 and never overwrites silently.

   Pinned by Task 3's test "refuses a save whose base version is stale" and Task 15's test "a clean buffer follows the disk, an unsaved one gets the conflict bar".
3. **CRLF files and UTF-8 BOMs.** Opening and saving a CRLF file with a BOM, without edits, must write identical bytes. A file that is not UTF-8 must never open as editable text, because saving it would corrupt it. Pinned by Task 3's tests "round-trips a CRLF file with a BOM byte for byte" and "treats a file that is not UTF-8 as binary".
4. **Huge folders.** A `node_modules` with 100k files must not slow the tree, list or watcher: the tree stays lazy, `list` prunes ignored folders and caps, and the watcher drops events under ignored folders and collapses floods into `resync`. Pinned by Task 3's test "list skips ignored folders and stops at the cap" and Task 4's test "a burst over the limit arrives as one resync".
5. **Hostile and unusual paths.** These must work:
   - spaces, unicode and leading dots: `My Notes/ü.md`, `.env`.

   These must be refused, as `outside_project`, `protected_path` or `invalid_path`:
   - `../x`, `C:\x`, `src/../../x`, `a\0b`;
   - `.git/config`, `sub/.GIT./hooks/x`;
   - Windows device names: `CON`, `aux.txt`.

   Pinned by Task 3's confinement table test.

## File Map

**Contracts** (`packages/contracts/src`)
- Create `workspace.ts`: paths, entries, content, save, create, move, list, repo status, `files.changed` payload, limits.
- Modify:
  - `errors.ts`: `IDE_ERROR_CODES` and their statuses;
  - `events.ts`: `PROJECT_EVENT_FRAME_SCHEMAS`, `PROJECT_EVENT_TYPES`, and `files.changed` made transient;
  - `ws.ts`: the `project` scope, and the project frames in `ServerFrameSchema`;
  - `index.ts`: the barrel line.
- Tests: create `__tests__/workspace.test.ts`; modify `__tests__/errors.test.ts`, `ws.test.ts`, `events.test.ts` and `index.test.ts`.

**Engine** (`packages/engine/src`)
- Create:
  - `ports/workspace.ts`: the `ProjectFiles` port, `WorkspaceFsError` and `isWorkspaceFsError`;
  - `workspace/service.ts`: `createWorkspaceService`;
  - `workspace/routes.ts`: `createWorkspaceRoutes`.
- Modify:
  - `ports/index.ts`: export the port;
  - `gateway/errors.ts`: `toApiError` answers `WorkspaceFsError`;
  - `gateway/index.ts`: `EngineDeps.workspace`, the mount, and `PUT` in CORS;
  - `events/ws-hub.ts`: the `project` scope and `onProjectWatch`;
  - `index.ts`: the barrel.
- Tests: create `gateway/__tests__/workspace-errors.test.ts`, `workspace/__tests__/routes.test.ts` and `workspace/__tests__/service.test.ts`; modify `__tests__/events.test.ts`.

**Tools** (`packages/tools/src`)
- Modify:
  - `project/paths.ts`: protected folders at any depth, and `protectedFolderIn` exported;
  - `builtins/git.ts`: export `runGit` and `GitResult`;
  - `index.ts`: the barrel;
  - `package.json`: add `ignore`.
- Create, in `workspace/`:
  - `ignore-rules.ts`;
  - `resolve.ts`;
  - `fs-files.ts`: list, read, raw, write, create, move, remove, list-all;
  - `repo-status.ts`;
  - `watcher.ts`;
  - `project-files.ts`: `createFsProjectFiles`.
- Tests: create `workspace/*.test.ts` and extend `project/paths.test.ts`.

**Server** (`apps/server/src`)
- Modify `server.ts`: wiring, the hub callback, shutdown.
- Create `__tests__/workspace.integration.test.ts`.

**SDK** (`packages/sdk/src`)
- Modify `client.ts`: `PUT`, and nine file methods.
- Create `__tests__/files.test.ts`.

**Web** (`apps/web/src`)
- Modify `app/`:
  - `routes.tsx`: the `WorkflowLayout` parent;
  - `layout/TopBar.tsx`: the switch, the chat toggle, canvas-only buttons;
  - `layout/AppShell.tsx`: the `beforeunload` guard.
- Create `app/`:
  - `shortcuts.ts`: matcher, labels, `useShortcuts`;
  - `stores/layout.ts`: persisted layout;
  - `layout/ModeSwitch.tsx`;
  - `layout/resize-handle.ts`.
- Workflows:
  - create `workflows/WorkflowLayout.tsx`;
  - modify `workflows/WorkflowPage.tsx` (hooks and chat move out) and `workflows/WorkflowTabs.tsx` (keep the mode).
- Config panel: modify `config-panel/monaco-loader.ts` to add every worker and export `monaco`.
- Forge, all new:
  - `forge/mode.ts`;
  - `forge/ForgePage.tsx`, `forge/ForgeWorkbench.tsx`, `forge/CompactForge.tsx`;
  - `forge/files/`: `keys.ts`, `hooks.ts`, `paths.ts`, `project-socket.ts`;
  - `forge/explorer/`: `explorer-store.ts`, `decorations.ts`, `useTreeRows.ts`, `FileIcon.tsx`, `FileTree.tsx`, `InlineName.tsx`, `ExplorerView.tsx`, `OpenEditors.tsx`, `EntryDialogs.tsx`, `names.ts`;
  - `forge/editor/`: `editor-store.ts`, `models.ts`, `actions.ts`, `useEditorSync.ts`, `guards.ts`, `EditorArea.tsx`, `TabsBar.tsx`, `EditorHost.tsx`, `forge-theme.ts`, `languages.ts`, `ConflictBar.tsx`, `CompareView.tsx`, `ImagePreview.tsx`, `FileNotice.tsx`, `EmptyEditor.tsx`, `CloseDialogs.tsx`, `editor-status.ts`;
  - `forge/quick-open/`: `QuickOpen.tsx`, `quick-open-store.ts`, `fuzzy.ts`;
  - `forge/panel/`: `BottomPanel.tsx`, `ProblemsView.tsx`, `OutputView.tsx`, `problems-store.ts`, `output-store.ts`;
  - `forge/layout/`: `ActivityBar.tsx`, `SideBar.tsx`, `StatusBar.tsx`, `IconAction.tsx`.
- Mocks:
  - modify `mocks/db.ts` (project files and repo status in the snapshot; `MockEvent` project scope), `mocks/fake-socket.ts` (project scope) and `mocks/browser.ts` (handlers and `__aceMock` file hooks);
  - create `mocks/files.ts` and `mocks/handlers-forge.ts`.
- Tests:
  - modify `test/setup.tsx` (the panels mock forwards `id` and `data-testid`; `EditorHost` and `CompareView` mocked globally) and `test/app.tsx` (handlers and store resets);
  - create `test/fake-monaco.ts` and `test/FakeEditorHost.tsx`;
  - create `e2e/forge.spec.ts` and extend `e2e/helpers.ts`.
- Help: modify `help/guide.ts` (`ORDER` gains `forge`).

**Docs**
- Modify `docs/DECISIONS.md` (D299–D302) and `CLAUDE.md` §9 (a Feature Log row).
- Create `docs/user-guide/forge.md`.

---

### Task 0: Worktree and baseline

**Files:** none. This sets up the workspace.

- [ ] **Step 1: Create the worktree**

```bash
cd "D:/ACE offcl/ACE"
git worktree add -b feat/forge-phase-1 "../wt/forge" feat/ide-workspace
cd "../wt/forge"
pnpm install --prefer-offline
pnpm --filter "./packages/**" build
```

Expected: `pnpm install` finishes without network errors; every package builds.

- [ ] **Step 2: Record the baseline**

```bash
pnpm typecheck 2>&1 | tail -5
pnpm lint 2>&1 | tail -5
pnpm test 2>&1 | tail -30
```

Expected: all green. Write the per-package pass counts into the task ledger, so later regressions are visible. If anything is red on the untouched branch, stop and report. Do not fix unrelated failures inside this plan.

---

### Task 1: Contracts — the workspace module, error codes, the `project` scope and `files.changed`

**Files:**
- Create: `packages/contracts/src/workspace.ts`
- Modify: `packages/contracts/src/errors.ts`, `packages/contracts/src/events.ts`, `packages/contracts/src/ws.ts`, `packages/contracts/src/index.ts`
- Test: create `packages/contracts/src/__tests__/workspace.test.ts`; modify `__tests__/errors.test.ts`, `__tests__/ws.test.ts`, `__tests__/events.test.ts`, `__tests__/index.test.ts`

**Interfaces:**
- Produces (every later task imports these from `@ace/contracts`):
  - `ProjectPathSchema`;
  - `FILE_EDIT_MAX_BYTES = 2_097_152`, `FILE_RAW_MAX_BYTES = 20_971_520`, `FILE_LIST_LIMIT = 50_000`, `FILES_CHANGED_MAX = 500`;
  - `FileEntryKind = 'file' | 'folder'`;
  - `FileEntry { path, name, kind, size, mtime, ignored }`;
  - `FolderListing { path, items }`;
  - `LineEnding = 'lf' | 'crlf'`;
  - `FileContent`, which is one of:
    - `{ kind: 'text', path, content, version, eol, bom, size }`;
    - `{ kind: 'binary', path, size }`;
    - `{ kind: 'too_large', path, size }`;
  - `SaveFileRequest { path, content, baseVersion: string | null, eol, bom }`;
  - `SaveFileResult { path, version, size, mtime }`;
  - `CreateEntryRequest { path, kind }`;
  - `MoveEntryRequest { from, to }`;
  - `FilePathQuerySchema` (`path` defaults to `''`) and `RequiredFilePathQuerySchema`;
  - `FileList { files: string[], truncated }`;
  - `RepoFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'`;
  - `RepoStatus = { repo: false } | { repo: true, branch: string | null, files: { path, status }[], truncated }`;
  - `FileChange { path, kind: 'created' | 'changed' | 'deleted' }`;
  - `FilesChangedPayload { projectId, changes, resync }`;
  - `FileChangedDetails { currentVersion: string | null }`;
  - `IDE_ERROR_CODES = ['file_changed', 'exists', 'file_too_large', 'outside_project', 'protected_path']`;
  - `WS_SCOPES` now includes `'project'`; `ServerFrame` includes `files.changed`.

- [ ] **Step 1: Write the failing contract tests**

Create `packages/contracts/src/__tests__/workspace.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  CreateEntryRequestSchema,
  FILE_EDIT_MAX_BYTES,
  FILE_LIST_LIMIT,
  FILES_CHANGED_MAX,
  FileContentSchema,
  FileEntrySchema,
  FilePathQuerySchema,
  FilesChangedPayloadSchema,
  MoveEntryRequestSchema,
  RepoStatusSchema,
  RequiredFilePathQuerySchema,
  SaveFileRequestSchema,
} from '../workspace.js';

const ID = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';
const AT = '2026-10-09T10:00:00.000Z';

describe('D299 FR-GIT-003 Forge project files contract', () => {
  it('pins the limits the spec gives (§6.1)', () => {
    expect(FILE_EDIT_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(FILE_LIST_LIMIT).toBe(50_000);
    expect(FILES_CHANGED_MAX).toBe(500);
  });

  it('describes a folder entry and refuses an unknown key', () => {
    const entry = { path: 'src', name: 'src', kind: 'folder', size: 0, mtime: AT, ignored: false };
    expect(FileEntrySchema.parse(entry)).toEqual(entry);
    expect(FileEntrySchema.safeParse({ ...entry, absolute: 'C:/x' }).success).toBe(false);
  });

  it('answers text with its version, line ending and BOM; binary and too-large carry no content', () => {
    const text = {
      kind: 'text',
      path: 'a.ts',
      content: 'x\r\n',
      version: 'abc',
      eol: 'crlf',
      bom: true,
      size: 6,
    };
    expect(FileContentSchema.parse(text)).toEqual(text);
    expect(FileContentSchema.parse({ kind: 'binary', path: 'a.png', size: 9 }).kind).toBe('binary');
    expect(
      FileContentSchema.safeParse({ kind: 'binary', path: 'a.png', size: 9, content: 'x' }).success,
    ).toBe(false);
    expect(FileContentSchema.parse({ kind: 'too_large', path: 'big.log', size: 9e6 }).kind).toBe(
      'too_large',
    );
  });

  it('saves against a base version, or null for a file that should not exist yet', () => {
    const base = { path: 'a.ts', content: '', eol: 'lf', bom: false };
    expect(SaveFileRequestSchema.parse({ ...base, baseVersion: 'v1' }).baseVersion).toBe('v1');
    expect(SaveFileRequestSchema.parse({ ...base, baseVersion: null }).baseVersion).toBeNull();
    expect(SaveFileRequestSchema.safeParse({ ...base }).success, 'baseVersion is required').toBe(
      false,
    );
    expect(SaveFileRequestSchema.safeParse({ ...base, path: '', baseVersion: null }).success).toBe(
      false,
    );
  });

  it('creates and moves non-empty paths only', () => {
    expect(CreateEntryRequestSchema.safeParse({ path: '', kind: 'file' }).success).toBe(false);
    expect(CreateEntryRequestSchema.parse({ path: 'a/b', kind: 'folder' }).kind).toBe('folder');
    expect(MoveEntryRequestSchema.safeParse({ from: 'a', to: '' }).success).toBe(false);
  });

  it('defaults a folder query to the root and requires a path for a file query', () => {
    expect(FilePathQuerySchema.parse({})).toEqual({ path: '' });
    expect(RequiredFilePathQuerySchema.safeParse({}).success).toBe(false);
  });

  it('says whether the folder is a repository', () => {
    expect(RepoStatusSchema.parse({ repo: false })).toEqual({ repo: false });
    const repo = {
      repo: true,
      branch: 'main',
      files: [{ path: 'src/a.ts', status: 'modified' }],
      truncated: false,
    };
    expect(RepoStatusSchema.parse(repo)).toEqual(repo);
    expect(
      RepoStatusSchema.safeParse({ ...repo, files: [{ path: 'x', status: 'ignored' }] }).success,
    ).toBe(false);
  });

  it('caps one files.changed burst at 500 changes', () => {
    const change = { path: 'a', kind: 'changed' };
    const ok = { projectId: ID, changes: [change], resync: false };
    expect(FilesChangedPayloadSchema.parse(ok)).toEqual(ok);
    const flood = { ...ok, changes: Array.from({ length: 501 }, () => change) };
    expect(FilesChangedPayloadSchema.safeParse(flood).success).toBe(false);
  });
});
```

Add to `__tests__/errors.test.ts`, inside `describe('FR-SYS-006 round 1 error codes', …)`. First import `IDE_ERROR_CODES` from `../errors.js`, then:

```ts
  it('adds the five codes Forge’s file API names (D299, design §6.1)', () => {
    expect([...IDE_ERROR_CODES]).toEqual([
      'file_changed',
      'exists',
      'file_too_large',
      'outside_project',
      'protected_path',
    ]);
  });
```

In the same file:
- Extend the `ERROR_CODES` equality, so the expected list ends with `...ROUND_4_ERROR_CODES, ...IDE_ERROR_CODES`.
- Extend the `ERROR_CODE_HTTP_STATUS` `toEqual` with `file_changed: 409, exists: 409, file_too_large: 413, outside_project: 403, protected_path: 403`.

In `__tests__/ws.test.ts`, change the scopes test and add a project subscription test:

```ts
  it('declares §2.9’s two scopes, round 4 §2.5’s thread and Forge’s project (D299)', () => {
    expect([...WS_SCOPES]).toEqual(['workflow', 'engine', 'thread', 'project']);
  });

  it('subscribes to a project by id and carries files.changed without a seq (D299)', () => {
    const frame = { type: 'subscribe', payload: { scope: 'project', id: WORKFLOW_ID } };
    expect(WsClientFrameSchema.parse(frame)).toEqual(frame);
    expect(
      WsClientFrameSchema.safeParse({ type: 'subscribe', payload: { scope: 'project' } }).success,
    ).toBe(false);
    const changed = {
      type: 'files.changed',
      payload: { projectId: WORKFLOW_ID, changes: [{ path: 'a.ts', kind: 'changed' }], resync: false },
    };
    expect(ServerFrameSchema.parse(changed)).toEqual(changed);
    expect(ServerFrameSchema.safeParse({ ...changed, seq: 3 }).success, 'transient: no seq').toBe(
      false,
    );
  });
```

(Import `ServerFrameSchema` in `ws.test.ts` if it is not already imported.)

In `__tests__/events.test.ts`, find the assertion on `TRANSIENT_EVENT_TYPES` and change it to `['node.token', 'chat.token', 'files.changed']`. Add `expect([...PROJECT_EVENT_TYPES]).toEqual(['files.changed'])`, importing `PROJECT_EVENT_TYPES`.

In `__tests__/index.test.ts`, add `import * as workspace from '../workspace.js';` and add these rows to the `it.each` table:

```ts
    ['workspace', 'FileEntrySchema'],
    ['workspace', 'FileContentSchema'],
    ['workspace', 'SaveFileRequestSchema'],
    ['workspace', 'RepoStatusSchema'],
    ['workspace', 'FilesChangedPayloadSchema'],
    ['errors', 'IDE_ERROR_CODES'],
    ['events', 'PROJECT_EVENT_TYPES'],
```

Also add a check that the barrel re-exports the module itself: `expect(contracts.FileEntrySchema).toBe(workspace.FileEntrySchema);`.

- [ ] **Step 2: Run the tests to watch them fail**

Run: `pnpm --filter @ace/contracts exec vitest run src/__tests__/workspace.test.ts src/__tests__/errors.test.ts src/__tests__/ws.test.ts src/__tests__/events.test.ts src/__tests__/index.test.ts`

Expected: FAIL. `../workspace.js` cannot be resolved, and `IDE_ERROR_CODES` is undefined.

- [ ] **Step 3: Write `workspace.ts`**

Create `packages/contracts/src/workspace.ts`:

```ts
import { z } from 'zod';

import { IdSchema, TimestampSchema } from './graph.js';

/**
 * Forge's project files (D299, design §6.1).
 *
 * Every path on this seam is project-relative, uses forward slashes and never starts with one; `''`
 * is the project root and names a folder only. Confinement is the engine's job (FR-GIT-008) — the
 * contract only bounds the length, so an absolute path is refused by the engine with a reason the
 * person can read rather than by a schema error.
 */
export const ProjectPathSchema = z.string().max(1024);
export type ProjectPath = z.infer<typeof ProjectPathSchema>;

/** The largest file Forge opens for editing, and the largest save it accepts. */
export const FILE_EDIT_MAX_BYTES = 2 * 1024 * 1024;
/** The largest file `GET /files/raw` serves (the image preview). */
export const FILE_RAW_MAX_BYTES = 20 * 1024 * 1024;
/** `GET /files/list` stops here and says so with `truncated` (quick open). */
export const FILE_LIST_LIMIT = 50_000;
/** More changes than this in one watcher burst arrive as `resync` instead of a list. */
export const FILES_CHANGED_MAX = 500;

export const FILE_ENTRY_KINDS = ['file', 'folder'] as const;
export const FileEntryKindSchema = z.enum(FILE_ENTRY_KINDS);
export type FileEntryKind = z.infer<typeof FileEntryKindSchema>;

export const FileEntrySchema = z.strictObject({
  path: ProjectPathSchema,
  name: z.string(),
  kind: FileEntryKindSchema,
  /** Bytes for a file; 0 for a folder. */
  size: z.number().int().min(0),
  mtime: TimestampSchema,
  /** Matched by a `.gitignore` or one of ACE's default excludes: shown dimmed, skipped by list. */
  ignored: z.boolean(),
});
export type FileEntry = z.infer<typeof FileEntrySchema>;

/** `GET /projects/:id/files/tree?path=` — one folder, one level, folders first. */
export const FolderListingSchema = z.strictObject({
  path: ProjectPathSchema,
  items: z.array(FileEntrySchema),
});
export type FolderListing = z.infer<typeof FolderListingSchema>;

export const LINE_ENDINGS = ['lf', 'crlf'] as const;
export const LineEndingSchema = z.enum(LINE_ENDINGS);
export type LineEnding = z.infer<typeof LineEndingSchema>;

/** A content hash: it changes whenever the bytes on disk change, and only then. */
export const FileVersionSchema = z.string().min(1).max(128);
export type FileVersion = z.infer<typeof FileVersionSchema>;

/**
 * `GET /projects/:id/files/content?path=`. Only UTF-8 text up to {@link FILE_EDIT_MAX_BYTES} is
 * editable; anything else is described, never sent.
 */
export const FileContentSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('text'),
    path: ProjectPathSchema,
    /** Without the BOM; line endings exactly as on disk. */
    content: z.string(),
    version: FileVersionSchema,
    eol: LineEndingSchema,
    bom: z.boolean(),
    size: z.number().int().min(0),
  }),
  /** Binary, or text that is not valid UTF-8 — saving it as text would corrupt it. */
  z.strictObject({
    kind: z.literal('binary'),
    path: ProjectPathSchema,
    size: z.number().int().min(0),
  }),
  z.strictObject({
    kind: z.literal('too_large'),
    path: ProjectPathSchema,
    size: z.number().int().min(0),
  }),
]);
export type FileContent = z.infer<typeof FileContentSchema>;
export type TextFileContent = Extract<FileContent, { kind: 'text' }>;

/** `PUT /projects/:id/files/content`. */
export const SaveFileRequestSchema = z.strictObject({
  path: ProjectPathSchema.min(1),
  content: z.string(),
  /**
   * The version the buffer was loaded from. A different version on disk answers 409
   * `file_changed`; `null` means "this file should not exist yet" (recreating a deleted one).
   */
  baseVersion: FileVersionSchema.nullable(),
  eol: LineEndingSchema,
  bom: z.boolean(),
});
export type SaveFileRequest = z.infer<typeof SaveFileRequestSchema>;

export const SaveFileResultSchema = z.strictObject({
  path: ProjectPathSchema,
  version: FileVersionSchema,
  size: z.number().int().min(0),
  mtime: TimestampSchema,
});
export type SaveFileResult = z.infer<typeof SaveFileResultSchema>;

/** `POST /projects/:id/files/entries` — missing parent folders are created too. */
export const CreateEntryRequestSchema = z.strictObject({
  path: ProjectPathSchema.min(1),
  kind: FileEntryKindSchema,
});
export type CreateEntryRequest = z.infer<typeof CreateEntryRequestSchema>;

/** `POST /projects/:id/files/move` — rename or move, inside the project only. */
export const MoveEntryRequestSchema = z.strictObject({
  from: ProjectPathSchema.min(1),
  to: ProjectPathSchema.min(1),
});
export type MoveEntryRequest = z.infer<typeof MoveEntryRequestSchema>;

/** `?path=` on `GET /files/tree`: the root when omitted. */
export const FilePathQuerySchema = z.object({ path: ProjectPathSchema.default('') });
/** `?path=` on the routes that name one entry. */
export const RequiredFilePathQuerySchema = z.object({ path: ProjectPathSchema.min(1) });

/** `GET /projects/:id/files/list` — every non-ignored file, breadth first, for quick open. */
export const FileListSchema = z.strictObject({
  files: z.array(ProjectPathSchema),
  truncated: z.boolean(),
});
export type FileList = z.infer<typeof FileListSchema>;

export const REPO_FILE_STATUSES = ['modified', 'added', 'deleted', 'renamed', 'untracked'] as const;
export const RepoFileStatusSchema = z.enum(REPO_FILE_STATUSES);
export type RepoFileStatus = z.infer<typeof RepoFileStatusSchema>;

/**
 * `GET /projects/:id/files/status` — the project repository's status, read-only, for the
 * Explorer's decorations (design §6.4). Never an error: no git, or no repository, is `repo: false`.
 * An untracked folder is one entry for the folder itself.
 */
export const RepoStatusSchema = z.union([
  z.strictObject({ repo: z.literal(false) }),
  z.strictObject({
    repo: z.literal(true),
    branch: z.string().nullable(),
    files: z.array(z.strictObject({ path: ProjectPathSchema, status: RepoFileStatusSchema })),
    truncated: z.boolean(),
  }),
]);
export type RepoStatus = z.infer<typeof RepoStatusSchema>;

export const FILE_CHANGE_KINDS = ['created', 'changed', 'deleted'] as const;
export const FileChangeSchema = z.strictObject({
  path: ProjectPathSchema,
  kind: z.enum(FILE_CHANGE_KINDS),
});
export type FileChange = z.infer<typeof FileChangeSchema>;

/**
 * The transient `files.changed` frame on the `project` scope: one debounced burst of the watcher.
 * Paths only — contents never travel on the socket. `resync: true` (with no changes) means "too
 * much changed to list; refetch what you show".
 */
export const FilesChangedPayloadSchema = z.strictObject({
  projectId: IdSchema,
  changes: z.array(FileChangeSchema).max(FILES_CHANGED_MAX),
  resync: z.boolean(),
});
export type FilesChangedPayload = z.infer<typeof FilesChangedPayloadSchema>;

/** `details` of a 409 `file_changed`: what is on disk now, `null` when the file is gone. */
export const FileChangedDetailsSchema = z.object({ currentVersion: FileVersionSchema.nullable() });
export type FileChangedDetails = z.infer<typeof FileChangedDetailsSchema>;
```

- [ ] **Step 4: Add the error codes**

In `packages/contracts/src/errors.ts`, after `ROUND_4_ERROR_CODES`:

```ts
/**
 * Codes Forge's file API adds (D299, design §6.1): a save on a stale base (409, with the disk's
 * version in `details`), a create or move onto an existing path (409), a save over the editable
 * size (413), a path outside the project folder (403) and a write into `.git`/`.ace` (403).
 */
export const IDE_ERROR_CODES = [
  'file_changed',
  'exists',
  'file_too_large',
  'outside_project',
  'protected_path',
] as const;
```

Spread `...IDE_ERROR_CODES` at the end of `ERROR_CODES`. Add these to `ERROR_CODE_HTTP_STATUS`:

```ts
  file_changed: 409,
  exists: 409,
  file_too_large: 413,
  outside_project: 403,
  protected_path: 403,
```

- [ ] **Step 5: Add the project frame family**

In `packages/contracts/src/events.ts`, add `import { FilesChangedPayloadSchema } from './workspace.js';` with the other imports. Then add the family after `ENGINE_EVENT_FRAME_SCHEMAS`:

```ts
/**
 * Forge's frames (D299). They ride the `project` scope and are never persisted: a file watcher's
 * burst is worth sending to a client that is looking and worth nothing in the log.
 */
export const PROJECT_EVENT_FRAME_SCHEMAS = [
  transientFrame('files.changed', FilesChangedPayloadSchema),
] as const;

/** Server → client, project scope (D299). */
export const ProjectEventSchema = z.discriminatedUnion('type', PROJECT_EVENT_FRAME_SCHEMAS);
export type ProjectEvent = z.infer<typeof ProjectEventSchema>;
```

Under "Type lists", add `PROJECT_EVENT_TYPES` and extend the transient list:

```ts
export const PROJECT_EVENT_TYPES = ['files.changed'] as const;
export type ProjectEventType = (typeof PROJECT_EVENT_TYPES)[number];

/** Not persisted, no `seq`, never replayed by `resume` (§2.4, round 4 §2.5, D299). */
export const TRANSIENT_EVENT_TYPES = ['node.token', 'chat.token', 'files.changed'] as const;
```

`isTransient` keeps its parameter type `RunEventType | ThreadEventType`. `includes` is over `readonly string[]`, so it still compiles.

- [ ] **Step 6: Add the scope and the frames to `ws.ts`**

In `packages/contracts/src/ws.ts`:

```ts
import {
  ENGINE_EVENT_FRAME_SCHEMAS,
  PROJECT_EVENT_FRAME_SCHEMAS,
  RUN_EVENT_FRAME_SCHEMAS,
  SeqSchema,
  THREAD_EVENT_FRAME_SCHEMAS,
} from './events.js';
```

```ts
/**
 * What a client may subscribe to. Round 4 §2.5 adds `thread`: a direct chat streams on its own
 * subscription. D299 adds `project`: Forge's `files.changed` frames for one project folder, and the
 * engine watches that folder only while someone subscribes.
 */
export const WS_SCOPES = ['workflow', 'engine', 'thread', 'project'] as const;
```

```ts
export const WsSubscribePayloadSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('workflow'), id: IdSchema }),
  z.object({ scope: z.literal('engine') }),
  z.object({ scope: z.literal('thread'), id: IdSchema }),
  z.object({ scope: z.literal('project'), id: IdSchema }),
]);
```

```ts
export const ServerFrameSchema = z.discriminatedUnion('type', [
  ...CORE_SERVER_FRAME_SCHEMAS,
  ...RUN_EVENT_FRAME_SCHEMAS,
  ...THREAD_EVENT_FRAME_SCHEMAS,
  ...ENGINE_EVENT_FRAME_SCHEMAS,
  ...PROJECT_EVENT_FRAME_SCHEMAS,
]);
```

In `packages/contracts/src/index.ts`, after the Round 5 block:

```ts
/* IDE — Forge (D299) */
export * from './workspace.js';
```

- [ ] **Step 7: Run the contract suite**

Run: `pnpm --filter @ace/contracts test`
Expected: PASS, every test, including the old ones. If a `switch` over `WsScope` or `ServerFrame['type']` elsewhere in contracts is no longer exhaustive, fix it here.

- [ ] **Step 8: Build contracts and typecheck the workspace**

Run: `pnpm --filter @ace/contracts build && pnpm typecheck`

Expected: the typecheck most likely passes. The existing `else` branches in `packages/engine/src/events/ws-hub.ts` and `apps/web/src/mocks/fake-socket.ts` still compile with the new `project` member; they just route it wrongly until Tasks 6 and 9 give it its own branch. Record any errors in the ledger. Nothing outside `packages/contracts` is edited in this task.

- [ ] **Step 9: Commit**

```bash
npx prettier --write --config packages/config/prettier.config.js packages/contracts/src/workspace.ts packages/contracts/src/__tests__/workspace.test.ts
git add packages/contracts
git commit -m "feat(contracts): Forge project files, file error codes, the project scope and files.changed [D299] [FR-GIT-003] [FR-GIT-004] [FR-GIT-008]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Engine — the `ProjectFiles` port and its errors

**Files:**
- Create: `packages/engine/src/ports/workspace.ts`
- Modify: `packages/engine/src/ports/index.ts`, `packages/engine/src/gateway/errors.ts`
- Test: create `packages/engine/src/gateway/__tests__/workspace-errors.test.ts`

**Interfaces:**
- Consumes (Task 1): `FileContent`, `FileEntry`, `FolderListing`, `FileList`, `RepoStatus`, `SaveFileRequest`, `SaveFileResult`, `CreateEntryRequest` and `FilesChangedPayload` from `@ace/contracts`.
- Produces:
  - `ProjectFiles`, the interface below;
  - `RawFile { bytes: ArrayBuffer; contentType: string }`;
  - `FileChangeBatch = Omit<FilesChangedPayload, 'projectId'>`;
  - `WORKSPACE_FS_ERROR_CODES`;
  - `class WorkspaceFsError(code, message, details?)`;
  - `isWorkspaceFsError(error)`;
  - `workspaceRefusal(error): HttpError`;
  - `toApiError` answering a `WorkspaceFsError` with its code's status.

  Tools (Tasks 3–4) throws `WorkspaceFsError`; the engine (Task 5) uses `ProjectFiles`.

- [ ] **Step 1: Write the failing test**

Create `packages/engine/src/gateway/__tests__/workspace-errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { WorkspaceFsError, isWorkspaceFsError } from '../../ports/workspace.js';
import { toApiError } from '../errors.js';

describe('D299 FR-GIT-008 the file API’s refusals', () => {
  it('answers a stale save 409 file_changed with the disk’s version', () => {
    const { status, body } = toApiError(
      new WorkspaceFsError('file_changed', 'a.ts changed on disk.', { currentVersion: 'v2' }),
    );
    expect(status).toBe(409);
    expect(body.error).toMatchObject({
      kind: 'workflow',
      code: 'file_changed',
      message: 'a.ts changed on disk.',
      details: { currentVersion: 'v2' },
      retryable: false,
    });
  });

  it.each([
    ['exists', 409, 'workflow'],
    ['not_found', 404, 'workflow'],
    ['file_too_large', 413, 'invalid_config'],
    ['outside_project', 403, 'invalid_config'],
    ['protected_path', 403, 'invalid_config'],
    ['invalid_path', 400, 'invalid_config'],
  ] as const)('answers %s with %i, kind %s', (code, status, kind) => {
    const answer = toApiError(new WorkspaceFsError(code, 'no'));
    expect(answer.status).toBe(status);
    expect(answer.body.error.kind).toBe(kind);
  });

  it('recognises a refusal thrown by another copy of the engine (branded, not instanceof)', () => {
    const foreign = Object.assign(new Error('elsewhere'), {
      name: 'WorkspaceFsError',
      code: 'exists',
      [Symbol.for('@ace/engine/WorkspaceFsError')]: true,
    });
    expect(isWorkspaceFsError(foreign)).toBe(true);
    expect(toApiError(foreign).status).toBe(409);
    expect(isWorkspaceFsError(Object.assign(new Error('x'), { code: 'exists' }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `pnpm --filter @ace/engine exec vitest run src/gateway/__tests__/workspace-errors.test.ts`
Expected: FAIL. Cannot find module `../../ports/workspace.js`.

- [ ] **Step 3: Write the port**

Create `packages/engine/src/ports/workspace.ts`:

```ts
import type {
  CreateEntryRequest,
  FileContent,
  FileEntry,
  FileList,
  FilesChangedPayload,
  FolderListing,
  RepoStatus,
  SaveFileRequest,
  SaveFileResult,
} from '@ace/contracts';

/** One debounced watcher burst — the `files.changed` payload before the engine names the project. */
export type FileChangeBatch = Omit<FilesChangedPayload, 'projectId'>;

/** `GET /files/raw`: the bytes and the type they are served with (image previews). */
export interface RawFile {
  bytes: ArrayBuffer;
  contentType: string;
}

/**
 * Forge's view of one project folder (D299, design §6.1). The engine names the folder (`root`, the
 * project's absolute `folderPath`); the adapter — `createFsProjectFiles` in `@ace/tools` — confines
 * every path to it (FR-GIT-008) and throws {@link WorkspaceFsError} for a refusal the person should
 * read. Paths in and out are project-relative with forward slashes.
 */
export interface ProjectFiles {
  listFolder(root: string, path: string): Promise<FolderListing>;
  read(root: string, path: string): Promise<FileContent>;
  readRaw(root: string, path: string): Promise<RawFile>;
  write(root: string, request: SaveFileRequest): Promise<SaveFileResult>;
  create(root: string, request: CreateEntryRequest): Promise<FileEntry>;
  move(root: string, from: string, to: string): Promise<FileEntry>;
  remove(root: string, path: string): Promise<void>;
  listAll(root: string): Promise<FileList>;
  status(root: string): Promise<RepoStatus>;
  /**
   * Watch the folder recursively. `onChange` gets each debounced burst; `onError` fires once if
   * the watcher dies (it is stopped by then). The returned function stops watching.
   */
  watch(
    root: string,
    onChange: (batch: FileChangeBatch) => void,
    onError: (error: Error) => void,
  ): () => void;
}

/** Every refusal a `ProjectFiles` adapter may throw; each is an `ErrorCode` of the contract. */
export const WORKSPACE_FS_ERROR_CODES = [
  'not_found',
  'exists',
  'file_changed',
  'file_too_large',
  'outside_project',
  'protected_path',
  'invalid_path',
] as const;
export type WorkspaceFsErrorCode = (typeof WORKSPACE_FS_ERROR_CODES)[number];

/**
 * Shared through the global symbol registry, so a refusal thrown by `@ace/tools`' copy of this
 * class — a different object when the packages resolve to different builds — is still recognised.
 * The same arrangement as `SecretWriteRejectedError`.
 */
const BRAND: unique symbol = Symbol.for('@ace/engine/WorkspaceFsError');

export class WorkspaceFsError extends Error {
  override readonly name = 'WorkspaceFsError';
  readonly [BRAND] = true;

  constructor(
    readonly code: WorkspaceFsErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** True for a `WorkspaceFsError` from this copy of the engine or any other. */
export function isWorkspaceFsError(error: unknown): error is WorkspaceFsError {
  if (error instanceof WorkspaceFsError) return true;
  if (!(error instanceof Error)) return false;
  const branded = error as Error & { [BRAND]?: unknown; code?: unknown };
  return (
    branded[BRAND] === true &&
    typeof branded.code === 'string' &&
    (WORKSPACE_FS_ERROR_CODES as readonly string[]).includes(branded.code)
  );
}
```

Add `export * from './workspace.js';` to `packages/engine/src/ports/index.ts`.

- [ ] **Step 4: Answer it in `toApiError`**

In `packages/engine/src/gateway/errors.ts`, import `isWorkspaceFsError` and `type WorkspaceFsError` from `'../ports/workspace.js'`, then add:

```ts
/**
 * D299: a `ProjectFiles` refusal, with the status §6.1 pairs with its code. A conflict, an
 * existing name and a missing file are about the project's state (`workflow`); the rest are about
 * the path the person asked for (`invalid_config`).
 */
export function workspaceRefusal(error: WorkspaceFsError): HttpError {
  const state = error.code === 'file_changed' || error.code === 'exists' || error.code === 'not_found';
  return new HttpError(state ? 'workflow' : 'invalid_config', error.code, error.message, error.details, false);
}
```

In `toApiError`, right after the `HttpError` branch:

```ts
  if (isWorkspaceFsError(error)) {
    const refused = workspaceRefusal(error);
    return { status: refused.status, body: refused.toApiError() };
  }
```

- [ ] **Step 5: Run the test**

Run: `pnpm --filter @ace/engine exec vitest run src/gateway/__tests__/workspace-errors.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Build the engine and commit**

Run: `pnpm --filter @ace/engine build`
Expected: it builds. (`ws-hub.ts` treats a `project` subscription as engine scope until Task 6. No test covers that path yet.)

```bash
npx prettier --write --config packages/config/prettier.config.js packages/engine/src/ports/workspace.ts packages/engine/src/gateway/__tests__/workspace-errors.test.ts
git add packages/engine
git commit -m "feat(engine): the ProjectFiles port and its refusals on the error envelope [D299] [FR-GIT-008]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Tools — confined, ignore-aware file operations on disk

**Files:**
- Modify: `packages/tools/src/project/paths.ts`, `packages/tools/package.json` (add `ignore`)
- Create: `packages/tools/src/workspace/ignore-rules.ts`, `packages/tools/src/workspace/resolve.ts`, `packages/tools/src/workspace/fs-files.ts`
- Test: extend `packages/tools/src/project/paths.test.ts`; create `packages/tools/src/workspace/ignore-rules.test.ts`, `packages/tools/src/workspace/fs-files.test.ts`

**Interfaces:**
- Consumes:
  - from Task 1: the contract types, plus `FILE_EDIT_MAX_BYTES`, `FILE_RAW_MAX_BYTES` and `FILE_LIST_LIMIT`;
  - from Task 2: `WorkspaceFsError` and `RawFile`, from `@ace/engine`;
  - existing in the sandbox code: `resolveInsideSandbox(dir, candidate): PathResolution` and `realpathOfDeepestExisting(path)`;
  - existing in project paths: `projectRelative(projectDir, absolute)`.
- Produces:
  - **`project/paths.ts`:** `protectedFolderIn(projectDir, absolute): string | undefined`. `assertWritable` now refuses `.git`/`.ace` at any depth.
  - **`ignore-rules.ts`:** `HIDDEN_NAMES`, `DEFAULT_IGNORED_FOLDERS`, and `createIgnoreRules(root): IgnoreRules`, where `IgnoreRules = { isIgnored(rel, isFolder), isHidden(rel), clear() }`.
  - **`resolve.ts`:** `toAbsolute(root, rel, { allowRoot?, write? }): string` and `assertValidName(name): void`.
  - **`fs-files.ts`:** `SAVE_TEMP_SUFFIX`, `versionOf(bytes)`, `listFolder(root, path)`, `readFile(root, path)`, `readRaw(root, path, maxBytes?)`, `writeFile(root, request)`, `createEntry(root, request)`, `moveEntry(root, from, to)`, `removeEntry(root, path)`, `listAllFiles(root, limit?)`.

- [ ] **Step 1: Add the dependency**

```bash
pnpm --filter @ace/tools add ignore@^5.3.2 --prefer-offline
```

Expected:
- `packages/tools/package.json` gains `"ignore": "^5.3.2"` under `dependencies`.
- The lockfile updates without a network error; the package is already in the store.

If it needs the network and that fails, stop and report. Do not hand-edit the lockfile.

- [ ] **Step 2: Write the failing tests**

Extend `packages/tools/src/project/paths.test.ts`. Read its existing imports and project-folder fixture first, and reuse them, importing `protectedFolderIn` beside `assertWritable`.

```ts
describe('D299 FR-GIT-008 protected folders at any depth', () => {
  it.each(['sub/.git/config', 'a/b/.GIT/hooks/pre-commit', 'x/.git./HEAD', 'deep/.ace/state.json'])(
    'refuses a write into %j',
    (rel) => {
      expect(() => assertWritable(project, join(project, rel), 'write_file')).toThrow(
        /may not write inside/,
      );
      expect(protectedFolderIn(project, join(project, rel))).toMatch(/^\.(git|ace)$/);
    },
  );

  it('still allows look-alikes: .github, .gitignore, my.git.txt', () => {
    for (const rel of ['.github/workflows/ci.yml', '.gitignore', 'notes/my.git.txt']) {
      expect(() => assertWritable(project, join(project, rel), 'write_file')).not.toThrow();
      expect(protectedFolderIn(project, join(project, rel))).toBeUndefined();
    }
  });
});
```

Create `packages/tools/src/workspace/ignore-rules.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createIgnoreRules } from './ignore-rules.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ace-ignore-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (rel: string, text: string) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
};

describe('D299 FR-GIT-003 which entries the Explorer dims', () => {
  it('hides .git and nothing else', () => {
    const rules = createIgnoreRules(root);
    expect(rules.isHidden('.git')).toBe(true);
    expect(rules.isHidden('.git/HEAD')).toBe(true);
    expect(rules.isHidden('.github')).toBe(false);
    expect(rules.isHidden('.gitignore')).toBe(false);
  });

  it('ignores the default folders and everything under them, but not a file of that name', () => {
    const rules = createIgnoreRules(root);
    expect(rules.isIgnored('node_modules', true)).toBe(true);
    expect(rules.isIgnored('pkg/node_modules/x/index.js', false)).toBe(true);
    expect(rules.isIgnored('dist', true)).toBe(true);
    expect(rules.isIgnored('dist', false), 'a file named dist').toBe(false);
    expect(rules.isIgnored('src/index.ts', false)).toBe(false);
  });

  it('honours the root .gitignore, folder-only patterns and nested .gitignore files', () => {
    put('.gitignore', '*.log\nout/\n!keep.log\n');
    put('web/.gitignore', 'generated/\n');
    const rules = createIgnoreRules(root);
    expect(rules.isIgnored('debug.log', false)).toBe(true);
    expect(rules.isIgnored('keep.log', false)).toBe(false);
    expect(rules.isIgnored('out', true)).toBe(true);
    expect(rules.isIgnored('out', false), 'out/ matches folders only').toBe(false);
    expect(rules.isIgnored('out/a.txt', false)).toBe(true);
    expect(rules.isIgnored('web/generated/a.ts', false)).toBe(true);
    expect(rules.isIgnored('generated/a.ts', false), 'the nested file applies below web/ only').toBe(
      false,
    );
  });

  it('reads a changed .gitignore again after clear()', () => {
    put('.gitignore', '');
    const rules = createIgnoreRules(root);
    expect(rules.isIgnored('a.tmp', false)).toBe(false);
    put('.gitignore', '*.tmp\n');
    expect(rules.isIgnored('a.tmp', false), 'cached').toBe(false);
    rules.clear();
    expect(rules.isIgnored('a.tmp', false)).toBe(true);
  });
});
```

Create `packages/tools/src/workspace/fs-files.test.ts`:

```ts
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FILE_EDIT_MAX_BYTES } from '@ace/contracts';
import { isWorkspaceFsError } from '@ace/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createEntry,
  listAllFiles,
  listFolder,
  moveEntry,
  readFile,
  readRaw,
  removeEntry,
  versionOf,
  writeFile,
} from './fs-files.js';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

let root: string;
let project: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ace-forge-'));
  project = join(root, 'My Project');
  mkdirSync(project);
});
afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));

const put = (rel: string, content: string | Buffer = '') => {
  mkdirSync(join(project, rel, '..'), { recursive: true });
  writeFileSync(join(project, rel), content);
};
const disk = (rel: string) => readFileSync(join(project, rel));

/** The refusal's code and details; fails when the promise resolves or throws something else. */
async function refusal(promise: Promise<unknown>): Promise<{ code: string; details?: unknown }> {
  try {
    await promise;
  } catch (error) {
    if (isWorkspaceFsError(error)) {
      return error.details === undefined ? { code: error.code } : { code: error.code, details: error.details };
    }
    throw error;
  }
  throw new Error('expected a refusal');
}

const save = (path: string, content: string, baseVersion: string | null) =>
  writeFile(project, { path, content, baseVersion, eol: 'lf', bom: false });

describe('FR-GIT-003 listing a folder', () => {
  it('lists one level, folders first in natural order, hides .git and dims ignored entries', async () => {
    put('b.txt', 'b');
    put('a10.txt');
    put('a2.txt');
    put('src/index.ts');
    put('.git/HEAD', 'ref: refs/heads/main');
    put('node_modules/x/index.js');
    put('.gitignore', '*.log\n');
    put('debug.log');

    const listing = await listFolder(project, '');

    expect(listing.path).toBe('');
    expect(listing.items.map((entry) => entry.name)).toEqual([
      'node_modules',
      'src',
      '.gitignore',
      'a2.txt',
      'a10.txt',
      'b.txt',
      'debug.log',
    ]);
    expect(listing.items.find((e) => e.name === 'node_modules')?.ignored).toBe(true);
    expect(listing.items.find((e) => e.name === 'debug.log')?.ignored).toBe(true);
    expect(listing.items.find((e) => e.name === 'src')).toMatchObject({
      path: 'src',
      kind: 'folder',
      size: 0,
      ignored: false,
    });
    expect(listing.items.find((e) => e.name === 'b.txt')).toMatchObject({ path: 'b.txt', size: 1 });
  });

  it('lists a nested folder with project-relative paths and honours its .gitignore', async () => {
    put('src/keep.ts');
    put('src/gen/out.js');
    put('src/.gitignore', 'gen/\n');

    const listing = await listFolder(project, 'src');

    expect(listing.path).toBe('src');
    expect(listing.items.map((e) => [e.path, e.ignored])).toEqual([
      ['src/gen', true],
      ['src/.gitignore', false],
      ['src/keep.ts', false],
    ]);
  });

  it('answers not_found for a missing folder and invalid_path for a file', async () => {
    put('a.txt');
    expect((await refusal(listFolder(project, 'nope'))).code).toBe('not_found');
    expect((await refusal(listFolder(project, 'a.txt'))).code).toBe('invalid_path');
  });
});

describe('FR-GIT-008 every path stays inside the project', () => {
  it.each([['../x'], ['src/../../x'], ['C:\\Windows\\win.ini'], ['/etc/passwd'], ['\\\\host\\share\\x'], ['a\u0000b'], ['~/secret']])(
    'refuses to read %j as outside_project',
    async (path) => {
      expect((await refusal(readFile(project, path))).code).toBe('outside_project');
    },
  );

  it.each([
    '.git/config',
    '.GIT/config',
    '.git./hooks/pre-commit',
    'sub/.git/config',
    'deep/er/.Git /HEAD',
    '.ace/state.json',
    'x/.ace/y',
  ])('refuses to write %j inside a protected folder', async (path) => {
    expect((await refusal(save(path, 'x', null))).code).toBe('protected_path');
    expect((await refusal(createEntry(project, { path, kind: 'file' }))).code).toBe('protected_path');
  });

  it.each(['CON', 'aux.txt', 'nul.md', 'trailing.', 'trailing ', 'a<b', 'a|b', 'q?.txt'])(
    'refuses to create the name %j',
    async (name) => {
      expect((await refusal(createEntry(project, { path: name, kind: 'file' }))).code).toMatch(
        /^(invalid_path|outside_project)$/,
      );
    },
  );

  it('refuses the project folder itself where an entry is needed', async () => {
    expect((await refusal(removeEntry(project, ''))).code).toBe('invalid_path');
    expect((await refusal(removeEntry(project, '.'))).code).toBe('invalid_path');
    expect((await refusal(readFile(project, './'))).code).toBe('invalid_path');
  });

  it('works with spaces, unicode and leading dots', async () => {
    const created = await createEntry(project, { path: 'My Notes/ü.md', kind: 'file' });
    expect(created).toMatchObject({ path: 'My Notes/ü.md', name: 'ü.md', kind: 'file' });
    await createEntry(project, { path: '.env', kind: 'file' });
    expect((await listFolder(project, 'My Notes')).items.map((e) => e.path)).toEqual(['My Notes/ü.md']);
    expect((await readFile(project, '.env')).kind).toBe('text');
  });

  it('neither lists nor reads through a link that points outside the project', async () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'top secret');
    // a junction needs no privilege on Windows; elsewhere the type argument is ignored
    symlinkSync(outside, join(project, 'out'), 'junction');

    expect((await listFolder(project, '')).items.map((e) => e.name)).not.toContain('out');
    expect((await refusal(readFile(project, 'out/secret.txt'))).code).toBe('outside_project');
  });
});

describe('FR-GIT-004 reading a file', () => {
  it('reads UTF-8 text with its version, line ending and BOM', async () => {
    put('a.txt', Buffer.concat([BOM, Buffer.from('one\r\ntwo\r\n')]));

    expect(await readFile(project, 'a.txt')).toEqual({
      kind: 'text',
      path: 'a.txt',
      content: 'one\r\ntwo\r\n',
      version: versionOf(disk('a.txt')),
      eol: 'crlf',
      bom: true,
      size: 13,
    });
  });

  it('treats a file with a NUL byte as binary', async () => {
    put('img.bin', Buffer.from([0x89, 0x50, 0x00, 0x01]));
    expect(await readFile(project, 'img.bin')).toEqual({ kind: 'binary', path: 'img.bin', size: 4 });
  });

  it('treats a file that is not UTF-8 as binary', async () => {
    put('latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    expect((await readFile(project, 'latin1.txt')).kind).toBe('binary');
  });

  it('describes a file over the editable limit without sending it', async () => {
    put('big.log', Buffer.alloc(FILE_EDIT_MAX_BYTES + 1, 0x61));
    expect(await readFile(project, 'big.log')).toEqual({
      kind: 'too_large',
      path: 'big.log',
      size: FILE_EDIT_MAX_BYTES + 1,
    });
  });

  it('answers not_found for a missing file and for a folder', async () => {
    put('src/a.ts');
    expect((await refusal(readFile(project, 'nope.ts'))).code).toBe('not_found');
    expect((await refusal(readFile(project, 'src'))).code).toBe('not_found');
  });
});

describe('FR-GIT-004 saving a file', () => {
  it('round-trips a CRLF file with a BOM byte for byte', async () => {
    const original = Buffer.concat([BOM, Buffer.from('a\r\nb\r\n')]);
    put('x.txt', original);
    const read = await readFile(project, 'x.txt');
    if (read.kind !== 'text') throw new Error('expected text');

    const saved = await writeFile(project, {
      path: 'x.txt',
      content: read.content,
      baseVersion: read.version,
      eol: read.eol,
      bom: read.bom,
    });

    expect(disk('x.txt').equals(original)).toBe(true);
    expect(saved).toMatchObject({ path: 'x.txt', version: read.version, size: original.length });
  });

  it('writes the line endings it is given', async () => {
    put('x.txt', 'old');
    await writeFile(project, {
      path: 'x.txt',
      content: 'a\nb\r\nc',
      baseVersion: versionOf(Buffer.from('old')),
      eol: 'crlf',
      bom: false,
    });
    expect(disk('x.txt').toString()).toBe('a\r\nb\r\nc');
  });

  it('refuses a save whose base version is stale, naming what is on disk', async () => {
    put('a.txt', 'one');
    const loaded = versionOf(Buffer.from('one'));
    put('a.txt', 'two');

    expect(await refusal(save('a.txt', 'mine', loaded))).toEqual({
      code: 'file_changed',
      details: { currentVersion: versionOf(Buffer.from('two')) },
    });
    expect(disk('a.txt').toString()).toBe('two');
  });

  it('recreates a deleted file with a null base, and refuses null while the file exists', async () => {
    expect((await save('again.txt', 'back', null)).path).toBe('again.txt');
    expect(disk('again.txt').toString()).toBe('back');
    expect(await refusal(save('again.txt', 'x', null))).toEqual({
      code: 'file_changed',
      details: { currentVersion: versionOf(Buffer.from('back')) },
    });
  });

  it('answers a stale save of a deleted file with currentVersion null', async () => {
    expect(await refusal(save('gone.txt', 'x', 'v1'))).toEqual({
      code: 'file_changed',
      details: { currentVersion: null },
    });
  });

  it('refuses a save over 2 MB', async () => {
    expect((await refusal(save('big.txt', 'a'.repeat(FILE_EDIT_MAX_BYTES + 1), null))).code).toBe(
      'file_too_large',
    );
  });

  it('answers not_found when the folder is gone, and leaves no temporary file behind', async () => {
    expect((await refusal(save('gone/a.txt', 'x', null))).code).toBe('not_found');
    put('a.txt', 'one');
    await save('a.txt', 'two', versionOf(Buffer.from('one')));
    expect(readdirSync(project).filter((name) => name.endsWith('.ace-save'))).toEqual([]);
  });
});

describe('FR-GIT-003 creating, moving and deleting', () => {
  it('creates a file with its missing folders, and a folder', async () => {
    expect(await createEntry(project, { path: 'a/b/c.ts', kind: 'file' })).toMatchObject({
      path: 'a/b/c.ts',
      kind: 'file',
      size: 0,
    });
    expect(await createEntry(project, { path: 'docs', kind: 'folder' })).toMatchObject({
      path: 'docs',
      kind: 'folder',
    });
    expect(disk('a/b/c.ts').length).toBe(0);
  });

  it('refuses to create over an existing entry', async () => {
    put('a.txt', 'keep');
    expect((await refusal(createEntry(project, { path: 'a.txt', kind: 'file' }))).code).toBe('exists');
    expect(disk('a.txt').toString()).toBe('keep');
  });

  it('moves a file into another folder, creating it, and renames a folder', async () => {
    put('a.txt', 'x');
    put('lib/u.ts', 'u');
    expect((await moveEntry(project, 'a.txt', 'docs/a.txt')).path).toBe('docs/a.txt');
    expect(disk('docs/a.txt').toString()).toBe('x');
    expect((await moveEntry(project, 'lib', 'src')).kind).toBe('folder');
    expect(disk('src/u.ts').toString()).toBe('u');
  });

  it('renames a file to another case of its own name', async () => {
    put('readme.md', 'x');
    expect((await moveEntry(project, 'readme.md', 'README.md')).path).toBe('README.md');
    expect(readdirSync(project)).toContain('README.md');
    expect(readdirSync(project)).not.toContain('readme.md');
  });

  it('refuses to move onto an existing entry, or a folder into itself', async () => {
    put('a.txt', 'a');
    put('b.txt', 'b');
    put('src/x.ts');
    expect((await refusal(moveEntry(project, 'a.txt', 'b.txt'))).code).toBe('exists');
    expect((await refusal(moveEntry(project, 'src', 'src/inner'))).code).toBe('invalid_path');
    expect((await refusal(moveEntry(project, 'nope', 'x'))).code).toBe('not_found');
    expect(disk('b.txt').toString()).toBe('b');
  });

  it('deletes a file and a folder with its contents', async () => {
    put('a.txt');
    put('src/deep/x.ts');
    await removeEntry(project, 'a.txt');
    await removeEntry(project, 'src');
    expect(readdirSync(project)).toEqual([]);
    expect((await refusal(removeEntry(project, 'a.txt'))).code).toBe('not_found');
  });

  it('refuses to move or delete inside .git', async () => {
    put('.git/config', '[core]');
    expect((await refusal(removeEntry(project, '.git/config'))).code).toBe('protected_path');
    expect((await refusal(moveEntry(project, '.git/config', 'config'))).code).toBe('protected_path');
  });
});

describe('quick open: every file in the project', () => {
  it('lists files breadth first, skipping hidden and ignored folders and ignored files', async () => {
    put('a.ts');
    put('src/b.ts');
    put('src/deep/c.ts');
    put('node_modules/x.js');
    put('.git/HEAD');
    put('dist/out.js');
    put('.gitignore', '*.log\n');
    put('notes.log');

    expect(await listAllFiles(project)).toEqual({
      files: ['.gitignore', 'a.ts', 'src/b.ts', 'src/deep/c.ts'],
      truncated: false,
    });
  });

  it('list skips ignored folders and stops at the cap', async () => {
    put('a.ts');
    put('b.ts');
    put('c.ts');
    put('node_modules/z.js');
    expect(await listAllFiles(project, 2)).toEqual({ files: ['a.ts', 'b.ts'], truncated: true });
  });
});

describe('D299 image previews', () => {
  it('serves the bytes with an image type, or a generic type', async () => {
    put('a.png', Buffer.from([1, 2, 3]));
    put('logo.SVG', '<svg/>');
    put('a.bin', Buffer.from([0]));
    const png = await readRaw(project, 'a.png');
    expect(png.contentType).toBe('image/png');
    expect([...new Uint8Array(png.bytes)]).toEqual([1, 2, 3]);
    expect((await readRaw(project, 'logo.SVG')).contentType).toBe('image/svg+xml');
    expect((await readRaw(project, 'a.bin')).contentType).toBe('application/octet-stream');
  });

  it('refuses a file over the preview limit', async () => {
    put('big.png', Buffer.alloc(5));
    expect((await refusal(readRaw(project, 'big.png', 4))).code).toBe('file_too_large');
  });
});
```

- [ ] **Step 3: Run the tests to watch them fail**

Run: `pnpm --filter @ace/tools exec vitest run src/project/paths.test.ts src/workspace`
Expected: FAIL. `protectedFolderIn` is not exported, and `./ignore-rules.js` and `./fs-files.js` do not exist.

- [ ] **Step 4: Protect `.git` and `.ace` at any depth**

In `packages/tools/src/project/paths.ts`, replace `protectedTop` and `assertWritable` with:

```ts
/** The first protected folder name anywhere on `absolute`'s path below `projectDir`. */
function protectedSegment(projectDir: string, absolute: string): string | undefined {
  for (const segment of projectRelative(projectDir, absolute).split('/')) {
    const name = asFilesystemSees(segment);
    if (PROTECTED_FOLDERS.has(name)) return name;
  }
  return undefined;
}

/**
 * The protected folder (`.git` or `.ace`) a write to `absolute` would land in — at any depth, so a
 * nested repository's hooks are as safe as the top-level one's (D299) — by name, and through a link
 * or a short (8.3) name that resolves into one (review C1).
 */
export function protectedFolderIn(projectDir: string, absolute: string): string | undefined {
  return (
    protectedSegment(projectDir, absolute) ??
    protectedSegment(realpathOfDeepestExisting(resolve(projectDir)), realpathOfDeepestExisting(absolute))
  );
}

/**
 * Writes never touch git's own data or ACE's per-project folder. A write into `.git/config` would
 * let a planted `core.fsmonitor` run on the next, auto-approved, `git_status`.
 */
export function assertWritable(projectDir: string, absolute: string, toolName: string): void {
  const folder = protectedFolderIn(projectDir, absolute);
  if (folder !== undefined) {
    throw new ToolError('denied', toolName, `${toolName} may not write inside ${folder}/.`, {
      reason: 'protected_folder',
    });
  }
}
```

- [ ] **Step 5: Write `ignore-rules.ts`**

Create `packages/tools/src/workspace/ignore-rules.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import ignore, { type Ignore } from 'ignore';

/** Never listed at all: git's own data (VS Code hides it too). Matched case-insensitively. */
export const HIDDEN_NAMES: ReadonlySet<string> = new Set(['.git']);

/**
 * Listed dimmed, and skipped by quick open's list and by the watcher, exactly like a `.gitignore`
 * match (design §5.1's excludes): folders nobody edits by hand and that can hold 100k files.
 */
export const DEFAULT_IGNORED_FOLDERS: ReadonlySet<string> = new Set([
  'node_modules',
  '.ace',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.venv',
]);

export interface IgnoreRules {
  /** `rel` is project-relative, forward slashes, not empty. */
  isIgnored(rel: string, isFolder: boolean): boolean;
  isHidden(rel: string): boolean;
  /** Forget the cached `.gitignore` files (one of them changed). */
  clear(): void;
}

/**
 * `.gitignore` semantics for one project folder: the root file and every nested one, each applied
 * to the paths below its own folder, plus {@link DEFAULT_IGNORED_FOLDERS}. Files are read lazily
 * and cached; a pattern that ignores a folder ignores everything under it, as git does.
 * Approximation: a `!` re-include in a nested file cannot undo a parent folder's exclusion (git
 * cannot either).
 */
export function createIgnoreRules(root: string): IgnoreRules {
  const cache = new Map<string, Ignore | null>();

  function rulesIn(folder: string): Ignore | null {
    const cached = cache.get(folder);
    if (cached !== undefined) return cached;
    let rules: Ignore | null = null;
    try {
      rules = ignore().add(readFileSync(join(root, folder, '.gitignore'), 'utf8'));
    } catch {
      rules = null;
    }
    cache.set(folder, rules);
    return rules;
  }

  return {
    isHidden: (rel) => rel.split('/').some((segment) => HIDDEN_NAMES.has(segment.toLowerCase())),

    isIgnored(rel, isFolder) {
      const segments = rel.split('/');
      for (let i = 0; i < segments.length; i += 1) {
        const folderSegment = i < segments.length - 1 || isFolder;
        if (folderSegment && DEFAULT_IGNORED_FOLDERS.has(segments[i] ?? '')) return true;
      }
      // Each .gitignore from the root down to the entry's parent, tested against every path from
      // that .gitignore's folder down to the entry.
      for (let depth = 0; depth < segments.length; depth += 1) {
        const rules = rulesIn(segments.slice(0, depth).join('/'));
        if (rules === null) continue;
        for (let end = depth + 1; end <= segments.length; end += 1) {
          const sub = segments.slice(depth, end).join('/');
          const subIsFolder = end < segments.length || isFolder;
          if (rules.ignores(subIsFolder ? `${sub}/` : sub)) return true;
        }
      }
      return false;
    },

    clear: () => cache.clear(),
  };
}
```

- [ ] **Step 6: Write `resolve.ts`**

Create `packages/tools/src/workspace/resolve.ts`:

```ts
import { resolve } from 'node:path';

import { WorkspaceFsError } from '@ace/engine';

import { protectedFolderIn } from '../project/paths.js';
import { resolveInsideSandbox } from '../sandbox/paths.js';

export interface ToAbsoluteOptions {
  /** `''`, `.` and `./` name the project folder itself (a listing). */
  allowRoot?: boolean;
  /** Refuse `.git` and `.ace` at any depth (D299). */
  write?: boolean;
}

const ROOT_REFUSED = 'That names the project folder itself, not an entry in it.';

/**
 * A wire path → an absolute path inside the project, or a refusal the person can read
 * (FR-GIT-008). The sandbox's lexical and symlink rules apply, so `..`, absolute and drive paths,
 * UNC roots, `~`, NUL bytes and links out are all refused.
 */
export function toAbsolute(root: string, rel: string, options: ToAbsoluteOptions = {}): string {
  const base = resolve(root);
  // Not trimmed: "notes " is a different name from "notes", and assertValidName refuses it.
  const candidate = rel;
  if (candidate === '' || candidate === '.' || candidate === './' || candidate === '.\\') {
    if (options.allowRoot === true) return base;
    throw new WorkspaceFsError('invalid_path', ROOT_REFUSED);
  }
  const resolution = resolveInsideSandbox(base, candidate);
  if (!resolution.ok) {
    if (resolution.reason === 'sandbox_root') {
      if (options.allowRoot === true) return base;
      throw new WorkspaceFsError('invalid_path', ROOT_REFUSED);
    }
    throw new WorkspaceFsError(
      'outside_project',
      `That path is outside the project folder (${resolution.reason}).`,
      { reason: resolution.reason },
    );
  }
  if (options.write === true) {
    const folder = protectedFolderIn(base, resolution.path);
    if (folder !== undefined) {
      throw new WorkspaceFsError('protected_path', `Forge does not change anything inside ${folder}/.`, {
        folder,
      });
    }
  }
  return resolution.path;
}

const RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
const FORBIDDEN_CHARS = /[<>:"|?*\u0000-\u001f]/;

/**
 * A name every OS ACE runs on can hold. Windows refuses device names (`CON`, `aux.txt`), the
 * characters `<>:"|?*`, and silently drops a trailing dot or space — which would rename the file
 * under the person's feet.
 */
export function assertValidName(name: string): void {
  const reason =
    name === '' || name === '.' || name === '..'
      ? 'it is empty or a dot name'
      : FORBIDDEN_CHARS.test(name)
        ? 'it contains a character file names cannot hold'
        : /[. ]$/.test(name)
          ? 'it ends with a dot or a space'
          : RESERVED_DEVICE.test(name)
            ? 'Windows reserves that name for a device'
            : undefined;
  if (reason !== undefined) {
    throw new WorkspaceFsError('invalid_path', `"${name}" cannot be used as a name: ${reason}.`, {
      path: name,
    });
  }
}
```

- [ ] **Step 7: Write `fs-files.ts`**

Create `packages/tools/src/workspace/fs-files.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs, type Dirent, type Stats } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';

import {
  FILE_EDIT_MAX_BYTES,
  FILE_LIST_LIMIT,
  FILE_RAW_MAX_BYTES,
  type CreateEntryRequest,
  type FileContent,
  type FileEntry,
  type FileList,
  type FolderListing,
  type SaveFileRequest,
  type SaveFileResult,
} from '@ace/contracts';
import { WorkspaceFsError, type RawFile } from '@ace/engine';

import { resolveInsideSandbox } from '../sandbox/paths.js';
import { createIgnoreRules, type IgnoreRules } from './ignore-rules.js';
import { assertValidName, toAbsolute } from './resolve.js';

/*
 * Forge's project files on disk (D299, design §6.1). Every function takes the project's absolute
 * folder and a wire path, and confines the one to the other before touching anything (FR-GIT-008).
 */

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
/** How much of a file is searched for a NUL byte to call it binary — git's own heuristic. */
const SNIFF_BYTES = 8000;
/** Forge's own temporary save files; the watcher never reports them. */
export const SAVE_TEMP_SUFFIX = '.ace-save';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** A content hash: equal bytes, equal version. */
export const versionOf = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex').slice(0, 32);

const relOf = (base: string, absolute: string): string => relative(base, absolute).split(sep).join('/');

const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

async function statOrNull(absolute: string): Promise<Stats | null> {
  try {
    return await fs.stat(absolute);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function lstatOrNull(absolute: string): Promise<Stats | null> {
  try {
    return await fs.lstat(absolute);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

const notFound = (path: string): WorkspaceFsError =>
  new WorkspaceFsError('not_found', `${path === '' ? 'The project folder' : path} was not found.`);

/** The operating system refused: say so, rather than a 500 with no reason (design §10). */
function refusedByOs(error: unknown, path: string): never {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    throw new WorkspaceFsError(
      'protected_path',
      `${path} cannot be changed: the operating system refused access.`,
      { reason: code },
    );
  }
  throw error;
}

function entryOf(base: string, rules: IgnoreRules, absolute: string, stats: Stats): FileEntry {
  const path = relOf(base, absolute);
  const kind = stats.isDirectory() ? 'folder' : 'file';
  return {
    path,
    name: basename(absolute),
    kind,
    size: kind === 'file' ? stats.size : 0,
    mtime: stats.mtime.toISOString(),
    ignored: rules.isIgnored(path, kind === 'folder'),
  };
}

const byFolderThenName = (a: FileEntry, b: FileEntry): number =>
  a.kind !== b.kind ? (a.kind === 'folder' ? -1 : 1) : collator.compare(a.name, b.name);

/** `GET /files/tree`: one folder, one level (FR-GIT-003). */
export async function listFolder(root: string, path: string): Promise<FolderListing> {
  const base = resolve(root);
  const folder = toAbsolute(base, path, { allowRoot: true });
  const stats = await statOrNull(folder);
  if (stats === null) throw notFound(path);
  if (!stats.isDirectory()) throw new WorkspaceFsError('invalid_path', `${path} is a file, not a folder.`);

  const rules = createIgnoreRules(base);
  const items: FileEntry[] = [];
  for (const dirent of await fs.readdir(folder, { withFileTypes: true })) {
    const absolute = join(folder, dirent.name);
    const rel = relOf(base, absolute);
    if (rules.isHidden(rel)) continue;
    // a link that resolves outside the project is not shown at all (FR-GIT-008)
    if (dirent.isSymbolicLink() && !resolveInsideSandbox(base, rel).ok) continue;
    const entryStats = await statOrNull(absolute);
    if (entryStats === null || (!entryStats.isFile() && !entryStats.isDirectory())) continue;
    items.push(entryOf(base, rules, absolute, entryStats));
  }
  items.sort(byFolderThenName);
  return { path: relOf(base, folder), items };
}

const looksBinary = (bytes: Buffer): boolean => bytes.subarray(0, SNIFF_BYTES).includes(0);

/** `GET /files/content`: text with its version, or a description (FR-GIT-004). */
export async function readFile(root: string, path: string): Promise<FileContent> {
  const base = resolve(root);
  const absolute = toAbsolute(base, path);
  const stats = await statOrNull(absolute);
  if (stats === null || !stats.isFile()) throw notFound(path);
  const rel = relOf(base, absolute);
  if (stats.size > FILE_EDIT_MAX_BYTES) return { kind: 'too_large', path: rel, size: stats.size };

  const bytes = await fs.readFile(absolute);
  if (looksBinary(bytes)) return { kind: 'binary', path: rel, size: bytes.length };
  const bom = bytes.subarray(0, 3).equals(BOM);
  const body = bytes.subarray(bom ? 3 : 0);
  const content = body.toString('utf8');
  // Not valid UTF-8: decoding replaced bytes, and a save would write the replacements back.
  if (!Buffer.from(content, 'utf8').equals(body)) return { kind: 'binary', path: rel, size: bytes.length };

  return {
    kind: 'text',
    path: rel,
    content,
    version: versionOf(bytes),
    eol: content.includes('\r\n') ? 'crlf' : 'lf',
    bom,
    size: bytes.length,
  };
}

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

/** `GET /files/raw`: the bytes, for the image preview (§6.2). */
export async function readRaw(root: string, path: string, maxBytes: number = FILE_RAW_MAX_BYTES): Promise<RawFile> {
  const absolute = toAbsolute(resolve(root), path);
  const stats = await statOrNull(absolute);
  if (stats === null || !stats.isFile()) throw notFound(path);
  if (stats.size > maxBytes) {
    throw new WorkspaceFsError('file_too_large', `${path} is too large to preview.`, { maxBytes });
  }
  const bytes = await fs.readFile(absolute);
  return {
    bytes: Uint8Array.from(bytes).buffer,
    contentType: IMAGE_TYPES[extname(absolute).toLowerCase()] ?? 'application/octet-stream',
  };
}

/** Windows refuses a rename over a file another process holds for a moment (an indexer, AV). */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 4 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error;
      await new Promise((settle) => setTimeout(settle, 25 * 2 ** attempt));
    }
  }
}

/** A temp file in the same folder, then a rename: a reader never sees half a file. */
async function atomicWrite(absolute: string, bytes: Uint8Array, mode: number | undefined): Promise<void> {
  const temp = join(
    dirname(absolute),
    `.${basename(absolute)}.${randomBytes(6).toString('hex')}${SAVE_TEMP_SUFFIX}`,
  );
  await fs.writeFile(temp, bytes, { flag: 'wx' });
  try {
    if (mode !== undefined) await fs.chmod(temp, mode);
    await renameWithRetry(temp, absolute);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

/** `PUT /files/content`: an atomic save that never overwrites a change it has not seen. */
export async function writeFile(root: string, request: SaveFileRequest): Promise<SaveFileResult> {
  const base = resolve(root);
  const absolute = toAbsolute(base, request.path, { write: true });
  const text =
    request.eol === 'crlf' ? request.content.replace(/\r?\n/g, '\r\n') : request.content.replace(/\r\n/g, '\n');
  const bytes = Buffer.concat([request.bom ? BOM : Buffer.alloc(0), Buffer.from(text, 'utf8')]);
  if (bytes.length > FILE_EDIT_MAX_BYTES) {
    throw new WorkspaceFsError('file_too_large', `${request.path} is over the 2 MB Forge saves.`, {
      maxBytes: FILE_EDIT_MAX_BYTES,
    });
  }

  const current = await statOrNull(absolute);
  if (current !== null && !current.isFile()) throw new WorkspaceFsError('exists', `${request.path} is a folder.`);
  const currentVersion = current === null ? null : versionOf(await fs.readFile(absolute));
  if (currentVersion !== request.baseVersion) {
    throw new WorkspaceFsError(
      'file_changed',
      currentVersion === null
        ? `${request.path} was deleted after it was opened.`
        : `${request.path} changed on disk after it was opened.`,
      { currentVersion },
    );
  }
  const parent = await statOrNull(dirname(absolute));
  if (parent === null || !parent.isDirectory()) throw notFound(relOf(base, dirname(absolute)));

  try {
    await atomicWrite(absolute, bytes, current?.mode);
  } catch (error) {
    refusedByOs(error, request.path);
  }
  const stats = await fs.stat(absolute);
  return { path: relOf(base, absolute), version: versionOf(bytes), size: bytes.length, mtime: stats.mtime.toISOString() };
}

/** `POST /files/entries`: an empty file or a folder; missing parent folders are created. */
export async function createEntry(root: string, request: CreateEntryRequest): Promise<FileEntry> {
  const base = resolve(root);
  const absolute = toAbsolute(base, request.path, { write: true });
  for (const segment of relOf(base, absolute).split('/')) assertValidName(segment);
  if ((await lstatOrNull(absolute)) !== null) throw new WorkspaceFsError('exists', `${request.path} already exists.`);
  try {
    await fs.mkdir(dirname(absolute), { recursive: true });
    if (request.kind === 'folder') await fs.mkdir(absolute);
    else await fs.writeFile(absolute, '', { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new WorkspaceFsError('exists', `${request.path} already exists.`);
    }
    refusedByOs(error, request.path);
  }
  return entryOf(base, createIgnoreRules(base), absolute, await fs.stat(absolute));
}

/** The same file under two spellings — a case-only rename on a case-insensitive disk. */
async function sameEntry(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([fs.stat(a), fs.stat(b)]);
  return x.ino !== 0 && x.ino === y.ino && x.dev === y.dev;
}

/** `POST /files/move`: rename or move inside the project. */
export async function moveEntry(root: string, from: string, to: string): Promise<FileEntry> {
  const base = resolve(root);
  const source = toAbsolute(base, from, { write: true });
  const target = toAbsolute(base, to, { write: true });
  assertValidName(basename(target));
  const sourceStats = await lstatOrNull(source);
  if (sourceStats === null) throw notFound(from);

  const relSource = relOf(base, source);
  const relTarget = relOf(base, target);
  if (sourceStats.isDirectory() && `${relTarget}/`.startsWith(`${relSource}/`)) {
    throw new WorkspaceFsError('invalid_path', 'A folder cannot be moved into itself.');
  }
  if (relSource !== relTarget) {
    const existing = await lstatOrNull(target);
    if (existing !== null && !(await sameEntry(source, target))) {
      throw new WorkspaceFsError('exists', `${to} already exists.`);
    }
    try {
      await fs.mkdir(dirname(target), { recursive: true });
      await renameWithRetry(source, target);
    } catch (error) {
      refusedByOs(error, from);
    }
  }
  return entryOf(base, createIgnoreRules(base), target, await fs.stat(target));
}

/**
 * `DELETE /files/entries`: a file, or a folder with everything in it. Permanent in Phase 1 — the
 * UI says so before asking; Phase 3 captures a `user_delete` checkpoint first (D300).
 */
export async function removeEntry(root: string, path: string): Promise<void> {
  const absolute = toAbsolute(resolve(root), path, { write: true });
  if ((await lstatOrNull(absolute)) === null) throw notFound(path);
  try {
    await fs.rm(absolute, { recursive: true, force: false, maxRetries: 3 });
  } catch (error) {
    refusedByOs(error, path);
  }
}

/**
 * `GET /files/list`: every file that is not hidden or ignored, breadth first so shallow files come
 * first, never following links, stopping at `limit` (quick open).
 */
export async function listAllFiles(root: string, limit: number = FILE_LIST_LIMIT): Promise<FileList> {
  const base = resolve(root);
  const rules = createIgnoreRules(base);
  const files: string[] = [];
  const queue: string[] = [''];
  for (let next = 0; next < queue.length; next += 1) {
    const folder = queue[next] ?? '';
    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(join(base, folder), { withFileTypes: true });
    } catch {
      continue;
    }
    dirents.sort((a, b) => collator.compare(a.name, b.name));
    for (const dirent of dirents) {
      const rel = folder === '' ? dirent.name : `${folder}/${dirent.name}`;
      if (rules.isHidden(rel)) continue;
      if (dirent.isDirectory()) {
        if (!rules.isIgnored(rel, true)) queue.push(rel);
        continue;
      }
      if (!dirent.isFile() || rules.isIgnored(rel, false)) continue;
      files.push(rel);
      if (files.length >= limit) return { files, truncated: true };
    }
  }
  return { files, truncated: false };
}
```

- [ ] **Step 8: Run the tests**

Run: `pnpm --filter @ace/tools exec vitest run src/project/paths.test.ts src/workspace`
Expected: PASS.

The first listing test asserts natural order. If it fails only because ICU sorts `.gitignore` differently against the letters, print the actual order. Keep the code, and change the expectation only if folders still come first and `a2.txt` still precedes `a10.txt`.

- [ ] **Step 9: Run the whole tools suite**

Run: `pnpm --filter @ace/tools test`
Expected: PASS.

The `assertWritable` change must not break the `write_file`/`edit_file` tests. If an existing test wrote into a nested `.git` on purpose, it now gets a refusal. Update its expectation and say so in the commit body.

- [ ] **Step 10: Commit**

```bash
npx prettier --write --config packages/config/prettier.config.js packages/tools/src/workspace packages/tools/src/project/paths.ts packages/tools/src/project/paths.test.ts
git add packages/tools pnpm-lock.yaml
git commit -m "feat(tools): project files on disk — confined, ignore-aware, atomic, conflict-checked [D299] [FR-GIT-003] [FR-GIT-004] [FR-GIT-008]

assertWritable now refuses .git and .ace at any depth, not only at the top.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Tools — repository status, the watcher, and the assembled adapter

**Files:**
- Modify: `packages/tools/src/builtins/git.ts` (export `runGit` and `GitResult`), `packages/tools/src/index.ts`
- Create: `packages/tools/src/workspace/repo-status.ts`, `packages/tools/src/workspace/watcher.ts`, `packages/tools/src/workspace/project-files.ts`
- Test: create `packages/tools/src/workspace/repo-status.test.ts`, `watcher.test.ts`, `project-files.test.ts`

**Interfaces:**
- Consumes:
  - from Task 3: `createIgnoreRules`, `SAVE_TEMP_SUFFIX` and the `fs-files.ts` functions;
  - from Task 2: `ProjectFiles` and `FileChangeBatch`;
  - existing: `runGit(args, cwd, tool, signal)`.
- Produces:
  - `parsePorcelainZ(stdout, prefix, truncated): RepoStatus`;
  - `readRepoStatus(root, signal?): Promise<RepoStatus>`;
  - `watchProject(root, onChange, onError, { debounceMs?, maxChanges? }): () => void`;
  - `createFsProjectFiles(): ProjectFiles`, which the server wires in Task 7.

- [ ] **Step 1: Write the failing tests**

Create `packages/tools/src/workspace/repo-status.test.ts`:

```ts
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parsePorcelainZ, readRepoStatus } from './repo-status.js';

const hasGit = spawnSync('git', ['--version']).status === 0;

describe('D299 reading git status for the Explorer', () => {
  it('reads the branch and modified, added, deleted, renamed and untracked entries', () => {
    const stdout = [
      '## main...origin/main [ahead 1]',
      ' M src/a.ts',
      'A  src/new.ts',
      ' D gone.ts',
      'R  to.ts',
      'from.ts',
      'MM both.ts',
      'UU conflict.ts',
      '?? scratch/',
      '?? notes.md',
      '',
    ].join('\0');

    expect(parsePorcelainZ(stdout, '', false)).toEqual({
      repo: true,
      branch: 'main',
      truncated: false,
      files: [
        { path: 'src/a.ts', status: 'modified' },
        { path: 'src/new.ts', status: 'added' },
        { path: 'gone.ts', status: 'deleted' },
        { path: 'to.ts', status: 'renamed' },
        { path: 'both.ts', status: 'modified' },
        { path: 'conflict.ts', status: 'modified' },
        { path: 'scratch', status: 'untracked' },
        { path: 'notes.md', status: 'untracked' },
      ],
    });
  });

  it('keeps only the entries under the project when it is a subfolder of the repository', () => {
    const stdout = ['## main', ' M apps/web/src/a.ts', ' M other/b.ts', ''].join('\0');
    expect(parsePorcelainZ(stdout, 'apps/web/', true)).toEqual({
      repo: true,
      branch: 'main',
      truncated: true,
      files: [{ path: 'src/a.ts', status: 'modified' }],
    });
  });

  it('reads a branch with no commits yet, and a detached HEAD', () => {
    expect(parsePorcelainZ('## No commits yet on main\0', '', false)).toMatchObject({ branch: 'main' });
    expect(parsePorcelainZ('## HEAD (no branch)\0', '', false)).toMatchObject({ branch: null });
  });
});

describe.skipIf(!hasGit)('D299 status of a real folder', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ace-status-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));

  const git = (...args: string[]) =>
    spawnSync(
      'git',
      ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
      { cwd: root },
    );

  it('answers repo: false for a folder that is not a repository', async () => {
    expect(await readRepoStatus(root)).toEqual({ repo: false });
  });

  it('reports a modified file and an untracked folder', async () => {
    git('init', '-q', '-b', 'main');
    writeFileSync(join(root, 'a.txt'), '1');
    git('add', '.');
    git('commit', '-qm', 'one');
    writeFileSync(join(root, 'a.txt'), '2');
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'new.md'), 'x');

    const status = await readRepoStatus(root);

    expect(status).toMatchObject({ repo: true, branch: 'main', truncated: false });
    expect(status.repo ? status.files : []).toEqual([
      { path: 'a.txt', status: 'modified' },
      { path: 'docs', status: 'untracked' },
    ]);
  });
});
```

Create `packages/tools/src/workspace/watcher.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FileChangeBatch } from '@ace/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { watchProject } from './watcher.js';

let root: string;
let stop: () => void = () => undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ace-watch-'));
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, 'node_modules'));
  mkdirSync(join(root, 'sub'));
});
afterEach(() => {
  stop();
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

function collect(options: { maxChanges?: number } = {}) {
  const batches: FileChangeBatch[] = [];
  const errors: Error[] = [];
  stop = watchProject(root, (batch) => batches.push(batch), (error) => errors.push(error), {
    debounceMs: 50,
    ...options,
  });
  return { batches, errors, changes: () => batches.flatMap((batch) => batch.changes) };
}

describe('D299 the project watcher', () => {
  it('reports a created, a changed and a deleted file', async () => {
    const seen = collect();
    await settle();

    writeFileSync(join(root, 'a.txt'), '1');
    await vi.waitFor(() => expect(seen.changes()).toContainEqual({ path: 'a.txt', kind: 'created' }), {
      timeout: 4000,
    });
    await settle();
    writeFileSync(join(root, 'a.txt'), '22');
    await vi.waitFor(
      () =>
        expect(seen.changes().some((c) => c.path === 'a.txt' && c.kind === 'changed')).toBe(true),
      { timeout: 4000 },
    );
    rmSync(join(root, 'a.txt'));
    await vi.waitFor(() => expect(seen.changes()).toContainEqual({ path: 'a.txt', kind: 'deleted' }), {
      timeout: 4000,
    });
    expect(seen.errors).toEqual([]);
  });

  it('uses forward slashes for nested paths', async () => {
    const seen = collect();
    await settle();
    writeFileSync(join(root, 'sub', 'b.txt'), 'x');
    await vi.waitFor(() => expect(seen.changes().map((c) => c.path)).toContain('sub/b.txt'), {
      timeout: 4000,
    });
  });

  it('says nothing about .git, ignored folders or its own temporary save files', async () => {
    const seen = collect();
    await settle();
    writeFileSync(join(root, '.git', 'index'), 'x');
    writeFileSync(join(root, 'node_modules', 'y.js'), 'x');
    writeFileSync(join(root, '.a.txt.0123456789ab.ace-save'), 'x');
    writeFileSync(join(root, 'marker.txt'), 'x');

    await vi.waitFor(() => expect(seen.changes().map((c) => c.path)).toContain('marker.txt'), {
      timeout: 4000,
    });
    const leaked = seen
      .changes()
      .map((c) => c.path)
      .filter((p) => p.startsWith('.git') || p.startsWith('node_modules/') || p.endsWith('.ace-save'));
    expect(leaked).toEqual([]);
  });

  it('a burst over the limit arrives as one resync', async () => {
    const seen = collect({ maxChanges: 3 });
    await settle();
    for (let i = 0; i < 8; i += 1) writeFileSync(join(root, `f${i}.txt`), 'x');
    await vi.waitFor(() => expect(seen.batches).toContainEqual({ changes: [], resync: true }), {
      timeout: 4000,
    });
  });

  it('stops reporting once stopped', async () => {
    const seen = collect();
    await settle();
    stop();
    writeFileSync(join(root, 'late.txt'), 'x');
    await settle(400);
    expect(seen.batches).toEqual([]);
  });
});
```

Create `packages/tools/src/workspace/project-files.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createFsProjectFiles } from './project-files.js';

describe('D299 the ProjectFiles adapter on disk', () => {
  it('answers every port method over one folder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ace-adapter-'));
    try {
      writeFileSync(join(root, 'a.txt'), 'hello');
      const files = createFsProjectFiles();

      expect((await files.listFolder(root, '')).items.map((e) => e.name)).toEqual(['a.txt']);
      expect((await files.read(root, 'a.txt')).kind).toBe('text');
      expect((await files.listAll(root)).files).toEqual(['a.txt']);
      expect((await files.status(root)).repo).toBe(false);
      const stop = files.watch(root, () => undefined, () => undefined);
      expect(typeof stop).toBe('function');
      stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run them to watch them fail**

Run: `pnpm --filter @ace/tools exec vitest run src/workspace/repo-status.test.ts src/workspace/watcher.test.ts src/workspace/project-files.test.ts`
Expected: FAIL, because the modules do not exist.

- [ ] **Step 3: Export `runGit`**

In `packages/tools/src/builtins/git.ts`, change `interface GitResult` to `export interface GitResult` and `function runGit(` to `export function runGit(`. Put this comment above `runGit`:

```ts
/**
 * git with ACE's hygiene (X1): argument arrays only, no pager, no prompt, no optional locks,
 * literal pathspecs, `core.fsmonitor` off, a timeout and capped output. Also used, read-only, by
 * Forge's Explorer decorations (D299).
 */
```

- [ ] **Step 4: Write `repo-status.ts`**

Create `packages/tools/src/workspace/repo-status.ts`:

```ts
import type { RepoFileStatus, RepoStatus } from '@ace/contracts';

import { runGit } from '../builtins/git.js';

/** Which decoration an `XY` pair gets; `undefined` for an ignored entry or anything unknown. */
function statusOf(x: string, y: string): RepoFileStatus | undefined {
  if (x === '?' && y === '?') return 'untracked';
  if (x === '!') return undefined;
  if (x === 'R' || x === 'C') return 'renamed';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'A') return 'added';
  if ('MUT'.includes(x) || 'MUT'.includes(y)) return 'modified';
  return undefined;
}

function branchOf(header: string): string | null {
  if (header.startsWith('No commits yet on ')) return header.slice('No commits yet on '.length);
  if (header.startsWith('HEAD (no branch)')) return null;
  return header.split('...')[0]?.split(' ')[0] ?? null;
}

/**
 * `git status --porcelain=v1 -z -b` → the Explorer's decorations. Porcelain paths are relative
 * to the repository root, so `prefix` (`git rev-parse --show-prefix`, e.g. `apps/web/`) is
 * stripped and anything outside the project folder dropped. With `-z`, a rename's original path
 * is the next field.
 */
export function parsePorcelainZ(stdout: string, prefix: string, truncated: boolean): RepoStatus {
  const fields = stdout.split('\0');
  let branch: string | null = null;
  const files: { path: string; status: RepoFileStatus }[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i] ?? '';
    if (field === '') continue;
    if (field.startsWith('## ')) {
      branch = branchOf(field.slice(3));
      continue;
    }
    const x = field[0] ?? ' ';
    const y = field[1] ?? ' ';
    if (x === 'R' || x === 'C') i += 1;
    const status = statusOf(x, y);
    const path = field.slice(3);
    if (status === undefined || !path.startsWith(prefix)) continue;
    const rel = path.slice(prefix.length).replace(/\/$/, '');
    if (rel !== '') files.push({ path: rel, status });
  }
  return { repo: true, branch, files, truncated };
}

/**
 * The project repository's status, read-only (design §6.4). Never throws for "git is not
 * installed" or "not a repository": both are `{ repo: false }`, and the Explorer simply shows no
 * decorations (design §10).
 */
export async function readRepoStatus(root: string, signal?: AbortSignal): Promise<RepoStatus> {
  try {
    const prefix = await runGit(['rev-parse', '--show-prefix'], root, 'files_status', signal);
    if (prefix.code !== 0) return { repo: false };
    const status = await runGit(['status', '--porcelain=v1', '-z', '-b', '--', '.'], root, 'files_status', signal);
    if (status.code !== 0) return { repo: false };
    return parsePorcelainZ(status.stdout, prefix.stdout.trim(), status.truncated);
  } catch {
    return { repo: false };
  }
}
```

- [ ] **Step 5: Write `watcher.ts`**

Create `packages/tools/src/workspace/watcher.ts`:

```ts
import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { FILES_CHANGED_MAX, type FileChange } from '@ace/contracts';
import type { FileChangeBatch } from '@ace/engine';

import { SAVE_TEMP_SUFFIX } from './fs-files.js';
import { createIgnoreRules } from './ignore-rules.js';

export interface WatchOptions {
  /** How long a burst collects before it is sent (design §6.1: 100 ms). */
  debounceMs?: number;
  /** More than this many paths in one burst is sent as `resync` instead. */
  maxChanges?: number;
}

/**
 * Watches a project folder recursively with Node's `fs.watch` (native recursion on Windows and
 * macOS; Node walks the tree on Linux) and reports bursts of project-relative paths. `.git`,
 * ignored folders and Forge's own temp save files are never reported. Contents are never read:
 * created, changed or deleted is decided by one `stat` when the burst is sent.
 */
export function watchProject(
  root: string,
  onChange: (batch: FileChangeBatch) => void,
  onError: (error: Error) => void,
  options: WatchOptions = {},
): () => void {
  const debounceMs = options.debounceMs ?? 100;
  const maxChanges = options.maxChanges ?? FILES_CHANGED_MAX;
  const rules = createIgnoreRules(root);
  const pending = new Map<string, 'rename' | 'change'>();
  let lostTrack = false;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let watcher: FSWatcher | undefined;

  const stop = (): void => {
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    watcher?.close();
  };

  async function flush(): Promise<void> {
    timer = undefined;
    const entries = [...pending.entries()];
    pending.clear();
    const resync = lostTrack || entries.length > maxChanges;
    lostTrack = false;
    if (closed || (entries.length === 0 && !resync)) return;
    if (resync) {
      onChange({ changes: [], resync: true });
      return;
    }
    const changes: FileChange[] = await Promise.all(
      entries.map(async ([path, eventType]) => {
        const exists = await stat(join(root, path)).then(
          () => true,
          () => false,
        );
        const kind: FileChange['kind'] = !exists ? 'deleted' : eventType === 'rename' ? 'created' : 'changed';
        return { path, kind };
      }),
    );
    if (!closed) onChange({ changes, resync: false });
  }

  const schedule = (): void => {
    if (timer === undefined) timer = setTimeout(() => void flush(), debounceMs);
  };

  try {
    watcher = watch(root, { recursive: true, persistent: false }, (eventType, filename) => {
      if (closed) return;
      if (filename === null) {
        // the OS dropped the name: ask the client to refetch rather than guess
        lostTrack = true;
        schedule();
        return;
      }
      const rel = filename.split('\\').join('/');
      if (rel === '' || rules.isHidden(rel) || rel.endsWith(SAVE_TEMP_SUFFIX) || rules.isIgnored(rel, false)) return;
      if (rel === '.gitignore' || rel.endsWith('/.gitignore')) rules.clear();
      pending.set(rel, pending.get(rel) === 'rename' ? 'rename' : eventType);
      schedule();
    });
  } catch (error) {
    closed = true;
    queueMicrotask(() => onError(error instanceof Error ? error : new Error(String(error))));
    return () => undefined;
  }

  watcher.on('error', (error) => {
    stop();
    onError(error);
  });
  return stop;
}
```

- [ ] **Step 6: Assemble the adapter**

Create `packages/tools/src/workspace/project-files.ts`:

```ts
import type { ProjectFiles } from '@ace/engine';

import { createEntry, listAllFiles, listFolder, moveEntry, readFile, readRaw, removeEntry, writeFile } from './fs-files.js';
import { readRepoStatus } from './repo-status.js';
import { watchProject } from './watcher.js';

/** Forge's `ProjectFiles` port on the real file system (D299); `apps/server` wires it. */
export function createFsProjectFiles(): ProjectFiles {
  return {
    listFolder,
    read: readFile,
    readRaw: (root, path) => readRaw(root, path),
    write: writeFile,
    create: createEntry,
    move: moveEntry,
    remove: removeEntry,
    listAll: (root) => listAllFiles(root),
    status: (root) => readRepoStatus(root),
    watch: (root, onChange, onError) => watchProject(root, onChange, onError),
  };
}
```

In `packages/tools/src/index.ts`, after `export * from './project/paths.js';`:

```ts
export * from './workspace/project-files.js';
```

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @ace/tools exec vitest run src/workspace`
Expected: PASS.

The watcher tests depend on the OS. If "reports a created, a changed and a deleted file" fails because this OS reports the first write without a `rename` event, do not loosen the test. Log the raw `(eventType, filename)` pairs once to see the order, then fix the classification in `flush`.

- [ ] **Step 8: Run the full tools suite, build, and commit**

Run: `pnpm --filter @ace/tools test && pnpm --filter @ace/tools build`
Expected: PASS, and the build succeeds.

```bash
npx prettier --write --config packages/config/prettier.config.js packages/tools/src/workspace packages/tools/src/builtins/git.ts
git add packages/tools
git commit -m "feat(tools): read-only repository status, the debounced project watcher, the ProjectFiles adapter [D299] [FR-GIT-003]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Engine — `WorkspaceService` and the file routes

**Files:**
- Create: `packages/engine/src/workspace/service.ts`, `packages/engine/src/workspace/routes.ts`, `packages/engine/src/workspace/__tests__/fake-files.ts`
- Modify: `packages/engine/src/gateway/index.ts` (`EngineDeps.workspace`, the mount, `PUT` in CORS), `packages/engine/src/index.ts`
- Test: create `packages/engine/src/workspace/__tests__/routes.test.ts`, `packages/engine/src/workspace/__tests__/service.test.ts`; extend `packages/engine/src/__tests__/gateway.test.ts` (CORS)

**Interfaces:**
- Consumes:
  - from Task 2: `ProjectFiles`, `RawFile`, `FileChangeBatch` and `WorkspaceFsError`;
  - existing: `Repository.projects.get(scope, id)`, `EventBus.emitTransient(event)`, `notFound`, `invalidPath`, `notImplemented`, `readJson`, `routeApp`/`send`/`errorCode` (test helpers) and `FakeRepository`.
- Produces:
  - `WorkspaceService`, which has:
    - `listFolder`, `read`, `readRaw`, `save`, `create`, `move`, `remove`, `listAll`, `status`, each taking `projectId` first;
    - `setWatched(projectId, watched): Promise<void>`;
    - `stopAll(): void`.
  - `createWorkspaceService({ repository, scope, files, bus, logger, restartDelayMs? })`.
  - `createWorkspaceRoutes(service | undefined)`.
  - `EngineDeps.workspace?: WorkspaceService`.
  - The routes:
    - `GET /api/v1/projects/:id/files/tree?path=`
    - `GET …/files/content?path=`
    - `GET …/files/raw?path=`
    - `PUT …/files/content`
    - `POST …/files/entries`
    - `POST …/files/move`
    - `DELETE …/files/entries?path=`
    - `GET …/files/list`
    - `GET …/files/status`

- [ ] **Step 1: Write the test helper**

Create `packages/engine/src/workspace/__tests__/fake-files.ts`:

```ts
import type { FileContent, FileEntry, FolderListing, RepoStatus, SaveFileResult } from '@ace/contracts';

import type { ProjectFiles } from '../../ports/index.js';

export const AT = '2026-10-09T10:00:00.000Z';
export const TEXT: FileContent = {
  kind: 'text',
  path: 'a.ts',
  content: 'x',
  version: 'v1',
  eol: 'lf',
  bom: false,
  size: 1,
};
export const ENTRY: FileEntry = { path: 'n.ts', name: 'n.ts', kind: 'file', size: 0, mtime: AT, ignored: false };
export const LISTING: FolderListing = { path: '', items: [ENTRY] };
export const SAVED: SaveFileResult = { path: 'a.ts', version: 'v2', size: 1, mtime: AT };
export const STATUS: RepoStatus = { repo: false };

export type Call = [method: string, ...args: unknown[]];

/** An in-memory `ProjectFiles` that records every call and answers fixed values. */
export function fakeFiles(overrides: Partial<ProjectFiles> = {}): ProjectFiles & { calls: Call[] } {
  const calls: Call[] = [];
  const files: ProjectFiles = {
    listFolder: async (...args) => {
      calls.push(['listFolder', ...args]);
      return LISTING;
    },
    read: async (...args) => {
      calls.push(['read', ...args]);
      return TEXT;
    },
    readRaw: async (...args) => {
      calls.push(['readRaw', ...args]);
      return { bytes: new Uint8Array([1, 2, 3]).buffer, contentType: 'image/png' };
    },
    write: async (...args) => {
      calls.push(['write', ...args]);
      return SAVED;
    },
    create: async (...args) => {
      calls.push(['create', ...args]);
      return ENTRY;
    },
    move: async (...args) => {
      calls.push(['move', ...args]);
      return { ...ENTRY, path: 'b/n.ts' };
    },
    remove: async (...args) => {
      calls.push(['remove', ...args]);
    },
    listAll: async (...args) => {
      calls.push(['listAll', ...args]);
      return { files: ['a.ts'], truncated: false };
    },
    status: async (...args) => {
      calls.push(['status', ...args]);
      return STATUS;
    },
    watch: () => () => undefined,
    ...overrides,
  };
  return Object.assign(files, { calls });
}
```

- [ ] **Step 2: Write the failing route tests**

Create `packages/engine/src/workspace/__tests__/routes.test.ts`:

```ts
import type { Project } from '@ace/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { InProcessPubSubStub } from '../../__tests__/pubsub-stub.js';
import { errorCode, routeApp, send } from '../../__tests__/route-app.js';
import { createEventBus } from '../../events/index.js';
import { newId } from '../../ids.js';
import { createLogger } from '../../logging/index.js';
import { LOCAL_SCOPE, WorkspaceFsError, type EngineEvent, type ProjectFiles } from '../../ports/index.js';
import { createWorkspaceRoutes } from '../routes.js';
import { createWorkspaceService } from '../service.js';
import { AT, LISTING, SAVED, STATUS, TEXT, fakeFiles } from './fake-files.js';

const FOLDER = 'D:/projects/demo';
const logger = createLogger({ level: 'silent', destination: { write: () => undefined } });

let repository: FakeRepository;
let project: Project;
let files: ReturnType<typeof fakeFiles>;
let app: ReturnType<typeof routeApp>;

function appOver(projectFiles: ProjectFiles): ReturnType<typeof routeApp> {
  const bus = createEventBus({ repository, scope: LOCAL_SCOPE, pubsub: new InProcessPubSubStub<EngineEvent>() });
  return routeApp(
    createWorkspaceRoutes(
      createWorkspaceService({ repository, scope: LOCAL_SCOPE, files: projectFiles, bus, logger }),
    ),
  );
}

beforeEach(async () => {
  repository = new FakeRepository();
  project = { id: newId(), name: 'Demo', folderPath: FOLDER, createdAt: AT, updatedAt: AT };
  await repository.projects.create(LOCAL_SCOPE, project);
  files = fakeFiles();
  app = appOver(files);
});

const base = () => `/projects/${project.id}/files`;
const body = { path: 'a.ts', content: 'y', baseVersion: 'v1', eol: 'lf', bom: false };

describe('D299 FR-GIT-003 the project file routes', () => {
  it('answers 501 when the engine has no workspace service (D121)', async () => {
    const response = await send(routeApp(createWorkspaceRoutes(undefined)), 'GET', `${base()}/tree`);
    expect(response.status).toBe(501);
    expect(await errorCode(response)).toBe('not_implemented');
  });

  it('answers 404 for a project that does not exist', async () => {
    const response = await send(app, 'GET', `/projects/${newId()}/files/tree`);
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe('not_found');
  });

  it('lists the root by default and a folder by path, inside the project folder', async () => {
    expect(await (await send(app, 'GET', `${base()}/tree`)).json()).toEqual(LISTING);
    await send(app, 'GET', `${base()}/tree?path=${encodeURIComponent('src/My Dir')}`);
    expect(files.calls).toEqual([
      ['listFolder', FOLDER, ''],
      ['listFolder', FOLDER, 'src/My Dir'],
    ]);
  });

  it('reads a file, and requires its path', async () => {
    expect(await (await send(app, 'GET', `${base()}/content?path=a.ts`)).json()).toEqual(TEXT);
    const missing = await send(app, 'GET', `${base()}/content`);
    expect(missing.status).toBe(400);
    expect(await errorCode(missing)).toBe('validation_failed');
  });

  it('saves with PUT and validates the body (FR-GIT-004)', async () => {
    const response = await send(app, 'PUT', `${base()}/content`, body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SAVED);
    expect(files.calls).toContainEqual(['write', FOLDER, body]);
    expect((await send(app, 'PUT', `${base()}/content`, { path: 'a.ts' })).status).toBe(400);
  });

  it('keeps the adapter’s refusal: a stale save is 409 with the disk’s version', async () => {
    app = appOver(
      fakeFiles({
        write: async () => {
          throw new WorkspaceFsError('file_changed', 'a.ts changed on disk.', { currentVersion: 'v9' });
        },
      }),
    );
    const response = await send(app, 'PUT', `${base()}/content`, body);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'file_changed', details: { currentVersion: 'v9' } },
    });
  });

  it('creates (201), moves (200) and deletes (204)', async () => {
    expect((await send(app, 'POST', `${base()}/entries`, { path: 'n.ts', kind: 'file' })).status).toBe(201);
    const moved = await send(app, 'POST', `${base()}/move`, { from: 'n.ts', to: 'b/n.ts' });
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as { path: string }).path).toBe('b/n.ts');
    expect((await send(app, 'DELETE', `${base()}/entries?path=b%2Fn.ts`)).status).toBe(204);
    expect(files.calls).toEqual([
      ['create', FOLDER, { path: 'n.ts', kind: 'file' }],
      ['move', FOLDER, 'n.ts', 'b/n.ts'],
      ['remove', FOLDER, 'b/n.ts'],
    ]);
  });

  it('serves raw bytes with their type — never sniffed, never cached, sandboxed', async () => {
    const response = await send(app, 'GET', `${base()}/raw?path=a.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it('lists every file and reads the repository status', async () => {
    expect(await (await send(app, 'GET', `${base()}/list`)).json()).toEqual({ files: ['a.ts'], truncated: false });
    expect(await (await send(app, 'GET', `${base()}/status`)).json()).toEqual(STATUS);
  });

  it('refuses a project with no folder as invalid_path', async () => {
    const bare = { ...project, id: newId(), folderPath: '' };
    await repository.projects.create(LOCAL_SCOPE, bare);
    const response = await send(app, 'GET', `/projects/${bare.id}/files/tree`);
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('invalid_path');
  });
});
```

- [ ] **Step 3: Write the failing service tests**

Create `packages/engine/src/workspace/__tests__/service.test.ts`:

```ts
import type { Project } from '@ace/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { InProcessPubSubStub } from '../../__tests__/pubsub-stub.js';
import { createEventBus } from '../../events/index.js';
import { newId } from '../../ids.js';
import { createLogger } from '../../logging/index.js';
import { LOCAL_SCOPE, type EngineEvent, type FileChangeBatch, type ProjectFiles } from '../../ports/index.js';
import { createWorkspaceService, type WorkspaceService } from '../service.js';
import { AT, fakeFiles } from './fake-files.js';

const FOLDER = 'D:/projects/demo';
const logger = createLogger({ level: 'silent', destination: { write: () => undefined } });

let repository: FakeRepository;
let project: Project;
let events: EngineEvent[];

beforeEach(async () => {
  repository = new FakeRepository();
  project = { id: newId(), name: 'Demo', folderPath: FOLDER, createdAt: AT, updatedAt: AT };
  await repository.projects.create(LOCAL_SCOPE, project);
  events = [];
});

async function serviceOver(files: ProjectFiles, restartDelayMs = 5): Promise<WorkspaceService> {
  const bus = createEventBus({ repository, scope: LOCAL_SCOPE, pubsub: new InProcessPubSubStub<EngineEvent>() });
  await bus.subscribe((event) => events.push(event));
  return createWorkspaceService({ repository, scope: LOCAL_SCOPE, files, bus, logger, restartDelayMs });
}

const changedFrames = () => events.filter((event) => event.type === 'files.changed');

describe('D299 a project folder is watched while someone looks at it', () => {
  it('starts one watcher, announces each burst as a transient files.changed, and stops', async () => {
    let started = 0;
    let stopped = 0;
    let report: ((batch: FileChangeBatch) => void) | undefined;
    const service = await serviceOver(
      fakeFiles({
        watch: (root, onChange) => {
          started += 1;
          expect(root).toBe(FOLDER);
          report = onChange;
          return () => {
            stopped += 1;
          };
        },
      }),
    );

    await service.setWatched(project.id, true);
    await service.setWatched(project.id, true);
    expect(started).toBe(1);

    report?.({ changes: [{ path: 'a.ts', kind: 'changed' }], resync: false });
    await vi.waitFor(() =>
      expect(changedFrames()).toEqual([
        expect.objectContaining({
          type: 'files.changed',
          transient: true,
          payload: { projectId: project.id, changes: [{ path: 'a.ts', kind: 'changed' }], resync: false },
        }),
      ]),
    );

    await service.setWatched(project.id, false);
    expect(stopped).toBe(1);
  });

  it('does nothing, and does not throw, for a project that does not exist', async () => {
    let started = 0;
    const service = await serviceOver(
      fakeFiles({
        watch: () => {
          started += 1;
          return () => undefined;
        },
      }),
    );
    await expect(service.setWatched(newId(), true)).resolves.toBeUndefined();
    expect(started).toBe(0);
  });

  it('a watcher that dies announces a resync and starts again while someone still watches', async () => {
    let starts = 0;
    let fail: ((error: Error) => void) | undefined;
    const service = await serviceOver(
      fakeFiles({
        watch: (_root, _onChange, onError) => {
          starts += 1;
          fail = onError;
          return () => undefined;
        },
      }),
    );

    await service.setWatched(project.id, true);
    fail?.(new Error('EPERM: the folder was removed'));

    await vi.waitFor(() =>
      expect(changedFrames().map((event) => event.payload)).toContainEqual({
        projectId: project.id,
        changes: [],
        resync: true,
      }),
    );
    await vi.waitFor(() => expect(starts).toBe(2));
  });

  it('stopAll stops every watcher and cancels a pending restart', async () => {
    let stopped = 0;
    let starts = 0;
    let fail: ((error: Error) => void) | undefined;
    const service = await serviceOver(
      fakeFiles({
        watch: (_root, _onChange, onError) => {
          starts += 1;
          fail = onError;
          return () => {
            stopped += 1;
          };
        },
      }),
      50,
    );
    await service.setWatched(project.id, true);
    fail?.(new Error('gone'));
    service.stopAll();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(starts).toBe(1);

    await service.setWatched(project.id, true);
    service.stopAll();
    expect(stopped).toBe(1);
  });
});
```

Extend `packages/engine/src/__tests__/gateway.test.ts`. Find its existing CORS preflight test, if there is one, and add `PUT`; otherwise add:

```ts
  it('D299 allows PUT in a CORS preflight from an allowed origin', async () => {
    const response = await app.request('/api/v1/projects/x/files/content', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://127.0.0.1:4747',
        'Access-Control-Request-Method': 'PUT',
      },
    });
    expect(response.headers.get('access-control-allow-methods')).toContain('PUT');
  });
```

(Use the `app` the file already builds with `selfOrigins: ['http://127.0.0.1:4747']`.)

- [ ] **Step 4: Run them to watch them fail**

Run: `pnpm --filter @ace/engine exec vitest run src/workspace src/__tests__/gateway.test.ts`
Expected: FAIL. `../service.js` and `../routes.js` do not exist, and the preflight lacks `PUT`.

- [ ] **Step 5: Write the service**

Create `packages/engine/src/workspace/service.ts`:

```ts
import type {
  CreateEntryRequest,
  FileContent,
  FileEntry,
  FileList,
  FolderListing,
  Id,
  RepoStatus,
  SaveFileRequest,
  SaveFileResult,
} from '@ace/contracts';

import type { EventBus } from '../events/index.js';
import { invalidPath, notFound } from '../gateway/errors.js';
import type { Logger } from '../logging/index.js';
import type { FileChangeBatch, ProjectFiles, RawFile, Repository, Scope } from '../ports/index.js';

/**
 * Forge's project files (D299, design §6.1): every call names a project, and the service hands the
 * adapter that project's folder. It also runs the watcher for a project while a WebSocket client is
 * subscribed to its `project` scope, turning each burst into a transient `files.changed` — never
 * persisted, paths only (design §7).
 */
export interface WorkspaceService {
  listFolder(projectId: Id, path: string): Promise<FolderListing>;
  read(projectId: Id, path: string): Promise<FileContent>;
  readRaw(projectId: Id, path: string): Promise<RawFile>;
  save(projectId: Id, request: SaveFileRequest): Promise<SaveFileResult>;
  create(projectId: Id, request: CreateEntryRequest): Promise<FileEntry>;
  move(projectId: Id, from: string, to: string): Promise<FileEntry>;
  remove(projectId: Id, path: string): Promise<void>;
  listAll(projectId: Id): Promise<FileList>;
  status(projectId: Id): Promise<RepoStatus>;
  /** The WS hub says a project gained its first subscriber (`true`) or lost its last (`false`). */
  setWatched(projectId: Id, watched: boolean): Promise<void>;
  /** Shutdown: every watcher stops and no restart is pending. */
  stopAll(): void;
}

export interface WorkspaceServiceDeps {
  repository: Repository;
  scope: Scope;
  files: ProjectFiles;
  bus: EventBus;
  logger: Logger;
  /** How long a watcher that died waits before it starts again while someone still watches. */
  restartDelayMs?: number;
}

export function createWorkspaceService(deps: WorkspaceServiceDeps): WorkspaceService {
  const { repository, scope, files, bus, logger } = deps;
  const restartDelayMs = deps.restartDelayMs ?? 2000;
  const watchers = new Map<Id, () => void>();
  /** Who should be watched; a subscribe and unsubscribe racing the folder lookup settle on the last word. */
  const wanted = new Set<Id>();
  const restarts = new Set<ReturnType<typeof setTimeout>>();

  async function folderOf(projectId: Id): Promise<string> {
    const project = await repository.projects.get(scope, projectId);
    if (project === null) throw notFound(`Project ${projectId}`);
    if (project.folderPath === '') throw invalidPath('(none)', 'this project has no folder.');
    return project.folderPath;
  }

  const announce = (projectId: Id, batch: FileChangeBatch): void => {
    void bus.emitTransient({ type: 'files.changed', payload: { projectId, ...batch } });
  };

  async function start(projectId: Id): Promise<void> {
    if (!wanted.has(projectId) || watchers.has(projectId)) return;
    let root: string;
    try {
      root = await folderOf(projectId);
    } catch {
      logger.warn({ subsystem: 'workspace', projectId }, 'not watching: the project or its folder is missing');
      return;
    }
    if (!wanted.has(projectId) || watchers.has(projectId)) return;
    const stop = files.watch(
      root,
      (batch) => announce(projectId, batch),
      (error) => {
        watchers.delete(projectId);
        logger.warn({ subsystem: 'workspace', projectId, reason: error.message }, 'the file watcher stopped');
        announce(projectId, { changes: [], resync: true });
        const timer = setTimeout(() => {
          restarts.delete(timer);
          void start(projectId);
        }, restartDelayMs);
        timer.unref?.();
        restarts.add(timer);
      },
    );
    watchers.set(projectId, stop);
  }

  return {
    listFolder: async (projectId, path) => files.listFolder(await folderOf(projectId), path),
    read: async (projectId, path) => files.read(await folderOf(projectId), path),
    readRaw: async (projectId, path) => files.readRaw(await folderOf(projectId), path),
    save: async (projectId, request) => files.write(await folderOf(projectId), request),
    create: async (projectId, request) => files.create(await folderOf(projectId), request),
    move: async (projectId, from, to) => files.move(await folderOf(projectId), from, to),
    remove: async (projectId, path) => files.remove(await folderOf(projectId), path),
    listAll: async (projectId) => files.listAll(await folderOf(projectId)),
    status: async (projectId) => files.status(await folderOf(projectId)),

    async setWatched(projectId, watched) {
      if (watched) {
        wanted.add(projectId);
        await start(projectId);
        return;
      }
      wanted.delete(projectId);
      watchers.get(projectId)?.();
      watchers.delete(projectId);
    },

    stopAll() {
      wanted.clear();
      for (const timer of restarts) clearTimeout(timer);
      restarts.clear();
      for (const stop of watchers.values()) stop();
      watchers.clear();
    },
  };
}
```

- [ ] **Step 6: Write the routes**

Create `packages/engine/src/workspace/routes.ts`:

```ts
import {
  CreateEntryRequestSchema,
  FilePathQuerySchema,
  MoveEntryRequestSchema,
  RequiredFilePathQuerySchema,
  SaveFileRequestSchema,
} from '@ace/contracts';
import { Hono } from 'hono';

import { notImplemented } from '../gateway/errors.js';
import { readJson } from '../gateway/read-json.js';
import type { WorkspaceService } from './service.js';

export type WorkspaceRouter = Hono<{ Variables: { requestId: string } }>;

/**
 * `/api/v1/projects/:id/files/*` (D299, design §6.1). Mounted inside the gateway's token, Origin
 * and request-id middleware; answers 501 when the engine was built without a workspace (D121).
 */
export function createWorkspaceRoutes(workspaceService: WorkspaceService | undefined): WorkspaceRouter {
  const router: WorkspaceRouter = new Hono<{ Variables: { requestId: string } }>();
  const workspace = (): WorkspaceService => {
    if (workspaceService === undefined) throw notImplemented('Project files');
    return workspaceService;
  };
  const base = '/projects/:id/files';

  router.get(`${base}/tree`, async (c) => {
    const { path } = FilePathQuerySchema.parse(c.req.query());
    return c.json(await workspace().listFolder(c.req.param('id'), path));
  });

  router.get(`${base}/content`, async (c) => {
    const { path } = RequiredFilePathQuerySchema.parse(c.req.query());
    return c.json(await workspace().read(c.req.param('id'), path));
  });

  router.get(`${base}/raw`, async (c) => {
    const { path } = RequiredFilePathQuerySchema.parse(c.req.query());
    const raw = await workspace().readRaw(c.req.param('id'), path);
    // An SVG opened on its own must not run script: the bytes are served as an inert document.
    return c.body(raw.bytes, 200, {
      'content-type': raw.contentType,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'cache-control': 'no-store',
    });
  });

  router.put(`${base}/content`, async (c) => {
    const service = workspace();
    const body = SaveFileRequestSchema.parse(await readJson(c));
    return c.json(await service.save(c.req.param('id'), body));
  });

  router.post(`${base}/entries`, async (c) => {
    const service = workspace();
    const body = CreateEntryRequestSchema.parse(await readJson(c));
    return c.json(await service.create(c.req.param('id'), body), 201);
  });

  router.post(`${base}/move`, async (c) => {
    const service = workspace();
    const body = MoveEntryRequestSchema.parse(await readJson(c));
    return c.json(await service.move(c.req.param('id'), body.from, body.to));
  });

  router.delete(`${base}/entries`, async (c) => {
    const { path } = RequiredFilePathQuerySchema.parse(c.req.query());
    await workspace().remove(c.req.param('id'), path);
    return c.body(null, 204);
  });

  router.get(`${base}/list`, async (c) => c.json(await workspace().listAll(c.req.param('id'))));
  router.get(`${base}/status`, async (c) => c.json(await workspace().status(c.req.param('id'))));

  return router;
}
```

- [ ] **Step 7: Wire it into the gateway**

In `packages/engine/src/gateway/index.ts`:
- Import `createWorkspaceRoutes` from `'../workspace/routes.js'` and `type WorkspaceService` from `'../workspace/service.js'`.
- Add to `EngineDeps`, after `backup`:

```ts
  /*
   * IDE (D299). Optional for the same reason as every round's services: an app built without it
   * answers 501 `not_implemented` on the routes that need it (D121).
   */

  /** `/projects/:id/files/*`: Forge's project files (FR-GIT-003, FR-GIT-004, FR-GIT-008). */
  workspace?: WorkspaceService;
```

- In `corsLayer`, set `allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']`. Add `// PUT: Forge's save (D299).` beside it.
- After `api.route('/', createBackupRoutes(deps.backup));`, add:

```ts
  /* IDE (D299): Forge's project files, inside the same middleware. */
  api.route('/', createWorkspaceRoutes(deps.workspace));
```

In `packages/engine/src/index.ts`, add:

```ts
/* IDE (D299): Forge's project files. */
export * from './workspace/service.js';
export * from './workspace/routes.js';
```

- [ ] **Step 8: Run the tests**

Run: `pnpm --filter @ace/engine exec vitest run src/workspace src/__tests__/gateway.test.ts src/gateway`
Expected: PASS.

If `c.body(raw.bytes, …)` fails to typecheck because this Hono version wants a `Uint8Array`, pass `new Uint8Array(raw.bytes)`. Do not cast.

- [ ] **Step 9: Full engine suite, build, commit**

Run: `pnpm --filter @ace/engine test && pnpm --filter @ace/engine build`
Expected: PASS. If a test asserts the exact `allowMethods` list, update it to include `PUT`.

```bash
npx prettier --write --config packages/config/prettier.config.js packages/engine/src/workspace
git add packages/engine
git commit -m "feat(engine): the workspace service and Forge's file routes, watched while someone looks [D299] [FR-GIT-003] [FR-GIT-004] [FR-GIT-008]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Engine — the `project` WebSocket scope and the watch lifecycle

**Files:**
- Modify: `packages/engine/src/events/ws-hub.ts`
- Test: extend `packages/engine/src/__tests__/events.test.ts`

**Interfaces:**
- Consumes (Task 1): `PROJECT_EVENT_TYPES` and the `project` member of `WsSubscribePayload`.
- Produces:
  - `WsHubDeps.onProjectWatch?: (projectId: Id, watched: boolean) => void`. It is called `true` when a project gets its first subscriber across all connections, and `false` when the last one unsubscribes, disconnects, or `closeAll` runs.
  - `files.changed` is routed by `payload.projectId` to that project's subscribers only.

- [ ] **Step 1: Write the failing tests**

Append to `packages/engine/src/__tests__/events.test.ts`:

```ts
describe('D299 the project scope', () => {
  const silent = createLogger({ level: 'silent', destination: { write: () => undefined } });
  const PROJECT = newId();
  const OTHER = newId();
  const changed = (projectId: string) => ({
    type: 'files.changed',
    payload: { projectId, changes: [{ path: 'a.ts', kind: 'changed' }], resync: false },
  });
  const subscribe = (id: string) => ({ type: 'subscribe', payload: { scope: 'project', id } });

  it('delivers a project’s files.changed to its subscribers only, without a seq', async () => {
    const watching = await connect();
    const engineOnly = await connect();
    const other = await connect();
    await watching.receive(subscribe(PROJECT));
    await engineOnly.receive({ type: 'subscribe', payload: { scope: 'engine' } });
    await other.receive(subscribe(OTHER));

    await bus.emitTransient(changed(PROJECT));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(watching.frames().filter((f) => f.type === 'files.changed')).toEqual([changed(PROJECT)]);
    expect(engineOnly.frames().some((f) => f.type === 'files.changed')).toBe(false);
    expect(other.frames().some((f) => f.type === 'files.changed')).toBe(false);
  });

  it('asks for a watcher on the first subscriber and releases it after the last one leaves', async () => {
    const calls: Array<[string, boolean]> = [];
    hub = createWsHub({ bus, repository, scope, auth, logger: silent, onProjectWatch: (id, on) => calls.push([id, on]) });
    const a = await connect();
    const b = await connect();

    await a.receive(subscribe(PROJECT));
    await a.receive(subscribe(PROJECT));
    await b.receive(subscribe(PROJECT));
    expect(calls).toEqual([[PROJECT, true]]);

    await a.receive({ type: 'unsubscribe', payload: { scope: 'project', id: PROJECT } });
    expect(calls).toEqual([[PROJECT, true]]);

    b.close(1000);
    expect(calls).toEqual([
      [PROJECT, true],
      [PROJECT, false],
    ]);
  });

  it('closeAll releases every watched project exactly once', async () => {
    const calls: Array<[string, boolean]> = [];
    hub = createWsHub({ bus, repository, scope, auth, logger: silent, onProjectWatch: (id, on) => calls.push([id, on]) });
    const a = await connect();
    await a.receive(subscribe(PROJECT));
    await a.receive(subscribe(OTHER));

    hub.closeAll();

    expect(calls).toEqual([
      [PROJECT, true],
      [OTHER, true],
      [PROJECT, false],
      [OTHER, false],
    ]);
  });
});
```

- [ ] **Step 2: Run them to watch them fail**

Run: `pnpm --filter @ace/engine exec vitest run src/__tests__/events.test.ts`
Expected: FAIL. `files.changed` reaches the engine-scope socket, and `onProjectWatch` is never called.

- [ ] **Step 3: Implement the scope**

In `packages/engine/src/events/ws-hub.ts`:

1. Import `PROJECT_EVENT_TYPES` next to `THREAD_EVENT_TYPES`.
2. Add to `WsHubDeps`:

```ts
  /**
   * D299: told when a project gains its first `project`-scope subscriber across every connection
   * (`true`) and when it loses its last (`false`), so its folder is watched only while someone
   * looks at it.
   */
  onProjectWatch?: (projectId: Id, watched: boolean) => void;
```

3. Add `projects: Set<Id>;` to `Subscription`, with the comment `/** Projects whose files.changed this client gets (D299). */`.
4. Add `const PROJECT_TYPES = new Set<string>(PROJECT_EVENT_TYPES);` after `THREAD_TYPES`.
5. Change the function signature to destructure `onProjectWatch`. Change `open` to `new Set<{ socket: HubSocket; unsubscribe: Unsubscribe; subscription: Subscription }>()`. Add the reference counting:

```ts
  /** How many connections watch each project; the watcher's life follows 0 ↔ 1 (D299). */
  const projectWatchers = new Map<Id, number>();

  function retain(projectId: Id): void {
    const count = projectWatchers.get(projectId) ?? 0;
    projectWatchers.set(projectId, count + 1);
    if (count === 0) onProjectWatch?.(projectId, true);
  }

  function release(projectId: Id): void {
    const count = projectWatchers.get(projectId) ?? 0;
    if (count > 1) {
      projectWatchers.set(projectId, count - 1);
      return;
    }
    projectWatchers.delete(projectId);
    if (count === 1) onProjectWatch?.(projectId, false);
  }

  /** Idempotent: the set is emptied first, so a second call (close after closeAll) releases nothing. */
  function releaseAll(subscription: Subscription): void {
    const projects = [...subscription.projects];
    subscription.projects.clear();
    for (const projectId of projects) release(projectId);
  }
```

6. Make `wants` check project frames first:

```ts
    // Forge's frames belong to their project and nowhere else (D299), matched by payload.projectId.
    if (PROJECT_TYPES.has(event.type)) {
      const projectId = (event.payload as { projectId?: Id }).projectId;
      return projectId !== undefined && subscription.projects.has(projectId);
    }
```

7. In `handleConnection`, add `projects: new Set()` to the subscription. Use `const entry = { socket, unsubscribe, subscription };`. In the `close` handler, call `releaseAll(subscription);` before `open.delete(entry)`.
8. In `handleFrame`:

```ts
          case 'subscribe': {
            const payload = frame.payload;
            if (payload.scope === 'workflow') subscription.workflows.add(payload.id);
            else if (payload.scope === 'thread') subscription.threads.add(payload.id);
            else if (payload.scope === 'project') {
              if (!subscription.projects.has(payload.id)) {
                subscription.projects.add(payload.id);
                retain(payload.id);
              }
            } else subscription.engineScope = true;
            return;
          }

          case 'unsubscribe': {
            if (frame.payload.scope === 'engine') {
              subscription.engineScope = false;
            } else if (frame.payload.scope === 'project') {
              if (frame.payload.id === undefined) releaseAll(subscription);
              else if (subscription.projects.delete(frame.payload.id)) release(frame.payload.id);
            } else if (frame.payload.scope === 'thread') {
              if (frame.payload.id === undefined) subscription.threads.clear();
              else subscription.threads.delete(frame.payload.id);
            } else if (frame.payload.id === undefined) {
              subscription.workflows.clear();
            } else {
              subscription.workflows.delete(frame.payload.id);
            }
            return;
          }
```

9. `closeAll`:

```ts
    closeAll(code = 1001) {
      for (const { socket, unsubscribe, subscription } of open) {
        unsubscribe();
        releaseAll(subscription);
        socket.close(code, 'engine shutting down');
      }
      open.clear();
    },
```

`resume` is unchanged. Project frames are transient, so there is nothing to replay.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @ace/engine exec vitest run src/__tests__/events.test.ts`
Expected: PASS, the old hub tests included.

- [ ] **Step 5: Full engine suite, build, commit**

Run: `pnpm --filter @ace/engine test && pnpm --filter @ace/engine build`
Expected: PASS.

```bash
git add packages/engine
git commit -m "feat(engine): the project WebSocket scope — files.changed by project, a watcher only while someone looks [D299]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Server — wiring, shutdown, and a real-engine integration test

**Files:**
- Modify: `apps/server/src/server.ts`
- Test: create `apps/server/src/__tests__/workspace.integration.test.ts`

**Interfaces:**
- Consumes:
  - from Task 4: `createFsProjectFiles` from `@ace/tools`;
  - from Task 5: `createWorkspaceService`;
  - from Task 6: `onProjectWatch`.
- Produces: a running engine that answers the file routes and streams `files.changed` on the `project` scope.

- [ ] **Step 1: Write the failing integration test**

Create `apps/server/src/__tests__/workspace.integration.test.ts`:

```ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { startEngine, type RunningEngine } from '../server.js';

let engine: RunningEngine;
let dataDir: string;
let folder: string;
let projectId: string;

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const response = await fetch(`${engine.url}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${engine.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: (text === '' ? undefined : JSON.parse(text)) as T };
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ace-forge-int-'));
  folder = join(dataDir, 'Forge Project');
  mkdirSync(folder);
  writeFileSync(join(folder, 'hello.txt'), 'hi\r\n');
  engine = await startEngine({ dataDir, port: 0, env: {} });
  const created = await api<{ id: string }>('POST', '/projects', { name: 'Forge', folderPath: folder });
  projectId = created.json.id;
});

afterAll(async () => {
  await engine.stop();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

describe('D299 FR-GIT-003 FR-GIT-004 Forge’s files through the real engine', () => {
  it('lists, reads and saves a real file, keeping its CRLF', async () => {
    const tree = await api<{ items: { name: string }[] }>('GET', `/projects/${projectId}/files/tree`);
    expect(tree.status).toBe(200);
    expect(tree.json.items.map((entry) => entry.name)).toContain('hello.txt');

    const read = await api<{ kind: string; content: string; version: string; eol: string }>(
      'GET',
      `/projects/${projectId}/files/content?path=hello.txt`,
    );
    expect(read.json).toMatchObject({ kind: 'text', content: 'hi\r\n', eol: 'crlf' });

    const saved = await api<{ version: string }>('PUT', `/projects/${projectId}/files/content`, {
      path: 'hello.txt',
      content: 'hello\r\nworld\r\n',
      baseVersion: read.json.version,
      eol: 'crlf',
      bom: false,
    });
    expect(saved.status).toBe(200);
    expect(readFileSync(join(folder, 'hello.txt'), 'utf8')).toBe('hello\r\nworld\r\n');

    const stale = await api<{ error: { code: string } }>('PUT', `/projects/${projectId}/files/content`, {
      path: 'hello.txt',
      content: 'lost',
      baseVersion: read.json.version,
      eol: 'lf',
      bom: false,
    });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('file_changed');
  });

  it('refuses a path outside the project and a write into .git (FR-GIT-008)', async () => {
    const outside = await api<{ error: { code: string } }>(
      'GET',
      `/projects/${projectId}/files/content?path=${encodeURIComponent('../secret.txt')}`,
    );
    expect(outside.status).toBe(403);
    expect(outside.json.error.code).toBe('outside_project');

    const git = await api<{ error: { code: string } }>('POST', `/projects/${projectId}/files/entries`, {
      path: '.git/hooks/pre-commit',
      kind: 'file',
    });
    expect(git.status).toBe(403);
    expect(git.json.error.code).toBe('protected_path');
  });

  it('streams files.changed to a project subscriber when a file changes on disk', async () => {
    const socket = new WebSocket(`${engine.wsUrl}?token=${engine.token}`);
    const frames: { type: string; payload: { changes?: { path: string }[] } }[] = [];
    socket.on('message', (data) => frames.push(JSON.parse(String(data))));
    await new Promise<void>((resolve) => socket.on('open', () => resolve()));
    socket.send(JSON.stringify({ type: 'subscribe', payload: { scope: 'project', id: projectId } }));
    await new Promise((resolve) => setTimeout(resolve, 300));

    writeFileSync(join(folder, 'agent-wrote.ts'), 'export const x = 1;\n');

    await vi.waitFor(
      () =>
        expect(
          frames.some(
            (frame) =>
              frame.type === 'files.changed' &&
              (frame.payload.changes ?? []).some((change) => change.path === 'agent-wrote.ts'),
          ),
        ).toBe(true),
      { timeout: 5000 },
    );
    expect(frames.find((frame) => frame.type === 'files.changed')).not.toHaveProperty('seq');
    socket.close();
  });
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `pnpm --filter @ace/tools build && pnpm --filter @ace/engine build && pnpm --filter @ace/server exec vitest run src/__tests__/workspace.integration.test.ts`
Expected: FAIL. The file routes answer 501 `not_implemented`.

- [ ] **Step 3: Wire the service**

In `apps/server/src/server.ts`:
- Add `createFsProjectFiles` to the existing `@ace/tools` import, and `createWorkspaceService` to the `@ace/engine` import.
- Replace the `createWsHub` block with:

```ts
  const bus = createEventBus({ repository, scope: LOCAL_SCOPE, pubsub });
  // Forge's project files (D299): a project folder is watched while a client subscribes to its scope.
  const workspace = createWorkspaceService({
    repository,
    scope: LOCAL_SCOPE,
    files: createFsProjectFiles(),
    bus,
    logger: logger.child({ subsystem: 'workspace' }),
  });
  const hub = createWsHub({
    bus,
    repository,
    scope: LOCAL_SCOPE,
    auth,
    logger,
    onProjectWatch: (projectId, watched) => {
      workspace.setWatched(projectId, watched).catch((error: unknown) => {
        logger.warn(
          { subsystem: 'workspace', projectId, reason: error instanceof Error ? error.message : String(error) },
          'could not change the project watch',
        );
      });
    },
  });
```

- Add `workspace,` to the `createEngineApp({...})` call, after `backup,`, with the comment `/* IDE (D299): Forge's project files. */`.
- In the shutdown sequence, call `workspace.stopAll();` immediately before `hub.closeAll();`.

- [ ] **Step 4: Run the integration test**

Run: `pnpm --filter @ace/server exec vitest run src/__tests__/workspace.integration.test.ts`
Expected: PASS.

`apps/server`'s vitest config does not alias `@ace/tools`, so it runs `packages/tools/dist`: rebuild tools after any tools change.

- [ ] **Step 5: Full server suite, commit**

Run: `pnpm --filter @ace/server test`
Expected: PASS.

```bash
npx prettier --write --config packages/config/prettier.config.js apps/server/src/__tests__/workspace.integration.test.ts
git add apps/server
git commit -m "feat(server): wire Forge's project files and the project watch into the engine [D299] [FR-GIT-003] [FR-GIT-004] [FR-GIT-008]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: SDK — `PUT` and the file methods

**Files:**
- Modify: `packages/sdk/src/client.ts`
- Test: create `packages/sdk/src/__tests__/files.test.ts`

**Interfaces:**
- Consumes (Task 1): the workspace schemas.
- Produces, on `AceClient`:
  - `listFolder(projectId, path?): Promise<FolderListing>`
  - `readFile(projectId, path): Promise<FileContent>`
  - `readFileRaw(projectId, path, signal?): Promise<Blob>`
  - `saveFile(projectId, body: SaveFileRequest): Promise<SaveFileResult>`
  - `createEntry(projectId, body: CreateEntryRequest): Promise<FileEntry>`
  - `moveEntry(projectId, body: MoveEntryRequest): Promise<FileEntry>`
  - `deleteEntry(projectId, path): Promise<void>`
  - `listAllFiles(projectId): Promise<FileList>`
  - `repoStatus(projectId): Promise<RepoStatus>`

  An error is still an `AceApiError` with `.status`, `.code` and `.details`.

- [ ] **Step 1: Write the failing test**

Create `packages/sdk/src/__tests__/files.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { createAceClient } from '../client.js';
import { AceApiError } from '../errors.js';

const PID = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';
const AT = '2026-10-09T10:00:00.000Z';

interface Seen {
  method: string;
  url: string;
  body: unknown;
}

function clientAnswering(status: number, answer: unknown, contentType = 'application/json') {
  const seen: Seen[] = [];
  const client = createAceClient({
    baseUrl: 'http://127.0.0.1:4747',
    token: 't',
    fetch: async (input, init) => {
      seen.push({
        method: init?.method ?? 'GET',
        url: String(input),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      const payload = answer instanceof Uint8Array ? answer : answer === undefined ? null : JSON.stringify(answer);
      return new Response(payload, { status, headers: { 'content-type': contentType } });
    },
  });
  return { client, seen };
}

describe('D299 FR-GIT-003 FR-GIT-004 the SDK’s file methods', () => {
  it('lists the root, then a folder with a space in its path', async () => {
    const { client, seen } = clientAnswering(200, { path: '', items: [] });
    await client.listFolder(PID);
    await client.listFolder(PID, 'My Dir/src');
    expect(seen.map((s) => s.url)).toEqual([
      `http://127.0.0.1:4747/api/v1/projects/${PID}/files/tree?path=`,
      `http://127.0.0.1:4747/api/v1/projects/${PID}/files/tree?path=My+Dir%2Fsrc`,
    ]);
  });

  it('saves with PUT and the validated body', async () => {
    const { client, seen } = clientAnswering(200, { path: 'a.ts', version: 'v2', size: 1, mtime: AT });
    const body = { path: 'a.ts', content: 'x', baseVersion: 'v1', eol: 'lf' as const, bom: false };
    expect((await client.saveFile(PID, body)).version).toBe('v2');
    expect(seen[0]).toEqual({ method: 'PUT', url: `http://127.0.0.1:4747/api/v1/projects/${PID}/files/content`, body });
  });

  it('turns a 409 file_changed into an AceApiError with the disk’s version', async () => {
    const { client } = clientAnswering(409, {
      error: { kind: 'workflow', code: 'file_changed', message: 'changed', details: { currentVersion: 'v9' }, retryable: false },
    });
    const error = await client
      .saveFile(PID, { path: 'a.ts', content: 'x', baseVersion: 'v1', eol: 'lf', bom: false })
      .catch((e: unknown) => e);
    expect(AceApiError.is(error) && error.code).toBe('file_changed');
    expect(AceApiError.is(error) && error.details).toEqual({ currentVersion: 'v9' });
  });

  it('creates, moves, deletes, lists and reads status', async () => {
    const entry = { path: 'n.ts', name: 'n.ts', kind: 'file', size: 0, mtime: AT, ignored: false };
    const { client, seen } = clientAnswering(200, entry);
    await client.createEntry(PID, { path: 'n.ts', kind: 'file' });
    await client.moveEntry(PID, { from: 'n.ts', to: 'b/n.ts' });
    expect(seen.map((s) => [s.method, new URL(s.url).pathname])).toEqual([
      ['POST', `/api/v1/projects/${PID}/files/entries`],
      ['POST', `/api/v1/projects/${PID}/files/move`],
    ]);

    const removed = clientAnswering(204, undefined);
    await removed.client.deleteEntry(PID, 'b/n.ts');
    expect(removed.seen[0]?.url).toBe(`http://127.0.0.1:4747/api/v1/projects/${PID}/files/entries?path=b%2Fn.ts`);
    expect(removed.seen[0]?.method).toBe('DELETE');

    const listed = clientAnswering(200, { files: ['a.ts'], truncated: false });
    expect((await listed.client.listAllFiles(PID)).files).toEqual(['a.ts']);
    const status = clientAnswering(200, { repo: false });
    expect(await status.client.repoStatus(PID)).toEqual({ repo: false });
  });

  it('reads raw bytes as a Blob with their type', async () => {
    const { client } = clientAnswering(200, new Uint8Array([1, 2, 3]), 'image/png');
    const blob = await client.readFileRaw(PID, 'a.png');
    expect(blob.type).toBe('image/png');
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3]);
  });
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `pnpm --filter @ace/sdk exec vitest run src/__tests__/files.test.ts`
Expected: FAIL. `client.listFolder` is not a function.

- [ ] **Step 3: Add `PUT` and the methods**

In `packages/sdk/src/client.ts`:
- Widen both `send`'s and `request`'s method union to `'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'`.
- Add the workspace schemas and types to the `@ace/contracts` import:
  - `CreateEntryRequestSchema`, `FileContentSchema`, `FileEntrySchema`, `FileListSchema`, `FolderListingSchema`, `MoveEntryRequestSchema`, `RepoStatusSchema`, `SaveFileRequestSchema`, `SaveFileResultSchema`;
  - and the types `CreateEntryRequest`, `FileContent`, `FileEntry`, `FileList`, `FolderListing`, `MoveEntryRequest`, `RepoStatus`, `SaveFileRequest`, `SaveFileResult`.
- Add these methods to the returned object, before the closing `};`:

```ts
    /* IDE — Forge's project files (D299, design §6.1) */
    listFolder: (projectId: Id, path = ''): Promise<FolderListing> =>
      request('GET', `/projects/${projectId}/files/tree`, FolderListingSchema, undefined, { path }),
    readFile: (projectId: Id, path: string): Promise<FileContent> =>
      request('GET', `/projects/${projectId}/files/content`, FileContentSchema, undefined, { path }),
    /** The bytes of a file (image previews); an error answers as an `AceApiError` like any route. */
    readFileRaw: async (projectId: Id, path: string, signal?: AbortSignal): Promise<Blob> => {
      const response = await send(
        'GET',
        `/projects/${projectId}/files/raw`,
        { accept: '*/*', ...(signal === undefined ? {} : { signal }) },
        { path },
      );
      if (!response.ok) throw AceApiError.fromResponse(response.status, await readJson(response));
      return response.blob();
    },
    saveFile: (projectId: Id, body: SaveFileRequest): Promise<SaveFileResult> =>
      request('PUT', `/projects/${projectId}/files/content`, SaveFileResultSchema, {
        schema: SaveFileRequestSchema,
        value: body,
      }),
    createEntry: (projectId: Id, body: CreateEntryRequest): Promise<FileEntry> =>
      request('POST', `/projects/${projectId}/files/entries`, FileEntrySchema, {
        schema: CreateEntryRequestSchema,
        value: body,
      }),
    moveEntry: (projectId: Id, body: MoveEntryRequest): Promise<FileEntry> =>
      request('POST', `/projects/${projectId}/files/move`, FileEntrySchema, {
        schema: MoveEntryRequestSchema,
        value: body,
      }),
    deleteEntry: (projectId: Id, path: string): Promise<void> =>
      request('DELETE', `/projects/${projectId}/files/entries`, NoContentSchema, undefined, { path }),
    listAllFiles: (projectId: Id): Promise<FileList> =>
      request('GET', `/projects/${projectId}/files/list`, FileListSchema),
    repoStatus: (projectId: Id): Promise<RepoStatus> =>
      request('GET', `/projects/${projectId}/files/status`, RepoStatusSchema),
```

`joinUrl` keeps `path: ''`, because only `undefined` is dropped, so the first list test sees `?path=`. If `URLSearchParams` encodes the space as `+`, the test above already expects that.

- [ ] **Step 4: Run the SDK suite, build, and commit**

Run: `pnpm --filter @ace/sdk test && pnpm --filter @ace/sdk build`
Expected: PASS, and the build succeeds.

```bash
npx prettier --write --config packages/config/prettier.config.js packages/sdk/src/__tests__/files.test.ts
git add packages/sdk
git commit -m "feat(sdk): PUT and Forge's file methods [D299] [FR-GIT-003] [FR-GIT-004]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Web mocks — an in-memory project folder, the file routes, and the `project` socket scope

**Files:**
- Create: `apps/web/src/mocks/files.ts`, `apps/web/src/mocks/handlers-forge.ts`
- Modify: `apps/web/src/mocks/db.ts`, `apps/web/src/mocks/fake-socket.ts`, `apps/web/src/mocks/browser.ts`, `apps/web/src/test/app.tsx`
- Test: create `apps/web/src/mocks/handlers-forge.test.ts`

**Interfaces:**
- Consumes:
  - from Task 1: the contract types;
  - existing: `MockDb` (`load`, `save`, `emit`, `getProject`, `createProject`, `latencyMs`), `aceError`, `ERROR_CODE_HTTP_STATUS`.
- Produces:
  - from `mocks/files.ts`:
    - `MockFsEntry`, `MockFs`, `MockFsError`, `mockVersion(content)`;
    - `listFolder`, `readFile`, `writeFile`, `createEntry`, `moveEntry`, `removeEntry`, `listAll`, `ensureFolders`.
  - `MockDb` methods:
    - `filesOf(projectId)`, `seedFiles(projectId, files)`;
    - `writeFileExternally(projectId, path, content)`, `deleteFileExternally(projectId, path)`;
    - `repoStatusOf(projectId)`, `setRepoStatus(projectId, status)`;
    - `emitFilesChanged(projectId, changes)`.
  - `MockEvent.scope` gains `'project'`, and `MockEvent.projectId?` is new.
  - `createForgeHandlers(db): HttpHandler[]`, mounted first in the browser worker and in `test/app.tsx`.
  - `window.__aceMock` gains `seedFiles`, `writeFileExternally`, `deleteFileExternally` and `setRepoStatus`.
  - The fake socket routes `files.changed` to `project` subscribers by `payload.projectId`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/mocks/handlers-forge.test.ts`:

```ts
import type { ServerFrame } from '@ace/contracts';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { MockDb } from './db';
import { createFakeWebSocket } from './fake-socket';
import { mockVersion } from './files';
import { createForgeHandlers } from './handlers-forge';

const db = new MockDb({ persist: false });
const server = setupServer(...createForgeHandlers(db));
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let projectId: string;
beforeEach(() => {
  db.reset();
  projectId = db.createProject({ name: 'P' }).id;
  db.seedFiles(projectId, { 'src/app.ts': 'export {};\n', 'README.md': '# hi', 'node_modules/x/i.js': '' });
});

const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`http://mock.local/api/v1/projects/${projectId}/files${path}`, {
    method,
    headers: { authorization: 'Bearer t', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: text === '' ? undefined : (JSON.parse(text) as Record<string, unknown>) };
};

describe('D299 the mock engine’s project files', () => {
  it('lists folders first, dims ignored folders, and never lists .git', async () => {
    db.seedFiles(projectId, { '.git/HEAD': 'x' });
    const { json } = await call('GET', '/tree');
    expect((json?.items as { name: string; ignored: boolean }[]).map((e) => [e.name, e.ignored])).toEqual([
      ['node_modules', true],
      ['src', false],
      ['README.md', false],
    ]);
  });

  it('reads text with a version, saves against it, and refuses a stale base with the disk’s version', async () => {
    const read = await call('GET', '/content?path=src%2Fapp.ts');
    expect(read.json).toMatchObject({ kind: 'text', content: 'export {};\n', version: mockVersion('export {};\n') });

    const saved = await call('PUT', '/content', {
      path: 'src/app.ts',
      content: 'export const a = 1;\n',
      baseVersion: read.json?.version,
      eol: 'lf',
      bom: false,
    });
    expect(saved.status).toBe(200);
    expect(db.filesOf(projectId)['src/app.ts']?.content).toBe('export const a = 1;\n');

    const stale = await call('PUT', '/content', {
      path: 'src/app.ts',
      content: 'lost',
      baseVersion: read.json?.version,
      eol: 'lf',
      bom: false,
    });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({
      error: { code: 'file_changed', details: { currentVersion: mockVersion('export const a = 1;\n') } },
    });
  });

  it('creates, moves a folder with its files, deletes, and lists every non-ignored file', async () => {
    expect((await call('POST', '/entries', { path: 'docs/a.md', kind: 'file' })).status).toBe(201);
    expect((await call('POST', '/move', { from: 'src', to: 'lib' })).status).toBe(200);
    expect(db.filesOf(projectId)['lib/app.ts']).toBeDefined();
    expect((await call('DELETE', '/entries?path=README.md')).status).toBe(204);
    expect((await call('GET', '/list')).json).toEqual({ files: ['docs/a.md', 'lib/app.ts'], truncated: false });
  });

  it('refuses paths outside the project and writes into .git, as the engine does', async () => {
    expect((await call('GET', '/content?path=..%2Fx')).json).toMatchObject({ error: { code: 'outside_project' } });
    const git = await call('POST', '/entries', { path: 'sub/.git/hooks/x', kind: 'file' });
    expect(git.status).toBe(403);
    expect(git.json).toMatchObject({ error: { code: 'protected_path' } });
    expect((await call('POST', '/entries', { path: 'README.md', kind: 'file' })).status).toBe(409);
  });

  it('answers the repository status it was given, repo: false by default', async () => {
    expect((await call('GET', '/status')).json).toEqual({ repo: false });
    db.setRepoStatus(projectId, { repo: true, branch: 'main', files: [{ path: 'README.md', status: 'modified' }], truncated: false });
    expect((await call('GET', '/status')).json).toMatchObject({ repo: true, branch: 'main' });
  });

  it('announces every change on the project scope only', async () => {
    const Socket = createFakeWebSocket(db);
    const watching = new Socket('ws://mock/ws?token=t');
    const elsewhere = new Socket('ws://mock/ws?token=t');
    const frames: ServerFrame[] = [];
    const leaked: ServerFrame[] = [];
    watching.onmessage = (event) => frames.push(JSON.parse(String(event.data)) as ServerFrame);
    elsewhere.onmessage = (event) => leaked.push(JSON.parse(String(event.data)) as ServerFrame);
    await new Promise((resolve) => setTimeout(resolve, 5));
    watching.send(JSON.stringify({ type: 'subscribe', payload: { scope: 'project', id: projectId } }));
    elsewhere.send(JSON.stringify({ type: 'subscribe', payload: { scope: 'engine' } }));

    db.writeFileExternally(projectId, 'README.md', '# changed');

    expect(frames.filter((f) => f.type === 'files.changed')).toEqual([
      { type: 'files.changed', payload: { projectId, changes: [{ path: 'README.md', kind: 'changed' }], resync: false } },
    ]);
    expect(leaked.some((f) => f.type === 'files.changed')).toBe(false);
  });
});
```

Read `fake-socket.ts`'s constructor before running. If `createFakeWebSocket(db)` returns a class whose constructor takes `(url)` and whose `onmessage`/`send` work as above, keep the test. If the open handshake needs more than one tick, wait for `hello` the way the existing fake-socket tests do.

- [ ] **Step 2: Run it to watch it fail**

Run: `pnpm --filter @ace/web exec vitest run src/mocks/handlers-forge.test.ts`
Expected: FAIL. `./files` and `./handlers-forge` do not exist.

- [ ] **Step 3: Write the in-memory folder**

Create `apps/web/src/mocks/files.ts`:

```ts
import {
  FILE_EDIT_MAX_BYTES,
  type CreateEntryRequest,
  type FileContent,
  type FileEntry,
  type FileList,
  type FolderListing,
  type SaveFileRequest,
  type SaveFileResult,
} from '@ace/contracts';

/**
 * A project folder for the mock engine (D299): path → entry, with folders explicit so an empty one
 * can exist. The rules mirror `@ace/tools`' `fs-files.ts` closely enough for the UI to meet every
 * refusal it can meet on the real engine.
 */
export interface MockFsEntry {
  kind: 'file' | 'folder';
  content: string;
  mtime: string;
}
export type MockFs = Record<string, MockFsEntry>;

export type MockFsErrorCode =
  | 'not_found'
  | 'exists'
  | 'file_changed'
  | 'file_too_large'
  | 'outside_project'
  | 'protected_path'
  | 'invalid_path';

export class MockFsError extends Error {
  constructor(
    readonly code: MockFsErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** FNV-1a plus the length: a stable, cheap stand-in for the engine's content hash. */
export function mockVersion(content: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i += 1) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16).padStart(8, '0')}${content.length.toString(16)}`;
}

const IGNORED = new Set(['node_modules', '.ace', 'dist', 'build', '.next', '__pycache__', '.venv']);
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const now = (): string => new Date().toISOString();
const bytesOf = (text: string): number => new TextEncoder().encode(text).length;
const parentOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const asSeen = (segment: string): string => (segment.split(':')[0] ?? '').replace(/[. ]+$/, '').toLowerCase();
const isHidden = (path: string): boolean => path.split('/').some((segment) => asSeen(segment) === '.git');
const isIgnored = (path: string, kind: MockFsEntry['kind']): boolean =>
  path.split('/').some((segment, i, all) => (i < all.length - 1 || kind === 'folder') && IGNORED.has(segment));

/** The engine's confinement, in miniature (FR-GIT-008). */
function checkPath(path: string, write: boolean): string {
  const clean = path.split('\\').join('/').replace(/^\.\//, '');
  const escapes =
    clean.includes('\u0000') ||
    clean.startsWith('/') ||
    /^[A-Za-z]:/.test(clean) ||
    clean.startsWith('~') ||
    clean.split('/').includes('..');
  if (escapes) throw new MockFsError('outside_project', 'That path is outside the project folder.');
  if (clean === '' || clean === '.') throw new MockFsError('invalid_path', 'That names the project folder itself.');
  if (write) {
    const folder = clean.split('/').map(asSeen).find((segment) => segment === '.git' || segment === '.ace');
    if (folder !== undefined) {
      throw new MockFsError('protected_path', `Forge does not change anything inside ${folder}/.`, { folder });
    }
  }
  return clean;
}

function assertValidName(name: string): void {
  if (name === '' || /[<>:"|?*]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) {
    throw new MockFsError('invalid_path', `"${name}" cannot be used as a name.`, { path: name });
  }
}

const notFound = (path: string) => new MockFsError('not_found', `${path} was not found.`);

function entryOf(fs: MockFs, path: string): FileEntry {
  const entry = fs[path];
  if (entry === undefined) throw notFound(path);
  return {
    path,
    name: nameOf(path),
    kind: entry.kind,
    size: entry.kind === 'file' ? bytesOf(entry.content) : 0,
    mtime: entry.mtime,
    ignored: isIgnored(path, entry.kind),
  };
}

export function ensureFolders(fs: MockFs, path: string): void {
  for (let folder = parentOf(path); folder !== ''; folder = parentOf(folder)) {
    if (fs[folder] === undefined) fs[folder] = { kind: 'folder', content: '', mtime: now() };
  }
}

export function listFolder(fs: MockFs, path: string): FolderListing {
  const folder = path === '' ? '' : checkPath(path, false);
  if (folder !== '' && fs[folder]?.kind !== 'folder') {
    throw fs[folder] === undefined ? notFound(folder) : new MockFsError('invalid_path', `${folder} is a file.`);
  }
  const items = Object.keys(fs)
    .filter((p) => parentOf(p) === folder && !isHidden(p))
    .map((p) => entryOf(fs, p))
    .sort((a, b) => (a.kind !== b.kind ? (a.kind === 'folder' ? -1 : 1) : collator.compare(a.name, b.name)));
  return { path: folder, items };
}

export function readFile(fs: MockFs, path: string): FileContent {
  const file = checkPath(path, false);
  const entry = fs[file];
  if (entry?.kind !== 'file') throw notFound(file);
  const size = bytesOf(entry.content);
  if (size > FILE_EDIT_MAX_BYTES) return { kind: 'too_large', path: file, size };
  if (entry.content.includes('\u0000')) return { kind: 'binary', path: file, size };
  return {
    kind: 'text',
    path: file,
    content: entry.content,
    version: mockVersion(entry.content),
    eol: entry.content.includes('\r\n') ? 'crlf' : 'lf',
    bom: false,
    size,
  };
}

export function writeFile(fs: MockFs, request: SaveFileRequest): SaveFileResult {
  const file = checkPath(request.path, true);
  const entry = fs[file];
  if (entry?.kind === 'folder') throw new MockFsError('exists', `${file} is a folder.`);
  const currentVersion = entry === undefined ? null : mockVersion(entry.content);
  if (currentVersion !== request.baseVersion) {
    throw new MockFsError('file_changed', `${file} changed on disk after it was opened.`, { currentVersion });
  }
  const parent = parentOf(file);
  if (parent !== '' && fs[parent]?.kind !== 'folder') throw notFound(parent);
  const text = request.eol === 'crlf' ? request.content.replace(/\r?\n/g, '\r\n') : request.content.replace(/\r\n/g, '\n');
  if (bytesOf(text) > FILE_EDIT_MAX_BYTES) throw new MockFsError('file_too_large', `${file} is over 2 MB.`);
  const mtime = now();
  fs[file] = { kind: 'file', content: text, mtime };
  return { path: file, version: mockVersion(text), size: bytesOf(text), mtime };
}

export function createEntry(fs: MockFs, request: CreateEntryRequest): FileEntry {
  const path = checkPath(request.path, true);
  path.split('/').forEach(assertValidName);
  if (fs[path] !== undefined) throw new MockFsError('exists', `${path} already exists.`);
  ensureFolders(fs, path);
  fs[path] = { kind: request.kind, content: '', mtime: now() };
  return entryOf(fs, path);
}

export function moveEntry(fs: MockFs, from: string, to: string): FileEntry {
  const source = checkPath(from, true);
  const target = checkPath(to, true);
  assertValidName(nameOf(target));
  const entry = fs[source];
  if (entry === undefined) throw notFound(source);
  if (entry.kind === 'folder' && `${target}/`.startsWith(`${source}/`)) {
    throw new MockFsError('invalid_path', 'A folder cannot be moved into itself.');
  }
  // a case-only rename is the same entry on Windows and macOS
  if (fs[target] !== undefined && source.toLowerCase() !== target.toLowerCase()) {
    throw new MockFsError('exists', `${target} already exists.`);
  }
  ensureFolders(fs, target);
  for (const key of Object.keys(fs)) {
    if (key !== source && !key.startsWith(`${source}/`)) continue;
    const value = fs[key];
    if (value === undefined) continue;
    delete fs[key];
    fs[`${target}${key.slice(source.length)}`] = value;
  }
  return entryOf(fs, target);
}

export function removeEntry(fs: MockFs, path: string): void {
  const target = checkPath(path, true);
  if (fs[target] === undefined) throw notFound(target);
  for (const key of Object.keys(fs)) {
    if (key === target || key.startsWith(`${target}/`)) delete fs[key];
  }
}

export function listAll(fs: MockFs): FileList {
  const depth = (path: string): number => path.split('/').length;
  const files = Object.keys(fs)
    .filter((path) => fs[path]?.kind === 'file' && !isHidden(path) && !isIgnored(path, 'file'))
    .sort((a, b) => depth(a) - depth(b) || collator.compare(a, b));
  return { files, truncated: false };
}
```

- [ ] **Step 4: Extend `MockDb`**

In `apps/web/src/mocks/db.ts`:
- Import `type MockFs`, `ensureFolders` from `./files`, and `type FileChange`, `type RepoStatus` from `@ace/contracts`.
- Change `MockEvent`:

```ts
  scope: 'workflow' | 'engine' | 'thread' | 'project';
  workflowId?: string;
  threadId?: string;
  /** The project a `project`-scope frame (`files.changed`) belongs to (D299). */
  projectId?: string;
```

- Add to `Snapshot`, after `memory`:

```ts
  /* ---- IDE (D299) ---- */
  /** Each project's folder, path → entry (Forge). */
  projectFiles: Record<string, MockFs>;
  /** What `GET /files/status` answers per project; `{ repo: false }` when absent. */
  repoStatus: Record<string, RepoStatus>;
```

- Add `projectFiles: {}, repoStatus: {},` to `emptySnapshot()`.
- Add a section of methods before `/* ---- events */`:

```ts
  /* ------------------------------------------------------------ files (D299) */

  /** A project's folder, created empty on first use. */
  filesOf(projectId: string): MockFs {
    const folders = this.state.projectFiles;
    folders[projectId] ??= {};
    return folders[projectId];
  }

  /** Put files in a project's folder (tests, `__aceMock.seedFiles`); parent folders appear too. */
  seedFiles(projectId: string, files: Record<string, string>): void {
    const fs = this.filesOf(projectId);
    const at = new Date().toISOString();
    for (const [path, content] of Object.entries(files)) {
      ensureFolders(fs, path);
      fs[path] = { kind: 'file', content, mtime: at };
    }
    this.save();
  }

  /** Change a file the way an agent or another editor would, and announce it like the watcher. */
  writeFileExternally(projectId: string, path: string, content: string): void {
    const fs = this.filesOf(projectId);
    const existed = fs[path] !== undefined;
    ensureFolders(fs, path);
    fs[path] = { kind: 'file', content, mtime: new Date().toISOString() };
    this.save();
    this.emitFilesChanged(projectId, [{ path, kind: existed ? 'changed' : 'created' }]);
  }

  deleteFileExternally(projectId: string, path: string): void {
    delete this.filesOf(projectId)[path];
    this.save();
    this.emitFilesChanged(projectId, [{ path, kind: 'deleted' }]);
  }

  repoStatusOf(projectId: string): RepoStatus {
    return this.state.repoStatus[projectId] ?? { repo: false };
  }

  setRepoStatus(projectId: string, status: RepoStatus): void {
    this.state.repoStatus[projectId] = status;
    this.save();
  }

  /** The watcher's frame: transient, on the project's scope, paths only. */
  emitFilesChanged(projectId: string, changes: FileChange[]): void {
    this.emit({
      type: 'files.changed',
      payload: { projectId, changes, resync: false },
      scope: 'project',
      projectId,
      transient: true,
    });
  }
```

- [ ] **Step 5: Route `project` frames in the fake socket**

In `apps/web/src/mocks/fake-socket.ts`:
- Add `private projects = new Set<string>();` beside `subscriptions`.
- At the top of `wants`:

```ts
      if (event.scope === 'project') {
        return event.projectId !== undefined && this.projects.has(event.projectId);
      }
```

- In `addSubscription`:

```ts
      if (payload.scope === 'engine') this.engineScope = true;
      else if (payload.scope === 'project') this.projects.add(payload.id);
      else this.subscriptions.add(payload.id);
```

- In `send`'s `unsubscribe` case:

```ts
        case 'unsubscribe':
          if (frame.payload.scope === 'engine') this.engineScope = false;
          else if (frame.payload.scope === 'project') {
            if (frame.payload.id) this.projects.delete(frame.payload.id);
            else this.projects.clear();
          } else if (frame.payload.id) this.subscriptions.delete(frame.payload.id);
          break;
```

- Update the `wants` doc comment to say a project subscription delivers `files.changed` (D299).

- [ ] **Step 6: Write the handlers**

Create `apps/web/src/mocks/handlers-forge.ts`:

```ts
import {
  CreateEntryRequestSchema,
  ERROR_CODE_HTTP_STATUS,
  MoveEntryRequestSchema,
  SaveFileRequestSchema,
  aceError,
  type FileChange,
} from '@ace/contracts';
import { http, HttpResponse, type HttpHandler, type PathParams } from 'msw';

import type { MockDb } from './db';
import * as files from './files';
import { MockFsError, type MockFs } from './files';

/**
 * Forge's file routes on the mock engine (D299, design §6.1), so the web app and its tests run
 * with zero env vars. Every change is announced on the project's scope, as the engine's watcher
 * would announce the same change on disk — including the app's own saves.
 */

const API = '*/api/v1';

type Ctx = { request: Request; params: PathParams };
type Handle = (fs: MockFs, projectId: string, request: Request, url: URL) => Response | Promise<Response>;

const hasToken = (request: Request): boolean => /^Bearer\s+\S+$/.test(request.headers.get('authorization') ?? '');

const fail = (status: number, kind: 'auth' | 'workflow' | 'invalid_config', code: string, message: string, details?: unknown) =>
  HttpResponse.json(aceError(kind, code, message, { details, retryable: false }), { status });

function refusal(error: unknown): Response {
  if (!(error instanceof MockFsError)) throw error;
  const state = error.code === 'file_changed' || error.code === 'exists' || error.code === 'not_found';
  return fail(ERROR_CODE_HTTP_STATUS[error.code], state ? 'workflow' : 'invalid_config', error.code, error.message, error.details);
}

function requiredPath(url: URL): string {
  const path = url.searchParams.get('path') ?? '';
  if (path === '') throw new MockFsError('invalid_path', 'A path is required.');
  return path;
}

async function parsed<T>(request: Request, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: unknown } } }) {
  const result = schema.safeParse(await request.json().catch(() => undefined));
  if (!result.success) {
    return { ok: false as const, response: fail(400, 'invalid_config', 'validation_failed', 'Request body is invalid.', result.error.issues) };
  }
  return { ok: true as const, data: result.data };
}

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };

export function createForgeHandlers(db: MockDb): HttpHandler[] {
  const route =
    (handle: Handle) =>
    async ({ request, params }: Ctx): Promise<Response> => {
      if (!hasToken(request)) return fail(401, 'auth', 'unauthorized', 'Missing or invalid session token.');
      db.load();
      if (db.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, db.latencyMs));
      const projectId = String(params.id ?? '');
      if (db.getProject(projectId) === undefined) return fail(404, 'workflow', 'not_found', 'Project not found.');
      try {
        return await handle(db.filesOf(projectId), projectId, request, new URL(request.url));
      } catch (error) {
        return refusal(error);
      }
    };

  const announce = (projectId: string, changes: FileChange[]): void => {
    db.save();
    db.emitFilesChanged(projectId, changes);
  };

  return [
    http.get(`${API}/projects/:id/files/tree`, route((fs, _id, _request, url) => HttpResponse.json(files.listFolder(fs, url.searchParams.get('path') ?? '')))),

    http.get(`${API}/projects/:id/files/content`, route((fs, _id, _request, url) => HttpResponse.json(files.readFile(fs, requiredPath(url))))),

    http.get(
      `${API}/projects/:id/files/raw`,
      route((fs, _id, _request, url) => {
        const path = requiredPath(url);
        const entry = fs[path];
        if (entry?.kind !== 'file') throw new MockFsError('not_found', `${path} was not found.`);
        const type = IMAGE_TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';
        return new HttpResponse(entry.content, { headers: { 'content-type': type } });
      }),
    ),

    http.put(
      `${API}/projects/:id/files/content`,
      route(async (fs, projectId, request) => {
        const body = await parsed(request, SaveFileRequestSchema);
        if (!body.ok) return body.response;
        const existed = fs[body.data.path] !== undefined;
        const result = files.writeFile(fs, body.data);
        announce(projectId, [{ path: result.path, kind: existed ? 'changed' : 'created' }]);
        return HttpResponse.json(result);
      }),
    ),

    http.post(
      `${API}/projects/:id/files/entries`,
      route(async (fs, projectId, request) => {
        const body = await parsed(request, CreateEntryRequestSchema);
        if (!body.ok) return body.response;
        const entry = files.createEntry(fs, body.data);
        announce(projectId, [{ path: entry.path, kind: 'created' }]);
        return HttpResponse.json(entry, { status: 201 });
      }),
    ),

    http.post(
      `${API}/projects/:id/files/move`,
      route(async (fs, projectId, request) => {
        const body = await parsed(request, MoveEntryRequestSchema);
        if (!body.ok) return body.response;
        const entry = files.moveEntry(fs, body.data.from, body.data.to);
        announce(projectId, [
          { path: body.data.from, kind: 'deleted' },
          { path: entry.path, kind: 'created' },
        ]);
        return HttpResponse.json(entry);
      }),
    ),

    http.delete(
      `${API}/projects/:id/files/entries`,
      route((fs, projectId, _request, url) => {
        const path = requiredPath(url);
        files.removeEntry(fs, path);
        announce(projectId, [{ path, kind: 'deleted' }]);
        return new HttpResponse(null, { status: 204 });
      }),
    ),

    http.get(`${API}/projects/:id/files/list`, route((fs) => HttpResponse.json(files.listAll(fs)))),

    http.get(`${API}/projects/:id/files/status`, route((_fs, projectId) => HttpResponse.json(db.repoStatusOf(projectId)))),
  ];
}
```

- [ ] **Step 7: Mount the handlers and expose the test hooks**

In `apps/web/src/mocks/browser.ts`:
- Import `createForgeHandlers` and `type RepoFileStatus`.
- Put `...createForgeHandlers(db),` first in `setupWorker(...)`.
- Add to the `__aceMock` declaration:

```ts
      /** Forge (D299): put files in a project's folder, as if they were on disk. */
      seedFiles(projectId: string, files: Record<string, string>): void;
      /** Forge: change a file the way an agent or another editor would; an open tab hears `files.changed`. */
      writeFileExternally(projectId: string, path: string, content: string): void;
      deleteFileExternally(projectId: string, path: string): void;
      /** Forge: what the Explorer's git decorations read. */
      setRepoStatus(projectId: string, files: Array<{ path: string; status: RepoFileStatus }>): void;
```

- Implement them in the object:

```ts
    seedFiles(projectId, files) {
      db.load();
      db.seedFiles(projectId, files);
    },
    writeFileExternally(projectId, path, content) {
      db.load();
      db.writeFileExternally(projectId, path, content);
    },
    deleteFileExternally(projectId, path) {
      db.load();
      db.deleteFileExternally(projectId, path);
    },
    setRepoStatus(projectId, files) {
      db.load();
      db.setRepoStatus(projectId, { repo: true, branch: 'main', files, truncated: false });
    },
```

In `apps/web/src/test/app.tsx`, import `createForgeHandlers` and put `...createForgeHandlers(db),` first in `setupServer(...)`.

- [ ] **Step 8: Run the tests**

Run: `pnpm --filter @ace/web exec vitest run src/mocks`
Expected: PASS, the existing mock tests included.

- [ ] **Step 9: Commit**

```bash
npx prettier --write --config packages/config/prettier.config.js apps/web/src/mocks/files.ts apps/web/src/mocks/handlers-forge.ts apps/web/src/mocks/handlers-forge.test.ts
git add apps/web/src/mocks apps/web/src/test/app.tsx
git commit -m "test(web): the mock engine gets project folders, Forge's file routes and the project scope [D299] [FR-GIT-003]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Web — the files data layer

**Files:**
- Create: `apps/web/src/forge/files/paths.ts`, `apps/web/src/forge/files/keys.ts`, `apps/web/src/forge/files/hooks.ts`, `apps/web/src/forge/files/project-socket.ts`
- Test: create `apps/web/src/forge/files/paths.test.ts`, `apps/web/src/forge/files/project-socket.test.ts`

**Interfaces:**
- Consumes:
  - from Task 8: the SDK methods `api().listFolder`, `readFile`, `listAllFiles`, `repoStatus`, `createEntry`, `moveEntry`, `deleteEntry`;
  - existing: `getSocket()`.
- Produces:
  - from `paths.ts`: `parentOf`, `nameOf`, `joinPath`, `isWithin`, `movedPath`, `extensionOf`, `isImagePath`;
  - from `keys.ts`: `fileKeys.all | folder | content | list | status`;
  - from `hooks.ts`:
    - `useFolders(projectId, paths)`;
    - `useFileContent(projectId, path | undefined)` and `fileContentQuery(projectId, path)`;
    - `useFileList(projectId, enabled)`;
    - `useRepoStatus(projectId)`;
    - `invalidateAround(queryClient, projectId, paths)`;
    - `useCreateEntry(projectId)`, `useMoveEntry(projectId)`, `useDeleteEntry(projectId)`;
  - from `project-socket.ts`: `applyFilesChanged(queryClient, payload)` and `useProjectFiles(projectId)`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/forge/files/paths.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { extensionOf, isImagePath, isWithin, joinPath, movedPath, nameOf, parentOf } from './paths';

describe('D299 wire paths in the web app', () => {
  it('splits and joins forward-slash paths, the root being empty', () => {
    expect(parentOf('src/a/b.ts')).toBe('src/a');
    expect(parentOf('b.ts')).toBe('');
    expect(nameOf('src/a/b.ts')).toBe('b.ts');
    expect(joinPath('', 'a.ts')).toBe('a.ts');
    expect(joinPath('src', 'a.ts')).toBe('src/a.ts');
  });

  it('knows what lies within a folder, and where it lands after a move', () => {
    expect(isWithin('src/a.ts', 'src')).toBe(true);
    expect(isWithin('src', 'src')).toBe(true);
    expect(isWithin('srcx/a.ts', 'src')).toBe(false);
    expect(movedPath('src/a/b.ts', 'src/a', 'lib/a')).toBe('lib/a/b.ts');
    expect(movedPath('src/a', 'src/a', 'lib/a')).toBe('lib/a');
  });

  it('reads extensions, including dot files, and recognises images', () => {
    expect(extensionOf('a/b.TS')).toBe('ts');
    expect(extensionOf('.env')).toBe('');
    expect(isImagePath('logo.SVG')).toBe(true);
    expect(isImagePath('a.ts')).toBe(false);
  });
});
```

Create `apps/web/src/forge/files/project-socket.test.ts`:

```ts
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fileKeys } from './keys';
import { applyFilesChanged } from './project-socket';

const PID = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';
let client: QueryClient;

beforeEach(() => {
  vi.useFakeTimers();
  client = new QueryClient();
  for (const key of [
    fileKeys.folder(PID, ''),
    fileKeys.folder(PID, 'src'),
    fileKeys.folder(PID, 'src/deep'),
    fileKeys.content(PID, 'src/a.ts'),
    fileKeys.content(PID, 'src/deep/b.ts'),
    fileKeys.content(PID, 'README.md'),
    fileKeys.list(PID),
    fileKeys.status(PID),
  ]) {
    client.setQueryData(key, {});
  }
});
afterEach(() => vi.useRealTimers());

const stale = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated ?? false;

describe('D299 a files.changed burst refreshes what shows it', () => {
  it('a changed file: its folder and its content, not quick open’s list', () => {
    applyFilesChanged(client, { projectId: PID, changes: [{ path: 'src/a.ts', kind: 'changed' }], resync: false });
    expect(stale(fileKeys.folder(PID, 'src'))).toBe(true);
    expect(stale(fileKeys.content(PID, 'src/a.ts'))).toBe(true);
    expect(stale(fileKeys.content(PID, 'README.md'))).toBe(false);
    expect(stale(fileKeys.list(PID))).toBe(false);
  });

  it('a deleted folder: its parent, everything inside it, and the list', () => {
    applyFilesChanged(client, { projectId: PID, changes: [{ path: 'src/deep', kind: 'deleted' }], resync: false });
    expect(stale(fileKeys.folder(PID, 'src'))).toBe(true);
    expect(stale(fileKeys.folder(PID, 'src/deep'))).toBe(true);
    expect(stale(fileKeys.content(PID, 'src/deep/b.ts'))).toBe(true);
    expect(stale(fileKeys.content(PID, 'src/a.ts'))).toBe(false);
    expect(stale(fileKeys.list(PID))).toBe(true);
  });

  it('a resync refreshes everything of the project', () => {
    applyFilesChanged(client, { projectId: PID, changes: [], resync: true });
    expect(stale(fileKeys.content(PID, 'README.md'))).toBe(true);
    expect(stale(fileKeys.folder(PID, ''))).toBe(true);
  });

  it('refetches the repository status at most once a second', () => {
    const spy = vi.spyOn(client, 'invalidateQueries');
    for (let i = 0; i < 5; i += 1) {
      applyFilesChanged(client, { projectId: PID, changes: [{ path: 'README.md', kind: 'changed' }], resync: false });
    }
    const statusCalls = () => spy.mock.calls.filter(([filters]) => JSON.stringify(filters?.queryKey) === JSON.stringify(fileKeys.status(PID)));
    expect(statusCalls()).toHaveLength(0);
    vi.advanceTimersByTime(1000);
    expect(statusCalls()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run them to watch them fail**

Run: `pnpm --filter @ace/web exec vitest run src/forge/files`
Expected: FAIL, because the modules are missing.

- [ ] **Step 3: Write `paths.ts` and `keys.ts`**

Create `apps/web/src/forge/files/paths.ts`:

```ts
/** Forge's wire paths (D299): project-relative, forward slashes, `''` is the root. */

export const parentOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

export const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

export const joinPath = (folder: string, name: string): string => (folder === '' ? name : `${folder}/${name}`);

/** `path` is `prefix` itself or lies inside it. */
export const isWithin = (path: string, prefix: string): boolean =>
  prefix === '' || path === prefix || path.startsWith(`${prefix}/`);

/** Where `path` lands when `from` (it, or a folder holding it) moves to `to`. */
export const movedPath = (path: string, from: string, to: string): string =>
  path === from ? to : `${to}${path.slice(from.length)}`;

export const extensionOf = (path: string): string => {
  const name = nameOf(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
};

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif']);

export const isImagePath = (path: string): boolean => IMAGE_EXTENSIONS.has(extensionOf(path));
```

Create `apps/web/src/forge/files/keys.ts`:

```ts
/** Query keys for Forge's files, all under `['files', projectId]` so a resync is one invalidation. */
export const fileKeys = {
  all: (projectId: string) => ['files', projectId] as const,
  folder: (projectId: string, path: string) => ['files', projectId, 'folder', path] as const,
  content: (projectId: string, path: string) => ['files', projectId, 'content', path] as const,
  list: (projectId: string) => ['files', projectId, 'list'] as const,
  status: (projectId: string) => ['files', projectId, 'status'] as const,
};
```

- [ ] **Step 4: Write `hooks.ts`**

Create `apps/web/src/forge/files/hooks.ts`:

```ts
import type { CreateEntryRequest, MoveEntryRequest } from '@ace/contracts';
import { useMutation, useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { api } from '../../app/api';
import { fileKeys } from './keys';
import { parentOf } from './paths';

const folderQuery = (projectId: string, path: string) => ({
  queryKey: fileKeys.folder(projectId, path),
  queryFn: () => api().listFolder(projectId, path),
  staleTime: 30_000,
});

/** Every listed folder of the Explorer at once: the root and each expanded folder. */
export function useFolders(projectId: string, paths: readonly string[]) {
  return useQueries({ queries: paths.map((path) => ({ ...folderQuery(projectId, path), enabled: projectId !== '' })) });
}

/**
 * An open file's content. Never stale by time: the watcher invalidates it when the disk changes
 * (design §5.4), and a refetch then reconciles the buffer.
 */
export const fileContentQuery = (projectId: string, path: string) => ({
  queryKey: fileKeys.content(projectId, path),
  queryFn: () => api().readFile(projectId, path),
  staleTime: Infinity,
  retry: false,
});

export function useFileContent(projectId: string, path: string | undefined) {
  return useQuery({ ...fileContentQuery(projectId, path ?? ''), enabled: projectId !== '' && path !== undefined });
}

/** Quick open's list (Ctrl/⌘+P), fetched when it opens. */
export function useFileList(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: fileKeys.list(projectId),
    queryFn: () => api().listAllFiles(projectId),
    enabled: enabled && projectId !== '',
    staleTime: 60_000,
  });
}

/** The Explorer's git decorations; `files.changed` refreshes it at most once a second. */
export function useRepoStatus(projectId: string) {
  return useQuery({
    queryKey: fileKeys.status(projectId),
    queryFn: () => api().repoStatus(projectId),
    enabled: projectId !== '',
    staleTime: 1_000,
  });
}

/** After a create, move or delete: the folders that show the paths, quick open's list, the status. */
export function invalidateAround(queryClient: QueryClient, projectId: string, paths: readonly string[]): void {
  for (const path of paths) {
    void queryClient.invalidateQueries({ queryKey: fileKeys.folder(projectId, parentOf(path)) });
  }
  void queryClient.invalidateQueries({ queryKey: fileKeys.list(projectId) });
  void queryClient.invalidateQueries({ queryKey: fileKeys.status(projectId) });
}

export function useCreateEntry(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateEntryRequest) => api().createEntry(projectId, body),
    onSuccess: (entry) => invalidateAround(queryClient, projectId, [entry.path]),
  });
}

export function useMoveEntry(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: MoveEntryRequest) => api().moveEntry(projectId, body),
    onSuccess: (_entry, body) => invalidateAround(queryClient, projectId, [body.from, body.to]),
  });
}

export function useDeleteEntry(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => api().deleteEntry(projectId, path),
    onSuccess: (_nothing, path) => {
      invalidateAround(queryClient, projectId, [path]);
      queryClient.removeQueries({ queryKey: fileKeys.folder(projectId, path) });
    },
  });
}
```

- [ ] **Step 5: Write `project-socket.ts`**

Create `apps/web/src/forge/files/project-socket.ts`:

```ts
import type { FilesChangedPayload } from '@ace/contracts';
import type { AceSocket } from '@ace/sdk';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { getSocket } from '../../app/socket';
import { fileKeys } from './keys';
import { isWithin, parentOf } from './paths';

/** `/files/status` is refetched at most once a second, however fast the disk churns (design §6.1). */
const STATUS_THROTTLE_MS = 1_000;
const statusTimers = new Map<string, ReturnType<typeof setTimeout>>();

function refreshStatusSoon(queryClient: QueryClient, projectId: string): void {
  if (statusTimers.has(projectId)) return;
  statusTimers.set(
    projectId,
    setTimeout(() => {
      statusTimers.delete(projectId);
      void queryClient.invalidateQueries({ queryKey: fileKeys.status(projectId) });
    }, STATUS_THROTTLE_MS),
  );
}

/**
 * One `files.changed` burst into the query cache: the folder showing each path, the content of a
 * changed file, everything inside a created or deleted folder, and quick open's list.
 */
export function applyFilesChanged(queryClient: QueryClient, payload: FilesChangedPayload): void {
  const { projectId } = payload;
  refreshStatusSoon(queryClient, projectId);
  if (payload.resync) {
    void queryClient.invalidateQueries({ queryKey: fileKeys.all(projectId) });
    return;
  }
  let listChanged = false;
  for (const change of payload.changes) {
    void queryClient.invalidateQueries({ queryKey: fileKeys.folder(projectId, parentOf(change.path)) });
    if (change.kind === 'changed') {
      void queryClient.invalidateQueries({ queryKey: fileKeys.content(projectId, change.path) });
      continue;
    }
    listChanged = true;
    void queryClient.invalidateQueries({
      predicate: ({ queryKey }) => {
        const [scope, owner, kind, path] = queryKey;
        return (
          scope === 'files' &&
          owner === projectId &&
          (kind === 'content' || kind === 'folder') &&
          typeof path === 'string' &&
          path !== '' &&
          isWithin(path, change.path)
        );
      },
    });
  }
  if (listChanged) void queryClient.invalidateQueries({ queryKey: fileKeys.list(projectId) });
}

/** Per socket, so a restarted socket (tests) starts from zero. */
const watchers = new WeakMap<AceSocket, Map<string, number>>();

/**
 * While mounted: subscribe to the project's scope — the engine watches its folder meanwhile — and
 * fold each `files.changed` into the cache. Mounting also refreshes every file query of the
 * project, and so does a reconnect (`hello`): frames missed while away are never replayed,
 * because they are transient.
 */
export function useProjectFiles(projectId: string | undefined): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const socket = getSocket();
    if (!projectId) return;
    void queryClient.invalidateQueries({ queryKey: fileKeys.all(projectId) });
    if (!socket) return;
    const payload = { scope: 'project' as const, id: projectId };
    const counts = watchers.get(socket) ?? new Map<string, number>();
    watchers.set(socket, counts);
    const count = counts.get(projectId) ?? 0;
    counts.set(projectId, count + 1);
    if (count === 0) socket.subscribe(payload);
    const offChanged = socket.on('files.changed', (frame) => {
      if (frame.projectId === projectId) applyFilesChanged(queryClient, frame);
    });
    const offHello = socket.on('hello', () => {
      void queryClient.invalidateQueries({ queryKey: fileKeys.all(projectId) });
    });
    return () => {
      offChanged();
      offHello();
      const left = (counts.get(projectId) ?? 1) - 1;
      if (left > 0) {
        counts.set(projectId, left);
        return;
      }
      counts.delete(projectId);
      socket.unsubscribe(payload);
    };
  }, [projectId, queryClient]);
}
```

If `AceSocket.on`'s handler receives the whole frame rather than the payload, read `frame.payload`. Check `packages/sdk/src/socket.ts` `on` and copy the form `socket.on('workflow.updated', …)` uses in `app/socket.ts`.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @ace/web exec vitest run src/forge/files`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npx prettier --write --config packages/config/prettier.config.js apps/web/src/forge/files
git add apps/web/src/forge/files
git commit -m "feat(web): Forge's files data layer — queries, mutations and the project subscription [D299] [FR-GIT-003]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Web — the Explorer tree (browsing, keyboard, decorations)

**Files:**
- Create:
  - `apps/web/src/forge/explorer/explorer-store.ts`
  - `apps/web/src/forge/explorer/useTreeRows.ts`
  - `apps/web/src/forge/explorer/decorations.ts`
  - `apps/web/src/forge/explorer/FileIcon.tsx`
  - `apps/web/src/forge/explorer/FileTree.tsx`
- Test: create `apps/web/src/forge/explorer/decorations.test.ts`, `apps/web/src/forge/explorer/FileTree.test.tsx`
- Modify: `apps/web/src/test/app.tsx` (reset the explorer store)

**Interfaces:**
- Consumes (Task 10): `useFolders`, `useRepoStatus`, `parentOf`, `isWithin`, `movedPath`, `nameOf`, `extensionOf`.
- Produces:
  - `useExplorerStore`, with:
    - `projects[pid] = { expanded: string[]; selected?: string }`;
    - `toggle`, `expand` (also opens the ancestors), `collapse`, `collapseAll`, `select`, `moved`, `removed`.
  - `useProjectExplorer(projectId)`.
  - `useTreeRows(projectId): { rows: TreeRow[]; loading; error }`, where `TreeRow = { entry: FileEntry; depth: number }`.
  - `buildDecorations(status)`, which returns `{ file(path), folder(path) }`.
  - `TONE_COLOR`.
  - `FileIcon({ path, className })`.
  - `FileTree({ projectId, label, onOpen(path, { preview }) })`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/forge/explorer/decorations.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { buildDecorations } from './decorations';

describe('D299 the Explorer’s git decorations, as in VS Code', () => {
  const decorations = buildDecorations({
    repo: true,
    branch: 'main',
    truncated: false,
    files: [
      { path: 'src/app.ts', status: 'modified' },
      { path: 'src/new.ts', status: 'added' },
      { path: 'scratch', status: 'untracked' },
    ],
  });

  it('letters each changed file', () => {
    expect(decorations.file('src/app.ts')).toMatchObject({ letter: 'M', tone: 'modified' });
    expect(decorations.file('src/new.ts')).toMatchObject({ letter: 'A', tone: 'added' });
    expect(decorations.file('src/other.ts')).toBeUndefined();
  });

  it('marks everything inside an untracked folder untracked', () => {
    expect(decorations.file('scratch/notes/a.md')).toMatchObject({ letter: 'U' });
    expect(decorations.folder('scratch')).toBe('added');
  });

  it('colours a folder by the most important change inside it', () => {
    expect(decorations.folder('src')).toBe('modified');
    expect(decorations.folder('docs')).toBeUndefined();
  });

  it('decorates nothing when the folder is not a repository', () => {
    const none = buildDecorations({ repo: false });
    expect(none.file('a.ts')).toBeUndefined();
    expect(none.folder('src')).toBeUndefined();
  });
});
```

Create `apps/web/src/forge/explorer/FileTree.test.tsx`:

```tsx
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { db, installMockServer, renderWithQuery } from '../../test/app';
import { useExplorerStore } from './explorer-store';
import { FileTree } from './FileTree';

installMockServer();

function seed() {
  const project = db.createProject({ name: 'Shop' });
  db.seedFiles(project.id, {
    'src/app.ts': 'export {};',
    'src/util/math.ts': '',
    'README.md': '# Shop',
    'node_modules/x/index.js': '',
  });
  db.setRepoStatus(project.id, { repo: true, branch: 'main', truncated: false, files: [{ path: 'src/app.ts', status: 'modified' }] });
  return project.id;
}

describe('FR-GIT-003 the Explorer tree', () => {
  it('lists the root with folders first, ignored folders dimmed', async () => {
    const projectId = seed();
    renderWithQuery(<FileTree projectId={projectId} label="Files" onOpen={vi.fn()} />);
    const tree = await screen.findByRole('tree', { name: 'Files' });
    await waitFor(() => expect(within(tree).getAllByRole('treeitem').map((item) => item.textContent)).toEqual(['node_modules', 'src', 'README.md']));
    expect(screen.getByTestId('tree-item-node_modules')).toHaveClass('opacity-50');
  });

  it('expands a folder on click, showing its children one level deeper, with decorations', async () => {
    const user = userEvent.setup();
    const projectId = seed();
    renderWithQuery(<FileTree projectId={projectId} label="Files" onOpen={vi.fn()} />);
    await user.click(await screen.findByTestId('tree-item-src'));
    const app = await screen.findByTestId('tree-item-src/app.ts');
    expect(app).toHaveAttribute('aria-level', '2');
    expect(screen.getByTestId('tree-item-src')).toHaveAttribute('aria-expanded', 'true');
    expect(within(app).getByText('M')).toHaveAttribute('title', 'Modified');
  });

  it('opens a file as a preview on click, and pinned on double click or Enter', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const projectId = seed();
    renderWithQuery(<FileTree projectId={projectId} label="Files" onOpen={onOpen} />);
    await user.click(await screen.findByTestId('tree-item-README.md'));
    expect(onOpen).toHaveBeenLastCalledWith('README.md', { preview: true });
    await user.dblClick(screen.getByTestId('tree-item-README.md'));
    expect(onOpen).toHaveBeenLastCalledWith('README.md', { preview: false });
    await user.keyboard('{Enter}');
    expect(onOpen).toHaveBeenLastCalledWith('README.md', { preview: false });
  });

  it('moves with the arrow keys: down, right into a folder, left back out', async () => {
    const user = userEvent.setup();
    const projectId = seed();
    renderWithQuery(<FileTree projectId={projectId} label="Files" onOpen={vi.fn()} />);
    // focus, not click: a click on a folder also opens it
    act(() => screen.getByTestId('tree-item-node_modules').focus());
    await user.keyboard('{ArrowDown}');
    expect(useExplorerStore.getState().projects[projectId]?.selected, 'nothing selected yet: the first row').toBe('node_modules');
    await user.keyboard('{ArrowDown}');
    expect(useExplorerStore.getState().projects[projectId]?.selected).toBe('src');
    await user.keyboard('{ArrowRight}');
    await screen.findByTestId('tree-item-src/app.ts');
    await user.keyboard('{ArrowRight}');
    expect(useExplorerStore.getState().projects[projectId]?.selected).toBe('src/util');
    await user.keyboard('{ArrowLeft}');
    expect(useExplorerStore.getState().projects[projectId]?.selected).toBe('src');
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByTestId('tree-item-src')).toHaveAttribute('aria-expanded', 'false');
  });

  it('says so when the folder cannot be read', async () => {
    renderWithQuery(<FileTree projectId="01J9ZZZZZZZZZZZZZZZZZZZZZZ" label="Files" onOpen={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t read the project folder/i);
  });
});
```

- [ ] **Step 2: Run them to watch them fail**

Run: `pnpm --filter @ace/web exec vitest run src/forge/explorer`
Expected: FAIL, because the modules are missing.

- [ ] **Step 3: Write the store, rows and decorations**

Create `apps/web/src/forge/explorer/explorer-store.ts`:

```ts
import { create } from 'zustand';

import { isWithin, movedPath, parentOf } from '../files/paths';

export interface ProjectExplorer {
  /** Expanded folders; the tree walks these, so a folder's children load only once it is open. */
  expanded: string[];
  selected: string | undefined;
}

const EMPTY: ProjectExplorer = { expanded: [], selected: undefined };

interface ExplorerState {
  projects: Record<string, ProjectExplorer>;
  toggle(projectId: string, path: string): void;
  /** Expand a folder and every folder above it (reveal). */
  expand(projectId: string, path: string): void;
  collapse(projectId: string, path: string): void;
  collapseAll(projectId: string): void;
  select(projectId: string, path: string | undefined): void;
  /** A file or folder moved: expansion and selection follow it. */
  moved(projectId: string, from: string, to: string): void;
  /** A file or folder is gone: forget what was expanded or selected inside it. */
  removed(projectId: string, path: string): void;
}

const lineage = (path: string): string[] => {
  const out: string[] = [];
  for (let current = path; current !== ''; current = parentOf(current)) out.push(current);
  return out;
};

/** The Explorer's state per project, outside the component, so switching modes loses none of it (§2.3). */
export const useExplorerStore = create<ExplorerState>()((set) => {
  const update = (projectId: string, change: (current: ProjectExplorer) => ProjectExplorer) =>
    set((state) => ({ projects: { ...state.projects, [projectId]: change(state.projects[projectId] ?? EMPTY) } }));
  return {
    projects: {},
    toggle: (projectId, path) =>
      update(projectId, (c) => ({
        ...c,
        expanded: c.expanded.includes(path) ? c.expanded.filter((p) => p !== path) : [...c.expanded, path],
      })),
    expand: (projectId, path) =>
      update(projectId, (c) => {
        const missing = lineage(path).filter((p) => !c.expanded.includes(p));
        return missing.length === 0 ? c : { ...c, expanded: [...c.expanded, ...missing] };
      }),
    collapse: (projectId, path) => update(projectId, (c) => ({ ...c, expanded: c.expanded.filter((p) => p !== path) })),
    collapseAll: (projectId) => update(projectId, (c) => ({ ...c, expanded: [] })),
    select: (projectId, selected) => update(projectId, (c) => ({ ...c, selected })),
    moved: (projectId, from, to) =>
      update(projectId, (c) => ({
        expanded: c.expanded.map((p) => (isWithin(p, from) ? movedPath(p, from, to) : p)),
        selected: c.selected !== undefined && isWithin(c.selected, from) ? movedPath(c.selected, from, to) : c.selected,
      })),
    removed: (projectId, path) =>
      update(projectId, (c) => ({
        expanded: c.expanded.filter((p) => !isWithin(p, path)),
        selected: c.selected !== undefined && isWithin(c.selected, path) ? undefined : c.selected,
      })),
  };
});

export const useProjectExplorer = (projectId: string): ProjectExplorer =>
  useExplorerStore((state) => state.projects[projectId] ?? EMPTY);
```

Create `apps/web/src/forge/explorer/useTreeRows.ts`:

```ts
import type { FileEntry } from '@ace/contracts';

import { useFolders } from '../files/hooks';
import { useProjectExplorer } from './explorer-store';

export interface TreeRow {
  entry: FileEntry;
  /** 0 for the root's entries. */
  depth: number;
}

/** The visible rows: the root's entries, and each expanded folder's entries under it, in order. */
export function useTreeRows(projectId: string): { rows: TreeRow[]; loading: boolean; error: unknown } {
  const { expanded } = useProjectExplorer(projectId);
  const folders = ['', ...expanded];
  const results = useFolders(projectId, folders);
  const byFolder = new Map<string, FileEntry[]>();
  folders.forEach((folder, index) => {
    const items = results[index]?.data?.items;
    if (items) byFolder.set(folder, items);
  });
  const open = new Set(expanded);
  const rows: TreeRow[] = [];
  const walk = (folder: string, depth: number): void => {
    for (const entry of byFolder.get(folder) ?? []) {
      rows.push({ entry, depth });
      if (entry.kind === 'folder' && open.has(entry.path)) walk(entry.path, depth + 1);
    }
  };
  walk('', 0);
  return { rows, loading: results[0]?.isPending ?? true, error: results[0]?.error ?? null };
}
```

Create `apps/web/src/forge/explorer/decorations.ts`:

```ts
import type { RepoFileStatus, RepoStatus } from '@ace/contracts';

import { isWithin, parentOf } from '../files/paths';

export type DecorationTone = 'modified' | 'added' | 'deleted';

export interface Decoration {
  letter: 'M' | 'A' | 'U' | 'D' | 'R';
  tone: DecorationTone;
  title: string;
}

const BY_STATUS: Record<RepoFileStatus, Decoration> = {
  modified: { letter: 'M', tone: 'modified', title: 'Modified' },
  added: { letter: 'A', tone: 'added', title: 'Added' },
  untracked: { letter: 'U', tone: 'added', title: 'Untracked' },
  deleted: { letter: 'D', tone: 'deleted', title: 'Deleted' },
  renamed: { letter: 'R', tone: 'added', title: 'Renamed' },
};

/** When a folder holds several kinds of change, it takes the colour of the highest. */
const RANK: Record<DecorationTone, number> = { deleted: 0, added: 1, modified: 2 };

/** Theme tokens, so Night and Paper both read well. */
export const TONE_COLOR: Record<DecorationTone, string> = {
  modified: 'var(--color-status-WAITING)',
  added: 'var(--color-status-COMPLETED)',
  deleted: 'var(--color-danger)',
};

export interface Decorations {
  file(path: string): Decoration | undefined;
  folder(path: string): DecorationTone | undefined;
}

/** The Explorer's read-only git decorations (design §6.4), from `GET /files/status`. */
export function buildDecorations(status: RepoStatus | undefined): Decorations {
  if (status === undefined || !status.repo) return { file: () => undefined, folder: () => undefined };
  const files = new Map<string, Decoration>();
  const untracked: string[] = [];
  const folders = new Map<string, DecorationTone>();
  for (const { path, status: kind } of status.files) {
    const decoration = BY_STATUS[kind];
    files.set(path, decoration);
    if (kind === 'untracked') untracked.push(path);
    for (let folder = parentOf(path); folder !== ''; folder = parentOf(folder)) {
      const current = folders.get(folder);
      if (current === undefined || RANK[decoration.tone] > RANK[current]) folders.set(folder, decoration.tone);
    }
  }
  const insideUntracked = (path: string): boolean => untracked.some((folder) => isWithin(path, folder));
  return {
    file: (path) => files.get(path) ?? (insideUntracked(path) ? BY_STATUS.untracked : undefined),
    folder: (path) => folders.get(path) ?? files.get(path)?.tone ?? (insideUntracked(path) ? 'added' : undefined),
  };
}
```

- [ ] **Step 4: Write `FileIcon` and `FileTree`**

Create `apps/web/src/forge/explorer/FileIcon.tsx`:

```tsx
import { File, FileCode, FileImage, FileJson, FileText, type LucideIcon } from 'lucide-react';

import { extensionOf, isImagePath } from '../files/paths';

const CODE = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'cs', 'rb', 'php', 'sh', 'css', 'scss', 'html', 'vue', 'sql']);
const TEXT = new Set(['md', 'txt', 'log', 'csv', 'yml', 'yaml', 'toml', 'ini', 'env']);

function iconOf(path: string): LucideIcon {
  if (isImagePath(path)) return FileImage;
  const extension = extensionOf(path);
  if (extension === 'json' || extension === 'jsonc') return FileJson;
  if (CODE.has(extension)) return FileCode;
  if (TEXT.has(extension)) return FileText;
  return File;
}

export function FileIcon({ path, className }: { path: string; className?: string }) {
  const Icon = iconOf(path);
  return <Icon className={className ?? 'h-3.5 w-3.5 shrink-0 text-fg-muted'} aria-hidden />;
}
```

Create `apps/web/src/forge/explorer/FileTree.tsx`:

```tsx
import { cn } from '@ace/ui';
import { ChevronRight, Folder, FolderOpen } from 'lucide-react';
import { useMemo, useRef, type KeyboardEvent } from 'react';

import { useRepoStatus } from '../files/hooks';
import { parentOf } from '../files/paths';
import { buildDecorations, TONE_COLOR } from './decorations';
import { useExplorerStore, useProjectExplorer } from './explorer-store';
import { FileIcon } from './FileIcon';
import { useTreeRows, type TreeRow } from './useTreeRows';

export interface FileTreeProps {
  projectId: string;
  /** The tree's accessible name. */
  label: string;
  /** A single click previews; a double click or Enter pins (§6.2's preview tab). */
  onOpen(path: string, options: { preview: boolean }): void;
}

/**
 * The project folder as an ARIA tree (FR-GIT-003): lazy (a folder lists when it opens), folders
 * first, ignored entries dimmed, git decorations as in VS Code, keyboard navigation with one
 * roving tab stop.
 */
export function FileTree({ projectId, label, onOpen }: FileTreeProps) {
  const { rows, loading, error } = useTreeRows(projectId);
  const { expanded, selected } = useProjectExplorer(projectId);
  const toggle = useExplorerStore((s) => s.toggle);
  const select = useExplorerStore((s) => s.select);
  const status = useRepoStatus(projectId);
  const decorations = useMemo(() => buildDecorations(status.data), [status.data]);
  const rowElements = useRef(new Map<string, HTMLDivElement>());
  const typed = useRef({ text: '', at: 0 });

  const focusRow = (path: string): void => {
    select(projectId, path);
    rowElements.current.get(path)?.focus();
  };

  const activate = (row: TreeRow, preview: boolean): void => {
    if (row.entry.kind === 'folder') toggle(projectId, row.entry.path);
    else onOpen(row.entry.path, { preview });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = rows.findIndex((row) => row.entry.path === selected);
    const row = rows[index];
    const isOpen = row !== undefined && expanded.includes(row.entry.path);
    const go = (target: TreeRow | undefined) => {
      if (target) focusRow(target.entry.path);
    };
    switch (event.key) {
      case 'ArrowDown':
        go(rows[Math.min(index + 1, rows.length - 1)] ?? rows[0]);
        break;
      case 'ArrowUp':
        go(rows[Math.max(index - 1, 0)]);
        break;
      case 'Home':
        go(rows[0]);
        break;
      case 'End':
        go(rows[rows.length - 1]);
        break;
      case 'ArrowRight':
        if (row?.entry.kind !== 'folder') return;
        if (!isOpen) toggle(projectId, row.entry.path);
        else go(rows[index + 1]?.depth === row.depth + 1 ? rows[index + 1] : undefined);
        break;
      case 'ArrowLeft':
        if (row === undefined) return;
        if (row.entry.kind === 'folder' && isOpen) toggle(projectId, row.entry.path);
        else go(rows.find((candidate) => candidate.entry.path === parentOf(row.entry.path)));
        break;
      case 'Enter':
        if (row) activate(row, false);
        break;
      case ' ':
        if (row) activate(row, true);
        break;
      default: {
        if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
        const now = Date.now();
        typed.current = { text: now - typed.current.at < 600 ? typed.current.text + event.key.toLowerCase() : event.key.toLowerCase(), at: now };
        const after = [...rows.slice(index + 1), ...rows.slice(0, index + 1)];
        go(after.find((candidate) => candidate.entry.name.toLowerCase().startsWith(typed.current.text)));
        break;
      }
    }
    event.preventDefault();
  };

  if (error) {
    return (
      <p role="alert" className="px-3 py-2 text-[12px] text-danger">
        Couldn’t read the project folder: {error instanceof Error ? error.message : String(error)}
      </p>
    );
  }
  if (loading) return <p className="px-3 py-2 text-[12px] text-fg-muted">Reading the folder…</p>;

  return (
    <div role="tree" aria-label={label} className="py-1 outline-none" onKeyDown={onKeyDown}>
      {rows.length === 0 && <p className="px-3 py-2 text-[12px] text-fg-muted">This folder is empty.</p>}
      {rows.map((row) => {
        const { entry, depth } = row;
        const folder = entry.kind === 'folder';
        const isOpen = folder && expanded.includes(entry.path);
        const isSelected = entry.path === selected || (selected === undefined && row === rows[0]);
        const decoration = folder ? undefined : decorations.file(entry.path);
        const tone = folder ? decorations.folder(entry.path) : decoration?.tone;
        return (
          <div
            key={entry.path}
            ref={(element) => {
              if (element) rowElements.current.set(entry.path, element);
              else rowElements.current.delete(entry.path);
            }}
            role="treeitem"
            aria-level={depth + 1}
            aria-expanded={folder ? isOpen : undefined}
            aria-selected={entry.path === selected}
            tabIndex={isSelected ? 0 : -1}
            data-testid={`tree-item-${entry.path}`}
            title={entry.path}
            className={cn(
              'flex h-[22px] cursor-pointer select-none items-center gap-1 pr-2 font-machine text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent',
              entry.path === selected ? 'bg-selection/20 text-fg' : 'text-fg-soft hover:bg-card',
              entry.ignored && 'opacity-50',
            )}
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => {
              select(projectId, entry.path);
              activate(row, true);
            }}
            onDoubleClick={() => {
              if (!folder) onOpen(entry.path, { preview: false });
            }}
          >
            {folder ? (
              <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-fg-muted transition-transform', isOpen && 'rotate-90')} aria-hidden />
            ) : (
              <span className="w-3.5 shrink-0" />
            )}
            {folder ? (
              isOpen ? (
                <FolderOpen className="h-3.5 w-3.5 shrink-0 text-fg-muted" aria-hidden />
              ) : (
                <Folder className="h-3.5 w-3.5 shrink-0 text-fg-muted" aria-hidden />
              )
            ) : (
              <FileIcon path={entry.path} />
            )}
            <span className="min-w-0 flex-1 truncate" style={tone ? { color: TONE_COLOR[tone] } : undefined}>
              {entry.name}
            </span>
            {decoration && (
              <span className="pl-2 text-[10px] font-semibold" style={{ color: TONE_COLOR[decoration.tone] }} title={decoration.title}>
                {decoration.letter}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

The decoration letter is a child of the row, so the row's `textContent` would be `app.tsM`. The first test compares `textContent` of root rows, which carry no decoration. Keep it that way, or change that test to read the name span.

In `apps/web/src/test/app.tsx`, add `useExplorerStore.setState({ projects: {} });` to `beforeEach`.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @ace/web exec vitest run src/forge/explorer`
Expected: PASS. The "cannot be read" test relies on the mock answering 404 for an unknown project; the tree shows the alert.

- [ ] **Step 6: Commit**

```bash
npx prettier --write --config packages/config/prettier.config.js apps/web/src/forge/explorer
git add apps/web/src/forge/explorer apps/web/src/test/app.tsx
git commit -m "feat(web): the Explorer tree — lazy, keyboard-driven, with git decorations [D299] [FR-GIT-003]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Web — the Forge workbench shell: layout store, shortcuts, activity bar, panels, status bar

**Files:**
- Create:
  - `apps/web/src/app/shortcuts.ts`
  - `apps/web/src/app/stores/layout.ts`
  - `apps/web/src/app/layout/resize-handle.ts`
  - `apps/web/src/forge/ForgePage.tsx`
  - `apps/web/src/forge/ForgeWorkbench.tsx`
  - `apps/web/src/forge/layout/ActivityBar.tsx`
  - `apps/web/src/forge/layout/SideBar.tsx`
  - `apps/web/src/forge/layout/StatusBar.tsx`
  - `apps/web/src/forge/layout/IconAction.tsx`
  - `apps/web/src/forge/explorer/ExplorerView.tsx`
  - `apps/web/src/forge/panel/BottomPanel.tsx`
  - `apps/web/src/forge/panel/OutputView.tsx`
  - `apps/web/src/forge/panel/output-store.ts`
  - `apps/web/src/forge/editor/EmptyEditor.tsx`
- Modify: `apps/web/src/app/routes.tsx` (a temporary sibling route for `…/forge`; Task 13 nests it), `apps/web/src/test/setup.tsx` (the panels mock forwards `id`/`data-testid`), `apps/web/src/test/app.tsx` (reset layout and output)
- Test: create `apps/web/src/app/shortcuts.test.tsx`, `apps/web/src/app/stores/layout.test.ts`, `apps/web/src/forge/ForgeWorkbench.test.tsx`

**Interfaces:**
- Consumes:
  - from Task 11: `FileTree`, `useExplorerStore`;
  - from Task 10: `useProjectFiles`, `useRepoStatus`, `fileKeys`;
  - existing: `useProject`.
- Produces:
  - from `app/shortcuts.ts`:
    - `Shortcut`, `matches(event, shortcut)`, `shortcutLabel(shortcut)`;
    - `SHORTCUTS`, which has `ideate`, `forge`, `toggleChat`, `save`, `saveAll`, `quickOpen`, `toggleSidebar`, `togglePanel`, `closeTab`;
    - `useShortcuts(bindings, enabled?)`.
  - `useLayoutStore`, persisted under `ace.layout`. Its state is `chatOpen`, `sidebarOpen`, `sidebarView: 'explorer'`, `panelOpen` and `panelTab: ForgePanelTab`. Its actions are `toggleChat`, `toggleSidebar`, `showView`, `togglePanel`, `showPanel`, `closePanel`, `toggleMaximized`. The state also has `panelMaximized`.
  - `RESIZE_HANDLE_X` and `RESIZE_HANDLE_Y`.
  - `ForgePage` (route element) and `ForgeWorkbench({ projectId })`.
  - `useOutputStore` and `logOutput(projectId, level, message)`.
  - `IconAction({ label, Icon, onClick, disabled? })`.

- [ ] **Step 1: Forward ids in the panels mock**

In `apps/web/src/test/setup.tsx`, replace the `react-resizable-panels` mock with:

```tsx
vi.mock('react-resizable-panels', () => {
  type Props = { children?: ReactNode; className?: string; id?: string; 'data-testid'?: string };
  const Box = ({ children, className, id, 'data-testid': testId }: Props) => (
    <div className={className} id={id} data-testid={testId}>
      {children}
    </div>
  );
  return { Panel: Box, PanelGroup: Box, PanelResizeHandle: () => <div role="separator" /> };
});
```

- [ ] **Step 2: Write the failing tests**

Create `apps/web/src/app/shortcuts.test.tsx`:

```tsx
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { matches, SHORTCUTS, shortcutLabel, useShortcuts } from './shortcuts';

const press = (init: KeyboardEventInit, target: EventTarget = document.body) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

describe('D299 Forge’s keyboard shortcuts', () => {
  it('treats Ctrl and ⌘ alike and refuses extra modifiers', () => {
    const ctrlS = new KeyboardEvent('keydown', { code: 'KeyS', ctrlKey: true });
    const metaS = new KeyboardEvent('keydown', { code: 'KeyS', metaKey: true });
    const ctrlAltS = new KeyboardEvent('keydown', { code: 'KeyS', ctrlKey: true, altKey: true });
    expect(matches(ctrlS, SHORTCUTS.save)).toBe(true);
    expect(matches(metaS, SHORTCUTS.save)).toBe(true);
    expect(matches(ctrlAltS, SHORTCUTS.save)).toBe(false);
    expect(matches(ctrlAltS, SHORTCUTS.saveAll)).toBe(true);
  });

  it('matches the mode keys by code, so Shift+1 works on any layout', () => {
    expect(matches(new KeyboardEvent('keydown', { code: 'Digit2', key: '@', ctrlKey: true, shiftKey: true }), SHORTCUTS.forge)).toBe(true);
  });

  it('never binds a key the browser keeps for itself', () => {
    const reserved = ['KeyW', 'KeyT', 'KeyN', 'Tab', ...Array.from({ length: 9 }, (_, i) => `Digit${i + 1}`)];
    for (const shortcut of Object.values(SHORTCUTS)) {
      const plainMod = shortcut.mod === true && shortcut.shift !== true && shortcut.alt !== true;
      expect(plainMod && reserved.includes(shortcut.code), shortcutLabel(shortcut)).toBe(false);
    }
  });

  it('runs in the capture phase, before an editor sees the key, and stops the browser default', () => {
    const save = vi.fn();
    function Probe() {
      useShortcuts([[SHORTCUTS.save, save]]);
      return <textarea aria-label="editor" />;
    }
    const { getByLabelText } = render(<Probe />);
    const editorSaw = vi.fn();
    getByLabelText('editor').addEventListener('keydown', editorSaw);
    const event = press({ code: 'KeyS', ctrlKey: true }, getByLabelText('editor'));
    expect(save).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(editorSaw).not.toHaveBeenCalled();
  });
});
```

Create `apps/web/src/app/stores/layout.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';

import { LAYOUT_STORAGE_KEY, useLayoutStore } from './layout';

const initial = useLayoutStore.getState();
beforeEach(() => {
  localStorage.clear();
  useLayoutStore.setState(initial, true);
});

describe('D299 the workbench layout is the person’s choice, and is remembered', () => {
  it('starts with the chat and the side bar open and the bottom panel closed', () => {
    expect(useLayoutStore.getState()).toMatchObject({ chatOpen: true, sidebarOpen: true, panelOpen: false });
  });

  it('remembers each choice in the browser', () => {
    useLayoutStore.getState().togglePanel();
    useLayoutStore.getState().toggleChat();
    const saved = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) ?? '{}') as { state: Record<string, unknown> };
    expect(saved.state).toMatchObject({ panelOpen: true, chatOpen: false });
  });

  it('clicking the active view hides the side bar, as in VS Code', () => {
    useLayoutStore.getState().showView('explorer');
    expect(useLayoutStore.getState().sidebarOpen).toBe(false);
    useLayoutStore.getState().showView('explorer');
    expect(useLayoutStore.getState().sidebarOpen).toBe(true);
  });

  it('closing the panel also leaves maximized', () => {
    useLayoutStore.getState().toggleMaximized();
    useLayoutStore.getState().closePanel();
    expect(useLayoutStore.getState()).toMatchObject({ panelOpen: false, panelMaximized: false });
  });
});
```

Create `apps/web/src/forge/ForgeWorkbench.test.tsx`:

```tsx
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { useLayoutStore } from '../app/stores/layout';
import { db, installMockServer, renderApp } from '../test/app';

installMockServer();

function seed() {
  const project = db.createProject({ name: 'Shop' });
  const workflow = db.createWorkflow(project.id, 'Main');
  db.seedFiles(project.id, { 'src/app.ts': 'export {};', 'README.md': '# Shop' });
  return `/projects/${project.id}/workflows/${workflow.id}/forge`;
}

describe('D299 FR-GIT-003 the Forge workbench', () => {
  it('lays out the activity bar, the Explorer with the project’s files, the editor and the status bar', async () => {
    renderApp(seed());
    const forge = await screen.findByTestId('forge');
    expect(within(forge).getByRole('navigation', { name: 'Forge views' })).toBeInTheDocument();
    expect(await within(forge).findByRole('tree', { name: 'Files of Shop' })).toBeInTheDocument();
    expect(within(forge).getByRole('region', { name: 'Editor' })).toBeInTheDocument();
    expect(within(forge).getByTestId('status-bar')).toBeInTheDocument();
    expect(within(forge).queryByRole('region', { name: 'Panel' })).toBeNull();
  });

  it('hides and shows the side bar and the panel by button and by key, and remembers', async () => {
    const user = userEvent.setup();
    renderApp(seed());
    await screen.findByRole('tree', { name: 'Files of Shop' });

    await user.click(screen.getByRole('button', { name: 'Explorer' }));
    expect(screen.queryByRole('tree', { name: 'Files of Shop' })).toBeNull();
    await user.keyboard('{Control>}b{/Control}');
    expect(await screen.findByRole('tree', { name: 'Files of Shop' })).toBeInTheDocument();

    await user.keyboard('{Control>}j{/Control}');
    expect(screen.getByRole('region', { name: 'Panel' })).toBeInTheDocument();
    expect(useLayoutStore.getState().panelOpen).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Close panel' }));
    expect(screen.queryByRole('region', { name: 'Panel' })).toBeNull();
  });
});
```

(`db.createWorkflow(projectId, name)` is the mock's existing call; see `TopBar.test.tsx`.)

- [ ] **Step 3: Run them to watch them fail**

Run: `pnpm --filter @ace/web exec vitest run src/app/shortcuts.test.tsx src/app/stores/layout.test.ts src/forge/ForgeWorkbench.test.tsx`
Expected: FAIL, because the modules are missing.

- [ ] **Step 4: Write the shortcuts module**

Create `apps/web/src/app/shortcuts.ts`:

```ts
import { useEffect, useRef } from 'react';

/**
 * A keyboard shortcut, matched on `event.code` (the key's place, so Shift+1 is `Digit1` on every
 * layout). `mod` is Ctrl on Windows and Linux and ⌘ on macOS; the other modifiers must match
 * exactly, so Ctrl+S and Ctrl+Alt+S are different shortcuts.
 */
export interface Shortcut {
  code: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export function matches(event: KeyboardEvent, shortcut: Shortcut): boolean {
  return (
    event.code === shortcut.code &&
    (event.ctrlKey || event.metaKey) === (shortcut.mod ?? false) &&
    event.shiftKey === (shortcut.shift ?? false) &&
    event.altKey === (shortcut.alt ?? false)
  );
}

/**
 * Forge's shortcuts (D299, design §6.2). The browser keeps Ctrl/⌘+W, T, N, Ctrl+Tab and
 * Ctrl/⌘+1…9 for itself and a page cannot take them, so none is bound here.
 */
export const SHORTCUTS = {
  ideate: { code: 'Digit1', mod: true, shift: true },
  forge: { code: 'Digit2', mod: true, shift: true },
  toggleChat: { code: 'KeyB', mod: true, alt: true },
  save: { code: 'KeyS', mod: true },
  saveAll: { code: 'KeyS', mod: true, alt: true },
  quickOpen: { code: 'KeyP', mod: true },
  toggleSidebar: { code: 'KeyB', mod: true },
  togglePanel: { code: 'KeyJ', mod: true },
  closeTab: { code: 'KeyW', alt: true },
} as const satisfies Record<string, Shortcut>;

const isMac = (): boolean => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** "Ctrl+Shift+2" on Windows, "⌘⇧2" on a Mac — for titles and the empty editor's hints. */
export function shortcutLabel(shortcut: Shortcut): string {
  const key = shortcut.code.replace(/^Key|^Digit/, '');
  if (isMac()) return `${shortcut.mod ? '⌘' : ''}${shortcut.alt ? '⌥' : ''}${shortcut.shift ? '⇧' : ''}${key}`;
  return [shortcut.mod && 'Ctrl', shortcut.alt && 'Alt', shortcut.shift && 'Shift', key].filter(Boolean).join('+');
}

/**
 * Binds shortcuts on `window` in the capture phase, so they run before Monaco, an input or the
 * terminal sees the key, and stop the browser's default (Ctrl+S would otherwise save the page).
 */
export function useShortcuts(bindings: ReadonlyArray<readonly [Shortcut, () => void]>, enabled = true): void {
  const current = useRef(bindings);
  current.current = bindings;
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      for (const [shortcut, run] of current.current) {
        if (!matches(event, shortcut)) continue;
        event.preventDefault();
        event.stopPropagation();
        run();
        return;
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [enabled]);
}
```

- [ ] **Step 5: Write the layout store and the resize handles**

Create `apps/web/src/app/stores/layout.ts`:

```ts
import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

export type ForgeView = 'explorer';
export type ForgePanelTab = 'output';

interface LayoutState {
  /** The chat column, in Ideate and in Forge (D299). */
  chatOpen: boolean;
  sidebarOpen: boolean;
  sidebarView: ForgeView;
  /** Forge's bottom panel: the person's choice, closed until first opened. */
  panelOpen: boolean;
  panelTab: ForgePanelTab;
  panelMaximized: boolean;
  toggleChat(): void;
  toggleSidebar(): void;
  /** Activity bar: the active view's icon hides the side bar, another one shows that view. */
  showView(view: ForgeView): void;
  togglePanel(): void;
  showPanel(tab: ForgePanelTab): void;
  closePanel(): void;
  toggleMaximized(): void;
}

export const LAYOUT_STORAGE_KEY = 'ace.layout';

const memory = new Map<string, string>();
const memoryStorage: StateStorage = {
  getItem: (name) => memory.get(name) ?? null,
  setItem: (name, value) => void memory.set(name, value),
  removeItem: (name) => void memory.delete(name),
};

/** localStorage when the browser allows it; private mode and blocked storage fall back to memory. */
function storage(): StateStorage {
  try {
    const probe = '__ace_probe__';
    localStorage.setItem(probe, probe);
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return memoryStorage;
  }
}

/** Which panels are open and on which view, remembered in the browser (D299, design §2.2). */
export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      chatOpen: true,
      sidebarOpen: true,
      sidebarView: 'explorer',
      panelOpen: false,
      panelTab: 'output',
      panelMaximized: false,
      toggleChat: () => set((s) => ({ chatOpen: !s.chatOpen })),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      showView: (view) =>
        set((s) => ({ sidebarView: view, sidebarOpen: s.sidebarView === view ? !s.sidebarOpen : true })),
      togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen, panelMaximized: s.panelOpen ? false : s.panelMaximized })),
      showPanel: (panelTab) => set({ panelTab, panelOpen: true }),
      closePanel: () => set({ panelOpen: false, panelMaximized: false }),
      toggleMaximized: () => set((s) => ({ panelMaximized: !s.panelMaximized, panelOpen: true })),
    }),
    {
      name: LAYOUT_STORAGE_KEY,
      storage: createJSONStorage(storage),
      partialize: (s) => ({
        chatOpen: s.chatOpen,
        sidebarOpen: s.sidebarOpen,
        sidebarView: s.sidebarView,
        panelOpen: s.panelOpen,
        panelTab: s.panelTab,
      }),
    },
  ),
);
```

Create `apps/web/src/app/layout/resize-handle.ts`:

```ts
/** A one-pixel rule that lights up while dragged (react-resizable-panels sets the data attribute). */
const HANDLE = 'shrink-0 bg-border transition-colors hover:bg-fg-faint data-[resize-handle-state=drag]:bg-accent';
export const RESIZE_HANDLE_X = `w-px ${HANDLE}`;
export const RESIZE_HANDLE_Y = `h-px ${HANDLE}`;
```

In `apps/web/src/test/app.tsx`, reset in `beforeEach`. Capture `const initialLayout = useLayoutStore.getState();` at module level, like `initialPanels`. Then reset with `useLayoutStore.setState(initialLayout, true);` and `useOutputStore.setState({ lines: {} });`, and call `localStorage.removeItem(LAYOUT_STORAGE_KEY);`.

- [ ] **Step 6: Write the Output store and view**

Create `apps/web/src/forge/panel/output-store.ts`:

```ts
import { create } from 'zustand';

export type OutputLevel = 'info' | 'warn' | 'error';

export interface OutputLine {
  id: number;
  at: string;
  level: OutputLevel;
  message: string;
}

const MAX_LINES = 500;
let nextId = 1;

interface OutputState {
  lines: Record<string, OutputLine[]>;
  log(projectId: string, level: OutputLevel, message: string): void;
  clear(projectId: string): void;
}

/** Forge's Output panel (design §6.4): what happened to the workspace, in words — saves, conflicts, refusals. */
export const useOutputStore = create<OutputState>()((set) => ({
  lines: {},
  log: (projectId, level, message) =>
    set((state) => ({
      lines: {
        ...state.lines,
        [projectId]: [...(state.lines[projectId] ?? []), { id: nextId++, at: new Date().toISOString(), level, message }].slice(-MAX_LINES),
      },
    })),
  clear: (projectId) => set((state) => ({ lines: { ...state.lines, [projectId]: [] } })),
}));

export const logOutput = (projectId: string, level: OutputLevel, message: string): void =>
  useOutputStore.getState().log(projectId, level, message);
```

Create `apps/web/src/forge/panel/OutputView.tsx`:

```tsx
import { cn } from '@ace/ui';
import { Trash2 } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { IconAction } from '../layout/IconAction';
import { useOutputStore, type OutputLine } from './output-store';

const EMPTY: OutputLine[] = [];
const LEVEL_CLASS = { info: 'text-fg-muted', warn: 'text-[var(--color-status-WAITING)]', error: 'text-danger' } as const;

export function OutputView({ projectId }: { projectId: string }) {
  const lines = useOutputStore((s) => s.lines[projectId] ?? EMPTY);
  const clear = useOutputStore((s) => s.clear);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [lines.length]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-7 shrink-0 items-center justify-end px-2">
        <IconAction label="Clear output" Icon={Trash2} onClick={() => clear(projectId)} disabled={lines.length === 0} />
      </div>
      <div role="log" aria-label="Output" className="min-h-0 flex-1 overflow-auto px-3 pb-2 font-machine text-[12px]">
        {lines.length === 0 && <p className="text-fg-muted">Nothing yet. Saves, conflicts and file errors appear here.</p>}
        {lines.map((line) => (
          <div key={line.id} className="flex gap-3 leading-5">
            <time className="shrink-0 text-fg-faint" dateTime={line.at}>
              {new Date(line.at).toLocaleTimeString()}
            </time>
            <span className={cn('whitespace-pre-wrap', LEVEL_CLASS[line.level])}>{line.message}</span>
          </div>
        ))}
        <div ref={end} />
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Write the workbench pieces**

Create `apps/web/src/forge/layout/IconAction.tsx`:

```tsx
import { cn } from '@ace/ui';
import type { LucideIcon } from 'lucide-react';

/** A small icon button with its name as the label and the tooltip. */
export function IconAction({
  label,
  Icon,
  onClick,
  disabled = false,
  pressed,
}: {
  label: string;
  Icon: LucideIcon;
  onClick(): void;
  disabled?: boolean;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'grid h-6 w-6 place-items-center rounded text-fg-muted hover:bg-card hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40',
        pressed === true && 'bg-card text-fg',
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
    </button>
  );
}
```

Create `apps/web/src/forge/layout/ActivityBar.tsx`:

```tsx
import { cn } from '@ace/ui';
import { Files, type LucideIcon } from 'lucide-react';

import { SHORTCUTS, shortcutLabel } from '../../app/shortcuts';
import { useLayoutStore, type ForgeView } from '../../app/stores/layout';

/** Phase 1 has the Explorer; Search arrives in Phase 4 and Changes in Phase 3, each with its view. */
const VIEWS: ReadonlyArray<{ view: ForgeView; label: string; Icon: LucideIcon }> = [
  { view: 'explorer', label: 'Explorer', Icon: Files },
];

export function ActivityBar() {
  const sidebarOpen = useLayoutStore((s) => s.sidebarOpen);
  const sidebarView = useLayoutStore((s) => s.sidebarView);
  const showView = useLayoutStore((s) => s.showView);
  return (
    <nav aria-label="Forge views" className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-border bg-panel py-2">
      {VIEWS.map(({ view, label, Icon }) => {
        const active = sidebarOpen && sidebarView === view;
        return (
          <button
            key={view}
            type="button"
            aria-label={label}
            aria-pressed={active}
            data-testid={`activity-${view}`}
            title={`${label} (${shortcutLabel(SHORTCUTS.toggleSidebar)})`}
            onClick={() => showView(view)}
            className={cn(
              'relative grid h-10 w-10 place-items-center text-fg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
              active && 'text-fg before:absolute before:left-[-2px] before:h-6 before:w-0.5 before:rounded before:bg-fg',
            )}
          >
            <Icon className="h-5 w-5" aria-hidden />
          </button>
        );
      })}
    </nav>
  );
}
```

Create `apps/web/src/forge/explorer/ExplorerView.tsx`:

```tsx
import { useQueryClient } from '@tanstack/react-query';
import { ChevronsDownUp, RefreshCw } from 'lucide-react';

import { useProject } from '../../projects/hooks';
import { fileKeys } from '../files/keys';
import { IconAction } from '../layout/IconAction';
import { useExplorerStore } from './explorer-store';
import { FileTree } from './FileTree';

/** The Explorer view (design §6.4). Task 14 adds Open editors above, Task 16 the create buttons. */
export function ExplorerView({ projectId }: { projectId: string }) {
  const project = useProject(projectId);
  const queryClient = useQueryClient();
  const collapseAll = useExplorerStore((s) => s.collapseAll);
  const select = useExplorerStore((s) => s.select);
  const name = project.data?.name ?? 'Project';
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-9 shrink-0 items-center px-3 font-machine text-[10.5px] uppercase tracking-[0.12em] text-fg-muted">
        Explorer
      </header>
      <section aria-label={name} className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-7 shrink-0 items-center gap-0.5 px-2">
          <h3 className="min-w-0 flex-1 truncate font-machine text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-soft">{name}</h3>
          <IconAction label="Refresh Explorer" Icon={RefreshCw} onClick={() => void queryClient.invalidateQueries({ queryKey: fileKeys.all(projectId) })} />
          <IconAction label="Collapse folders" Icon={ChevronsDownUp} onClick={() => collapseAll(projectId)} />
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <FileTree projectId={projectId} label={`Files of ${name}`} onOpen={(path) => select(projectId, path)} />
        </div>
      </section>
    </div>
  );
}
```

Create `apps/web/src/forge/layout/SideBar.tsx`:

```tsx
import { useLayoutStore } from '../../app/stores/layout';
import { ExplorerView } from '../explorer/ExplorerView';

export function SideBar({ projectId }: { projectId: string }) {
  const view = useLayoutStore((s) => s.sidebarView);
  return (
    <aside aria-label="Side bar" className="flex h-full min-h-0 flex-col border-r border-border bg-panel">
      {view === 'explorer' && <ExplorerView projectId={projectId} />}
    </aside>
  );
}
```

Create `apps/web/src/forge/panel/BottomPanel.tsx`:

```tsx
import { cn } from '@ace/ui';
import { Maximize2, Minimize2, X } from 'lucide-react';

import { useLayoutStore, type ForgePanelTab } from '../../app/stores/layout';
import { IconAction } from '../layout/IconAction';
import { OutputView } from './OutputView';

/** Phase 1: Problems (Task 18) and Output. The Terminal arrives in Phase 2 with its view. */
const TABS: ReadonlyArray<{ tab: ForgePanelTab; label: string }> = [{ tab: 'output', label: 'Output' }];

export function BottomPanel({ projectId }: { projectId: string }) {
  const panelTab = useLayoutStore((s) => s.panelTab);
  const showPanel = useLayoutStore((s) => s.showPanel);
  const closePanel = useLayoutStore((s) => s.closePanel);
  const maximized = useLayoutStore((s) => s.panelMaximized);
  const toggleMaximized = useLayoutStore((s) => s.toggleMaximized);
  return (
    <section aria-label="Panel" className="flex h-full min-h-0 flex-col border-t border-border bg-panel">
      <div className="flex h-8 shrink-0 items-center gap-4 px-3">
        <div role="tablist" aria-label="Panel views" className="flex h-full items-center gap-4">
          {TABS.map(({ tab, label }) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={panelTab === tab}
              onClick={() => showPanel(tab)}
              className={cn(
                'h-full border-b font-machine text-[10.5px] uppercase tracking-[0.1em]',
                panelTab === tab ? 'border-fg text-fg' : 'border-transparent text-fg-muted hover:text-fg',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <IconAction label={maximized ? 'Restore panel size' : 'Maximize panel'} Icon={maximized ? Minimize2 : Maximize2} onClick={toggleMaximized} />
        <IconAction label="Close panel" Icon={X} onClick={closePanel} />
      </div>
      <div role="tabpanel" className="min-h-0 flex-1">
        {panelTab === 'output' && <OutputView projectId={projectId} />}
      </div>
    </section>
  );
}
```

Create `apps/web/src/forge/layout/StatusBar.tsx`:

```tsx
import { GitBranch, PanelBottom } from 'lucide-react';

import { SHORTCUTS, shortcutLabel } from '../../app/shortcuts';
import { useLayoutStore } from '../../app/stores/layout';
import { useRepoStatus } from '../files/hooks';

/** VS Code's status bar (design §2.2). Task 18 adds the problem counts and the editor's fields. */
export function StatusBar({ projectId }: { projectId: string }) {
  const status = useRepoStatus(projectId);
  const panelOpen = useLayoutStore((s) => s.panelOpen);
  const togglePanel = useLayoutStore((s) => s.togglePanel);
  const branch = status.data?.repo === true ? status.data.branch : undefined;
  return (
    <footer data-testid="status-bar" className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-panel px-3 font-machine text-[11px] text-fg-muted">
      {branch && (
        <span className="flex items-center gap-1" title="Current branch (read-only)">
          <GitBranch className="h-3 w-3" aria-hidden />
          {branch}
        </span>
      )}
      <div className="flex-1" />
      <button
        type="button"
        aria-pressed={panelOpen}
        onClick={togglePanel}
        title={`Toggle panel (${shortcutLabel(SHORTCUTS.togglePanel)})`}
        className="flex items-center gap-1 hover:text-fg"
      >
        <PanelBottom className="h-3 w-3" aria-hidden />
        Panel
      </button>
    </footer>
  );
}
```

Create `apps/web/src/forge/editor/EmptyEditor.tsx`:

```tsx
import { SHORTCUTS, shortcutLabel, type Shortcut } from '../../app/shortcuts';

/** What the editor area shows with no file open: real actions, with their keys (design §2.2). */
const HINTS: ReadonlyArray<{ label: string; shortcut: Shortcut }> = [
  { label: 'Show or hide the Explorer', shortcut: SHORTCUTS.toggleSidebar },
  { label: 'Show or hide the panel', shortcut: SHORTCUTS.togglePanel },
  { label: 'Show or hide the chat', shortcut: SHORTCUTS.toggleChat },
  { label: 'Back to Ideate', shortcut: SHORTCUTS.ideate },
];

export function EmptyEditor() {
  return (
    <div className="grid h-full place-items-center bg-canvas">
      <div className="space-y-4 text-center">
        <p className="font-human text-2xl text-fg-soft">Forge</p>
        <p className="text-[13px] text-fg-muted">Open a file from the Explorer.</p>
        <dl className="mx-auto grid w-max grid-cols-[auto_auto] gap-x-6 gap-y-1.5 text-left text-[12px]">
          {HINTS.map(({ label, shortcut }) => (
            <div key={label} className="contents">
              <dt className="text-fg-muted">{label}</dt>
              <dd className="font-machine text-fg-soft">{shortcutLabel(shortcut)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
```

Create `apps/web/src/forge/ForgeWorkbench.tsx`:

```tsx
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';

import { RESIZE_HANDLE_X, RESIZE_HANDLE_Y } from '../app/layout/resize-handle';
import { SHORTCUTS, useShortcuts } from '../app/shortcuts';
import { useLayoutStore } from '../app/stores/layout';
import { EmptyEditor } from './editor/EmptyEditor';
import { ActivityBar } from './layout/ActivityBar';
import { SideBar } from './layout/SideBar';
import { StatusBar } from './layout/StatusBar';
import { BottomPanel } from './panel/BottomPanel';

/**
 * Forge laid out like VS Code (D299, design §2.2): activity bar, side bar, editor, bottom panel and
 * status bar. Every panel is resizable (sizes saved by react-resizable-panels under `autoSaveId`)
 * and hideable (visibility in the layout store); a hidden panel is not rendered, so each
 * combination keeps its own remembered sizes. The chat column is the layout's, not Forge's.
 */
export function ForgeWorkbench({ projectId }: { projectId: string }) {
  const sidebarOpen = useLayoutStore((s) => s.sidebarOpen);
  const panelOpen = useLayoutStore((s) => s.panelOpen);
  const maximized = useLayoutStore((s) => s.panelMaximized);
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);
  const togglePanel = useLayoutStore((s) => s.togglePanel);
  useShortcuts([
    [SHORTCUTS.toggleSidebar, toggleSidebar],
    [SHORTCUTS.togglePanel, togglePanel],
  ]);
  const showEditor = !(panelOpen && maximized);

  return (
    <div data-testid="forge" className="flex h-full min-h-0 min-w-0 flex-col bg-canvas">
      <div className="flex min-h-0 flex-1">
        <ActivityBar />
        <PanelGroup direction="horizontal" autoSaveId="ace.forge.columns" className="min-h-0 min-w-0 flex-1">
          {sidebarOpen && (
            <>
              <Panel id="forge-sidebar" order={1} defaultSize={22} minSize={12} maxSize={45} className="min-h-0 min-w-0">
                <SideBar projectId={projectId} />
              </Panel>
              <PanelResizeHandle className={RESIZE_HANDLE_X} />
            </>
          )}
          <Panel id="forge-main" order={2} minSize={30} className="min-h-0 min-w-0">
            <PanelGroup direction="vertical" autoSaveId="ace.forge.rows" className="h-full">
              {showEditor && (
                <Panel id="forge-editor" order={1} minSize={20} className="min-h-0 min-w-0">
                  <section aria-label="Editor" className="h-full min-h-0">
                    <EmptyEditor />
                  </section>
                </Panel>
              )}
              {panelOpen && (
                <>
                  {showEditor && <PanelResizeHandle className={RESIZE_HANDLE_Y} />}
                  <Panel id="forge-panel" order={2} defaultSize={30} minSize={10} className="min-h-0 min-w-0">
                    <BottomPanel projectId={projectId} />
                  </Panel>
                </>
              )}
            </PanelGroup>
          </Panel>
        </PanelGroup>
      </div>
      <StatusBar projectId={projectId} />
    </div>
  );
}
```

Create `apps/web/src/forge/ForgePage.tsx`:

```tsx
import { useParams } from 'react-router-dom';

import { useProjectFiles } from './files/project-socket';
import { ForgeWorkbench } from './ForgeWorkbench';

/** The Forge route element (D299). The project's folder is watched while it is mounted. */
export function ForgePage() {
  const { projectId = '' } = useParams();
  useProjectFiles(projectId);
  return <ForgeWorkbench projectId={projectId} />;
}
```

In `apps/web/src/app/routes.tsx`, add a route after the workflow route (Task 13 nests it):

```tsx
      { path: 'projects/:projectId/workflows/:workflowId/forge', element: <ForgePage /> },
```

- [ ] **Step 8: Run the tests**

Run: `pnpm --filter @ace/web exec vitest run src/app/shortcuts.test.tsx src/app/stores/layout.test.ts src/forge`
Expected: PASS.

- [ ] **Step 9: Run the whole web suite and commit**

Run: `pnpm --filter @ace/web test`
Expected: PASS. If any existing test relied on the old panels mock dropping `data-testid`, update it.

```bash
npx prettier --write --config packages/config/prettier.config.js apps/web/src/forge apps/web/src/app/shortcuts.ts apps/web/src/app/shortcuts.test.tsx apps/web/src/app/stores/layout.ts apps/web/src/app/stores/layout.test.ts apps/web/src/app/layout/resize-handle.ts
git add apps/web/src
git commit -m "feat(web): the Forge workbench — activity bar, Explorer, panel and status bar, every panel the person's choice [D299] [FR-GIT-003]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Web — `WorkflowLayout`, the `Ideate | Forge` switch and the shared chat column

**Files:**
- Create: `apps/web/src/forge/mode.ts`, `apps/web/src/app/layout/ModeSwitch.tsx`, `apps/web/src/workflows/WorkflowLayout.tsx`
- Modify: `apps/web/src/app/routes.tsx`, `apps/web/src/workflows/WorkflowPage.tsx`, `apps/web/src/workflows/WorkflowTabs.tsx`, `apps/web/src/app/layout/TopBar.tsx`
- Test: create `apps/web/src/workflows/WorkflowLayout.test.tsx`; modify `apps/web/src/workflows/WorkflowPage.test.tsx`

**Interfaces:**
- Consumes:
  - from Task 12: `useLayoutStore`, `SHORTCUTS`, `useShortcuts`, `shortcutLabel`, `RESIZE_HANDLE_X`, `ForgePage`;
  - existing: `ChatAside`, `useWorkflowSubscription`, `useRunEvents`, `useAdoptActiveRun`, `useWorkflowGraph`, `useIsCompact`.
- Produces:
  - `WorkflowMode = 'ideate' | 'forge'`;
  - `workflowPath(projectId, workflowId, mode)`;
  - `useWorkflowMode()`;
  - `ModeSwitch({ projectId, workflowId })`;
  - `WorkflowLayout`, the parent route element: its index child is `WorkflowPage` (Ideate) and its `forge` child is `ForgePage`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/workflows/WorkflowLayout.test.tsx`:

```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { useLayoutStore } from '../app/stores/layout';
import { db, installMockServer, renderApp } from '../test/app';

installMockServer();

vi.mock('../canvas/Canvas', () => ({
  Canvas: ({ workflowId }: { workflowId: string }) => <div data-testid="canvas">{workflowId}</div>,
}));

function seed() {
  const project = db.createProject({ name: 'Shop' });
  const main = db.createWorkflow(project.id, 'Main');
  const second = db.createWorkflow(project.id, 'Second');
  db.seedFiles(project.id, { 'README.md': '# Shop' });
  return { project, main, second, ideate: `/projects/${project.id}/workflows/${main.id}` };
}

describe('D299 Ideate and Forge, one click apart', () => {
  it('lands in Ideate with the switch on Ideate and the chat on the right', async () => {
    renderApp(seed().ideate);
    expect(await screen.findByTestId('canvas')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Ideate/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('chat-aside')).toBeInTheDocument();
  });

  it('switches to Forge and back by button, keeping the very same chat column mounted', async () => {
    const user = userEvent.setup();
    const { router } = renderApp(seed().ideate);
    const chat = await screen.findByTestId('chat-aside');

    await user.click(screen.getByRole('radio', { name: /Forge/ }));
    expect(await screen.findByTestId('forge')).toBeInTheDocument();
    expect(router.state.location.pathname).toMatch(/\/forge$/);
    expect(screen.getByTestId('chat-aside')).toBe(chat);

    await user.click(screen.getByRole('radio', { name: /Ideate/ }));
    expect(await screen.findByTestId('canvas')).toBeInTheDocument();
    expect(screen.getByTestId('chat-aside')).toBe(chat);
  });

  it('switches by Ctrl+Shift+2 and Ctrl+Shift+1, and hides the chat with Ctrl+Alt+B', async () => {
    const user = userEvent.setup();
    renderApp(seed().ideate);
    await screen.findByTestId('canvas');
    await user.keyboard('{Control>}{Shift>}2{/Shift}{/Control}');
    expect(await screen.findByTestId('forge')).toBeInTheDocument();
    await user.keyboard('{Control>}{Shift>}1{/Shift}{/Control}');
    expect(await screen.findByTestId('canvas')).toBeInTheDocument();
    await user.keyboard('{Control>}{Alt>}b{/Alt}{/Control}');
    expect(screen.queryByTestId('chat-aside')).toBeNull();
    expect(useLayoutStore.getState().chatOpen).toBe(false);
  });

  it('keeps the mode when another workflow’s tab is chosen', async () => {
    const user = userEvent.setup();
    const { project, second, ideate } = seed();
    const { router } = renderApp(`${ideate}/forge`);
    await screen.findByTestId('forge');
    await user.click(await screen.findByRole('tab', { name: 'Second' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/projects/${project.id}/workflows/${second.id}/forge`));
  });

  it('shows New node and the workflow panel toggle in Ideate only', async () => {
    const user = userEvent.setup();
    renderApp(seed().ideate);
    expect(await screen.findByTestId('new-node-button')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Forge/ }));
    await screen.findByTestId('forge');
    expect(screen.queryByTestId('new-node-button')).toBeNull();
    expect(screen.queryByTestId('sheet-toggle')).toBeNull();
  });

  it('says so when the workflow does not exist', async () => {
    const { project } = seed();
    renderApp(`/projects/${project.id}/workflows/01J9ZZZZZZZZZZZZZZZZZZZZZZ/forge`);
    expect(await screen.findByRole('alert')).toHaveTextContent('Workflow not found.');
  });
});
```

In `apps/web/src/workflows/WorkflowPage.test.tsx`, replace the first test's layout assertions. Delete the `toHaveClass('grid', 'h-full', 'grid-cols-[minmax(0,1fr)_340px]')` check on `workflow-page`, and the assumption that the chat column is a grid child of `workflow-page`. Use:

```tsx
    const page = screen.getByTestId('workflow-page');
    // the chat column is the layout's (D299): beside the page, never inside it
    const column = screen.getByTestId('chat-column');
    expect(page.contains(column)).toBe(false);
    expect(surface.parentElement).toHaveClass('relative', 'min-h-0');
```

Keep the rest of that test (one Chat landmark, the left rule on the aside, no palette).

- [ ] **Step 2: Run them to watch them fail**

Run: `pnpm --filter @ace/web exec vitest run src/workflows/WorkflowLayout.test.tsx src/workflows/WorkflowPage.test.tsx`
Expected: FAIL. There is no radio named Ideate, and the chat is inside `workflow-page`.

- [ ] **Step 3: Write `mode.ts` and the switch**

Create `apps/web/src/forge/mode.ts`:

```ts
import { useMatch } from 'react-router-dom';

/** D299: inside a workflow a person is in Ideate (the canvas) or Forge (the code editor). */
export type WorkflowMode = 'ideate' | 'forge';

export function workflowPath(projectId: string, workflowId: string, mode: WorkflowMode): string {
  const base = `/projects/${projectId}/workflows/${workflowId}`;
  return mode === 'forge' ? `${base}/forge` : base;
}

export function useWorkflowMode(): WorkflowMode {
  return useMatch('/projects/:projectId/workflows/:workflowId/forge') === null ? 'ideate' : 'forge';
}
```

Create `apps/web/src/app/layout/ModeSwitch.tsx`:

```tsx
import { cn } from '@ace/ui';
import { Code2, Workflow, type LucideIcon } from 'lucide-react';
import { useRef, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { useWorkflowMode, workflowPath, type WorkflowMode } from '../../forge/mode';
import { SHORTCUTS, shortcutLabel } from '../shortcuts';

const MODES: ReadonlyArray<{ mode: WorkflowMode; label: string; Icon: LucideIcon; keys: string }> = [
  { mode: 'ideate', label: 'Ideate', Icon: Workflow, keys: shortcutLabel(SHORTCUTS.ideate) },
  { mode: 'forge', label: 'Forge', Icon: Code2, keys: shortcutLabel(SHORTCUTS.forge) },
];

/** The top bar's `Ideate | Forge` switch (D299): a radio group, arrow keys move between the two. */
export function ModeSwitch({ projectId, workflowId }: { projectId: string; workflowId: string }) {
  const mode = useWorkflowMode();
  const navigate = useNavigate();
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const go = (next: WorkflowMode) => {
    if (next !== mode) navigate(workflowPath(projectId, workflowId, next));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next: WorkflowMode = mode === 'ideate' ? 'forge' : 'ideate';
    go(next);
    buttons.current[next === 'ideate' ? 0 : 1]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label="Mode"
      data-testid="mode-switch"
      onKeyDown={onKeyDown}
      className="flex shrink-0 items-center gap-[3px] rounded-chip border border-border bg-card p-[3px]"
    >
      {MODES.map(({ mode: value, label, Icon, keys }, index) => (
        <button
          key={value}
          ref={(element) => {
            buttons.current[index] = element;
          }}
          type="button"
          role="radio"
          aria-checked={mode === value}
          tabIndex={mode === value ? 0 : -1}
          data-testid={`mode-${value}`}
          title={`${label} (${keys})`}
          onClick={() => go(value)}
          className={cn(
            'flex h-[26px] items-center gap-1.5 rounded-chip px-3 font-machine text-[10.5px] uppercase tracking-[0.1em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            mode === value ? 'bg-fg text-canvas' : 'text-fg-muted hover:text-fg',
          )}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden />
          {label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Write `WorkflowLayout` and slim `WorkflowPage`**

Create `apps/web/src/workflows/WorkflowLayout.tsx`:

```tsx
import { Link, Outlet, useNavigate, useParams } from 'react-router-dom';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';

import { RESIZE_HANDLE_X } from '../app/layout/resize-handle';
import { SHORTCUTS, useShortcuts } from '../app/shortcuts';
import { useWorkflowSubscription } from '../app/socket';
import { useLayoutStore } from '../app/stores/layout';
import { ChatAside } from '../chat';
import { workflowPath } from '../forge/mode';
import { useIsCompact } from '../responsive/useIsCompact';
import { useAdoptActiveRun, useRunEvents } from '../runs/hooks';
import { useWorkflowGraph } from './hooks';

/**
 * The parent of both modes (D299, design §2.1). It owns what must outlive a switch: the workflow
 * subscription, the run events and adopting an active run (all three used to live in
 * WorkflowPage), and the chat column — so switching Ideate ⇄ Forge changes the main area only and
 * a reply still arriving keeps arriving. At phone width the modes lay themselves out and there is
 * no chat column here (Ideate's compact layout has its own chat tab).
 */
export function WorkflowLayout() {
  const { projectId = '', workflowId = '' } = useParams();
  const graph = useWorkflowGraph(workflowId);
  useWorkflowSubscription(workflowId);
  useRunEvents(workflowId);
  useAdoptActiveRun(workflowId);
  const compact = useIsCompact();
  const chatOpen = useLayoutStore((s) => s.chatOpen);
  const toggleChat = useLayoutStore((s) => s.toggleChat);
  const navigate = useNavigate();
  useShortcuts([
    [SHORTCUTS.ideate, () => navigate(workflowPath(projectId, workflowId, 'ideate'))],
    [SHORTCUTS.forge, () => navigate(workflowPath(projectId, workflowId, 'forge'))],
    [SHORTCUTS.toggleChat, toggleChat],
  ]);

  if (graph.isError) {
    return (
      <p role="alert" className="p-6 text-danger">
        Workflow not found.{' '}
        <Link to={`/projects/${projectId}`} className="underline">
          Back to the project
        </Link>
      </p>
    );
  }
  if (compact) return <Outlet />;

  return (
    <PanelGroup direction="horizontal" autoSaveId="ace.workflow" className="h-full">
      <Panel id="workflow-main" order={1} minSize={40} className="min-h-0 min-w-0">
        <Outlet />
      </Panel>
      {chatOpen && (
        <>
          <PanelResizeHandle className={RESIZE_HANDLE_X} />
          <Panel id="workflow-chat" order={2} defaultSize={24} minSize={16} maxSize={45} className="min-h-0 min-w-0">
            {/* a plain box: ChatAside is the landmark (<aside aria-label="Chat">) and draws the rule */}
            <div data-testid="chat-column" className="flex h-full min-h-0 min-w-0 flex-col">
              <ChatAside workflowId={workflowId} />
            </div>
          </Panel>
        </>
      )}
    </PanelGroup>
  );
}
```

In `apps/web/src/workflows/WorkflowPage.tsx`:
- Remove `useWorkflowSubscription`, `useRunEvents`, `useAdoptActiveRun`, the `graph.isError` branch, the `ChatAside` import and the chat column; the layout owns them now.
- Keep `useWorkflowGraph` for the dialog's name.
- Update the doc comment to say that the chat column and the subscriptions live in `WorkflowLayout` (D299).
- The desktop return becomes:

```tsx
  return (
    <div data-testid="workflow-page" className="relative grid h-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden">
      {/* `relative` + an absolutely filled Canvas: a percentage height inside a grid row would
          collapse to 0 and leave the Canvas unmeasurable (no fit, no minimap). */}
      <div className="relative min-h-0">
        <Canvas workflowId={workflowId} />
        <PreflightIssues workflowId={workflowId} />
        <CanvasHaltNote workflowId={workflowId} />
      </div>
      <WorkflowSheet workflowId={workflowId} />
      <section
        data-testid="bottom-section"
        className="border-t border-border bg-panel transition-[height] duration-200"
        style={{ height: bottomOpen ? 232 : 40 }}
      >
        <BottomPanel workflowId={workflowId} />
      </section>
      <NewNodeDialog
        workflowId={workflowId}
        workflowName={graph.data?.workflow.name ?? 'Workflow'}
        open={newNodeOpen}
        onClose={closeNewNode}
        // the dialog closes itself after an add
        onAdd={(kind, init) => canvasApi?.addNode(kind, init)}
      />
    </div>
  );
```

(The import named `BottomPanel` here is the canvas's own `../bottom-panel/BottomPanel`, not Forge's panel.)

In `apps/web/src/app/routes.tsx`, replace the workflow route and Task 12's temporary Forge route with:

```tsx
      {
        path: 'projects/:projectId/workflows/:workflowId',
        element: <WorkflowLayout />,
        children: [
          { index: true, element: <WorkflowPage /> },
          { path: 'forge', element: <ForgePage /> },
        ],
      },
```

Keep the `…/timeline` route where it is.

- [ ] **Step 5: Keep the mode in the workflow tabs, and update the top bar**

In `apps/web/src/workflows/WorkflowTabs.tsx`, import `useWorkflowMode` and `workflowPath`, then:

```tsx
  const mode = useWorkflowMode();
  …
              onClick={() => navigate(workflowPath(projectId, workflow.id, mode))}
  …
                      onSuccess: (graph) => navigate(workflowPath(projectId, graph.workflow.id, mode)),
```

In `apps/web/src/app/layout/TopBar.tsx`:
- Import `ModeSwitch`, `useWorkflowMode`, `useLayoutStore`, and `MessageSquare` from lucide.
- Read `const mode = useWorkflowMode();`, `const chatOpen = useLayoutStore((s) => s.chatOpen);` and `const toggleChat = useLayoutStore((s) => s.toggleChat);`.
- **Desktop:** right after the workflow tabs' wrapper `div`, add:

```tsx
      {projectId && workflowId && <ModeSwitch projectId={projectId} workflowId={workflowId} />}
```

- **Desktop:** change the sheet toggle's and New node's conditions from `workflowId &&` to `workflowId && mode === 'ideate' &&`.
- **Desktop:** before the sheet toggle, add the chat toggle:

```tsx
        {workflowId && (
          <button
            type="button"
            data-testid="chat-toggle"
            aria-label="Chat"
            aria-pressed={chatOpen}
            title={`Chat (${shortcutLabel(SHORTCUTS.toggleChat)})`}
            className={cn(ICON_BUTTON, chatOpen && 'bg-border text-fg')}
            onClick={toggleChat}
          >
            <MessageSquare className="h-4 w-4" aria-hidden />
          </button>
        )}
```

- **Compact:** in the `workflowId` row, render `{projectId && <ModeSwitch projectId={projectId} workflowId={workflowId} />}` before `RunBar`, inside a `flex items-center gap-2` row.
- Update the top bar's doc comment to mention the switch (D299).

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @ace/web exec vitest run src/workflows src/app/layout`
Expected: PASS.

- [ ] **Step 7: Run the whole web suite and the e2e specs that touch the canvas page**

Run: `pnpm --filter @ace/web test`
Expected: PASS. Fix any test that assumed the chat column sits inside `workflow-page`, or that the column is exactly 340 px. In e2e, `chat.spec.ts` and `mobile.spec.ts` are the likely ones; run them next.

Run: `pnpm --filter @ace/web exec playwright test e2e/chat.spec.ts e2e/mobile.spec.ts e2e/workflows.spec.ts e2e/canvas.spec.ts`
Expected: PASS. A failure because a test measured the old fixed width is fixed by asserting the column is visible, not its width.

- [ ] **Step 8: Commit**

```bash
npx prettier --write --config packages/config/prettier.config.js apps/web/src/forge/mode.ts apps/web/src/app/layout/ModeSwitch.tsx apps/web/src/workflows/WorkflowLayout.tsx apps/web/src/workflows/WorkflowLayout.test.tsx
git add apps/web/src apps/web/e2e
git commit -m "feat(web): Ideate | Forge — one switch in the top bar, one chat column for both modes [D299]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Web — the editor: store, model registry, Monaco host, tabs and Open editors

**Files:**
- Create, in `apps/web/src/forge/editor/`:
  - `editor-store.ts`, `models.ts`, `actions.ts`, `languages.ts`, `forge-theme.ts`, `editor-status.ts`;
  - `EditorHost.tsx`, `EditorArea.tsx`, `TabsBar.tsx`, `ImagePreview.tsx`, `FileNotice.tsx`.
- Create: `apps/web/src/forge/explorer/OpenEditors.tsx`, `apps/web/src/test/fake-monaco.ts`, `apps/web/src/test/FakeEditorHost.tsx`
- Modify:
  - `apps/web/src/config-panel/monaco-loader.ts`: every worker, and export `monaco`;
  - `apps/web/src/forge/ForgeWorkbench.tsx`: `EditorArea`;
  - `apps/web/src/forge/explorer/ExplorerView.tsx`: Open editors, and opening files;
  - `apps/web/src/test/setup.tsx`: mock `EditorHost` globally;
  - `apps/web/src/test/app.tsx`: reset the editor store and models, and install the fake Monaco.
- Test: create `apps/web/src/forge/editor/editor-store.test.ts`, `apps/web/src/forge/editor/models.test.ts`, `apps/web/src/forge/editor/EditorArea.test.tsx`

**Interfaces:**
- Consumes:
  - from Task 10: `useFileContent`, the path helpers and `api().readFileRaw`;
  - from Task 11: `useExplorerStore`, `FileIcon`;
  - from Task 12: `IconAction`, `EmptyEditor`;
  - existing: `useResolvedTheme`.
- Produces:
  - from `editor-store.ts`:
    - `OpenFile { path, baseVersion: string | null | undefined, bom, dirty, saving, conflict: 'changed' | 'deleted' | undefined, deletedOnDisk, error }`;
    - `ProjectEditor { tabs, active, preview, files, reveal }`;
    - `useEditorStore` with `open`, `activate`, `pin`, `closeMany`, `loaded`, `setDirty`, `saveStarted`, `saved`, `saveFailed`, `conflicted`, `resolved`, `markDeletedOnDisk`, `renamed`, `revealAt`, `revealDone`;
    - `useProjectEditor`, `useOpenFile`, `hasUnsavedWork`, `replaceablePreview`, `EMPTY_EDITOR`.
  - from `models.ts`: `setMonaco`, `fileUri`, `pathOfUri`, `getModel`, `ensureModel`, `markSaved(projectId, path, alt?)`, `replaceContent`, `saveViewState`, `viewStateOf`, `moveModels`, `disposeModel`, `resetModels`.
  - from `actions.ts`: `dirtyHandler`, `openFile(projectId, path, { preview? })`, `closeFiles`, `filesMoved`, `filesRemoved`.
  - `languageOf(path)`, `languageLabel(id)`, `applyForgeTheme(monaco, theme)`.
  - `useEditorStatus`, with `{ line, column, language, eol, indentation, bom, setCursor, describe }`.
  - `EditorArea({ projectId })`.

- [ ] **Step 1: Write the test doubles**

Create `apps/web/src/test/fake-monaco.ts`:

```ts
import type * as Monaco from 'monaco-editor';

/**
 * The slice of Monaco the model registry and the Problems store use, without a browser: models with
 * values, alternative version ids and change events, and markers. `setMarkers` drives Problems.
 */
export function createFakeMonaco() {
  class Uri {
    constructor(
      readonly scheme: string,
      readonly path: string,
    ) {}
    toString(): string {
      return `${this.scheme}://${this.path}`;
    }
    static from({ scheme, path }: { scheme: string; path: string }): Uri {
      return new Uri(scheme, path);
    }
  }

  const models = new Map<string, ReturnType<typeof createModel>>();
  let markers: Array<{ resource: Uri; severity: number; message: string; startLineNumber: number; startColumn: number; source?: string }> = [];
  const markerListeners = new Set<() => void>();

  function createModel(value: string, language: string, uri: Uri) {
    let text = value;
    let alternative = 1;
    let disposed = false;
    const listeners = new Set<() => void>();
    const model = {
      uri,
      getValue: () => text,
      setValue(next: string) {
        text = next;
        alternative += 1;
        listeners.forEach((listener) => listener());
      },
      getAlternativeVersionId: () => alternative,
      onDidChangeContent(listener: () => void) {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      isDisposed: () => disposed,
      dispose() {
        disposed = true;
        models.delete(uri.toString());
      },
      getEOL: () => (text.includes('\r\n') ? '\r\n' : '\n'),
      getLanguageId: () => language,
      getOptions: () => ({ insertSpaces: true, tabSize: 2 }),
    };
    models.set(uri.toString(), model);
    return model;
  }

  return {
    Uri,
    MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
    editor: {
      createModel,
      getModel: (uri: Uri) => models.get(uri.toString()) ?? null,
      getModels: () => [...models.values()],
      getModelMarkers: () => markers,
      onDidChangeMarkers(listener: () => void) {
        markerListeners.add(listener);
        return { dispose: () => markerListeners.delete(listener) };
      },
      defineTheme: () => undefined,
      setTheme: () => undefined,
    },
    /** Test helper: replace every marker, as the TS worker would after a parse. */
    setMarkers(next: typeof markers) {
      markers = next;
      markerListeners.forEach((listener) => listener());
    },
  };
}

export type FakeMonaco = ReturnType<typeof createFakeMonaco>;

export const asMonaco = (fake: FakeMonaco): typeof Monaco => fake as unknown as typeof Monaco;
```

Create `apps/web/src/test/FakeEditorHost.tsx`:

```tsx
import type { TextFileContent } from '@ace/contracts';
import { useEffect, useState } from 'react';

import { dirtyHandler } from '../forge/editor/actions';
import { useEditorStore } from '../forge/editor/editor-store';
import { ensureModel, getModel } from '../forge/editor/models';

/**
 * Monaco stands in as a textarea over the real model registry (with the fake Monaco installed), so
 * tests drive edits, unsaved state and saves exactly as the real host does, without a browser.
 */
export function FakeEditorHost({
  projectId,
  path,
  initial,
}: {
  projectId: string;
  path: string;
  initial: TextFileContent | undefined;
}) {
  const model =
    getModel(projectId, path) ??
    (initial ? ensureModel(projectId, path, initial.content, 'plaintext', dirtyHandler(projectId, path)) : undefined);
  const [, rerender] = useState(0);
  useEffect(() => {
    const file = useEditorStore.getState().projects[projectId]?.files[path];
    if (initial && file?.baseVersion === undefined) {
      useEditorStore.getState().loaded(projectId, path, initial.version, initial.bom);
    }
  }, [projectId, path, initial]);
  useEffect(() => {
    const subscription = model?.onDidChangeContent(() => rerender((n) => n + 1));
    return () => subscription?.dispose();
  }, [model]);
  return (
    <textarea
      aria-label={`Editing ${path}`}
      data-testid="fake-editor"
      value={model?.getValue() ?? ''}
      onChange={(event) => model?.setValue(event.target.value)}
    />
  );
}
```

In `apps/web/src/test/setup.tsx`, add a global mock under the panels mock:

```tsx
// Forge's Monaco host is a lazy chunk that needs a browser; every test gets the textarea stand-in.
vi.mock('../forge/editor/EditorHost', async () => ({
  EditorHost: (await import('./FakeEditorHost')).FakeEditorHost,
}));
```

In `apps/web/src/test/app.tsx`, add to `beforeEach`:

```ts
    useEditorStore.setState({ projects: {} });
    resetModels();
    setMonaco(asMonaco(createFakeMonaco()));
```

- [ ] **Step 2: Write the failing tests**

Create `apps/web/src/forge/editor/editor-store.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';

import { hasUnsavedWork, useEditorStore } from './editor-store';

const P = 'p1';
const store = () => useEditorStore.getState();
const editor = () => store().projects[P];

beforeEach(() => useEditorStore.setState({ projects: {} }));

describe('D299 FR-GIT-004 the editor’s tabs', () => {
  it('a preview open replaces the previous preview; a pinned open stays', () => {
    store().open(P, 'a.ts', { preview: true });
    store().open(P, 'b.ts', { preview: true });
    expect(editor()?.tabs).toEqual(['b.ts']);
    expect(editor()?.preview).toBe('b.ts');
    store().open(P, 'b.ts');
    expect(editor()?.preview).toBeUndefined();
    store().open(P, 'c.ts', { preview: true });
    expect(editor()?.tabs).toEqual(['b.ts', 'c.ts']);
  });

  it('a preview with unsaved changes is pinned, never replaced', () => {
    store().open(P, 'a.ts', { preview: true });
    store().setDirty(P, 'a.ts', true);
    expect(editor()?.preview).toBeUndefined();
    store().open(P, 'b.ts', { preview: true });
    expect(editor()?.tabs).toEqual(['a.ts', 'b.ts']);
  });

  it('opens next to the active tab, and closing activates the right neighbour, else the left', () => {
    store().open(P, 'a.ts');
    store().open(P, 'b.ts');
    store().activate(P, 'a.ts');
    store().open(P, 'c.ts');
    expect(editor()?.tabs).toEqual(['a.ts', 'c.ts', 'b.ts']);
    store().closeMany(P, ['c.ts']);
    expect(editor()?.active).toBe('b.ts');
    store().closeMany(P, ['b.ts']);
    expect(editor()?.active).toBe('a.ts');
  });

  it('a moved folder takes its open files with it, unsaved state and all', () => {
    store().open(P, 'src/a.ts');
    store().open(P, 'src/deep/b.ts');
    store().setDirty(P, 'src/deep/b.ts', true);
    store().renamed(P, 'src', 'lib');
    expect(editor()?.tabs).toEqual(['lib/a.ts', 'lib/deep/b.ts']);
    expect(editor()?.files['lib/deep/b.ts']).toMatchObject({ path: 'lib/deep/b.ts', dirty: true });
    expect(editor()?.active).toBe('lib/deep/b.ts');
  });

  it('knows when any project holds unsaved work', () => {
    store().open(P, 'a.ts');
    expect(hasUnsavedWork(store())).toBe(false);
    store().setDirty(P, 'a.ts', true);
    expect(hasUnsavedWork(store())).toBe(true);
  });
});
```

Create `apps/web/src/forge/editor/models.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { asMonaco, createFakeMonaco } from '../../test/fake-monaco';
import { ensureModel, fileUri, getModel, markSaved, moveModels, pathOfUri, replaceContent, resetModels, setMonaco } from './models';

const P = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';

beforeEach(() => {
  resetModels();
  setMonaco(asMonaco(createFakeMonaco()));
});

describe('D299 one Monaco model per open file', () => {
  it('names each model by project and path, and reads the name back', () => {
    const uri = fileUri(P, 'My Dir/a.ts');
    expect(pathOfUri(uri)).toEqual({ projectId: P, path: 'My Dir/a.ts' });
  });

  it('creates a model once, and reports unsaved changes until the disk holds them', () => {
    const dirty = vi.fn();
    const model = ensureModel(P, 'a.ts', 'one', 'typescript', dirty);
    expect(ensureModel(P, 'a.ts', 'ignored', 'typescript', dirty)).toBe(model);
    model.setValue('two');
    expect(dirty).toHaveBeenLastCalledWith(true);
    markSaved(P, 'a.ts');
    expect(dirty).toHaveBeenLastCalledWith(false);
  });

  it('only the text that was sent counts as saved: typing during a save stays unsaved', () => {
    const dirty = vi.fn();
    const model = ensureModel(P, 'a.ts', 'one', 'plaintext', dirty);
    model.setValue('sent');
    const sent = model.getAlternativeVersionId();
    model.setValue('typed while saving');
    markSaved(P, 'a.ts', sent);
    expect(dirty).toHaveBeenLastCalledWith(true);
  });

  it('replacing the content with the disk’s leaves the buffer clean', () => {
    const dirty = vi.fn();
    ensureModel(P, 'a.ts', 'one', 'plaintext', dirty);
    replaceContent(P, 'a.ts', 'theirs');
    expect(getModel(P, 'a.ts')?.getValue()).toBe('theirs');
    expect(dirty).toHaveBeenLastCalledWith(false);
  });

  it('a move carries the text and the unsaved state to the new path', () => {
    const model = ensureModel(P, 'src/a.ts', 'one', 'plaintext', () => undefined);
    model.setValue('edited');
    const moved = vi.fn();
    moveModels(P, 'src', 'lib', () => moved, () => 'plaintext');
    expect(getModel(P, 'src/a.ts')).toBeUndefined();
    const target = getModel(P, 'lib/a.ts');
    expect(target?.getValue()).toBe('edited');
    target?.setValue('edited more');
    expect(moved).toHaveBeenLastCalledWith(true);
  });
});
```

Create `apps/web/src/forge/editor/EditorArea.test.tsx`:

```tsx
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { db, installMockServer, renderWithQuery } from '../../test/app';
import { openFile } from './actions';
import { EditorArea } from './EditorArea';
import { useEditorStore } from './editor-store';
import { getModel } from './models';

installMockServer();

let projectId: string;
beforeEach(() => {
  projectId = db.createProject({ name: 'Shop' }).id;
  db.seedFiles(projectId, {
    'src/app.ts': 'export const app = 1;\n',
    'src/index.ts': '',
    'lib/index.ts': '',
    'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'blob.bin': 'a\u0000b',
  });
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => vi.restoreAllMocks());

describe('D299 FR-GIT-004 the editor area', () => {
  it('opens a file in a tab and shows its text', async () => {
    renderWithQuery(<EditorArea projectId={projectId} />);
    act(() => openFile(projectId, 'src/app.ts'));
    expect(await screen.findByRole('tab', { name: /app\.ts/ })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByLabelText('Editing src/app.ts')).toHaveValue('export const app = 1;\n');
  });

  it('a preview tab is italic, replaced by the next preview, and pinned by an edit', async () => {
    const user = userEvent.setup();
    renderWithQuery(<EditorArea projectId={projectId} />);
    act(() => openFile(projectId, 'src/app.ts', { preview: true }));
    expect(await screen.findByTestId('tab-src/app.ts')).toHaveClass('italic');
    act(() => openFile(projectId, 'src/index.ts', { preview: true }));
    expect(await screen.findByTestId('tab-src/index.ts')).toBeInTheDocument();
    expect(screen.queryByTestId('tab-src/app.ts')).toBeNull();
    expect(getModel(projectId, 'src/app.ts'), 'the replaced preview’s model is disposed').toBeUndefined();

    await user.type(await screen.findByLabelText('Editing src/index.ts'), 'x');
    expect(screen.getByTestId('tab-src/index.ts')).not.toHaveClass('italic');
    expect(screen.getByTestId('dirty-src/index.ts')).toBeInTheDocument();
  });

  it('closes a tab with its button or a middle click, and shows the next one', async () => {
    const user = userEvent.setup();
    renderWithQuery(<EditorArea projectId={projectId} />);
    act(() => {
      openFile(projectId, 'src/app.ts');
      openFile(projectId, 'src/index.ts');
    });
    await user.click(await screen.findByRole('button', { name: 'Close index.ts' }));
    expect(screen.queryByTestId('tab-src/index.ts')).toBeNull();
    expect(useEditorStore.getState().projects[projectId]?.active).toBe('src/app.ts');
  });

  it('tells two files of the same name apart by their folder', async () => {
    renderWithQuery(<EditorArea projectId={projectId} />);
    act(() => {
      openFile(projectId, 'src/index.ts');
      openFile(projectId, 'lib/index.ts');
    });
    expect(within(await screen.findByTestId('tab-src/index.ts')).getByText('src')).toBeInTheDocument();
    expect(within(screen.getByTestId('tab-lib/index.ts')).getByText('lib')).toBeInTheDocument();
  });

  it('shows an image as a picture and a binary file as a notice, never as text', async () => {
    renderWithQuery(<EditorArea projectId={projectId} />);
    act(() => openFile(projectId, 'logo.svg'));
    expect(await screen.findByRole('img', { name: 'logo.svg' })).toHaveAttribute('src', 'blob:preview');
    act(() => openFile(projectId, 'blob.bin'));
    expect(await screen.findByTestId('file-notice')).toHaveTextContent(/binary/);
    expect(screen.queryByTestId('fake-editor')).toBeNull();
  });
});
```

- [ ] **Step 3: Run them to watch them fail**

Run: `pnpm --filter @ace/web exec vitest run src/forge/editor`
Expected: FAIL, because the modules are missing.

- [ ] **Step 4: Write the store**

Create `apps/web/src/forge/editor/editor-store.ts`:

```ts
import { create } from 'zustand';

import { isWithin, movedPath } from '../files/paths';

export type Conflict = 'changed' | 'deleted';

export interface OpenFile {
  path: string;
  /**
   * The disk version the buffer was loaded from or last saved as. `null`: not on disk (deleted
   * since, so a save recreates it). `undefined`: the content has not loaded yet.
   */
  baseVersion: string | null | undefined;
  bom: boolean;
  dirty: boolean;
  saving: boolean;
  /** The disk moved on under an unsaved buffer (design §5.4). */
  conflict: Conflict | undefined;
  /** Gone from disk while the buffer was clean: struck through until it is closed or saved. */
  deletedOnDisk: boolean;
  /** The last save's failure, in words (design §10). */
  error: string | undefined;
}

export interface Reveal {
  path: string;
  line: number;
  column: number;
}

export interface ProjectEditor {
  tabs: string[];
  active: string | undefined;
  /** The italic preview tab a single click opened; the next preview replaces it (§6.2). */
  preview: string | undefined;
  files: Record<string, OpenFile>;
  /** A position to show once the file is in the editor (Problems). */
  reveal: Reveal | undefined;
}

export const EMPTY_EDITOR: ProjectEditor = { tabs: [], active: undefined, preview: undefined, files: {}, reveal: undefined };

const fresh = (path: string): OpenFile => ({
  path,
  baseVersion: undefined,
  bom: false,
  dirty: false,
  saving: false,
  conflict: undefined,
  deletedOnDisk: false,
  error: undefined,
});

/** The preview tab a new preview of `path` would replace: the current one, unless it holds unsaved work. */
export function replaceablePreview(editor: ProjectEditor, path: string): string | undefined {
  const { preview } = editor;
  return preview !== undefined && preview !== path && editor.files[preview]?.dirty !== true ? preview : undefined;
}

interface EditorState {
  projects: Record<string, ProjectEditor>;
  open(projectId: string, path: string, options?: { preview?: boolean }): void;
  activate(projectId: string, path: string): void;
  pin(projectId: string, path: string): void;
  closeMany(projectId: string, paths: readonly string[]): void;
  loaded(projectId: string, path: string, version: string, bom: boolean): void;
  setDirty(projectId: string, path: string, dirty: boolean): void;
  saveStarted(projectId: string, path: string): void;
  saved(projectId: string, path: string, version: string): void;
  saveFailed(projectId: string, path: string, message: string): void;
  conflicted(projectId: string, path: string, conflict: Conflict): void;
  /** Buffer and disk agree again (a reload, Keep mine, Take theirs): a new base, no conflict. */
  resolved(projectId: string, path: string, baseVersion: string | null): void;
  markDeletedOnDisk(projectId: string, path: string): void;
  renamed(projectId: string, from: string, to: string): void;
  revealAt(projectId: string, reveal: Reveal): void;
  revealDone(projectId: string): void;
}

/**
 * Forge's editor workspace per project, outside every component, so a mode switch, a workflow
 * switch or a route change never tears it down (D299, design §2.3). The Monaco models themselves
 * live in `models.ts`; this holds what React renders.
 */
export const useEditorStore = create<EditorState>()((set) => {
  const update = (projectId: string, change: (editor: ProjectEditor) => ProjectEditor) =>
    set((state) => ({ projects: { ...state.projects, [projectId]: change(state.projects[projectId] ?? EMPTY_EDITOR) } }));
  const patch = (projectId: string, path: string, fields: Partial<OpenFile>) =>
    update(projectId, (editor) => {
      const file = editor.files[path];
      return file === undefined ? editor : { ...editor, files: { ...editor.files, [path]: { ...file, ...fields } } };
    });

  return {
    projects: {},

    open: (projectId, path, options = {}) =>
      update(projectId, (editor) => {
        const preview = options.preview === true;
        if (editor.files[path] !== undefined) {
          return { ...editor, active: path, preview: !preview && editor.preview === path ? undefined : editor.preview };
        }
        const replaced = preview ? replaceablePreview(editor, path) : undefined;
        const files: Record<string, OpenFile> = { ...editor.files, [path]: fresh(path) };
        let tabs: string[];
        if (replaced !== undefined) {
          delete files[replaced];
          tabs = editor.tabs.map((tab) => (tab === replaced ? path : tab));
        } else {
          const at = editor.active === undefined ? editor.tabs.length : editor.tabs.indexOf(editor.active) + 1;
          tabs = [...editor.tabs.slice(0, at), path, ...editor.tabs.slice(at)];
        }
        return { ...editor, tabs, files, active: path, preview: preview ? path : editor.preview };
      }),

    activate: (projectId, path) => update(projectId, (editor) => (editor.files[path] ? { ...editor, active: path } : editor)),

    pin: (projectId, path) => update(projectId, (editor) => (editor.preview === path ? { ...editor, preview: undefined } : editor)),

    closeMany: (projectId, paths) =>
      update(projectId, (editor) => {
        const closing = new Set(paths);
        const tabs = editor.tabs.filter((tab) => !closing.has(tab));
        const files = Object.fromEntries(Object.entries(editor.files).filter(([path]) => !closing.has(path)));
        let { active } = editor;
        if (active !== undefined && closing.has(active)) {
          const index = editor.tabs.indexOf(active);
          active =
            editor.tabs.slice(index + 1).find((tab) => !closing.has(tab)) ??
            editor.tabs.slice(0, index).reverse().find((tab) => !closing.has(tab));
        }
        const preview = editor.preview !== undefined && closing.has(editor.preview) ? undefined : editor.preview;
        return { ...editor, tabs, files, active, preview };
      }),

    loaded: (projectId, path, version, bom) => patch(projectId, path, { baseVersion: version, bom }),

    setDirty: (projectId, path, dirty) =>
      update(projectId, (editor) => {
        const file = editor.files[path];
        if (file === undefined || file.dirty === dirty) return editor;
        return {
          ...editor,
          files: { ...editor.files, [path]: { ...file, dirty } },
          // editing a preview keeps it (§6.2)
          preview: dirty && editor.preview === path ? undefined : editor.preview,
        };
      }),

    saveStarted: (projectId, path) => patch(projectId, path, { saving: true, error: undefined }),
    saved: (projectId, path, version) =>
      patch(projectId, path, { saving: false, baseVersion: version, deletedOnDisk: false, error: undefined }),
    saveFailed: (projectId, path, message) => patch(projectId, path, { saving: false, error: message }),
    conflicted: (projectId, path, conflict) => patch(projectId, path, { saving: false, conflict }),
    resolved: (projectId, path, baseVersion) => patch(projectId, path, { baseVersion, conflict: undefined, deletedOnDisk: false }),
    markDeletedOnDisk: (projectId, path) => patch(projectId, path, { deletedOnDisk: true, baseVersion: null }),

    renamed: (projectId, from, to) =>
      update(projectId, (editor) => {
        const move = (path: string): string => (isWithin(path, from) ? movedPath(path, from, to) : path);
        return {
          tabs: editor.tabs.map(move),
          files: Object.fromEntries(Object.entries(editor.files).map(([path, file]) => [move(path), { ...file, path: move(path) }])),
          active: editor.active === undefined ? undefined : move(editor.active),
          preview: editor.preview === undefined ? undefined : move(editor.preview),
          reveal: editor.reveal === undefined ? undefined : { ...editor.reveal, path: move(editor.reveal.path) },
        };
      }),

    revealAt: (projectId, reveal) => update(projectId, (editor) => ({ ...editor, reveal })),
    revealDone: (projectId) => update(projectId, (editor) => ({ ...editor, reveal: undefined })),
  };
});

export const useProjectEditor = (projectId: string): ProjectEditor =>
  useEditorStore((state) => state.projects[projectId] ?? EMPTY_EDITOR);

export const useOpenFile = (projectId: string, path: string | undefined): OpenFile | undefined =>
  useEditorStore((state) => (path === undefined ? undefined : state.projects[projectId]?.files[path]));

export const hasUnsavedWork = (state: Pick<EditorState, 'projects'>): boolean =>
  Object.values(state.projects).some((editor) => Object.values(editor.files).some((file) => file.dirty));
```

- [ ] **Step 5: Write the model registry, languages, theme and status**

Create `apps/web/src/forge/editor/models.ts`:

```ts
import type * as Monaco from 'monaco-editor';

import { isWithin, movedPath } from '../files/paths';

type MonacoApi = typeof Monaco;
type Model = Monaco.editor.ITextModel;

interface Entry {
  model: Model;
  /** The alternative version id the disk holds; any other is unsaved (undo back to it is clean, as in VS Code). */
  savedAlt: number;
  viewState: Monaco.editor.ICodeEditorViewState | null;
  onDirty: (dirty: boolean) => void;
  listener: Monaco.IDisposable;
}

let monaco: MonacoApi | undefined;
const entries = new Map<string, Entry>();
const keyOf = (projectId: string, path: string): string => `${projectId}\u0000${path}`;

/**
 * Forge's Monaco models (D299, §6.2): one per open file, outliving the editor widget, so tabs, modes
 * and workflows can switch without losing text, undo, cursor or scroll. Monaco itself is set by the
 * lazy editor chunk (`setMonaco`); tests set a fake.
 */
export function setMonaco(instance: MonacoApi): void {
  monaco = instance;
}

/** `file:///<projectId>/<path>`: one URI space per project, so two projects' `src/index.ts` never share a model. */
export function fileUri(projectId: string, path: string): Monaco.Uri {
  if (monaco === undefined) throw new Error('Monaco is not loaded yet.');
  return monaco.Uri.from({ scheme: 'file', path: `/${projectId}/${path}` });
}

/** The project and path a model's URI names — how a Problems marker finds its file. */
export function pathOfUri(uri: Monaco.Uri): { projectId: string; path: string } | undefined {
  if (uri.scheme !== 'file') return undefined;
  const [, projectId, ...rest] = uri.path.split('/');
  return projectId === undefined || projectId === '' || rest.length === 0 ? undefined : { projectId, path: rest.join('/') };
}

export function getModel(projectId: string, path: string): Model | undefined {
  const entry = entries.get(keyOf(projectId, path));
  return entry === undefined || entry.model.isDisposed() ? undefined : entry.model;
}

export function ensureModel(
  projectId: string,
  path: string,
  content: string,
  language: string,
  onDirty: (dirty: boolean) => void,
): Model {
  const key = keyOf(projectId, path);
  const existing = entries.get(key);
  if (existing !== undefined && !existing.model.isDisposed()) return existing.model;
  if (monaco === undefined) throw new Error('Monaco is not loaded yet.');
  const uri = fileUri(projectId, path);
  const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(content, language, uri);
  const entry: Entry = {
    model,
    savedAlt: model.getAlternativeVersionId(),
    viewState: null,
    onDirty,
    listener: model.onDidChangeContent(() => entry.onDirty(model.getAlternativeVersionId() !== entry.savedAlt)),
  };
  entries.set(key, entry);
  return model;
}

/**
 * The disk now holds this buffer — all of it, or (`alt`) the text as it was when a save started,
 * so typing during the save stays unsaved.
 */
export function markSaved(projectId: string, path: string, alt?: number): void {
  const entry = entries.get(keyOf(projectId, path));
  if (entry === undefined) return;
  entry.savedAlt = alt ?? entry.model.getAlternativeVersionId();
  entry.onDirty(entry.model.getAlternativeVersionId() !== entry.savedAlt);
}

/** The buffer takes the disk's text (a clean buffer following the disk, or Take theirs); it is clean after. */
export function replaceContent(projectId: string, path: string, content: string): void {
  const entry = entries.get(keyOf(projectId, path));
  if (entry === undefined) return;
  if (entry.model.getValue() !== content) entry.model.setValue(content);
  markSaved(projectId, path);
}

export function saveViewState(projectId: string, path: string, viewState: Monaco.editor.ICodeEditorViewState | null): void {
  const entry = entries.get(keyOf(projectId, path));
  if (entry !== undefined) entry.viewState = viewState;
}

export function viewStateOf(projectId: string, path: string): Monaco.editor.ICodeEditorViewState | null {
  return entries.get(keyOf(projectId, path))?.viewState ?? null;
}

/** A file or folder moved: its models move to the new URIs with their text, unsaved state and place. */
export function moveModels(
  projectId: string,
  from: string,
  to: string,
  onDirtyFor: (path: string) => (dirty: boolean) => void,
  languageOf: (path: string) => string,
): void {
  for (const [key, entry] of [...entries]) {
    const [owner, path = ''] = key.split('\u0000');
    if (owner !== projectId || !isWithin(path, from)) continue;
    const target = movedPath(path, from, to);
    const dirty = entry.model.getAlternativeVersionId() !== entry.savedAlt;
    const value = entry.model.getValue();
    entry.listener.dispose();
    if (!entry.model.isDisposed()) entry.model.dispose();
    entries.delete(key);
    ensureModel(projectId, target, value, languageOf(target), onDirtyFor(target));
    const moved = entries.get(keyOf(projectId, target));
    if (moved !== undefined) {
      moved.viewState = entry.viewState;
      if (dirty) moved.savedAlt = -1;
    }
  }
}

export function disposeModel(projectId: string, path: string): void {
  const key = keyOf(projectId, path);
  const entry = entries.get(key);
  if (entry === undefined) return;
  entry.listener.dispose();
  if (!entry.model.isDisposed()) entry.model.dispose();
  entries.delete(key);
}

/** Tests only. */
export function resetModels(): void {
  for (const entry of entries.values()) {
    entry.listener.dispose();
    if (!entry.model.isDisposed()) entry.model.dispose();
  }
  entries.clear();
  monaco = undefined;
}
```

Create `apps/web/src/forge/editor/languages.ts`:

```ts
import { extensionOf, nameOf } from '../files/paths';

const BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html', vue: 'html',
  md: 'markdown', markdown: 'markdown', py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift',
  dart: 'dart', lua: 'lua', r: 'r', sh: 'shell', bash: 'shell', ps1: 'powershell', yml: 'yaml', yaml: 'yaml',
  toml: 'ini', ini: 'ini', xml: 'xml', svg: 'xml', sql: 'sql', graphql: 'graphql', gql: 'graphql',
};
const BY_NAME: Readonly<Record<string, string>> = { dockerfile: 'dockerfile', '.env': 'ini', makefile: 'plaintext' };

/** The Monaco language for a path; highlighting for every one, IntelliSense for TS/JS/CSS/HTML/JSON (§6.2). */
export function languageOf(path: string): string {
  return BY_NAME[nameOf(path).toLowerCase()] ?? BY_EXTENSION[extensionOf(path)] ?? 'plaintext';
}

const LABELS: Readonly<Record<string, string>> = {
  typescript: 'TypeScript', javascript: 'JavaScript', json: 'JSON', css: 'CSS', scss: 'SCSS', html: 'HTML',
  markdown: 'Markdown', python: 'Python', plaintext: 'Plain Text', yaml: 'YAML', shell: 'Shell', csharp: 'C#', cpp: 'C++',
};

export const languageLabel = (id: string): string => LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
```

Create `apps/web/src/forge/editor/forge-theme.ts`:

```ts
import type * as Monaco from 'monaco-editor';

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

const token = (name: string, fallback: string): string => {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return HEX.test(value) ? value : fallback;
};

/** Night and Paper for Monaco, from `@ace/ui`'s own tokens, so the editor follows the app theme (§6.2). */
export function applyForgeTheme(monaco: typeof Monaco, theme: 'dark' | 'light'): void {
  const light = theme === 'light';
  const name = light ? 'ace-paper' : 'ace-night';
  const canvas = token('--color-canvas', light ? '#f3f1ec' : '#0a0a0b');
  const card = token('--color-card', light ? '#fbfaf7' : '#111113');
  const border = token('--color-border', light ? '#dcd8d0' : '#232327');
  const fg = token('--color-fg', light ? '#1b1a1e' : '#f6f5f2');
  const soft = token('--color-fg-soft', light ? '#46444c' : '#b8b5ae');
  const faint = token('--color-fg-faint', light ? '#8d8a93' : '#7d7c82');
  const selection = token('--color-selection', light ? '#7c6fd6' : '#c4b5fd');
  const danger = token('--color-danger', '#f0563f');
  monaco.editor.defineTheme(name, {
    base: light ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': canvas,
      'editor.foreground': fg,
      'editorGutter.background': canvas,
      'minimap.background': canvas,
      'editorLineNumber.foreground': faint,
      'editorLineNumber.activeForeground': soft,
      'editorCursor.foreground': fg,
      'editor.selectionBackground': `${selection.slice(0, 7)}55`,
      'editor.inactiveSelectionBackground': `${selection.slice(0, 7)}30`,
      'editor.lineHighlightBackground': card,
      'editor.lineHighlightBorder': card,
      'editorWidget.background': card,
      'editorWidget.border': border,
      'editorIndentGuide.background1': border,
      'editorError.foreground': danger,
      'scrollbarSlider.background': `${border.slice(0, 7)}aa`,
    },
  });
  monaco.editor.setTheme(name);
}
```

Create `apps/web/src/forge/editor/editor-status.ts`:

```ts
import { create } from 'zustand';

interface DescribedModel {
  getLanguageId(): string;
  getEOL(): string;
  getOptions(): { insertSpaces: boolean; tabSize: number };
}

interface EditorStatusState {
  line: number;
  column: number;
  language: string;
  eol: 'LF' | 'CRLF';
  indentation: string;
  bom: boolean;
  setCursor(line: number, column: number): void;
  describe(model: DescribedModel, bom: boolean): void;
}

/** What the status bar reads about the active editor (Task 18). */
export const useEditorStatus = create<EditorStatusState>()((set) => ({
  line: 1,
  column: 1,
  language: 'plaintext',
  eol: 'LF',
  indentation: 'Spaces: 2',
  bom: false,
  setCursor: (line, column) => set({ line, column }),
  describe: (model, bom) => {
    const options = model.getOptions();
    set({
      language: model.getLanguageId(),
      eol: model.getEOL() === '\r\n' ? 'CRLF' : 'LF',
      indentation: options.insertSpaces ? `Spaces: ${options.tabSize}` : `Tab Size: ${options.tabSize}`,
      bom,
    });
  },
}));
```

- [ ] **Step 6: Write the actions**

Create `apps/web/src/forge/editor/actions.ts`:

```ts
import { useExplorerStore } from '../explorer/explorer-store';
import { isWithin, parentOf } from '../files/paths';
import { EMPTY_EDITOR, replaceablePreview, useEditorStore } from './editor-store';
import { languageOf } from './languages';
import { disposeModel, moveModels } from './models';

/** How a model tells the store its buffer is (un)saved. */
export const dirtyHandler =
  (projectId: string, path: string) =>
  (dirty: boolean): void =>
    useEditorStore.getState().setDirty(projectId, path, dirty);

/** Open a file in Forge; a preview replaces the last preview, and the Explorer reveals the file. */
export function openFile(projectId: string, path: string, options: { preview?: boolean } = {}): void {
  const before = useEditorStore.getState().projects[projectId] ?? EMPTY_EDITOR;
  const replaced =
    options.preview === true && before.files[path] === undefined ? replaceablePreview(before, path) : undefined;
  useEditorStore.getState().open(projectId, path, options);
  if (replaced !== undefined) disposeModel(projectId, replaced);
  const explorer = useExplorerStore.getState();
  if (parentOf(path) !== '') explorer.expand(projectId, parentOf(path));
  explorer.select(projectId, path);
}

/** Close tabs and drop their models. The caller asks first when a buffer is unsaved (Task 15). */
export function closeFiles(projectId: string, paths: readonly string[]): void {
  useEditorStore.getState().closeMany(projectId, paths);
  for (const path of paths) disposeModel(projectId, path);
}

/** A file or folder was renamed or moved in the Explorer: tabs, models and the tree follow it, revealed. */
export function filesMoved(projectId: string, from: string, to: string): void {
  useEditorStore.getState().renamed(projectId, from, to);
  moveModels(projectId, from, to, (path) => dirtyHandler(projectId, path), languageOf);
  const explorer = useExplorerStore.getState();
  explorer.moved(projectId, from, to);
  if (parentOf(to) !== '') explorer.expand(projectId, parentOf(to));
  explorer.select(projectId, to);
}

/** A file or folder was deleted in the Explorer: its open tabs close. */
export function filesRemoved(projectId: string, path: string): void {
  const open = Object.keys(useEditorStore.getState().projects[projectId]?.files ?? {}).filter((p) => isWithin(p, path));
  closeFiles(projectId, open);
  useExplorerStore.getState().removed(projectId, path);
}
```

- [ ] **Step 7: Write the Monaco host and the editor area**

Replace `apps/web/src/config-panel/monaco-loader.ts` with:

```ts
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

/**
 * Serve Monaco from the bundle, not the default CDN: ACE is local-first and must work offline.
 * Imported lazily with the editor so none of this lands in the initial chunk. Every language service
 * gets its own worker (D299): without them TS, CSS and HTML silently fell back to the plain editor
 * worker and offered no IntelliSense.
 */
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

loader.config({ monaco });

export { monaco };
export { default as MonacoEditor } from '@monaco-editor/react';
```

Create `apps/web/src/forge/editor/EditorHost.tsx`:

```tsx
import type { TextFileContent } from '@ace/contracts';
import type * as Monaco from 'monaco-editor';
import { useEffect, useRef } from 'react';

import { useResolvedTheme } from '../../app/theme';
import { monaco } from '../../config-panel/monaco-loader';
import { dirtyHandler } from './actions';
import { useEditorStore } from './editor-store';
import { useEditorStatus } from './editor-status';
import { applyForgeTheme } from './forge-theme';
import { languageOf } from './languages';
import { ensureModel, getModel, saveViewState, setMonaco, viewStateOf } from './models';

setMonaco(monaco);

export interface EditorHostProps {
  projectId: string;
  path: string;
  /** The disk's text, for a file that has no model yet. */
  initial: TextFileContent | undefined;
}

/**
 * The workbench's one Monaco editor (a lazy chunk). It shows the active file's model and remembers
 * each file's cursor, scroll and folding; the models live in the registry, so switching tabs or
 * modes loses nothing (§2.3).
 */
export function EditorHost({ projectId, path, initial }: EditorHostProps) {
  const container = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const theme = useResolvedTheme();
  const reveal = useEditorStore((state) => state.projects[projectId]?.reveal);

  useEffect(() => applyForgeTheme(monaco, theme), [theme]);

  useEffect(() => {
    if (container.current === null) return;
    const editor = monaco.editor.create(container.current, {
      model: null,
      automaticLayout: true,
      fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', Consolas, monospace",
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: true, renderCharacters: false },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      renderWhitespace: 'selection',
      bracketPairColorization: { enabled: true },
      fixedOverflowWidgets: true,
      tabSize: 2,
    });
    editorRef.current = editor;
    const cursor = editor.onDidChangeCursorPosition((event) =>
      useEditorStatus.getState().setCursor(event.position.lineNumber, event.position.column),
    );
    return () => {
      cursor.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  // Show this file's model; give the previous one's place back to the registry on the way out.
  // `initial` is read once: later disk changes reach the model through useEditorSync (§5.4).
  useEffect(() => {
    const editor = editorRef.current;
    if (editor === null) return;
    const model =
      getModel(projectId, path) ??
      (initial ? ensureModel(projectId, path, initial.content, languageOf(path), dirtyHandler(projectId, path)) : undefined);
    if (model === undefined) return;
    const file = useEditorStore.getState().projects[projectId]?.files[path];
    if (initial && file?.baseVersion === undefined) useEditorStore.getState().loaded(projectId, path, initial.version, initial.bom);
    editor.setModel(model);
    const view = viewStateOf(projectId, path);
    if (view !== null) editor.restoreViewState(view);
    editor.focus();
    useEditorStatus.getState().describe(model, file?.bom ?? initial?.bom ?? false);
    const position = editor.getPosition();
    if (position) useEditorStatus.getState().setCursor(position.lineNumber, position.column);
    return () => saveViewState(projectId, path, editor.saveViewState());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above: `initial` only seeds a new model
  }, [projectId, path]);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor === null || reveal === undefined || reveal.path !== path) return;
    editor.revealLineInCenter(reveal.line);
    editor.setPosition({ lineNumber: reveal.line, column: reveal.column });
    editor.focus();
    useEditorStore.getState().revealDone(projectId);
  }, [reveal, path, projectId]);

  return <div ref={container} className="h-full w-full" data-testid="monaco-host" />;
}
```

Create `apps/web/src/forge/editor/FileNotice.tsx`:

```tsx
import { FileIcon } from '../explorer/FileIcon';
import { nameOf } from '../files/paths';

const sizeOf = (bytes = 0): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`);

/** A file Forge does not open as text, and why (§6.1, §6.2). */
export function FileNotice({ path, kind, size, message }: { path: string; kind: 'binary' | 'too_large' | 'missing'; size?: number; message?: string }) {
  const text =
    kind === 'binary'
      ? 'This file is binary, or not UTF-8 text, so Forge does not open it as text.'
      : kind === 'too_large'
        ? `This file is ${sizeOf(size)}; Forge opens text files up to 2 MB.`
        : (message ?? 'This file could not be opened.');
  return (
    <div role="status" data-testid="file-notice" className="grid h-full place-items-center p-6 text-center text-[13px] text-fg-muted">
      <div className="flex max-w-sm flex-col items-center gap-2">
        <FileIcon path={path} className="h-8 w-8 text-fg-faint" />
        <p className="font-machine text-fg-soft">{nameOf(path)}</p>
        <p>{text}</p>
      </div>
    </div>
  );
}
```

Create `apps/web/src/forge/editor/ImagePreview.tsx`:

```tsx
import { useEffect, useState } from 'react';

import { api } from '../../app/api';
import { nameOf } from '../files/paths';
import { FileNotice } from './FileNotice';

/** An image opens as a picture (§6.2), fetched with the session token and shown from a blob URL. */
export function ImagePreview({ projectId, path }: { projectId: string; path: string }) {
  const [state, setState] = useState<{ url?: string; error?: string }>({});
  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    setState({});
    api()
      .readFileRaw(projectId, path, controller.signal)
      .then(
        (blob) => {
          url = URL.createObjectURL(blob);
          setState({ url });
        },
        (error: unknown) => {
          if (!controller.signal.aborted) setState({ error: error instanceof Error ? error.message : String(error) });
        },
      );
    return () => {
      controller.abort();
      if (url !== undefined) URL.revokeObjectURL(url);
    };
  }, [projectId, path]);

  if (state.error !== undefined) return <FileNotice path={path} kind="missing" message={`This image could not be shown: ${state.error}`} />;
  if (state.url === undefined) return <p className="p-4 text-[13px] text-fg-muted">Loading {nameOf(path)}…</p>;
  return (
    <div className="grid h-full place-items-center overflow-auto p-6">
      <img src={state.url} alt={nameOf(path)} className="max-h-full max-w-full object-contain" />
    </div>
  );
}
```

Create `apps/web/src/forge/editor/TabsBar.tsx`:

```tsx
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger, cn } from '@ace/ui';
import { X } from 'lucide-react';

import { FileIcon } from '../explorer/FileIcon';
import { nameOf, parentOf } from '../files/paths';
import { closeFiles } from './actions';
import { useEditorStore, useProjectEditor } from './editor-store';

/** The editor's tabs (§6.2): a dirty dot, middle-click close, Close others / Close saved. */
export function TabsBar({ projectId }: { projectId: string }) {
  const editor = useProjectEditor(projectId);
  const close = (paths: readonly string[]): void => closeFiles(projectId, paths);
  const nameCount = new Map<string, number>();
  for (const tab of editor.tabs) nameCount.set(nameOf(tab), (nameCount.get(nameOf(tab)) ?? 0) + 1);

  return (
    <div role="tablist" aria-label="Open files" className="flex h-9 shrink-0 overflow-x-auto border-b border-border bg-panel">
      {editor.tabs.map((path) => {
        const file = editor.files[path];
        if (file === undefined) return null;
        const active = editor.active === path;
        return (
          <ContextMenu key={path}>
            <ContextMenuTrigger asChild>
              <div
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                data-testid={`tab-${path}`}
                title={path}
                className={cn(
                  'group flex h-full max-w-[16rem] shrink-0 cursor-pointer items-center gap-1.5 border-r border-border pl-3 pr-1 font-machine text-[12px]',
                  active ? 'bg-canvas text-fg' : 'text-fg-muted hover:text-fg',
                  editor.preview === path && 'italic',
                  file.deletedOnDisk && 'line-through',
                )}
                onClick={() => useEditorStore.getState().activate(projectId, path)}
                onDoubleClick={() => useEditorStore.getState().pin(projectId, path)}
                onAuxClick={(event) => {
                  if (event.button !== 1) return;
                  event.preventDefault();
                  close([path]);
                }}
              >
                <FileIcon path={path} />
                <span className="truncate">{nameOf(path)}</span>
                {(nameCount.get(nameOf(path)) ?? 0) > 1 && (
                  <span className="truncate text-[11px] text-fg-faint">{parentOf(path) === '' ? '/' : parentOf(path)}</span>
                )}
                <button
                  type="button"
                  aria-label={`Close ${nameOf(path)}`}
                  className="ml-1 grid h-5 w-5 shrink-0 place-items-center rounded hover:bg-card"
                  onClick={(event) => {
                    event.stopPropagation();
                    close([path]);
                  }}
                >
                  {file.dirty && (
                    <span data-testid={`dirty-${path}`} aria-label="Unsaved changes" className="h-2 w-2 rounded-full bg-fg group-hover:hidden" />
                  )}
                  <X className={cn('h-3.5 w-3.5', file.dirty && 'hidden group-hover:block')} aria-hidden />
                </button>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => close([path])}>Close</ContextMenuItem>
              <ContextMenuItem onSelect={() => close(editor.tabs.filter((tab) => tab !== path))}>Close others</ContextMenuItem>
              <ContextMenuItem onSelect={() => close(editor.tabs.filter((tab) => editor.files[tab]?.dirty !== true))}>Close saved</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(path)}>Copy relative path</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
    </div>
  );
}
```

Create `apps/web/src/forge/editor/EditorArea.tsx`:

```tsx
import { AceApiError } from '@ace/sdk';
import { Suspense, lazy } from 'react';

import { useFileContent } from '../files/hooks';
import { isImagePath, nameOf } from '../files/paths';
import { useProjectEditor } from './editor-store';
import { EmptyEditor } from './EmptyEditor';
import { FileNotice } from './FileNotice';
import { ImagePreview } from './ImagePreview';
import { getModel } from './models';
import { TabsBar } from './TabsBar';

const EditorHost = lazy(() => import('./EditorHost').then((module) => ({ default: module.EditorHost })));

/** The editor area: tabs over the active file — text in Monaco, an image as a picture, the rest as a notice. */
export function EditorArea({ projectId }: { projectId: string }) {
  const editor = useProjectEditor(projectId);
  const active = editor.active;
  return (
    <section aria-label="Editor" className="flex h-full min-h-0 min-w-0 flex-col bg-canvas">
      {editor.tabs.length > 0 && <TabsBar projectId={projectId} />}
      <div className="relative min-h-0 flex-1">
        {active === undefined ? (
          <EmptyEditor />
        ) : isImagePath(active) ? (
          <ImagePreview projectId={projectId} path={active} />
        ) : (
          <TextFile projectId={projectId} path={active} />
        )}
      </div>
    </section>
  );
}

function TextFile({ projectId, path }: { projectId: string; path: string }) {
  const content = useFileContent(projectId, path);
  const text = content.data?.kind === 'text' ? content.data : undefined;
  if (getModel(projectId, path) === undefined) {
    if (content.isPending) return <p className="p-4 text-[13px] text-fg-muted">Opening {nameOf(path)}…</p>;
    if (content.error) {
      const gone = AceApiError.is(content.error) && content.error.status === 404;
      return <FileNotice path={path} kind="missing" message={gone ? 'This file is no longer on disk.' : content.error.message} />;
    }
    if (content.data !== undefined && content.data.kind !== 'text') {
      return <FileNotice path={path} kind={content.data.kind} size={content.data.size} />;
    }
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <Suspense fallback={<p className="p-4 text-[13px] text-fg-muted">Loading the editor…</p>}>
          <EditorHost projectId={projectId} path={path} initial={text} />
        </Suspense>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Open editors, and wiring**

Create `apps/web/src/forge/explorer/OpenEditors.tsx`:

```tsx
import { cn } from '@ace/ui';
import { ChevronRight, X } from 'lucide-react';
import { useState } from 'react';

import { closeFiles } from '../editor/actions';
import { useEditorStore, useProjectEditor } from '../editor/editor-store';
import { nameOf, parentOf } from '../files/paths';
import { FileIcon } from './FileIcon';

/** The Explorer's "Open editors" section (§6.4): the files the person is editing, unsaved ones marked. */
export function OpenEditors({ projectId }: { projectId: string }) {
  const editor = useProjectEditor(projectId);
  const [collapsed, setCollapsed] = useState(false);
  const close = (paths: readonly string[]): void => closeFiles(projectId, paths);
  return (
    <section aria-label="Open editors" className="shrink-0 border-b border-border">
      <div className="flex h-7 items-center gap-0.5 px-2">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-1 font-machine text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-soft"
        >
          <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', !collapsed && 'rotate-90')} aria-hidden />
          Open editors
        </button>
      </div>
      {!collapsed && (
        <ul className="pb-1">
          {editor.tabs.length === 0 && <li className="px-6 py-1 text-[12px] text-fg-faint">No open files.</li>}
          {editor.tabs.map((path) => {
            const file = editor.files[path];
            return (
              <li
                key={path}
                data-testid={`open-editor-${path}`}
                className={cn(
                  'group flex h-[22px] cursor-pointer items-center gap-1.5 pl-6 pr-2 font-machine text-[12px]',
                  editor.active === path ? 'bg-selection/20 text-fg' : 'text-fg-soft hover:bg-card',
                )}
                onClick={() => useEditorStore.getState().activate(projectId, path)}
              >
                <FileIcon path={path} />
                <span className="truncate">{nameOf(path)}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-fg-faint">{parentOf(path)}</span>
                {file?.dirty === true && <span aria-label="Unsaved changes" className="h-2 w-2 shrink-0 rounded-full bg-fg group-hover:hidden" />}
                <button
                  type="button"
                  aria-label={`Close ${nameOf(path)}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    close([path]);
                  }}
                  className={cn(
                    'h-4 w-4 shrink-0 place-items-center rounded hover:bg-card',
                    file?.dirty === true ? 'hidden group-hover:grid' : 'grid opacity-0 group-hover:opacity-100',
                  )}
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
```

In `apps/web/src/forge/explorer/ExplorerView.tsx`:
- Import `OpenEditors` and `openFile`.
- Render `<OpenEditors projectId={projectId} />` between the "Explorer" header and the project section.
- Change `FileTree`'s `onOpen` to `(path, options) => openFile(projectId, path, options)`.
- Remove the `select` selector, which is no longer used.

In `apps/web/src/forge/ForgeWorkbench.tsx`, replace the editor panel's content (`<section aria-label="Editor" …><EmptyEditor /></section>`) with `<EditorArea projectId={projectId} />`, import `EditorArea`, and drop the `EmptyEditor` import.

- [ ] **Step 9: Run the tests**

Run: `pnpm --filter @ace/web exec vitest run src/forge`
Expected: PASS, the Task 11–13 tests included.

- [ ] **Step 10: Check the real Monaco build**

Run: `pnpm --filter @ace/web typecheck && pnpm --filter @ace/web build`
Expected: both succeed. The build emits the `ts.worker`, `css.worker` and `html.worker` chunks, which you can see in `apps/web/dist/assets`. The real host is exercised in e2e (Task 20).

- [ ] **Step 11: Commit**

```bash
npx prettier --write --config packages/config/prettier.config.js apps/web/src/forge/editor apps/web/src/forge/explorer/OpenEditors.tsx apps/web/src/test/fake-monaco.ts apps/web/src/test/FakeEditorHost.tsx apps/web/src/config-panel/monaco-loader.ts
git add apps/web/src
git commit -m "feat(web): Forge's editor — tabs, Monaco with every language worker, one model per file, Open editors [D299] [FR-GIT-004]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: Web — save, conflicts, the disk changing underneath, and unsaved-work guards

**Files:**
- Modify:
  - `apps/web/src/forge/editor/actions.ts`: `saveFile`, `saveAll`, `keepMine`, `takeTheirs`;
  - `apps/web/src/forge/editor/EditorArea.tsx`: the bars and Compare;
  - `apps/web/src/forge/editor/TabsBar.tsx` and `apps/web/src/forge/explorer/OpenEditors.tsx`: closing asks first, and Save all;
  - `apps/web/src/forge/ForgeWorkbench.tsx`: sync, Ctrl+S, Ctrl+Alt+S, Alt+W;
  - `apps/web/src/app/layout/AppShell.tsx`: `beforeunload`;
  - `apps/web/src/test/setup.tsx`: mock `CompareView`.
- Create, in `apps/web/src/forge/editor/`:
  - `useEditorSync.ts`, `ConflictBar.tsx`, `CompareView.tsx`, `CloseDialogs.tsx`, `guards.ts`.
- Test: create `apps/web/src/forge/editor/actions.test.ts`, `apps/web/src/forge/editor/sync.test.tsx`, `apps/web/src/forge/editor/CloseDialogs.test.tsx`

**Interfaces:**
- Consumes:
  - from Task 14: the editor store, the models and `closeFiles`;
  - from Task 12: `logOutput`;
  - from Task 10: `fileContentQuery` and `fileKeys`;
  - `AceApiError` from `@ace/sdk`.
- Produces:
  - `saveFile(projectId, path, queryClient): Promise<boolean>`;
  - `saveAll(projectId, queryClient)`;
  - `keepMine(projectId, path, queryClient)` and `takeTheirs(projectId, path, queryClient)`;
  - `useEditorSync(projectId)`;
  - `useCloseRequest(projectId): { request(paths): void; dialog: ReactElement | null }`;
  - `useBeforeUnloadGuard()`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/forge/editor/actions.test.ts`:

```ts
import { aceError } from '@ace/contracts';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { mockVersion } from '../../mocks/files';
import { db, installMockServer, queryClient, server } from '../../test/app';
import { useOutputStore } from '../panel/output-store';
import { dirtyHandler, keepMine, openFile, saveFile, takeTheirs } from './actions';
import { useEditorStore } from './editor-store';
import { ensureModel, getModel } from './models';

installMockServer();

let projectId: string;
const file = () => useEditorStore.getState().projects[projectId]?.files['a.ts'];
const disk = () => db.filesOf(projectId)['a.ts']?.content;
const output = () => (useOutputStore.getState().lines[projectId] ?? []).map((line) => `${line.level}: ${line.message}`);

/** What the host does when a file opens: a model over the disk's text, and its base version. */
function openOnDisk(content: string) {
  db.seedFiles(projectId, { 'a.ts': content });
  openFile(projectId, 'a.ts');
  const model = ensureModel(projectId, 'a.ts', content, 'typescript', dirtyHandler(projectId, 'a.ts'));
  useEditorStore.getState().loaded(projectId, 'a.ts', mockVersion(content), false);
  return model;
}

beforeEach(() => {
  projectId = db.createProject({ name: 'P' }).id;
});

describe('D299 FR-GIT-004 saving', () => {
  it('saves the buffer against its base and marks it clean', async () => {
    const model = openOnDisk('one');
    model.setValue('two');
    expect(file()?.dirty).toBe(true);

    expect(await saveFile(projectId, 'a.ts', queryClient)).toBe(true);

    expect(disk()).toBe('two');
    expect(file()).toMatchObject({ dirty: false, saving: false, baseVersion: mockVersion('two') });
    expect(output()).toContain('info: Saved a.ts');
  });

  it('never overwrites silently: a stale base raises the conflict and the disk keeps its text', async () => {
    const model = openOnDisk('one');
    model.setValue('mine');
    db.writeFileExternally(projectId, 'a.ts', 'theirs');

    expect(await saveFile(projectId, 'a.ts', queryClient)).toBe(false);

    expect(disk()).toBe('theirs');
    expect(file()).toMatchObject({ conflict: 'changed', dirty: true });
    expect(output().some((line) => line.startsWith('warn: a.ts changed on disk'))).toBe(true);
  });

  it('typing during a save stays unsaved', async () => {
    const model = openOnDisk('one');
    model.setValue('sent');
    db.setLatency(30);
    const saving = saveFile(projectId, 'a.ts', queryClient);
    model.setValue('typed meanwhile');
    await saving;
    expect(disk()).toBe('sent');
    expect(file()?.dirty).toBe(true);
  });

  it('a failed save keeps the buffer unsaved and says why', async () => {
    server.use(
      http.put('*/api/v1/projects/:id/files/content', () =>
        HttpResponse.json(aceError('provider', 'internal', 'The engine hit an unexpected error.', { retryable: false }), { status: 500 }),
      ),
    );
    const model = openOnDisk('one');
    model.setValue('two');
    expect(await saveFile(projectId, 'a.ts', queryClient)).toBe(false);
    expect(file()).toMatchObject({ dirty: true, error: 'The engine hit an unexpected error.' });
    expect(output()).toContain('error: Could not save a.ts: The engine hit an unexpected error.');
  });
});

describe('D299 §5.4 resolving a conflict', () => {
  it('Keep mine takes the disk’s version as the base, so the next save wins', async () => {
    const model = openOnDisk('one');
    model.setValue('mine');
    db.writeFileExternally(projectId, 'a.ts', 'theirs');
    await saveFile(projectId, 'a.ts', queryClient);

    await keepMine(projectId, 'a.ts', queryClient);
    expect(file()).toMatchObject({ conflict: undefined, dirty: true, baseVersion: mockVersion('theirs') });
    expect(await saveFile(projectId, 'a.ts', queryClient)).toBe(true);
    expect(disk()).toBe('mine');
  });

  it('Take theirs replaces the buffer with the disk and closes the conflict', async () => {
    const model = openOnDisk('one');
    model.setValue('mine');
    db.writeFileExternally(projectId, 'a.ts', 'theirs');
    await saveFile(projectId, 'a.ts', queryClient);

    await takeTheirs(projectId, 'a.ts', queryClient);
    expect(getModel(projectId, 'a.ts')?.getValue()).toBe('theirs');
    expect(file()).toMatchObject({ conflict: undefined, dirty: false, baseVersion: mockVersion('theirs') });
  });

  it('Take theirs on a file deleted on disk closes its tab', async () => {
    const model = openOnDisk('one');
    model.setValue('mine');
    db.deleteFileExternally(projectId, 'a.ts');
    await takeTheirs(projectId, 'a.ts', queryClient);
    expect(file()).toBeUndefined();
  });
});
```

`installMockServer` must export `server` (it already does) and `queryClient` (a `let` export, already exported). Latency is set with `db.setLatency(ms)` (db.ts:185). `beforeEach` in `installMockServer` resets it through `db.reset()`.

Create `apps/web/src/forge/editor/sync.test.tsx`:

```tsx
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { db, installMockServer, queryClient, renderApp } from '../../test/app';
import { applyFilesChanged } from '../files/project-socket';
import { openFile } from './actions';
import { useEditorStore } from './editor-store';

installMockServer();

let projectId: string;
let path: string;
beforeEach(() => {
  const project = db.createProject({ name: 'Shop' });
  const workflow = db.createWorkflow(project.id, 'Main');
  projectId = project.id;
  path = `/projects/${project.id}/workflows/${workflow.id}/forge`;
  db.seedFiles(projectId, { 'a.ts': 'one' });
});

/** What the watcher would send for an agent's write. */
function agentWrites(content: string) {
  act(() => {
    db.writeFileExternally(projectId, 'a.ts', content);
    applyFilesChanged(queryClient, { projectId, changes: [{ path: 'a.ts', kind: 'changed' }], resync: false });
  });
}

describe('D299 §5.4 the disk changes under an open file', () => {
  it('a clean buffer follows the disk, an unsaved one gets the conflict bar', async () => {
    const user = userEvent.setup();
    renderApp(path);
    await screen.findByTestId('forge');
    act(() => openFile(projectId, 'a.ts'));
    const editor = await screen.findByLabelText('Editing a.ts');

    agentWrites('two');
    await waitFor(() => expect(editor).toHaveValue('two'));
    expect(screen.queryByTestId('conflict-bar')).toBeNull();

    await user.type(editor, '!');
    agentWrites('three');
    expect(await screen.findByTestId('conflict-bar')).toHaveTextContent('a.ts changed on disk while you were editing it.');
    expect(editor).toHaveValue('two!');
  });

  it('a clean file deleted on disk is struck through, and saving brings it back', async () => {
    const user = userEvent.setup();
    renderApp(path);
    await screen.findByTestId('forge');
    act(() => openFile(projectId, 'a.ts'));
    await screen.findByLabelText('Editing a.ts');

    act(() => {
      db.deleteFileExternally(projectId, 'a.ts');
      applyFilesChanged(queryClient, { projectId, changes: [{ path: 'a.ts', kind: 'deleted' }], resync: false });
    });
    await waitFor(() => expect(screen.getByTestId('tab-a.ts')).toHaveClass('line-through'));
    expect(screen.getByTestId('deleted-bar')).toBeInTheDocument();

    await user.keyboard('{Control>}s{/Control}');
    await waitFor(() => expect(db.filesOf(projectId)['a.ts']?.content).toBe('one'));
    expect(useEditorStore.getState().projects[projectId]?.files['a.ts']?.deletedOnDisk).toBe(false);
  });
});
```

In the deleted case the buffer is clean but no longer on disk, so Ctrl+S must save it with base `null` even though it is not dirty. `saveFile` handles that: it saves when the file is dirty **or** `deletedOnDisk`.

Create `apps/web/src/forge/editor/CloseDialogs.test.tsx`:

```tsx
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { db, installMockServer, renderWithQuery } from '../../test/app';
import { openFile } from './actions';
import { EditorArea } from './EditorArea';
import { useEditorStore } from './editor-store';
import { useBeforeUnloadGuard } from './guards';

installMockServer();

let projectId: string;
beforeEach(() => {
  projectId = db.createProject({ name: 'P' }).id;
  db.seedFiles(projectId, { 'a.ts': 'one', 'b.ts': 'bee' });
});

async function dirtyTab(user: ReturnType<typeof userEvent.setup>) {
  renderWithQuery(<EditorArea projectId={projectId} />);
  act(() => openFile(projectId, 'a.ts'));
  await user.type(await screen.findByLabelText('Editing a.ts'), '!');
}

describe('D299 §6.2 closing a tab with unsaved changes asks first', () => {
  it('Cancel keeps the tab and the changes', async () => {
    const user = userEvent.setup();
    await dirtyTab(user);
    await user.click(screen.getByRole('button', { name: 'Close a.ts' }));
    expect(await screen.findByRole('dialog', { name: 'Save changes to a.ts?' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByTestId('tab-a.ts')).toBeInTheDocument();
  });

  it('Don’t save closes the tab and drops the changes', async () => {
    const user = userEvent.setup();
    await dirtyTab(user);
    await user.click(screen.getByRole('button', { name: 'Close a.ts' }));
    await user.click(await screen.findByRole('button', { name: 'Don’t save' }));
    expect(screen.queryByTestId('tab-a.ts')).toBeNull();
    expect(db.filesOf(projectId)['a.ts']?.content).toBe('one');
  });

  it('Save writes the file, then closes the tab', async () => {
    const user = userEvent.setup();
    await dirtyTab(user);
    await user.click(screen.getByRole('button', { name: 'Close a.ts' }));
    await user.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByTestId('tab-a.ts')).toBeNull());
    expect(db.filesOf(projectId)['a.ts']?.content).toBe('one!');
  });

  it('closing a clean tab asks nothing', async () => {
    const user = userEvent.setup();
    renderWithQuery(<EditorArea projectId={projectId} />);
    act(() => openFile(projectId, 'b.ts'));
    await user.click(await screen.findByRole('button', { name: 'Close b.ts' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('D299 §2.3 closing the browser tab with unsaved work asks first', () => {
  function Guard() {
    useBeforeUnloadGuard();
    return null;
  }

  it('cancels beforeunload only while something is unsaved', () => {
    renderWithQuery(<Guard />);
    const quiet = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(quiet);
    expect(quiet.defaultPrevented).toBe(false);

    act(() => {
      useEditorStore.getState().open(projectId, 'a.ts');
      useEditorStore.getState().setDirty(projectId, 'a.ts', true);
    });
    const guarded = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(guarded);
    expect(guarded.defaultPrevented).toBe(true);
  });
});
```

In `apps/web/src/test/setup.tsx`, add:

```tsx
vi.mock('../forge/editor/CompareView', () => ({
  CompareView: ({ path }: { path: string }) => <div data-testid="compare-view">{path}</div>,
}));
```

- [ ] **Step 2: Run them to watch them fail**

Run: `pnpm --filter @ace/web exec vitest run src/forge/editor/actions.test.ts src/forge/editor/sync.test.tsx src/forge/editor/CloseDialogs.test.tsx`
Expected: FAIL. `saveFile` is not exported, and `./guards` does not exist.

- [ ] **Step 3: Add save, Keep mine and Take theirs to `actions.ts`**

Append to `apps/web/src/forge/editor/actions.ts`, and add the imports `type FileContent` from `@ace/contracts`, `AceApiError` from `@ace/sdk`, `type QueryClient` from `@tanstack/react-query`, `api` from `../../app/api`, `fileContentQuery` from `../files/hooks`, `fileKeys` from `../files/keys`, `logOutput` from `../panel/output-store`, and `getModel, markSaved, replaceContent` from `./models`:

```ts
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const isNotFound = (error: unknown): boolean => AceApiError.is(error) && error.status === 404;

/**
 * Save one buffer (FR-GIT-004, §6.1): against the version it was loaded from, so a file the disk
 * changed meanwhile is never overwritten — that answers 409 and raises the conflict bar (§5.4). A
 * clean file deleted on disk is saved too: that recreates it. Only the text that was sent counts
 * as saved; typing during the save stays unsaved.
 */
export async function saveFile(projectId: string, path: string, queryClient: QueryClient): Promise<boolean> {
  const store = useEditorStore.getState();
  const file = store.projects[projectId]?.files[path];
  const model = getModel(projectId, path);
  if (file === undefined || model === undefined || file.baseVersion === undefined || file.saving) return false;
  if (!file.dirty && !file.deletedOnDisk) return true;
  if (file.conflict !== undefined) {
    logOutput(projectId, 'warn', `${path} changed on disk — choose Compare, Take theirs or Keep mine first.`);
    return false;
  }
  const content = model.getValue();
  const sent = model.getAlternativeVersionId();
  const eol = model.getEOL() === '\r\n' ? 'crlf' : 'lf';
  store.saveStarted(projectId, path);
  try {
    const result = await api().saveFile(projectId, { path, content, baseVersion: file.baseVersion, eol, bom: file.bom });
    markSaved(projectId, path, sent);
    useEditorStore.getState().saved(projectId, path, result.version);
    queryClient.setQueryData<FileContent>(fileKeys.content(projectId, path), {
      kind: 'text',
      path,
      content,
      version: result.version,
      eol,
      bom: file.bom,
      size: result.size,
    });
    logOutput(projectId, 'info', `Saved ${path}`);
    return true;
  } catch (error) {
    if (AceApiError.is(error) && error.code === 'file_changed') {
      const current = (error.details as { currentVersion?: string | null } | undefined)?.currentVersion ?? null;
      useEditorStore.getState().conflicted(projectId, path, current === null ? 'deleted' : 'changed');
      logOutput(projectId, 'warn', `${path} changed on disk after it was opened; nothing was overwritten.`);
      return false;
    }
    useEditorStore.getState().saveFailed(projectId, path, messageOf(error));
    logOutput(projectId, 'error', `Could not save ${path}: ${messageOf(error)}`);
    return false;
  }
}

/** Save every unsaved buffer of the project, one after another. */
export async function saveAll(projectId: string, queryClient: QueryClient): Promise<void> {
  const files = useEditorStore.getState().projects[projectId]?.files ?? {};
  for (const [path, file] of Object.entries(files)) {
    if (file.dirty || file.deletedOnDisk) await saveFile(projectId, path, queryClient);
  }
}

async function readDisk(projectId: string, path: string, queryClient: QueryClient): Promise<FileContent | null> {
  try {
    return await queryClient.fetchQuery({ ...fileContentQuery(projectId, path), staleTime: 0 });
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** §5.4 Keep mine: the disk's version becomes the base, so the next save wins. The buffer stays as typed. */
export async function keepMine(projectId: string, path: string, queryClient: QueryClient): Promise<void> {
  try {
    const disk = await readDisk(projectId, path, queryClient);
    useEditorStore.getState().resolved(projectId, path, disk?.kind === 'text' ? disk.version : null);
    logOutput(projectId, 'info', `Keeping your version of ${path}; your next save replaces the one on disk.`);
  } catch (error) {
    logOutput(projectId, 'error', `Could not read ${path}: ${messageOf(error)}`);
  }
}

/** §5.4 Take theirs: the buffer takes the disk's text; a file gone from disk closes. */
export async function takeTheirs(projectId: string, path: string, queryClient: QueryClient): Promise<void> {
  try {
    const disk = await readDisk(projectId, path, queryClient);
    if (disk === null || disk.kind !== 'text') {
      closeFiles(projectId, [path]);
      logOutput(projectId, 'info', `Closed ${path}: it is no longer a text file on disk.`);
      return;
    }
    replaceContent(projectId, path, disk.content);
    useEditorStore.getState().resolved(projectId, path, disk.version);
    logOutput(projectId, 'info', `Reloaded ${path} from disk; your unsaved changes were discarded.`);
  } catch (error) {
    logOutput(projectId, 'error', `Could not read ${path}: ${messageOf(error)}`);
  }
}
```

- [ ] **Step 4: Follow the disk**

Create `apps/web/src/forge/editor/useEditorSync.ts`:

```ts
import type { TextFileContent } from '@ace/contracts';
import { AceApiError } from '@ace/sdk';
import { useQueries } from '@tanstack/react-query';
import { useEffect } from 'react';

import { fileContentQuery } from '../files/hooks';
import { isImagePath } from '../files/paths';
import { logOutput } from '../panel/output-store';
import { useEditorStore, useProjectEditor, type OpenFile } from './editor-store';
import { replaceContent } from './models';

function diskChanged(projectId: string, file: OpenFile, disk: TextFileContent): void {
  const store = useEditorStore.getState();
  if (!file.dirty) {
    replaceContent(projectId, file.path, disk.content);
    store.resolved(projectId, file.path, disk.version);
    logOutput(projectId, 'info', `${file.path} changed on disk; reloaded.`);
    return;
  }
  if (file.conflict === undefined) {
    store.conflicted(projectId, file.path, 'changed');
    logOutput(projectId, 'warn', `${file.path} changed on disk while you were editing it.`);
  }
}

function diskGone(projectId: string, file: OpenFile): void {
  const store = useEditorStore.getState();
  if (file.dirty) {
    if (file.conflict === undefined) {
      store.conflicted(projectId, file.path, 'deleted');
      logOutput(projectId, 'warn', `${file.path} was deleted on disk while you were editing it.`);
    }
  } else if (!file.deletedOnDisk) {
    store.markDeletedOnDisk(projectId, file.path);
    logOutput(projectId, 'info', `${file.path} was deleted on disk.`);
  }
}

/**
 * Conflict-aware editing (D300's half that Phase 1 needs, §5.4): every open file's content query is
 * watched; when the watcher invalidates one and the refetch shows a new version, a clean buffer
 * follows the disk and an unsaved one gets the conflict bar. A save in flight is left alone.
 */
export function useEditorSync(projectId: string): void {
  const editor = useProjectEditor(projectId);
  const paths = editor.tabs.filter((path) => !isImagePath(path));
  const results = useQueries({ queries: paths.map((path) => ({ ...fileContentQuery(projectId, path), enabled: projectId !== '' })) });

  useEffect(() => {
    paths.forEach((path, index) => {
      const result = results[index];
      const file = useEditorStore.getState().projects[projectId]?.files[path];
      if (result === undefined || file === undefined || file.saving || file.baseVersion === undefined) return;
      if (result.error) {
        if (AceApiError.is(result.error) && result.error.status === 404 && file.baseVersion !== null) diskGone(projectId, file);
        return;
      }
      const disk = result.data;
      if (disk?.kind !== 'text' || disk.version === file.baseVersion) return;
      diskChanged(projectId, file, disk);
    });
  });
}
```

The effect has no dependency array on purpose. It runs after every render and only acts on new query data, and each action is idempotent: a conflict is raised once, and a reload only happens when the version differs.

- [ ] **Step 5: The bars, Compare, and the close guard**

Create `apps/web/src/forge/editor/ConflictBar.tsx`:

```tsx
import { Button } from '@ace/ui';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Trash2 } from 'lucide-react';

import { nameOf } from '../files/paths';
import { closeFiles, keepMine, saveFile, takeTheirs } from './actions';
import type { Conflict } from './editor-store';

const BAR = 'flex shrink-0 items-center gap-3 border-b border-border px-3 py-1.5 text-[12.5px]';

/** §5.4: the disk moved on under unsaved work. Compare, Take theirs, or Keep mine (the next save wins). */
export function ConflictBar({ projectId, path, conflict, comparing, onCompare }: { projectId: string; path: string; conflict: Conflict; comparing: boolean; onCompare(): void }) {
  const queryClient = useQueryClient();
  return (
    <div role="alert" data-testid="conflict-bar" className={`${BAR} bg-card`}>
      <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--color-status-WAITING)]" aria-hidden />
      <span className="min-w-0 flex-1">
        {conflict === 'deleted'
          ? `${nameOf(path)} was deleted on disk while you were editing it.`
          : `${nameOf(path)} changed on disk while you were editing it.`}
      </span>
      {conflict === 'changed' && (
        <Button size="sm" variant="ghost" onClick={onCompare}>
          {comparing ? 'Back to editing' : 'Compare'}
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={() => void takeTheirs(projectId, path, queryClient)}>
        {conflict === 'deleted' ? 'Close file' : 'Take theirs'}
      </Button>
      <Button size="sm" onClick={() => void keepMine(projectId, path, queryClient)}>
        Keep mine
      </Button>
    </div>
  );
}

/** A clean file that is gone from disk: saving recreates it. */
export function DeletedBar({ projectId, path }: { projectId: string; path: string }) {
  const queryClient = useQueryClient();
  return (
    <div role="status" data-testid="deleted-bar" className={`${BAR} bg-card`}>
      <Trash2 className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
      <span className="min-w-0 flex-1">{nameOf(path)} was deleted on disk. Saving puts it back.</span>
      <Button size="sm" variant="ghost" onClick={() => closeFiles(projectId, [path])}>
        Close
      </Button>
      <Button size="sm" onClick={() => void saveFile(projectId, path, queryClient)}>
        Save
      </Button>
    </div>
  );
}

/** The last save failed: the buffer is still unsaved, and this says why (§10). */
export function SaveErrorBar({ projectId, path, message }: { projectId: string; path: string; message: string }) {
  const queryClient = useQueryClient();
  return (
    <div role="alert" data-testid="save-error-bar" className={`${BAR} bg-card text-danger`}>
      <span className="min-w-0 flex-1">Couldn’t save {nameOf(path)}: {message}</span>
      <Button size="sm" variant="ghost" onClick={() => void saveFile(projectId, path, queryClient)}>
        Try again
      </Button>
    </div>
  );
}
```

Create `apps/web/src/forge/editor/CompareView.tsx`:

```tsx
import { useQueryClient } from '@tanstack/react-query';
import type * as Monaco from 'monaco-editor';
import { useEffect, useRef } from 'react';

import { monaco } from '../../config-panel/monaco-loader';
import { fileContentQuery } from '../files/hooks';
import { languageOf } from './languages';
import { getModel } from './models';

/** §5.4 Compare: the disk on the left, read-only; your buffer on the right, still editable. */
export function CompareView({ projectId, path }: { projectId: string; path: string }) {
  const container = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  useEffect(() => {
    const element = container.current;
    const buffer = getModel(projectId, path);
    if (element === null || buffer === undefined) return;
    let disposed = false;
    let original: Monaco.editor.ITextModel | undefined;
    let diff: Monaco.editor.IStandaloneDiffEditor | undefined;
    queryClient.fetchQuery({ ...fileContentQuery(projectId, path), staleTime: 0 }).then(
      (disk) => {
        if (disposed) return;
        original = monaco.editor.createModel(disk.kind === 'text' ? disk.content : '', languageOf(path));
        diff = monaco.editor.createDiffEditor(element, {
          automaticLayout: true,
          originalEditable: false,
          renderSideBySide: true,
          fontSize: 13,
        });
        diff.setModel({ original, modified: buffer });
      },
      () => undefined,
    );
    return () => {
      disposed = true;
      diff?.dispose();
      original?.dispose();
    };
  }, [projectId, path, queryClient]);
  return <div ref={container} className="h-full w-full" data-testid="compare-view" />;
}
```

Create `apps/web/src/forge/editor/CloseDialogs.tsx`:

```tsx
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@ace/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, type ReactElement } from 'react';

import { nameOf } from '../files/paths';
import { closeFiles, saveFile } from './actions';
import { useEditorStore, type OpenFile } from './editor-store';

const NO_FILES: Record<string, OpenFile> = {};

/** Closing tabs that hold unsaved work asks Save / Don't save / Cancel first (§6.2); clean ones close at once. */
export function useCloseRequest(projectId: string): { request(paths: readonly string[]): void; dialog: ReactElement | null } {
  const [pending, setPending] = useState<readonly string[] | undefined>();
  const request = useCallback(
    (paths: readonly string[]) => {
      const files = useEditorStore.getState().projects[projectId]?.files ?? NO_FILES;
      if (paths.some((path) => files[path]?.dirty === true)) setPending(paths);
      else closeFiles(projectId, paths);
    },
    [projectId],
  );
  const dialog = pending === undefined ? null : <UnsavedDialog projectId={projectId} paths={pending} onDone={() => setPending(undefined)} />;
  return { request, dialog };
}

function UnsavedDialog({ projectId, paths, onDone }: { projectId: string; paths: readonly string[]; onDone(): void }) {
  const queryClient = useQueryClient();
  const files = useEditorStore((state) => state.projects[projectId]?.files ?? NO_FILES);
  const dirty = paths.filter((path) => files[path]?.dirty === true);
  const [busy, setBusy] = useState(false);
  const first = dirty[0] ?? paths[0] ?? '';

  const saveAndClose = async (): Promise<void> => {
    setBusy(true);
    const saved = await Promise.all(dirty.map((path) => saveFile(projectId, path, queryClient)));
    setBusy(false);
    // a failed save keeps the dialog and the tab, with its reason on the tab (§10)
    if (saved.every(Boolean)) {
      closeFiles(projectId, paths);
      onDone();
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onDone()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{dirty.length > 1 ? `Save changes to ${dirty.length} files?` : `Save changes to ${nameOf(first)}?`}</DialogTitle>
          <DialogDescription>Your changes are lost if you don’t save them.</DialogDescription>
        </DialogHeader>
        {dirty.length > 1 && (
          <ul className="font-machine text-[12px] text-fg-soft">
            {dirty.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              closeFiles(projectId, paths);
              onDone();
            }}
          >
            Don’t save
          </Button>
          <Button disabled={busy} onClick={() => void saveAndClose()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

Create `apps/web/src/forge/editor/guards.ts`:

```ts
import { useEffect } from 'react';

import { hasUnsavedWork, useEditorStore } from './editor-store';

/**
 * Unsaved buffers survive every in-app navigation — the editor store outlives routes — so the
 * only way to lose one is closing or reloading the browser tab: that asks first (§2.3).
 */
export function useBeforeUnloadGuard(): void {
  const unsaved = useEditorStore(hasUnsavedWork);
  useEffect(() => {
    if (!unsaved) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [unsaved]);
}
```

- [ ] **Step 6: Wire everything**

In `apps/web/src/forge/editor/EditorArea.tsx`, replace `TextFile`'s final `return` with the bars and Compare. Import `useEffect`, `useState`, `useOpenFile`, `ConflictBar`, `DeletedBar`, `SaveErrorBar`, and a lazy `CompareView`. Define the lazy import at module level:

```tsx
const CompareView = lazy(() => import('./CompareView').then((module) => ({ default: module.CompareView })));
```

Inside `TextFile`, declare these hooks **before** the early returns (rules of hooks):

```tsx
  const file = useOpenFile(projectId, path);
  const [comparing, setComparing] = useState(false);
  useEffect(() => {
    if (file?.conflict === undefined) setComparing(false);
  }, [file?.conflict]);
```

Then the final return:

```tsx
  return (
    <div className="flex h-full min-h-0 flex-col">
      {file?.conflict !== undefined && (
        <ConflictBar projectId={projectId} path={path} conflict={file.conflict} comparing={comparing} onCompare={() => setComparing((value) => !value)} />
      )}
      {file?.deletedOnDisk === true && file.conflict === undefined && <DeletedBar projectId={projectId} path={path} />}
      {file?.error !== undefined && <SaveErrorBar projectId={projectId} path={path} message={file.error} />}
      <div className="min-h-0 flex-1">
        <Suspense fallback={<p className="p-4 text-[13px] text-fg-muted">Loading the editor…</p>}>
          {comparing ? <CompareView projectId={projectId} path={path} /> : <EditorHost projectId={projectId} path={path} initial={text} />}
        </Suspense>
      </div>
    </div>
  );
```

In `TabsBar.tsx` and `OpenEditors.tsx`, replace `const close = (paths) => closeFiles(projectId, paths);` with:

```tsx
  const { request: close, dialog } = useCloseRequest(projectId);
```

Render `{dialog}` once inside each component's root element. In `OpenEditors.tsx` also add a Save all action to the header row, after the toggle button:

```tsx
        <IconAction
          label="Save all"
          Icon={SaveAll}
          disabled={!editor.tabs.some((path) => editor.files[path]?.dirty === true)}
          onClick={() => void saveAll(projectId, queryClient)}
        />
```

For that, import `IconAction`, `SaveAll` from lucide, `saveAll`, and `useQueryClient`.

In `apps/web/src/forge/ForgeWorkbench.tsx`:
- Add `useEditorSync(projectId);`.
- Add `const queryClient = useQueryClient();` and `const closeRequest = useCloseRequest(projectId);`.
- Extend the shortcuts:

```tsx
  useShortcuts([
    [SHORTCUTS.toggleSidebar, toggleSidebar],
    [SHORTCUTS.togglePanel, togglePanel],
    [SHORTCUTS.save, () => {
      const active = useEditorStore.getState().projects[projectId]?.active;
      if (active !== undefined) void saveFile(projectId, active, queryClient);
    }],
    [SHORTCUTS.saveAll, () => void saveAll(projectId, queryClient)],
    [SHORTCUTS.closeTab, () => {
      const active = useEditorStore.getState().projects[projectId]?.active;
      if (active !== undefined) closeRequest.request([active]);
    }],
  ]);
```

- Render `{closeRequest.dialog}` just before the `StatusBar`.

In `apps/web/src/app/layout/AppShell.tsx`, call `useBeforeUnloadGuard();` after `useApplyTheme();`.

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @ace/web exec vitest run src/forge`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
npx prettier --write --config packages/config/prettier.config.js apps/web/src/forge/editor
git add apps/web/src
git commit -m "feat(web): conflict-safe saves — 409 never overwrites, the disk changing under a buffer, Keep mine / Take theirs / Compare, unsaved-work guards [D299] [FR-GIT-004]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: Web — Explorer file operations: create, rename, move by drag, delete, context menu

**Files:**
- Modify:
  - `apps/web/src/forge/explorer/explorer-store.ts`: the `editing` state;
  - `apps/web/src/forge/explorer/FileTree.tsx`: inline input, context menu, drag and drop, F2/Delete;
  - `apps/web/src/forge/explorer/ExplorerView.tsx`: New file and New folder buttons.
- Create: `apps/web/src/forge/explorer/names.ts`, `apps/web/src/forge/explorer/EntryDialogs.tsx`, `apps/web/src/forge/explorer/InlineName.tsx`
- Test: create `apps/web/src/forge/explorer/names.test.ts`, `apps/web/src/forge/explorer/FileOperations.test.tsx`

**Interfaces:**
- Consumes:
  - from Task 10: `useCreateEntry`, `useMoveEntry`, `useDeleteEntry`, `joinPath`;
  - from Task 14: `openFile`, `filesMoved`, `filesRemoved`;
  - `ContextMenu*` and `Dialog*` from `@ace/ui`.
- Produces:
  - `Editing = { mode: 'create'; parent: string; kind: FileEntryKind } | { mode: 'rename'; path: string }`;
  - `useExplorerStore.startCreate(projectId, parent, kind)`, `startRename(projectId, path)`, `stopEditing(projectId)`;
  - `nameProblem(name, siblings, { allowSlash })`;
  - `FileTree`'s new prop `editable?: boolean` (default `true`; the phone view passes `false`).

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/forge/explorer/names.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { nameProblem } from './names';

describe('D299 a name the engine will accept, checked before asking', () => {
  it.each([
    ['', 'A name is required.'],
    ['CON', 'Windows reserves that name.'],
    ['a:b', 'A name cannot contain < > : " | ? *'],
    ['trailing.', 'A name cannot end with a dot or a space.'],
    ['..', 'That name is reserved.'],
  ])('%j → %s', (name, problem) => {
    expect(nameProblem(name, [], { allowSlash: false })).toBe(problem);
  });

  it('refuses a sibling’s name in any case, and a slash in a rename only', () => {
    expect(nameProblem('readme.md', ['README.md'], { allowSlash: false })).toBe('“readme.md” already exists here.');
    expect(nameProblem('a/b.ts', [], { allowSlash: false })).toBe('A name cannot contain a slash.');
    expect(nameProblem('a/b.ts', [], { allowSlash: true })).toBeUndefined();
  });
});
```

Create `apps/web/src/forge/explorer/FileOperations.test.tsx`:

```tsx
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { db, installMockServer, renderWithQuery } from '../../test/app';
import { openFile } from '../editor/actions';
import { useEditorStore } from '../editor/editor-store';
import { ExplorerView } from './ExplorerView';

installMockServer();

let projectId: string;
beforeEach(() => {
  projectId = db.createProject({ name: 'Shop' }).id;
  db.seedFiles(projectId, { 'src/app.ts': 'export {};', 'notes.md': '# notes', 'docs/readme.md': '' });
});

const tabs = () => useEditorStore.getState().projects[projectId]?.tabs ?? [];
const onDisk = () => Object.keys(db.filesOf(projectId)).sort();

describe('D299 FR-GIT-003 file operations in the Explorer', () => {
  it('creates a file inline from the header button and opens it', async () => {
    const user = userEvent.setup();
    renderWithQuery(<ExplorerView projectId={projectId} />);
    await screen.findByTestId('tree-item-notes.md');
    await user.click(screen.getByRole('button', { name: 'New File' }));
    await user.type(screen.getByRole('textbox', { name: 'New file name' }), 'todo.md{Enter}');
    await waitFor(() => expect(onDisk()).toContain('todo.md'));
    expect(tabs()).toContain('todo.md');
  });

  it('refuses a bad name inline, without asking the engine', async () => {
    const user = userEvent.setup();
    renderWithQuery(<ExplorerView projectId={projectId} />);
    await screen.findByTestId('tree-item-notes.md');
    await user.click(screen.getByRole('button', { name: 'New File' }));
    await user.type(screen.getByRole('textbox', { name: 'New file name' }), 'notes.md{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('“notes.md” already exists here.');
    expect(onDisk().filter((path) => path === 'notes.md')).toHaveLength(1);
  });

  it('renames with F2, and an open tab follows the file', async () => {
    const user = userEvent.setup();
    renderWithQuery(<ExplorerView projectId={projectId} />);
    act(() => openFile(projectId, 'notes.md'));
    act(() => screen.getByTestId('tree-item-notes.md').focus());
    await user.keyboard('{F2}');
    const input = screen.getByRole('textbox', { name: 'Rename notes.md' });
    await user.clear(input);
    await user.type(input, 'journal.md{Enter}');
    await waitFor(() => expect(onDisk()).toContain('journal.md'));
    expect(tabs()).toEqual(['journal.md']);
  });

  it('moves a file by dragging it onto a folder, after a confirm', async () => {
    const user = userEvent.setup();
    renderWithQuery(<ExplorerView projectId={projectId} />);
    const file = await screen.findByTestId('tree-item-notes.md');
    const folder = screen.getByTestId('tree-item-docs');
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? '',
      effectAllowed: 'move',
      dropEffect: 'move',
      types: ['application/x-ace-path'],
    };
    fireEvent.dragStart(file, { dataTransfer });
    fireEvent.dragOver(folder, { dataTransfer });
    fireEvent.drop(folder, { dataTransfer });
    const dialog = await screen.findByRole('dialog', { name: 'Move “notes.md” into docs?' });
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(onDisk()).toContain('docs/notes.md'));
  });

  it('deletes after a confirm that says it cannot be undone, and closes the tab', async () => {
    const user = userEvent.setup();
    renderWithQuery(<ExplorerView projectId={projectId} />);
    act(() => openFile(projectId, 'notes.md'));
    act(() => screen.getByTestId('tree-item-notes.md').focus());
    await user.keyboard('{Delete}');
    const dialog = await screen.findByRole('dialog', { name: 'Delete “notes.md”?' });
    expect(dialog).toHaveTextContent('This cannot be undone.');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onDisk()).not.toContain('notes.md'));
    expect(tabs()).toEqual([]);
  });

  it('offers the operations on a right click', async () => {
    const user = userEvent.setup();
    renderWithQuery(<ExplorerView projectId={projectId} />);
    fireEvent.contextMenu(await screen.findByTestId('tree-item-src'));
    for (const name of ['New File', 'New Folder', 'Rename', 'Delete', 'Copy Path', 'Copy Relative Path']) {
      expect(await screen.findByRole('menuitem', { name: new RegExp(name) })).toBeInTheDocument();
    }
    await user.click(screen.getByRole('menuitem', { name: /New Folder/ }));
    expect(screen.getByRole('textbox', { name: 'New folder name' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run them to watch them fail**

Run: `pnpm --filter @ace/web exec vitest run src/forge/explorer/names.test.ts src/forge/explorer/FileOperations.test.tsx`
Expected: FAIL. `./names` does not exist, and there is no New File button.

- [ ] **Step 3: Names and the editing state**

Create `apps/web/src/forge/explorer/names.ts`:

```ts
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Why a name cannot be used, in words — the engine's rule (`assertValidName`, §6.1), checked
 * before the request so the person sees it while typing. A create may hold slashes (`a/b.ts`
 * makes the folder too); a rename may not.
 */
export function nameProblem(name: string, siblings: readonly string[], options: { allowSlash: boolean }): string | undefined {
  if (name.trim() === '') return 'A name is required.';
  if (!options.allowSlash && /[\\/]/.test(name)) return 'A name cannot contain a slash.';
  const segments = options.allowSlash ? name.split('/') : [name];
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return 'That name is reserved.';
    if (/[<>:"|?*\\]/.test(segment)) return 'A name cannot contain < > : " | ? *';
    if (/[. ]$/.test(segment)) return 'A name cannot end with a dot or a space.';
    if (RESERVED.test(segment)) return 'Windows reserves that name.';
  }
  const first = segments[0] ?? name;
  if (siblings.some((sibling) => sibling.toLowerCase() === first.toLowerCase())) return `“${first}” already exists here.`;
  return undefined;
}
```

In `apps/web/src/forge/explorer/explorer-store.ts`:
- Import `type FileEntryKind` from `@ace/contracts`.
- Add:

```ts
/** The tree row being typed into: a new entry under `parent`, or a rename. */
export type Editing = { mode: 'create'; parent: string; kind: FileEntryKind } | { mode: 'rename'; path: string };
```

- Add `editing: Editing | undefined;` to `ProjectExplorer`, and `editing: undefined` to `EMPTY`.
- Add these actions to the interface and the store:

```ts
  startCreate(projectId: string, parent: string, kind: FileEntryKind): void;
  startRename(projectId: string, path: string): void;
  stopEditing(projectId: string): void;
```

```ts
    startCreate: (projectId, parent, kind) =>
      update(projectId, (c) => {
        const missing = parent === '' ? [] : lineage(parent).filter((p) => !c.expanded.includes(p));
        return { ...c, expanded: [...c.expanded, ...missing], editing: { mode: 'create', parent, kind } };
      }),
    startRename: (projectId, path) => update(projectId, (c) => ({ ...c, selected: path, editing: { mode: 'rename', path } })),
    stopEditing: (projectId) => update(projectId, (c) => ({ ...c, editing: undefined })),
```

- Make `moved` and `removed` keep `editing` by spreading `...c` first. For example, `moved` becomes `update(projectId, (c) => ({ ...c, expanded: …, selected: … }))`.

- [ ] **Step 4: The inline input and the dialogs**

Create `apps/web/src/forge/explorer/InlineName.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';

/**
 * The tree's inline name field (VS Code): Enter commits, Escape cancels, leaving the field commits
 * a changed name. A problem shows under it as an alert, and the field stays open until it is fixed
 * or cancelled.
 */
export function InlineName({ label, initial, problemOf, onCommit, onCancel, depth }: {
  label: string;
  initial: string;
  /** The reason a name cannot be used, checked locally, or undefined. */
  problemOf(name: string): string | undefined;
  /** Resolves with a refusal to show (the engine's), or undefined when done. */
  onCommit(name: string): Promise<string | undefined>;
  onCancel(): void;
  depth: number;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  const [problem, setProblem] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const element = input.current;
    if (element === null) return;
    element.focus();
    const dot = initial.lastIndexOf('.');
    element.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);

  const commit = async (): Promise<void> => {
    if (busy) return;
    if (value === initial) {
      onCancel();
      return;
    }
    const local = problemOf(value);
    if (local !== undefined) {
      setProblem(local);
      return;
    }
    setBusy(true);
    const refused = await onCommit(value);
    setBusy(false);
    setProblem(refused);
  };

  return (
    <div className="relative" style={{ paddingLeft: 8 + depth * 12 + 32 }}>
      <input
        ref={input}
        aria-label={label}
        value={value}
        disabled={busy}
        onChange={(event) => {
          setValue(event.target.value);
          setProblem(undefined);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') void commit();
          if (event.key === 'Escape') onCancel();
        }}
        onBlur={() => {
          if (value.trim() === '' || value === initial) onCancel();
          else void commit();
        }}
        className="h-[22px] w-full rounded-sm border border-accent bg-canvas px-1 font-machine text-[12px] text-fg outline-none"
      />
      {problem !== undefined && (
        <p role="alert" className="absolute left-0 right-0 z-10 mt-0.5 border border-danger bg-panel px-2 py-1 text-[11.5px] text-danger" style={{ marginLeft: 8 + depth * 12 + 32 }}>
          {problem}
        </p>
      )}
    </div>
  );
}
```

Create `apps/web/src/forge/explorer/EntryDialogs.tsx`:

```tsx
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@ace/ui';
import { useState } from 'react';

import { nameOf } from '../files/paths';

/** A confirm with an error line for the engine's refusal; the action resolves to that refusal or undefined. */
function ConfirmDialog({ title, description, action, destructive, onConfirm, onClose }: {
  title: string;
  description: string;
  action: string;
  destructive: boolean;
  onConfirm(): Promise<string | undefined>;
  onClose(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {problem !== undefined && (
          <p role="alert" className="text-sm text-danger">
            {problem}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const refused = await onConfirm();
              setBusy(false);
              if (refused === undefined) onClose();
              else setProblem(refused);
            }}
          >
            {action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Phase 1: a delete is permanent and says so. Phase 3 keeps a checkpoint first (D300) and changes this line. */
export function DeleteDialog({ path, isFolder, onConfirm, onClose }: { path: string; isFolder: boolean; onConfirm(): Promise<string | undefined>; onClose(): void }) {
  return (
    <ConfirmDialog
      title={`Delete “${nameOf(path)}”?`}
      description={`${isFolder ? 'The folder and everything in it are' : 'The file is'} removed from disk. This cannot be undone. Open files with unsaved changes are closed without saving.`}
      action="Delete"
      destructive
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}

export function MoveDialog({ from, folder, onConfirm, onClose }: { from: string; folder: string; onConfirm(): Promise<string | undefined>; onClose(): void }) {
  const where = folder === '' ? 'the project folder' : folder;
  return (
    <ConfirmDialog
      title={`Move “${nameOf(from)}” into ${where}?`}
      description="Open files follow it."
      action="Move"
      destructive={false}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}
```

- [ ] **Step 5: Replace `FileTree.tsx` with the editable tree**

Replace `apps/web/src/forge/explorer/FileTree.tsx` with this version. It keeps Task 11's browsing, keyboard and decorations as they are, and adds the operations:

```tsx
import type { FileEntry } from '@ace/contracts';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger, cn } from '@ace/ui';
import { AceApiError } from '@ace/sdk';
import { ChevronRight, Folder, FolderOpen } from 'lucide-react';
import { useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';

import { useProject } from '../../projects/hooks';
import { filesMoved, filesRemoved, openFile } from '../editor/actions';
import { useCreateEntry, useDeleteEntry, useMoveEntry, useRepoStatus } from '../files/hooks';
import { isWithin, joinPath, nameOf, parentOf } from '../files/paths';
import { buildDecorations, TONE_COLOR } from './decorations';
import { DeleteDialog, MoveDialog } from './EntryDialogs';
import { useExplorerStore, useProjectExplorer } from './explorer-store';
import { FileIcon } from './FileIcon';
import { InlineName } from './InlineName';
import { nameProblem } from './names';
import { useTreeRows, type TreeRow } from './useTreeRows';

const DRAG_TYPE = 'application/x-ace-path';
const messageOf = (error: unknown): string => (AceApiError.is(error) || error instanceof Error ? error.message : String(error));

export interface FileTreeProps {
  projectId: string;
  label: string;
  onOpen(path: string, options: { preview: boolean }): void;
  /** False on a phone: browse only (FR-MOB-001). */
  editable?: boolean;
}

/**
 * The project folder as an ARIA tree (FR-GIT-003): lazy, folders first, ignored entries dimmed, git
 * decorations, keyboard navigation — and, when editable, VS Code's operations: inline create and
 * rename (F2), delete (Delete) after a confirm, move by drag after a confirm, all from a context
 * menu too. Open tabs follow every rename and move.
 */
export function FileTree({ projectId, label, onOpen, editable = true }: FileTreeProps) {
  const { rows, loading, error } = useTreeRows(projectId);
  const { expanded, selected, editing } = useProjectExplorer(projectId);
  const store = useExplorerStore;
  const status = useRepoStatus(projectId);
  const project = useProject(projectId);
  const decorations = useMemo(() => buildDecorations(status.data), [status.data]);
  const create = useCreateEntry(projectId);
  const move = useMoveEntry(projectId);
  const remove = useDeleteEntry(projectId);
  const rowElements = useRef(new Map<string, HTMLDivElement>());
  const typed = useRef({ text: '', at: 0 });
  const dragging = useRef<string | undefined>(undefined);
  const [dropTarget, setDropTarget] = useState<string | undefined>();
  const [menuTarget, setMenuTarget] = useState<FileEntry | undefined>();
  const [pendingMove, setPendingMove] = useState<{ from: string; folder: string } | undefined>();
  const [pendingDelete, setPendingDelete] = useState<FileEntry | undefined>();

  const siblingsOf = (folder: string, except?: string): string[] =>
    rows.filter((row) => parentOf(row.entry.path) === folder && row.entry.path !== except).map((row) => row.entry.name);
  const folderFor = (entry: FileEntry | undefined): string =>
    entry === undefined ? '' : entry.kind === 'folder' ? entry.path : parentOf(entry.path);

  const focusRow = (path: string): void => {
    store.getState().select(projectId, path);
    rowElements.current.get(path)?.focus();
  };
  const activate = (row: TreeRow, preview: boolean): void => {
    if (row.entry.kind === 'folder') store.getState().toggle(projectId, row.entry.path);
    else onOpen(row.entry.path, { preview });
  };

  const commitCreate = async (parent: string, kind: FileEntry['kind'], name: string): Promise<string | undefined> => {
    try {
      const entry = await create.mutateAsync({ path: joinPath(parent, name), kind });
      store.getState().stopEditing(projectId);
      if (kind === 'file') openFile(projectId, entry.path, { preview: false });
      else store.getState().expand(projectId, entry.path);
      return undefined;
    } catch (failure) {
      return messageOf(failure);
    }
  };

  const commitMove = async (from: string, to: string): Promise<string | undefined> => {
    try {
      await move.mutateAsync({ from, to });
      store.getState().stopEditing(projectId);
      filesMoved(projectId, from, to);
      return undefined;
    } catch (failure) {
      return messageOf(failure);
    }
  };

  const commitDelete = async (path: string): Promise<string | undefined> => {
    try {
      await remove.mutateAsync(path);
      filesRemoved(projectId, path);
      return undefined;
    } catch (failure) {
      return messageOf(failure);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = rows.findIndex((row) => row.entry.path === selected);
    const row = rows[index];
    const isOpen = row !== undefined && expanded.includes(row.entry.path);
    const go = (target: TreeRow | undefined) => {
      if (target) focusRow(target.entry.path);
    };
    switch (event.key) {
      case 'ArrowDown':
        go(rows[Math.min(index + 1, rows.length - 1)] ?? rows[0]);
        break;
      case 'ArrowUp':
        go(rows[Math.max(index - 1, 0)]);
        break;
      case 'Home':
        go(rows[0]);
        break;
      case 'End':
        go(rows[rows.length - 1]);
        break;
      case 'ArrowRight':
        if (row?.entry.kind !== 'folder') return;
        if (!isOpen) store.getState().toggle(projectId, row.entry.path);
        else go(rows[index + 1]?.depth === row.depth + 1 ? rows[index + 1] : undefined);
        break;
      case 'ArrowLeft':
        if (row === undefined) return;
        if (row.entry.kind === 'folder' && isOpen) store.getState().toggle(projectId, row.entry.path);
        else go(rows.find((candidate) => candidate.entry.path === parentOf(row.entry.path)));
        break;
      case 'Enter':
        if (row) activate(row, false);
        break;
      case ' ':
        if (row) activate(row, true);
        break;
      case 'F2':
        if (!editable || row === undefined) return;
        store.getState().startRename(projectId, row.entry.path);
        break;
      case 'Delete':
        if (!editable || row === undefined) return;
        setPendingDelete(row.entry);
        break;
      default: {
        if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
        const now = Date.now();
        typed.current = {
          text: now - typed.current.at < 600 ? typed.current.text + event.key.toLowerCase() : event.key.toLowerCase(),
          at: now,
        };
        const after = [...rows.slice(index + 1), ...rows.slice(0, index + 1)];
        go(after.find((candidate) => candidate.entry.name.toLowerCase().startsWith(typed.current.text)));
        break;
      }
    }
    event.preventDefault();
  };

  /* drag and drop: a file or folder onto a folder row, or onto the empty tree for the root */
  /** Not into itself or its own subtree, and not where it already is. */
  const canMove = (from: string, folder: string): boolean => !isWithin(folder, from) && parentOf(from) !== folder;
  const dragTargetProps = (folder: string) => ({
    onDragOver: (event: DragEvent) => {
      // the dragged path is only readable on drop, so the drag in progress is remembered here
      if (dragging.current === undefined || !canMove(dragging.current, folder)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      setDropTarget(folder);
    },
    onDragLeave: () => setDropTarget((current) => (current === folder ? undefined : current)),
    onDrop: (event: DragEvent) => {
      const from = dragging.current ?? event.dataTransfer.getData(DRAG_TYPE);
      setDropTarget(undefined);
      dragging.current = undefined;
      if (from === '' || !canMove(from, folder)) return;
      event.preventDefault();
      event.stopPropagation();
      setPendingMove({ from, folder });
    },
  });

  const inputRow = (depth: number): ReactNode => {
    if (editing?.mode !== 'create') return null;
    const { parent, kind } = editing;
    return (
      <InlineName
        key="__new__"
        label={kind === 'folder' ? 'New folder name' : 'New file name'}
        initial=""
        depth={depth}
        problemOf={(name) => nameProblem(name, siblingsOf(parent), { allowSlash: true })}
        onCommit={(name) => commitCreate(parent, kind, name)}
        onCancel={() => store.getState().stopEditing(projectId)}
      />
    );
  };

  if (error) {
    return (
      <p role="alert" className="px-3 py-2 text-[12px] text-danger">
        Couldn’t read the project folder: {messageOf(error)}
      </p>
    );
  }
  if (loading) return <p className="px-3 py-2 text-[12px] text-fg-muted">Reading the folder…</p>;

  const rendered: ReactNode[] = [];
  if (editing?.mode === 'create' && editing.parent === '') rendered.push(inputRow(0));
  for (const row of rows) {
    const { entry, depth } = row;
    const folder = entry.kind === 'folder';
    const isOpen = folder && expanded.includes(entry.path);
    const isSelected = entry.path === selected || (selected === undefined && row === rows[0]);
    const decoration = folder ? undefined : decorations.file(entry.path);
    const tone = folder ? decorations.folder(entry.path) : decoration?.tone;
    const renaming = editing?.mode === 'rename' && editing.path === entry.path;
    rendered.push(
      renaming ? (
        <InlineName
          key={entry.path}
          label={`Rename ${entry.name}`}
          initial={entry.name}
          depth={depth}
          problemOf={(name) => nameProblem(name, siblingsOf(parentOf(entry.path), entry.path), { allowSlash: false })}
          onCommit={(name) => commitMove(entry.path, joinPath(parentOf(entry.path), name))}
          onCancel={() => store.getState().stopEditing(projectId)}
        />
      ) : (
        <div
          key={entry.path}
          ref={(element) => {
            if (element) rowElements.current.set(entry.path, element);
            else rowElements.current.delete(entry.path);
          }}
          role="treeitem"
          aria-level={depth + 1}
          aria-expanded={folder ? isOpen : undefined}
          aria-selected={entry.path === selected}
          tabIndex={isSelected ? 0 : -1}
          data-testid={`tree-item-${entry.path}`}
          title={entry.path}
          draggable={editable}
          onDragStart={(event) => {
            dragging.current = entry.path;
            event.dataTransfer.setData(DRAG_TYPE, entry.path);
            event.dataTransfer.effectAllowed = 'move';
          }}
          onDragEnd={() => {
            dragging.current = undefined;
            setDropTarget(undefined);
          }}
          {...(editable && folder ? dragTargetProps(entry.path) : {})}
          onContextMenu={() => {
            setMenuTarget(entry);
            store.getState().select(projectId, entry.path);
          }}
          className={cn(
            'flex h-[22px] cursor-pointer select-none items-center gap-1 pr-2 font-machine text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent',
            entry.path === selected ? 'bg-selection/20 text-fg' : 'text-fg-soft hover:bg-card',
            dropTarget === entry.path && 'bg-selection/30 ring-1 ring-inset ring-accent',
            entry.ignored && 'opacity-50',
          )}
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => {
            store.getState().select(projectId, entry.path);
            activate(row, true);
          }}
          onDoubleClick={() => {
            if (!folder) onOpen(entry.path, { preview: false });
          }}
        >
          {folder ? (
            <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-fg-muted transition-transform', isOpen && 'rotate-90')} aria-hidden />
          ) : (
            <span className="w-3.5 shrink-0" />
          )}
          {folder ? (
            isOpen ? (
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-fg-muted" aria-hidden />
            ) : (
              <Folder className="h-3.5 w-3.5 shrink-0 text-fg-muted" aria-hidden />
            )
          ) : (
            <FileIcon path={entry.path} />
          )}
          <span className="min-w-0 flex-1 truncate" style={tone ? { color: TONE_COLOR[tone] } : undefined}>
            {entry.name}
          </span>
          {decoration && (
            <span className="pl-2 text-[10px] font-semibold" style={{ color: TONE_COLOR[decoration.tone] }} title={decoration.title}>
              {decoration.letter}
            </span>
          )}
        </div>
      ),
    );
    if (editing?.mode === 'create' && folder && editing.parent === entry.path && isOpen) rendered.push(inputRow(depth + 1));
  }

  const folderPath = project.data?.folderPath ?? '';
  const separator = folderPath.includes('\\') ? '\\' : '/';
  const target = menuTarget;
  const tree = (
    <div
      role="tree"
      aria-label={label}
      className={cn('min-h-full py-1 outline-none', dropTarget === '' && 'bg-selection/10')}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => {
        if (event.target === event.currentTarget) setMenuTarget(undefined);
      }}
      {...(editable ? dragTargetProps('') : {})}
    >
      {rows.length === 0 && editing === undefined && <p className="px-3 py-2 text-[12px] text-fg-muted">This folder is empty.</p>}
      {rendered}
    </div>
  );

  return (
    <>
      {editable ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>{tree}</ContextMenuTrigger>
          <ContextMenuContent className="w-56">
            <ContextMenuItem onSelect={() => store.getState().startCreate(projectId, folderFor(target), 'file')}>New File</ContextMenuItem>
            <ContextMenuItem onSelect={() => store.getState().startCreate(projectId, folderFor(target), 'folder')}>New Folder</ContextMenuItem>
            {target !== undefined && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => store.getState().startRename(projectId, target.path)}>
                  Rename <ContextMenuShortcut>F2</ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem className="text-danger" onSelect={() => setPendingDelete(target)}>
                  Delete <ContextMenuShortcut>Del</ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(`${folderPath}${separator}${target.path.split('/').join(separator)}`)}>
                  Copy Path
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(target.path)}>Copy Relative Path</ContextMenuItem>
              </>
            )}
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        tree
      )}
      {pendingDelete !== undefined && (
        <DeleteDialog
          path={pendingDelete.path}
          isFolder={pendingDelete.kind === 'folder'}
          onConfirm={() => commitDelete(pendingDelete.path)}
          onClose={() => setPendingDelete(undefined)}
        />
      )}
      {pendingMove !== undefined && (
        <MoveDialog
          from={pendingMove.from}
          folder={pendingMove.folder}
          onConfirm={() => commitMove(pendingMove.from, joinPath(pendingMove.folder, nameOf(pendingMove.from)))}
          onClose={() => setPendingMove(undefined)}
        />
      )}
    </>
  );
}
```

In `apps/web/src/forge/explorer/ExplorerView.tsx`, add two `IconAction`s before Refresh. Import `FilePlus` and `FolderPlus` from lucide:

```tsx
          <IconAction label="New File" Icon={FilePlus} onClick={() => startCreate(projectId, folderOfSelection(), 'file')} />
          <IconAction label="New Folder" Icon={FolderPlus} onClick={() => startCreate(projectId, folderOfSelection(), 'folder')} />
```

`folderOfSelection` gives the selected folder, the selected file's parent, or `''`, the way VS Code does. Define it in the component:

```tsx
  const startCreate = useExplorerStore((s) => s.startCreate);
  const selected = useProjectExplorer(projectId).selected;
  const selectedRow = useTreeRows(projectId).rows.find((row) => row.entry.path === selected);
  const folderOfSelection = (): string =>
    selectedRow === undefined ? '' : selectedRow.entry.kind === 'folder' ? selectedRow.entry.path : parentOf(selectedRow.entry.path);
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @ace/web exec vitest run src/forge/explorer`
Expected: PASS, the Task 11 tests included.

- [ ] **Step 7: Commit**

```bash
npx prettier --write --config packages/config/prettier.config.js apps/web/src/forge/explorer
git add apps/web/src/forge
git commit -m "feat(web): Explorer file operations — inline create and rename, drag to move, delete with a confirm, context menu [D299] [FR-GIT-003]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: Web — quick open (Ctrl/⌘+P) and the empty editor's actions

**Files:**
- Create: `apps/web/src/forge/quick-open/fuzzy.ts`, `apps/web/src/forge/quick-open/quick-open-store.ts`, `apps/web/src/forge/quick-open/QuickOpen.tsx`
- Modify:
  - `apps/web/src/forge/ForgeWorkbench.tsx`: Ctrl+P, and render `QuickOpen`;
  - `apps/web/src/forge/editor/EmptyEditor.tsx` and `EditorArea.tsx`: real actions, so pass `projectId`;
  - `apps/web/src/test/app.tsx`: reset the store.
- Test: create `apps/web/src/forge/quick-open/fuzzy.test.ts`, `apps/web/src/forge/quick-open/QuickOpen.test.tsx`

**Interfaces:**
- Consumes:
  - from Task 10: `useFileList`;
  - from Task 14: `openFile` and `useProjectEditor`;
  - from Task 16: `useExplorerStore.startCreate`;
  - from Task 12: `useLayoutStore`.
- Produces:
  - `fuzzyScore(query, path): number | undefined`;
  - `rankPaths(query, paths, limit?)`;
  - `useQuickOpen` with `{ open, show, hide }`;
  - `QuickOpen({ projectId })`;
  - `EmptyEditor({ projectId })`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/forge/quick-open/fuzzy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { fuzzyScore, rankPaths } from './fuzzy';

describe('D299 quick open’s matching, VS Code in miniature', () => {
  it('matches the letters in order, ignoring case and spaces', () => {
    expect(fuzzyScore('idx', 'src/index.ts')).toBeDefined();
    expect(fuzzyScore('I DX', 'src/index.ts')).toBeDefined();
    expect(fuzzyScore('xdi', 'src/index.ts')).toBeUndefined();
  });

  it('ranks a match in the file name, in a row, at a word start first', () => {
    expect(rankPaths('math', ['src/mathematics/readme.md', 'docs/m-a-t-h.md', 'src/util/math.ts'])).toEqual([
      'src/util/math.ts',
      'src/mathematics/readme.md',
      'docs/m-a-t-h.md',
    ]);
  });

  it('prefers the shorter path on a tie, and caps the list', () => {
    expect(rankPaths('a', ['deep/folder/a.ts', 'a.ts'])[0]).toBe('a.ts');
    expect(rankPaths('', Array.from({ length: 80 }, (_, i) => `f${i}.ts`))).toHaveLength(50);
  });
});
```

Create `apps/web/src/forge/quick-open/QuickOpen.test.tsx`:

```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { db, installMockServer, renderApp } from '../../test/app';
import { useEditorStore } from '../editor/editor-store';

installMockServer();

function seed() {
  const project = db.createProject({ name: 'Shop' });
  const workflow = db.createWorkflow(project.id, 'Main');
  db.seedFiles(project.id, { 'src/app.ts': '', 'src/util/math.ts': '', 'README.md': '', 'node_modules/x.js': '' });
  return { projectId: project.id, path: `/projects/${project.id}/workflows/${workflow.id}/forge` };
}

describe('D299 Ctrl/⌘+P opens any file by a few letters', () => {
  it('lists the project’s files, never the ignored ones, and opens the chosen one pinned', async () => {
    const user = userEvent.setup();
    const { projectId, path } = seed();
    renderApp(path);
    await screen.findByTestId('forge');

    await user.keyboard('{Control>}p{/Control}');
    const input = await screen.findByRole('combobox', { name: 'Go to file' });
    await waitFor(() => expect(screen.getAllByRole('option').map((o) => o.getAttribute('data-path'))).toEqual(['README.md', 'src/app.ts', 'src/util/math.ts']));

    await user.type(input, 'mth');
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('data-path', 'src/util/math.ts');
    await user.keyboard('{Enter}');

    expect(screen.queryByRole('combobox', { name: 'Go to file' })).toBeNull();
    expect(useEditorStore.getState().projects[projectId]).toMatchObject({ active: 'src/util/math.ts', preview: undefined });
  });

  it('puts open files first, moves with the arrows, and closes with Escape', async () => {
    const user = userEvent.setup();
    const { path } = seed();
    renderApp(path);
    await screen.findByTestId('forge');
    await user.click(screen.getByRole('button', { name: /Go to file/ }));
    await screen.findByRole('combobox', { name: 'Go to file' });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
    await user.keyboard('{ArrowDown}');
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Go to file' })).toBeNull());
  });
});
```

- [ ] **Step 2: Run them to watch them fail**

Run: `pnpm --filter @ace/web exec vitest run src/forge/quick-open`
Expected: FAIL, because the modules are missing.

- [ ] **Step 3: Write the matcher, the store and the dialog**

Create `apps/web/src/forge/quick-open/fuzzy.ts`:

```ts
/**
 * A score for `path` against `query` (higher is better), or `undefined` when the query's letters do
 * not all appear in order. Letters in the file name, letters in a row, and letters at a word start
 * (after `/ . - _`, or a camelCase hump) score more — VS Code's quick open in miniature.
 */
export function fuzzyScore(query: string, path: string): number | undefined {
  const wanted = query.toLowerCase().replace(/\s+/g, '');
  if (wanted === '') return 0;
  const haystack = path.toLowerCase();
  const nameStart = path.lastIndexOf('/') + 1;
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const letter of wanted) {
    const found = haystack.indexOf(letter, from);
    if (found === -1) return undefined;
    score += 1;
    if (found === previous + 1) score += 3;
    if (found >= nameStart) score += 2;
    const before = path[found - 1];
    const here = path[found] ?? '';
    const hump = before !== undefined && before === before.toLowerCase() && here !== here.toLowerCase();
    if (found === 0 || before === '/' || before === '.' || before === '-' || before === '_' || hump) score += 2;
    previous = found;
    from = found + 1;
  }
  return score * 100 - path.length;
}

export function rankPaths(query: string, paths: readonly string[], limit = 50): string[] {
  if (query.trim() === '') return paths.slice(0, limit);
  return paths
    .map((path) => ({ path, score: fuzzyScore(query, path) }))
    .filter((entry): entry is { path: string; score: number } => entry.score !== undefined)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.path);
}
```

Create `apps/web/src/forge/quick-open/quick-open-store.ts`:

```ts
import { create } from 'zustand';

/** Whether quick open is showing — a store, so the empty editor's button and Ctrl/⌘+P share it. */
export const useQuickOpen = create<{ open: boolean; show(): void; hide(): void }>()((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));
```

Create `apps/web/src/forge/quick-open/QuickOpen.tsx`:

```tsx
import { Dialog, DialogContent, DialogTitle, Input, cn } from '@ace/ui';
import { useEffect, useMemo, useState } from 'react';

import { openFile } from '../editor/actions';
import { useProjectEditor } from '../editor/editor-store';
import { FileIcon } from '../explorer/FileIcon';
import { useFileList } from '../files/hooks';
import { nameOf, parentOf } from '../files/paths';
import { rankPaths } from './fuzzy';
import { useQuickOpen } from './quick-open-store';

/** Ctrl/⌘+P (§6.2): open files first, then every non-ignored file of the project, matched as you type. */
export function QuickOpen({ projectId }: { projectId: string }) {
  const open = useQuickOpen((s) => s.open);
  const hide = useQuickOpen((s) => s.hide);
  const list = useFileList(projectId, open);
  const editor = useProjectEditor(projectId);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setIndex(0);
  }, [open]);

  const results = useMemo(() => {
    const files = list.data?.files ?? [];
    const candidates = [...editor.tabs, ...files.filter((file) => !editor.tabs.includes(file))];
    return rankPaths(query, candidates);
  }, [list.data, editor.tabs, query]);

  const choose = (path: string | undefined): void => {
    if (path === undefined) return;
    openFile(projectId, path, { preview: false });
    hide();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && hide()}>
      <DialogContent className="top-[12%] max-w-xl translate-y-0 gap-0 p-0" aria-describedby={undefined}>
        <DialogTitle className="sr-only">Go to file</DialogTitle>
        <Input
          autoFocus
          role="combobox"
          aria-label="Go to file"
          aria-expanded
          aria-controls="quick-open-results"
          aria-activedescendant={results[index] === undefined ? undefined : `quick-open-${index}`}
          placeholder="Search files by name"
          value={query}
          className="rounded-none border-0 border-b border-border font-machine text-[13px]"
          onChange={(event) => {
            setQuery(event.target.value);
            setIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') setIndex((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
            else if (event.key === 'ArrowUp') setIndex((i) => Math.max(i - 1, 0));
            else if (event.key === 'Enter') choose(results[index]);
            else return;
            event.preventDefault();
          }}
        />
        <ul id="quick-open-results" role="listbox" aria-label="Files" className="max-h-[22rem] overflow-auto py-1">
          {results.map((path, i) => (
            <li
              key={path}
              id={`quick-open-${i}`}
              role="option"
              aria-selected={i === index}
              data-path={path}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setIndex(i)}
              onClick={() => choose(path)}
              className={cn('flex cursor-pointer items-center gap-2 px-3 py-1 font-machine text-[12.5px]', i === index ? 'bg-selection/20 text-fg' : 'text-fg-soft')}
            >
              <FileIcon path={path} />
              <span className="truncate">{nameOf(path)}</span>
              <span className="truncate text-[11px] text-fg-faint">{parentOf(path)}</span>
            </li>
          ))}
          {list.isPending && <li className="px-3 py-1 text-[12px] text-fg-muted">Listing the project’s files…</li>}
          {!list.isPending && results.length === 0 && <li className="px-3 py-1 text-[12px] text-fg-muted">No file matches.</li>}
        </ul>
        {list.data?.truncated === true && (
          <p className="border-t border-border px-3 py-1 text-[11px] text-fg-faint">Only the first 50,000 files are searched.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Wire it, and give the empty editor its real actions**

Replace `apps/web/src/forge/editor/EmptyEditor.tsx`:

```tsx
import { Button } from '@ace/ui';
import { FilePlus, Search } from 'lucide-react';

import { SHORTCUTS, shortcutLabel, type Shortcut } from '../../app/shortcuts';
import { useLayoutStore } from '../../app/stores/layout';
import { useExplorerStore } from '../explorer/explorer-store';
import { useQuickOpen } from '../quick-open/quick-open-store';

const HINTS: ReadonlyArray<{ label: string; shortcut: Shortcut }> = [
  { label: 'Save', shortcut: SHORTCUTS.save },
  { label: 'Show or hide the Explorer', shortcut: SHORTCUTS.toggleSidebar },
  { label: 'Show or hide the panel', shortcut: SHORTCUTS.togglePanel },
  { label: 'Show or hide the chat', shortcut: SHORTCUTS.toggleChat },
  { label: 'Back to Ideate', shortcut: SHORTCUTS.ideate },
];

/** What the editor area shows with no file open: real actions, with their keys (design §2.2). */
export function EmptyEditor({ projectId }: { projectId: string }) {
  const showQuickOpen = useQuickOpen((s) => s.show);
  const newFile = (): void => {
    useLayoutStore.setState({ sidebarOpen: true, sidebarView: 'explorer' });
    useExplorerStore.getState().startCreate(projectId, '', 'file');
  };
  return (
    <div className="grid h-full place-items-center bg-canvas">
      <div className="space-y-5 text-center">
        <p className="font-human text-2xl text-fg-soft">Forge</p>
        <div className="flex justify-center gap-2">
          <Button variant="secondary" size="sm" onClick={showQuickOpen}>
            <Search className="h-3.5 w-3.5" aria-hidden /> Go to file <span className="font-machine text-fg-faint">{shortcutLabel(SHORTCUTS.quickOpen)}</span>
          </Button>
          <Button variant="secondary" size="sm" onClick={newFile}>
            <FilePlus className="h-3.5 w-3.5" aria-hidden /> New file
          </Button>
        </div>
        <dl className="mx-auto grid w-max grid-cols-[auto_auto] gap-x-6 gap-y-1.5 text-left text-[12px]">
          {HINTS.map(({ label, shortcut }) => (
            <div key={label} className="contents">
              <dt className="text-fg-muted">{label}</dt>
              <dd className="font-machine text-fg-soft">{shortcutLabel(shortcut)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
```

In `EditorArea.tsx`, render `<EmptyEditor projectId={projectId} />`.

In `ForgeWorkbench.tsx`:
- Add `[SHORTCUTS.quickOpen, () => useQuickOpen.getState().show()]` to the shortcuts.
- Render `<QuickOpen projectId={projectId} />` next to `{closeRequest.dialog}`.

In `apps/web/src/test/app.tsx`, add `useQuickOpen.setState({ open: false });` to `beforeEach`.

- [ ] **Step 5: Run the tests and commit**

Run: `pnpm --filter @ace/web exec vitest run src/forge`
Expected: PASS.

```bash
npx prettier --write --config packages/config/prettier.config.js apps/web/src/forge/quick-open apps/web/src/forge/editor/EmptyEditor.tsx
git add apps/web/src
git commit -m "feat(web): quick open — any file by a few letters, open files first [D299] [FR-GIT-003]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 18: Web — Problems, and the status bar's editor fields

**Files:**
- Create: `apps/web/src/forge/panel/problems-store.ts`, `apps/web/src/forge/panel/ProblemsView.tsx`
- Modify:
  - `apps/web/src/app/stores/layout.ts`: `ForgePanelTab` gains `'problems'`, which becomes the default;
  - `apps/web/src/forge/panel/BottomPanel.tsx`: the Problems tab, with a count;
  - `apps/web/src/forge/editor/EditorHost.tsx`: watch the markers;
  - `apps/web/src/forge/layout/StatusBar.tsx`: the counts, plus Ln/Col, indentation, encoding, EOL and language;
  - `apps/web/src/test/app.tsx`: reset the problems.
- Test: create `apps/web/src/forge/panel/problems-store.test.ts`, `apps/web/src/forge/panel/ProblemsView.test.tsx`, `apps/web/src/forge/layout/StatusBar.test.tsx`

**Interfaces:**
- Consumes:
  - from Task 14: `pathOfUri`, `openFile`, `useEditorStore.revealAt`, `useEditorStatus`, `languageLabel`;
  - from Task 12: `useLayoutStore.showPanel`.
- Produces:
  - `Problem { path, line, column, severity: 'error' | 'warning' | 'info', message, source? }`;
  - `useProblemsStore`, holding `{ byProject }`;
  - `watchMarkers(monaco): () => void`;
  - `ProblemsView({ projectId })`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/forge/panel/problems-store.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';

import { asMonaco, createFakeMonaco, type FakeMonaco } from '../../test/fake-monaco';
import { fileUri, resetModels, setMonaco } from '../editor/models';
import { useProblemsStore, watchMarkers } from './problems-store';

const P = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';
let fake: FakeMonaco;

beforeEach(() => {
  resetModels();
  fake = createFakeMonaco();
  setMonaco(asMonaco(fake));
  useProblemsStore.setState({ byProject: {} });
});

describe('D299 §6.4 Problems follows Monaco’s markers for open files', () => {
  it('groups markers by project and file, errors first, hints left out', () => {
    const stop = watchMarkers(asMonaco(fake));
    const marker = (path: string, severity: number, message: string, line = 1) => ({
      resource: fileUri(P, path) as unknown as InstanceType<FakeMonaco['Uri']>,
      severity,
      message,
      startLineNumber: line,
      startColumn: 3,
      source: 'ts',
    });
    fake.setMarkers([
      marker('src/a.ts', fake.MarkerSeverity.Warning, 'unused', 4),
      marker('src/a.ts', fake.MarkerSeverity.Error, 'type error', 9),
      marker('src/b.ts', fake.MarkerSeverity.Hint, 'a hint'),
    ]);
    expect(useProblemsStore.getState().byProject[P]).toEqual([
      { path: 'src/a.ts', line: 9, column: 3, severity: 'error', message: 'type error', source: 'ts' },
      { path: 'src/a.ts', line: 4, column: 3, severity: 'warning', message: 'unused', source: 'ts' },
    ]);
    stop();
  });
});
```

Create `apps/web/src/forge/panel/ProblemsView.test.tsx`:

```tsx
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { db, installMockServer, renderWithQuery } from '../../test/app';
import { useEditorStore } from '../editor/editor-store';
import { ProblemsView } from './ProblemsView';
import { useProblemsStore } from './problems-store';

installMockServer();

describe('D299 §6.4 the Problems panel', () => {
  it('says so when there are none', () => {
    renderWithQuery(<ProblemsView projectId="p1" />);
    expect(screen.getByText('No problems in the open files.')).toBeInTheDocument();
  });

  it('lists problems by file, and a click opens the file at the problem', async () => {
    const user = userEvent.setup();
    const projectId = db.createProject({ name: 'P' }).id;
    act(() =>
      useProblemsStore.setState({
        byProject: { [projectId]: [{ path: 'src/a.ts', line: 9, column: 3, severity: 'error', message: 'type error', source: 'ts' }] },
      }),
    );
    renderWithQuery(<ProblemsView projectId={projectId} />);
    expect(screen.getByText('a.ts')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /type error/ }));
    expect(useEditorStore.getState().projects[projectId]).toMatchObject({
      active: 'src/a.ts',
      reveal: { path: 'src/a.ts', line: 9, column: 3 },
    });
  });
});
```

Create `apps/web/src/forge/layout/StatusBar.test.tsx`:

```tsx
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { useLayoutStore } from '../../app/stores/layout';
import { db, installMockServer, renderWithQuery } from '../../test/app';
import { useEditorStore } from '../editor/editor-store';
import { useEditorStatus } from '../editor/editor-status';
import { useProblemsStore } from '../panel/problems-store';
import { StatusBar } from './StatusBar';

installMockServer();

describe('D299 the status bar', () => {
  it('counts errors and warnings, and a click opens Problems', async () => {
    const user = userEvent.setup();
    const projectId = db.createProject({ name: 'P' }).id;
    act(() =>
      useProblemsStore.setState({
        byProject: {
          [projectId]: [
            { path: 'a.ts', line: 1, column: 1, severity: 'error', message: 'x', source: undefined },
            { path: 'a.ts', line: 2, column: 1, severity: 'warning', message: 'y', source: undefined },
            { path: 'b.ts', line: 1, column: 1, severity: 'error', message: 'z', source: undefined },
          ],
        },
      }),
    );
    renderWithQuery(<StatusBar projectId={projectId} />);
    await user.click(screen.getByRole('button', { name: '2 errors, 1 warning' }));
    expect(useLayoutStore.getState()).toMatchObject({ panelOpen: true, panelTab: 'problems' });
  });

  it('describes the active text file: position, indentation, encoding, line endings, language', () => {
    const projectId = db.createProject({ name: 'P' }).id;
    act(() => {
      useEditorStore.getState().open(projectId, 'a.ts');
      useEditorStatus.setState({ line: 12, column: 4, indentation: 'Spaces: 2', bom: true, eol: 'CRLF', language: 'typescript' });
    });
    renderWithQuery(<StatusBar projectId={projectId} />);
    for (const text of ['Ln 12, Col 4', 'Spaces: 2', 'UTF-8 with BOM', 'CRLF', 'TypeScript']) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
  });
});
```

- [ ] **Step 2: Run them to watch them fail**

Run: `pnpm --filter @ace/web exec vitest run src/forge/panel src/forge/layout`
Expected: FAIL, because the modules are missing.

- [ ] **Step 3: Write the store and the view**

Create `apps/web/src/forge/panel/problems-store.ts`:

```ts
import type * as Monaco from 'monaco-editor';
import { create } from 'zustand';

import { pathOfUri } from '../editor/models';

export type ProblemSeverity = 'error' | 'warning' | 'info';

export interface Problem {
  path: string;
  line: number;
  column: number;
  severity: ProblemSeverity;
  message: string;
  source: string | undefined;
}

export const useProblemsStore = create<{ byProject: Record<string, Problem[]> }>()(() => ({ byProject: {} }));

const RANK: Record<ProblemSeverity, number> = { error: 0, warning: 1, info: 2 };

/**
 * Follow Monaco's markers for every Forge model (Problems, design §6.4): grouped by project, errors
 * first, hints left out as VS Code does. A disposed model's markers go with it. Phase 4 adds the
 * project's check command to the same list.
 */
export function watchMarkers(monaco: typeof Monaco): () => void {
  const publish = (): void => {
    const byProject: Record<string, Problem[]> = {};
    for (const marker of monaco.editor.getModelMarkers({})) {
      const where = pathOfUri(marker.resource);
      if (where === undefined || marker.severity < monaco.MarkerSeverity.Info) continue;
      const severity: ProblemSeverity =
        marker.severity >= monaco.MarkerSeverity.Error ? 'error' : marker.severity >= monaco.MarkerSeverity.Warning ? 'warning' : 'info';
      (byProject[where.projectId] ??= []).push({
        path: where.path,
        line: marker.startLineNumber,
        column: marker.startColumn,
        severity,
        message: marker.message,
        source: marker.source,
      });
    }
    for (const problems of Object.values(byProject)) {
      problems.sort((a, b) => a.path.localeCompare(b.path) || RANK[a.severity] - RANK[b.severity] || a.line - b.line);
    }
    useProblemsStore.setState({ byProject });
  };
  publish();
  const subscription = monaco.editor.onDidChangeMarkers(publish);
  return () => subscription.dispose();
}
```

Create `apps/web/src/forge/panel/ProblemsView.tsx`:

```tsx
import { AlertTriangle, Info, XCircle } from 'lucide-react';

import { openFile } from '../editor/actions';
import { useEditorStore } from '../editor/editor-store';
import { FileIcon } from '../explorer/FileIcon';
import { nameOf, parentOf } from '../files/paths';
import { useProblemsStore, type Problem, type ProblemSeverity } from './problems-store';

const NONE: Problem[] = [];
const ICON: Record<ProblemSeverity, JSX.Element> = {
  error: <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" aria-label="Error" />,
  warning: <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-status-WAITING)]" aria-label="Warning" />,
  info: <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-muted" aria-label="Info" />,
};

export function ProblemsView({ projectId }: { projectId: string }) {
  const problems = useProblemsStore((s) => s.byProject[projectId] ?? NONE);
  if (problems.length === 0) return <p className="px-3 py-2 text-[12px] text-fg-muted">No problems in the open files.</p>;

  const groups = new Map<string, Problem[]>();
  for (const problem of problems) groups.set(problem.path, [...(groups.get(problem.path) ?? []), problem]);
  const reveal = (problem: Problem): void => {
    openFile(projectId, problem.path, { preview: false });
    useEditorStore.getState().revealAt(projectId, { path: problem.path, line: problem.line, column: problem.column });
  };

  return (
    <div className="h-full overflow-auto py-1 font-machine text-[12px]">
      {[...groups].map(([path, list]) => (
        <section key={path} aria-label={path}>
          <div className="flex items-center gap-1.5 px-3 py-0.5 text-fg-soft">
            <FileIcon path={path} />
            <span>{nameOf(path)}</span>
            <span className="text-fg-faint">{parentOf(path)}</span>
            <span className="ml-1 rounded-chip bg-card px-1.5 text-[10px]">{list.length}</span>
          </div>
          <ul aria-label={`Problems in ${path}`}>
            {list.map((problem, index) => (
              <li key={`${problem.line}:${problem.column}:${index}`}>
                <button type="button" onClick={() => reveal(problem)} className="flex w-full items-start gap-2 py-0.5 pl-8 pr-3 text-left hover:bg-card">
                  {ICON[problem.severity]}
                  <span className="min-w-0 flex-1 whitespace-pre-wrap text-fg">{problem.message}</span>
                  <span className="shrink-0 text-fg-faint">
                    {problem.source === undefined ? '' : `${problem.source} `}[Ln {problem.line}, Col {problem.column}]
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Wire Problems into the panel, the host and the status bar**

In `apps/web/src/app/stores/layout.ts`:
- Set `export type ForgePanelTab = 'problems' | 'output';`.
- Change the default to `panelTab: 'problems'`.
- Fix `layout.test.ts` if it pinned the old default.

In `apps/web/src/forge/panel/BottomPanel.tsx`:
- Use `TABS = [{ tab: 'problems', label: 'Problems' }, { tab: 'output', label: 'Output' }]`.
- Render `{panelTab === 'problems' && <ProblemsView projectId={projectId} />}`.
- Show a count beside "Problems" when there are any:

```tsx
  const count = useProblemsStore((s) => (s.byProject[projectId] ?? []).length);
  …
              {label}
              {tab === 'problems' && count > 0 && <span className="ml-1.5 rounded-chip bg-card px-1.5 text-[10px] text-fg-soft">{count}</span>}
```

In `apps/web/src/forge/editor/EditorHost.tsx`, after `setMonaco(monaco);` at module level:

```ts
// Problems follows every Forge model's markers from the moment the editor chunk loads (§6.4).
watchMarkers(monaco);
```

Replace `apps/web/src/forge/layout/StatusBar.tsx`:

```tsx
import { AlertTriangle, GitBranch, PanelBottom, XCircle } from 'lucide-react';

import { SHORTCUTS, shortcutLabel } from '../../app/shortcuts';
import { useLayoutStore } from '../../app/stores/layout';
import { useProjectEditor } from '../editor/editor-store';
import { useEditorStatus } from '../editor/editor-status';
import { languageLabel } from '../editor/languages';
import { useRepoStatus } from '../files/hooks';
import { isImagePath } from '../files/paths';
import { useProblemsStore, type Problem } from '../panel/problems-store';

const NONE: Problem[] = [];
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** VS Code's status bar (design §2.2): branch and problems on the left, the active file's facts on the right. */
export function StatusBar({ projectId }: { projectId: string }) {
  const status = useRepoStatus(projectId);
  const problems = useProblemsStore((s) => s.byProject[projectId] ?? NONE);
  const showPanel = useLayoutStore((s) => s.showPanel);
  const panelOpen = useLayoutStore((s) => s.panelOpen);
  const togglePanel = useLayoutStore((s) => s.togglePanel);
  const active = useProjectEditor(projectId).active;
  const editor = useEditorStatus();
  const branch = status.data?.repo === true ? status.data.branch : undefined;
  const errors = problems.filter((p) => p.severity === 'error').length;
  const warnings = problems.filter((p) => p.severity === 'warning').length;
  const textActive = active !== undefined && !isImagePath(active);

  return (
    <footer data-testid="status-bar" className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-panel px-3 font-machine text-[11px] text-fg-muted">
      {branch && (
        <span className="flex items-center gap-1" title="Current branch (read-only)">
          <GitBranch className="h-3 w-3" aria-hidden />
          {branch}
        </span>
      )}
      <button
        type="button"
        aria-label={`${plural(errors, 'error')}, ${plural(warnings, 'warning')}`}
        title="Problems"
        onClick={() => showPanel('problems')}
        className="flex items-center gap-2 hover:text-fg"
      >
        <span className="flex items-center gap-1">
          <XCircle className="h-3 w-3" aria-hidden />
          {errors}
        </span>
        <span className="flex items-center gap-1">
          <AlertTriangle className="h-3 w-3" aria-hidden />
          {warnings}
        </span>
      </button>
      <div className="flex-1" />
      {textActive && (
        <>
          <span>{`Ln ${editor.line}, Col ${editor.column}`}</span>
          <span>{editor.indentation}</span>
          <span>{editor.bom ? 'UTF-8 with BOM' : 'UTF-8'}</span>
          <span>{editor.eol}</span>
          <span>{languageLabel(editor.language)}</span>
        </>
      )}
      <button
        type="button"
        aria-pressed={panelOpen}
        onClick={togglePanel}
        title={`Toggle panel (${shortcutLabel(SHORTCUTS.togglePanel)})`}
        className="flex items-center gap-1 hover:text-fg"
      >
        <PanelBottom className="h-3 w-3" aria-hidden />
        Panel
      </button>
    </footer>
  );
}
```

In `apps/web/src/test/app.tsx`, add `useProblemsStore.setState({ byProject: {} });` and `useEditorStatus.setState({ line: 1, column: 1, language: 'plaintext', eol: 'LF', indentation: 'Spaces: 2', bom: false });` to `beforeEach`.

- [ ] **Step 5: Run the tests and commit**

Run: `pnpm --filter @ace/web exec vitest run src/forge src/app`
Expected: PASS.

```bash
npx prettier --write --config packages/config/prettier.config.js apps/web/src/forge/panel apps/web/src/forge/layout/StatusBar.tsx apps/web/src/forge/layout/StatusBar.test.tsx
git add apps/web/src
git commit -m "feat(web): Problems from Monaco's markers, and a status bar that says where you are [D299] [FR-GIT-004]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 19: Web — Forge at phone width: browse only

**Files:**
- Create: `apps/web/src/forge/CompactForge.tsx`
- Modify: `apps/web/src/forge/ForgePage.tsx`
- Test: create `apps/web/src/forge/CompactForge.test.tsx`

**Interfaces:**
- Consumes:
  - from Task 16: `FileTree` with `editable={false}`;
  - from Task 10: `useFileContent`;
  - from Task 14: `ImagePreview` and `FileNotice`;
  - existing: `useIsCompact`, and `installMatchMedia` from `responsive/test-support`.
- Produces: `CompactForge({ projectId })`. At ≤ 640 px, `ForgePage` renders it instead of the workbench (FR-MOB-001).

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/forge/CompactForge.test.tsx`:

```tsx
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installMatchMedia, uninstallMatchMedia } from '../responsive/test-support';
import { db, installMockServer, renderApp } from '../test/app';

installMockServer();
beforeEach(() => installMatchMedia(true));
afterEach(() => uninstallMatchMedia());

describe('D299 FR-MOB-001 Forge on a phone is browse-only', () => {
  it('shows the tree, then a file read-only, and offers nothing that edits', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'Shop' });
    const workflow = db.createWorkflow(project.id, 'Main');
    db.seedFiles(project.id, { 'README.md': '# Shop' });
    renderApp(`/projects/${project.id}/workflows/${workflow.id}/forge`);

    expect(await screen.findByTestId('compact-forge')).toHaveTextContent('Browse only on a phone');
    expect(screen.queryByTestId('forge')).toBeNull();
    expect(screen.queryByRole('button', { name: 'New File' })).toBeNull();

    await user.click(await screen.findByTestId('tree-item-README.md'));
    expect(await screen.findByLabelText('Contents of README.md')).toHaveTextContent('# Shop');
    expect(screen.queryByRole('textbox')).toBeNull();

    await user.click(screen.getByRole('button', { name: /Files/ }));
    expect(await screen.findByTestId('compact-forge')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `pnpm --filter @ace/web exec vitest run src/forge/CompactForge.test.tsx`
Expected: FAIL, because the workbench renders.

- [ ] **Step 3: Write the compact view**

Create `apps/web/src/forge/CompactForge.tsx`:

```tsx
import { Button } from '@ace/ui';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';

import { FileNotice } from './editor/FileNotice';
import { ImagePreview } from './editor/ImagePreview';
import { FileTree } from './explorer/FileTree';
import { useFileContent } from './files/hooks';
import { isImagePath } from './files/paths';

/** Forge at ≤ 640 px (FR-MOB-001, design §2.1): the tree, then one file read-only. Editing needs a wider screen. */
export function CompactForge({ projectId }: { projectId: string }) {
  const [path, setPath] = useState<string | undefined>();
  if (path !== undefined) return <CompactFile projectId={projectId} path={path} onBack={() => setPath(undefined)} />;
  return (
    <div data-testid="compact-forge" className="flex h-full min-h-0 flex-col bg-panel">
      <p className="border-b border-border px-3 py-2 text-[12px] text-fg-muted">Browse only on a phone — open Forge on a wider screen to edit.</p>
      <div className="min-h-0 flex-1 overflow-auto">
        <FileTree projectId={projectId} label="Project files" editable={false} onOpen={(next) => setPath(next)} />
      </div>
    </div>
  );
}

function CompactFile({ projectId, path, onBack }: { projectId: string; path: string; onBack(): void }) {
  const image = isImagePath(path);
  const content = useFileContent(projectId, image ? undefined : path);
  let body;
  if (image) body = <ImagePreview projectId={projectId} path={path} />;
  else if (content.isPending) body = <p className="p-3 text-[12px] text-fg-muted">Opening…</p>;
  else if (content.data?.kind === 'text')
    body = (
      <pre aria-label={`Contents of ${path}`} className="whitespace-pre p-3 font-machine text-[12px] leading-5 text-fg">
        {content.data.content}
      </pre>
    );
  else if (content.data !== undefined) body = <FileNotice path={path} kind={content.data.kind} size={content.data.size} />;
  else body = <FileNotice path={path} kind="missing" message={content.error instanceof Error ? content.error.message : undefined} />;

  return (
    <div data-testid="compact-file" className="flex h-full min-h-0 flex-col bg-canvas">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" aria-hidden /> Files
        </Button>
        <span className="truncate font-machine text-[12px] text-fg-soft">{path}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{body}</div>
    </div>
  );
}
```

In `apps/web/src/forge/ForgePage.tsx`:

```tsx
import { useParams } from 'react-router-dom';

import { useIsCompact } from '../responsive/useIsCompact';
import { CompactForge } from './CompactForge';
import { useProjectFiles } from './files/project-socket';
import { ForgeWorkbench } from './ForgeWorkbench';

/** The Forge route element (D299). The project's folder is watched while it is mounted; a phone browses only. */
export function ForgePage() {
  const { projectId = '' } = useParams();
  useProjectFiles(projectId);
  return useIsCompact() ? <CompactForge projectId={projectId} /> : <ForgeWorkbench projectId={projectId} />;
}
```

- [ ] **Step 4: Run the test and commit**

Run: `pnpm --filter @ace/web exec vitest run src/forge`
Expected: PASS.

```bash
npx prettier --write --config packages/config/prettier.config.js apps/web/src/forge/CompactForge.tsx apps/web/src/forge/CompactForge.test.tsx apps/web/src/forge/ForgePage.tsx
git add apps/web/src/forge
git commit -m "feat(web): Forge on a phone is browse-only [D299] [FR-MOB-001]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 20: Web e2e — the whole of Forge in a real browser, with the real Monaco

**Files:**
- Modify: `apps/web/e2e/helpers.ts`
- Create: `apps/web/e2e/forge.spec.ts`

**Interfaces:**
- Consumes: everything above. `window.__aceMock`'s `seedGraph`, `seedFiles`, `writeFileExternally` and `setRepoStatus` from Task 9.
- Produces: e2e coverage for spec §11's web e2e row.

- [ ] **Step 1: Add the helpers**

Append to `apps/web/e2e/helpers.ts`:

```ts
/** Forge (D299): a project with a workflow and files on its (mock) disk. */
export async function seedForge(page: Page, files: Record<string, string>): Promise<Seeded> {
  const seeded = await seedGraph(page, ['agent'], { projectName: 'Shop', workflowName: 'Main', withModel: true });
  await page.evaluate(({ projectId, files }) => window.__aceMock!.seedFiles(projectId, files), { projectId: seeded.projectId, files });
  return seeded;
}

export const forgeUrl = (seeded: Seeded): string => `/projects/${seeded.projectId}/workflows/${seeded.workflowId}/forge`;

/** What the mock engine's disk holds — the truth for every "saved" assertion. */
export async function diskFile(page: Page, projectId: string, path: string): Promise<string | undefined> {
  return page.evaluate(({ projectId, path }) => {
    const db = window.__aceMock!.db;
    db.load();
    return db.filesOf(projectId)[path]?.content;
  }, { projectId, path });
}

/** The real Monaco editor in the workbench. */
export const monacoEditor = (page: Page): Locator => page.locator('[data-testid="monaco-host"] .monaco-editor').first();

/** Type at the end of the active file, as a person would. */
export async function typeAtEnd(page: Page, text: string): Promise<void> {
  await monacoEditor(page).locator('.view-lines').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
}
```

- [ ] **Step 2: Write the spec**

Create `apps/web/e2e/forge.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

import { diskFile, forgeUrl, freshApp, monacoEditor, seedForge, typeAtEnd } from './helpers';

const FILES = {
  'src/app.ts': 'export const app = 1;\n',
  'src/util/math.ts': 'export const add = (a: number, b: number) => a + b;\n',
  'README.md': '# Shop\n',
  'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
};

test.describe('Forge (D299, FR-GIT-003, FR-GIT-004)', () => {
  test.beforeEach(async ({ page }) => freshApp(page));

  test('switches Ideate ⇄ Forge by button and by key, with the chat on the right in both', async ({ page }) => {
    const seeded = await seedForge(page, FILES);
    await page.goto(`/projects/${seeded.projectId}/workflows/${seeded.workflowId}`);
    await expect(page.getByTestId('canvas')).toBeVisible();
    await expect(page.getByTestId('chat-aside')).toBeVisible();

    await page.getByTestId('mode-forge').click();
    await expect(page).toHaveURL(/\/forge$/);
    await expect(page.getByRole('tree', { name: 'Files of Shop' })).toBeVisible();
    await expect(page.getByTestId('chat-aside')).toBeVisible();

    await page.keyboard.press('Control+Shift+Digit1');
    await expect(page.getByTestId('canvas')).toBeVisible();
    await page.keyboard.press('Control+Shift+Digit2');
    await expect(page.getByTestId('forge')).toBeVisible();
  });

  test('opens a file in the real Monaco, edits it and saves it with Ctrl+S', async ({ page }) => {
    const seeded = await seedForge(page, FILES);
    await page.goto(forgeUrl(seeded));
    await page.getByTestId('tree-item-src').click();
    await page.getByTestId('tree-item-src/app.ts').dblclick();
    await expect(monacoEditor(page)).toContainText('export const app = 1;');

    await typeAtEnd(page, '// edited');
    await expect(page.getByTestId('dirty-src/app.ts')).toBeVisible();
    await page.keyboard.press('Control+S');
    await expect(page.getByTestId('dirty-src/app.ts')).toHaveCount(0);
    expect(await diskFile(page, seeded.projectId, 'src/app.ts')).toContain('// edited');
  });

  test('an unsaved buffer survives a switch to Ideate and back', async ({ page }) => {
    const seeded = await seedForge(page, FILES);
    await page.goto(forgeUrl(seeded));
    await page.getByTestId('tree-item-README.md').dblclick();
    await typeAtEnd(page, 'kept across modes');
    await page.keyboard.press('Control+Shift+Digit1');
    await expect(page.getByTestId('canvas')).toBeVisible();
    await page.keyboard.press('Control+Shift+Digit2');
    await expect(page.getByTestId('dirty-README.md')).toBeVisible();
    await expect(monacoEditor(page)).toContainText('kept across modes');
  });

  test('a clean buffer follows the disk; an unsaved one gets the conflict bar, and Keep mine wins on save', async ({ page }) => {
    const seeded = await seedForge(page, FILES);
    await page.goto(forgeUrl(seeded));
    await page.getByTestId('tree-item-README.md').dblclick();
    await expect(monacoEditor(page)).toContainText('# Shop');

    await page.evaluate((id) => window.__aceMock!.writeFileExternally(id, 'README.md', '# Theirs\n'), seeded.projectId);
    await expect(monacoEditor(page)).toContainText('# Theirs');

    await typeAtEnd(page, 'mine');
    await page.evaluate((id) => window.__aceMock!.writeFileExternally(id, 'README.md', '# Theirs again\n'), seeded.projectId);
    await expect(page.getByTestId('conflict-bar')).toBeVisible();
    await page.getByRole('button', { name: 'Keep mine' }).click();
    await page.keyboard.press('Control+S');
    await expect.poll(() => diskFile(page, seeded.projectId, 'README.md')).toContain('mine');
  });

  test('quick open finds a file by a few letters', async ({ page }) => {
    const seeded = await seedForge(page, FILES);
    await page.goto(forgeUrl(seeded));
    await expect(page.getByTestId('forge')).toBeVisible();
    await page.keyboard.press('Control+P');
    await page.getByRole('combobox', { name: 'Go to file' }).fill('mth');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('tab-src/util/math.ts')).toBeVisible();
  });

  test('creates, renames, moves by drag and deletes in the Explorer', async ({ page }) => {
    const seeded = await seedForge(page, FILES);
    await page.goto(forgeUrl(seeded));
    await page.getByRole('button', { name: 'New File' }).click();
    await page.getByRole('textbox', { name: 'New file name' }).fill('todo.md');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('tab-todo.md')).toBeVisible();

    await page.getByTestId('tree-item-todo.md').click();
    await page.keyboard.press('F2');
    await page.getByRole('textbox', { name: 'Rename todo.md' }).fill('done.md');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('tab-done.md')).toBeVisible();

    await page.getByTestId('tree-item-done.md').dragTo(page.getByTestId('tree-item-src'));
    await page.getByRole('dialog').getByRole('button', { name: 'Move' }).click();
    await expect.poll(() => diskFile(page, seeded.projectId, 'src/done.md')).toBe('');
    await expect(page.getByTestId('tab-src/done.md')).toBeVisible();

    await page.getByTestId('tree-item-src/done.md').click();
    await page.keyboard.press('Delete');
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await expect.poll(() => diskFile(page, seeded.projectId, 'src/done.md')).toBeUndefined();
    await expect(page.getByTestId('tab-src/done.md')).toHaveCount(0);
  });

  test('panels are the person’s choice and are remembered across a reload', async ({ page }) => {
    const seeded = await seedForge(page, FILES);
    await page.goto(forgeUrl(seeded));
    await expect(page.getByRole('tree', { name: 'Files of Shop' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Panel' })).toHaveCount(0);

    await page.keyboard.press('Control+J');
    await expect(page.getByRole('region', { name: 'Panel' })).toBeVisible();
    await page.keyboard.press('Control+B');
    await expect(page.getByRole('tree', { name: 'Files of Shop' })).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole('region', { name: 'Panel' })).toBeVisible();
    await expect(page.getByRole('tree', { name: 'Files of Shop' })).toHaveCount(0);
  });

  test('git decorations mark a changed file and colour its folder', async ({ page }) => {
    const seeded = await seedForge(page, FILES);
    await page.evaluate((id) => window.__aceMock!.setRepoStatus(id, [{ path: 'src/app.ts', status: 'modified' }]), seeded.projectId);
    await page.goto(forgeUrl(seeded));
    await page.getByTestId('tree-item-src').click();
    await expect(page.getByTestId('tree-item-src/app.ts').getByTitle('Modified')).toHaveText('M');
  });

  test('Problems lists a TypeScript error from the real language service, and a click reveals it', async ({ page }) => {
    const seeded = await seedForge(page, { ...FILES, 'src/bad.ts': 'const n: number = "text";\nexport { n };\n' });
    await page.goto(forgeUrl(seeded));
    await page.getByTestId('tree-item-src').click();
    await page.getByTestId('tree-item-src/bad.ts').dblclick();
    await expect(page.getByRole('button', { name: /^1 error/ })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /^1 error/ }).click();
    await expect(page.getByRole('region', { name: 'Panel' })).toContainText("Type 'string' is not assignable to type 'number'.");
  });

  test('Alt+W closes the editor tab; an image opens as a picture', async ({ page }) => {
    const seeded = await seedForge(page, FILES);
    await page.goto(forgeUrl(seeded));
    await page.getByTestId('tree-item-logo.svg').dblclick();
    await expect(page.getByRole('img', { name: 'logo.svg' })).toBeVisible();
    await page.keyboard.press('Alt+W');
    await expect(page.getByTestId('tab-logo.svg')).toHaveCount(0);
  });

  test('on a phone Forge is browse-only', async ({ page }) => {
    const seeded = await seedForge(page, FILES);
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(forgeUrl(seeded));
    await expect(page.getByTestId('compact-forge')).toBeVisible();
    await page.getByTestId('tree-item-README.md').click();
    await expect(page.getByLabel('Contents of README.md')).toContainText('# Shop');
    await expect(page.getByTestId('monaco-host')).toHaveCount(0);
  });
});
```

- [ ] **Step 3: Run the spec**

Run: `pnpm --filter @ace/web exec playwright test e2e/forge.spec.ts`
Expected: PASS.

The real Monaco loads its workers in Chromium, and the Problems test waits up to 20 s for the TS worker's first diagnostics. If Monaco's auto-closing changes what `keyboard.type` produced, type plain words as above, without brackets or quotes. If a test fails, fix the product, not the expectation, unless the expectation contradicts the spec.

- [ ] **Step 4: Run the whole e2e suite**

Run: `pnpm test:e2e`
Expected: PASS. Earlier specs may assume the chat column inside `workflow-page`, the old fixed width, or Ctrl+B/J/P being free on the canvas page. Forge binds those keys only while Forge is mounted, so the canvas keeps its own behaviour. Fix stale assumptions in the specs and note each in the commit body.

- [ ] **Step 5: Commit**

```bash
npx prettier --write --config packages/config/prettier.config.js apps/web/e2e/forge.spec.ts apps/web/e2e/helpers.ts
git add apps/web/e2e
git commit -m "test(web): Forge end to end — switch, edit, save, conflicts, quick open, Explorer, panels, Problems, phone [D299] [FR-GIT-003] [FR-GIT-004]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 21: Docs, the gates, a live check on the real engine, and the hand-off

**Files:**
- Modify: `docs/DECISIONS.md`, `CLAUDE.md` (§9 Feature Log), `apps/web/src/help/guide.ts` (`ORDER`)
- Create: `docs/user-guide/forge.md`

**Interfaces:**
- Consumes: the whole branch.
- Produces: the decision rows D299–D302, a Feature Log row, a user-guide page, green gates, and a live-check report.

- [ ] **Step 1: Append the decisions**

Append these four rows to the table in `docs/DECISIONS.md`. Put the commit's date in place of `YYYY-MM-DD`:

```markdown
| D299 | Ideate and Forge: two modes per workflow, one shared chat | Inside a workflow ACE has two modes, switched from the top bar (`Ideate \| Forge`, Ctrl/⌘+Shift+1 / 2): Ideate is the canvas, Forge a VS Code–style editor on the project folder — activity bar, Explorer with Open editors and read-only git decorations, Monaco tabs, a bottom panel (Problems, Output), a status bar. The chat column belongs to the parent `WorkflowLayout`, so a switch never unmounts it; every panel can be resized and hidden, and the choice is remembered. Files travel through `/projects/:id/files/*`: confined to the folder, `.git`/`.ace` read-only at any depth, saves against a content-hash base version that answers 409 `file_changed` rather than overwrite. A watcher runs while a client subscribes to the new `project` WS scope and sends transient, path-only `files.changed`. Phase 1 refinements of the design: a delete is permanent behind a confirm until Phase 3's checkpoints; unsaved buffers survive every in-app navigation, so only closing or reloading the browser tab asks; cross-file TS IntelliSense moves to Phase 4; `GET /files/raw` serves image previews; new error codes `file_changed exists file_too_large outside_project protected_path`; `ignore` is the one new engine-side dependency. | FR-GIT-003, FR-GIT-004, FR-GIT-008, FR-MOB-001; design §2, §6 | YYYY-MM-DD | Arhant (Claude) |
| D300 | AI file changes are reviewed through checkpoints | A private git store per project outside the project's own `.git`, snapshotted before and after each writing chat turn or run, with keep and revert per file. It replaces FR-GIT-004's "editor read-only during runs" with conflict-aware editing: a clean buffer follows the disk, an unsaved one gets Compare / Take theirs / Keep mine. Phase 1 ships the conflict-aware editing; the store arrives in Phase 3. | FR-GIT-004; design §5 | YYYY-MM-DD | Arhant (Claude) |
| D301 | The terminal runs a person's commands as supervised processes | Confined working folder, scrubbed environment, streamed output, capped buffers, tree kill, a per-project trust level (`on` / `scripts` / `off`). Agents never use it. No PTY in v1. Arrives in Phase 2. | design §6.3 | YYYY-MM-DD | Arhant (Claude) |
| D302 | A node chat works in the project folder | CLI nodes use their provider's permission preset; API nodes get the non-destructive project tools in a bounded loop; writing turns are queued per project; `@Node` asks another node inside the same conversation with its recent turns as context. Amends FR-CHAT-005: a chat turn may change project files, always checkpointed, and still never reads or writes runs. Arrives in Phase 3. | FR-CHAT-005; design §3, §4 | YYYY-MM-DD | Arhant (Claude) |
```

- [ ] **Step 2: Write the user guide page**

Create `docs/user-guide/forge.md`:

```markdown
# Forge: the code editor

Inside a workflow, the switch at the top flips between **Ideate** (the canvas) and **Forge** (the
code editor on the project folder). **Ctrl+Shift+1** and **Ctrl+Shift+2** do the same
(**⌘⇧1** / **⌘⇧2** on a Mac). The chat stays on the right in both, and nothing is lost when you switch.

## The layout

- **Left:** the Explorer — *Open editors* (what you are editing) above the project's folder tree.
  Changed files carry git's letters (**M**odified, **A**dded, **U**ntracked); ignored folders such as
  `node_modules` are dimmed. **Ctrl+B** shows or hides it.
- **Centre:** the editor. A single click previews a file (italic tab); a double click, or an edit, keeps it.
- **Bottom:** Problems and Output. **Ctrl+J** shows or hides the panel. Your choice is remembered.
- **Right:** the chat. **Ctrl+Alt+B** shows or hides it.

Every panel can be resized by dragging its edge.

## Files

- **New file / folder:** the buttons at the top of the Explorer, or right-click. Type the name and press Enter.
- **Rename:** select it and press **F2**.
- **Move:** drag it onto a folder.
- **Delete:** select it and press **Delete**. In this version a delete cannot be undone.
- **Go to a file:** **Ctrl+P**, then type a few letters of its name.

## Saving, and files that change underneath you

**Ctrl+S** saves, **Ctrl+Alt+S** saves everything. A dot on a tab means unsaved changes.

If a file changes on disk — an agent wrote it, or another editor — while it is open:

- with no unsaved changes, Forge simply shows the new text;
- with unsaved changes, a bar appears: **Compare** (yours against the disk), **Take theirs**, or
  **Keep mine** (your next save wins). Forge never overwrites a change it has not shown you.

Closing a tab with unsaved changes asks first, and so does closing or reloading the browser tab.

## Keys the browser keeps

The browser keeps **Ctrl+W**, **Ctrl+T**, **Ctrl+N**, **Ctrl+Tab** and **Ctrl+1…9** for itself, so
Forge uses **Alt+W** to close an editor tab, and **Ctrl+P** lists your open files first.

## Limits in this version

- Text files up to 2 MB open for editing; binary files show a notice, images a preview.
- IntelliSense covers TypeScript, JavaScript, CSS, HTML and JSON inside each file; other languages
  get highlighting.
- On a phone, Forge is browse-only.
```

In `apps/web/src/help/guide.ts`, add `'forge'` to `ORDER` after `'building-a-workflow'`.

- [ ] **Step 3: Add the Feature Log row**

In `CLAUDE.md` §9, append a row after X1, matching the table's columns:

`| IDE | F1 | Forge phase 1 — Ideate/Forge switch, project files API + watcher, Explorer, Monaco editor, conflict-safe saves, quick open, Problems/Output | Arhant | feat/forge-phase-1 | IN REVIEW | — | <date> | — | <gate counts from Step 4; deviations: the Phase 1 refinements of D299> |`

- [ ] **Step 4: Run every gate and record the real output**

```bash
pnpm --filter "./packages/**" build
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @ace/web test:coverage
pnpm --filter @ace/tools test:coverage
pnpm --filter @ace/engine test:coverage
pnpm test:e2e
```

Expected: everything green.
- Coverage is at least 80 % for tools and engine, and at least 60 % for web.
- Paste the real summaries, with the counts per package, into the ledger and the Feature Log row's notes.
- Never claim green without them (CLAUDE.md §7).
- A Windows flake already known (D-088, the GuardrailsPage timeout) is reported as such, with the rerun's result.

- [ ] **Step 5: The live check on the real engine**

The user's own ACE may be running from the main checkout on ports 4747 and 5173. Check first:

```bash
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4747/api/v1/health
```

- **If it answers:** ask the user before stopping their ACE, or run this worktree's engine on other ports if `pnpm dev` supports that. Read `apps/server/src/cli.ts` for a port option.
- **Then, from `D:\ACE offcl\wt\forge`:** run `pnpm dev`, and open the printed `?token=` URL in Playwright's Chromium (Claude in Chrome cannot load local dev servers here).
- **Check, on a project whose folder is a real git repository with a few files:**
  1. Ideate → Forge by the switch: the real tree shows, `node_modules` dimmed, `.git` absent, and a changed file marked **M**.
  2. Open a `.ts` file, edit it and press Ctrl+S: the file on disk changed (read it with `cat`), and CRLF and BOM are kept.
  3. With the file open and clean, change it from a shell (`echo // outside >> file.ts`): the editor shows the change within a second.
  4. Edit the buffer, change the file from a shell again: the conflict bar appears. Keep mine, then Ctrl+S: the disk has your text.
  5. Create, rename, drag-move and delete a file: each matches the disk.
  6. Ctrl+P finds a file. A TypeScript error shows in Problems.
  7. Switch back to Ideate with an unsaved buffer, then return: it is still there.
- **Record the results** in the ledger and the Feature Log notes. Anything that fails live is a bug: fix it test-first on this branch.

- [ ] **Step 6: Commit the docs**

```bash
git add docs/DECISIONS.md docs/user-guide/forge.md CLAUDE.md apps/web/src/help/guide.ts
git commit -m "docs: Forge phase 1 — decisions D299–D302, the user guide page, the Feature Log row [D299]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Hand off**

Use superpowers:finishing-a-development-branch. Pushing, opening a PR, or merging is the user's decision: report the branch, the gates, the live-check results and the open items, then ask.
