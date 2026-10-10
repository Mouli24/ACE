# Forge, Phase 2 — the Terminal: supervised processes, trust levels and the WebSocket Origin check — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In Forge, a person opens a Terminal in the bottom panel and runs the project's commands and scripts as supervised processes, with streamed ANSI output, line prompts, `cd`, several tabs, a Processes list with Stop, and a per-project trust level. The engine's WebSocket refuses a page from an origin that is not on the allow-list.

**Architecture:**
- **Engine.** A new `ProcessService` in `packages/engine/src/processes/` sits over a new `ProcessRunner` port (`ports/processes.ts`). It:
  - enforces the project's trust level (`on` / `scripts` / `off`);
  - allows 8 running processes per project;
  - keeps the last 1,048,576 characters of each process's output and the last 20 finished processes, in memory only;
  - batches output at 50 ms into transient `process.output` frames and ends with a transient `process.exited`, both on the existing `project` WebSocket scope.
- **Routes** live under `/api/v1/projects/:id/processes`, behind the gateway's token, Origin and request-id middleware.
- **Tools.** `packages/tools/src/process/` implements the port on real child processes:
  - the platform shell, exactly as `run_command` spawns it, with stdin piped;
  - a working folder confined like a file read;
  - the engine's environment minus anything secret-shaped;
  - UTF-8 decoded across chunk boundaries;
  - tree kill on Stop;
  - the root `package.json` scripts and the package manager they run with.
- **Server.** `apps/server` wires the two together, stops every process on shutdown before the database closes, and checks `Origin` on the WebSocket upgrade, closing a refused socket with 4403.
- **Web.** `apps/web/src/forge/terminal/` holds:
  - a zustand store of terminal tabs per project (scrollback, cwd, history, the attached process), outside the components, so it survives Ideate ↔ Forge and a hidden panel;
  - a pure line discipline (local echo, editing, history, Enter, Ctrl+C);
  - the `cd` / `cls` / `clear` built-ins;
  - an xterm.js view that only renders;
  - tabs, the Processes list, script buttons, a status-bar count and Ctrl+`.
- **Mock engine.** MSW gets a scripted process runner, so unit and e2e tests run with zero env vars.

**Tech Stack:**
- Language and runtime: TypeScript ESM, Node 20+ (24 here).
- Engine side: Hono 4.13, Zod 4.6, `node:child_process` and `node:string_decoder` (in `@ace/tools` only). No new engine-side dependency.
- Web: React 18, zustand 5, TanStack Query 5, react-resizable-panels 3.0.6, lucide-react. New: `@xterm/xterm` 6.0.0, `@xterm/addon-fit` 0.11.0, `@xterm/addon-web-links` 0.12.0, `@xterm/addon-search` 0.16.0 (all released 2025-12-22; checked with `pnpm view <pkg> time --json` on 2026-10-10).
- Testing: MSW 2.15, Vitest 5, Testing Library, Playwright 1.56, `ws` 8 for real-socket integration tests.

**Spec:** `docs/team-prompts/ide-workspace-design.md`. Read it first. This phase implements:
- §6.3 Terminal and processes (D301), all of it;
- §7 Security: the WebSocket Origin line and the terminal line;
- §8 Contracts: the process parts, the two process frames and `Project.terminal`;
- §9: the `process/` and `processes/` rows, the server's WS Origin check and the xterm dependencies;
- §10: "A process that fails to start says so in its terminal tab";
- §11: the process-runner, terminal-streaming, WS Origin refusal, scrollback-survives-switching and terminal-run rows;
- §12 item 2;
- §14: No PTY and shell state.

**Repo:** `D:\ACE offcl\ACE`.
- Work happens in the worktree `D:\ACE offcl\wt\forge2` on branch `feat/forge-phase-2`, cut from `feat/forge-phase-1` at fab26e4.
- The person's own ACE is served from `D:\ACE offcl\wt\forge` on ports 4747 and 5173. **Never stop, restart or bind those ports.** Every server this plan starts uses another port.

**Later phases** keep their own plans:
- **Phase 3:** agents in the project and checkpoints (D300, D302).
- **Phase 4:** checks in Problems, Search, Ask/Fix with agent, format-on-save, cross-file TypeScript IntelliSense, phone polish.

## Global Constraints

Every Phase 1 constraint still applies. They are restated here, then Phase 2's own follow.

**Branch and commits**
- **One branch, `feat/forge-phase-2`.** Commits go in task order, contracts first (CLAUDE.md §3.4 rule 2). Nothing is pushed or opened as a PR without the user's word (Task 17).
- **Commit messages** are Conventional Commits ending in `[D301]` plus FR ids. Each ends with the trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
  - `docs/ACE-FRS.md` has no terminal or process requirement; D301 is the authority. The FR ids that apply:
    - FR-GIT-008: confinement (the working folder, the scripts reader);
    - FR-SYS-003: the Origin allow-list (the WebSocket check);
    - FR-SYS-008: shutdown (every process stops before the database closes);
    - FR-GIT-004: the editor (Task 1 only).
  - **One exception:** Task 1 carries Phase 1's review item N1, so its commit keeps Phase 1's `[D299]`.

  Example: `feat(tools): a supervised process runner — the platform shell, a confined folder, a scrubbed environment, tree kill [D301] [FR-GIT-008]`.

**Code rules**
- **Never** use `any`, `@ts-ignore` or `console.*` in engine-side code (`packages/engine|tools|contracts|storage-local`, `apps/server`).
- **No Node APIs** (`fs`, `path`, `child_process`, `process.env`, `node:*`) in `apps/web`, `packages/ui` or `packages/sdk`. **No browser APIs** in engine-side code.
- **Dependency rule** (CLAUDE.md §3.4 rule 3):
  - `packages/engine` imports only `@ace/contracts` and its own files. It never imports `@ace/tools`.
  - `packages/tools` implements the engine's `ProcessRunner` port.
  - `apps/server` wires the two together.
- **Agents never get the terminal** (D301): no `RegisteredTool`, nothing in the tool registry, nothing in `registerBuiltinTools`.

**Tests and builds**
- **`pnpm test` passes with zero env vars and no network.** Real-process tests in `@ace/tools` and `apps/server` run `process.execPath`, as `run-command.test.ts`'s `node()` helper does, never a tool from `PATH`.
- **Workspace packages resolve to their `dist/`** on the engine side. After changing a package another package imports, run `pnpm --filter <that package> build` before testing the importer. The chain here is contracts → engine → tools / storage-local → server, and contracts → sdk.
- **`apps/web` resolves `@ace/contracts` and `@ace/sdk` to their `src/`** (`vite.config.ts` aliases), so web tests need no build.
- **Coverage gates** (NFR-MAIN-02): at least 80 % for engine-side packages, and at least 60 % for `apps/web`, `packages/ui` and `packages/sdk`.
- **Focused runs** use `pnpm --filter <pkg> exec vitest run <file>`.
- **e2e** runs on its own port: `ACE_E2E_PORT=5196`, never 5173 or 5174 (another worktree's Vite may hold 5174, and `reuseExistingServer` would test the wrong code).

**Phase 1 values that still hold**
- **Paths on the wire** are project-relative, use forward slashes, and never start with one. `''` is the root and names a folder only. Absolute paths never cross the API.
- **Protected paths:** `.git` is never read or listed, at any depth; writes are refused into `.git` and `.ace` at any depth.
- **Browser-reserved keys are never bound:** `Ctrl/⌘+W`, `Ctrl/⌘+T`, `Ctrl/⌘+N`, `Ctrl+Tab`, `Ctrl/⌘+1…9`.
- **Nothing reaches the DB or the event log** from Forge: `files.changed`, `process.output` and `process.exited` are transient. No file content, terminal output or environment value is ever persisted.
- **Prettier:** run `npx prettier --write --config packages/config/prettier.config.js <files>` on the files you create or rewrite only.

**Phase 2's decisions (D301 refinements).** Each is stated in the code comments and in Task 17's DECISIONS row.
1. **Layering.**
   - The port is `packages/engine/src/ports/processes.ts`; the runner is `packages/tools/src/process/`; `apps/server` wires them.
   - Agents never get a tool for it.
2. **Spawn.** Exactly as `tools/src/builtins/run-command.ts:82-108`:
   - Windows: `ComSpec` (else `cmd.exe`) with `/d /s /c "<command>"` and `windowsVerbatimArguments: true`;
   - elsewhere: `/bin/sh -c <command>`;
   - `detached` on POSIX (the process leads its own group), `windowsHide: true`;
   - **stdin piped**, stdout and stderr piped.

   Stop reuses `killTree` from `tools/src/sandbox/runner.ts`, whose Windows `taskkill` gains `windowsHide: true` in Task 4.
3. **Environment.** `scrubSecrets(env, platform)`, exported from `tools/src/sandbox/env.ts`:
   - it keeps every variable whose name does not match `SECRET_SHAPED` (`/KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|SESSION|AUTH|COOKIE/i`, now exported);
   - it also keeps `SSH_AUTH_SOCK`, `SSH_AGENT_PID`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS` and `SESSIONNAME`, which match but are sockets and paths (git over ssh needs the agent), compared case-insensitively on Windows;
   - it then sets `FORCE_COLOR=1`.

   `PATH` and `HOME` survive because they do not match. `ANTHROPIC_API_KEY` and `ACE_*TOKEN` are dropped because they do.
4. **Working folder.**
   - It is a project-relative path, confined with `toAbsolute(root, cwd, { allowRoot: true })` from `tools/src/workspace/resolve.ts`. So it refuses outside paths (`outside_project`) and `.git` (`protected_path`) exactly as a file read does.
   - The runner then checks the path is an existing folder, or refuses with `invalid_path`.
5. **Start body.** `ProcessStartRequest` is a union. Either `{ command: string(1..8000), cwd?, label? }` or `{ script: string(1..200), cwd?, label? }`.
   - A `script` names a root `package.json` script. The service runs `<pm> run <script>`, with the package manager from decision 9.
   - A script name with characters other than `[A-Za-z0-9_:.@/+-]` is refused `validation_failed` rather than handed to a shell.
6. **Trust levels.** `Project.terminal?: 'on' | 'scripts' | 'off'`; absent means `on`.
   - `scripts` accepts only the `script` form; a `command` answers 403 `terminal_restricted`.
   - `off` refuses a start with 403 `terminal_disabled`.
   - Setting a project to `off` also stops its running processes (Task 8).
   - `input`, `stop`, list and get always work, so a person can stop what runs.
7. **Limits.**
   - At most **8** running processes per project; the 9th answers 409 `process_limit`.
   - Output is batched at **50 ms** with the engine's `createBatcher`.
   - The last **1,048,576** characters (UTF-16 code units, decoded with a UTF-8 `StringDecoder`) are kept per process. A cut never leaves half a surrogate pair at the front.
   - The last **20** finished processes per project are kept, in memory only. Nothing goes to the DB or the event log, and all of it is lost on an engine restart.
   - Every process stops on engine shutdown, next to `workspace.stopAll()` and before the database closes.
8. **Late subscribers** are served over REST, not the hub.
   - `GET /projects/:id/processes/:procId` answers `ProcessDetail = ProcessSummary + { output, truncated }`.
   - The web app fetches it when a terminal tab re-attaches: on entering Forge, and on every `hello` (a reconnect).
9. **Scripts.** `GET /projects/:id/processes/scripts` answers `{ packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun', scripts: { name, command }[] }`, from the root `package.json` only.
   - The package manager comes first from `package.json`'s `packageManager` field.
   - Then from the lockfiles, in this order: `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `bun.lock` or `bun.lockb` → bun, `package-lock.json` → npm.
   - Otherwise it is npm.
   - No `package.json`, an unparsable one, or one linked from outside the project gives an empty list, never an error.
   - **This plan's choice:** the reader is exposed as `ProcessRunner.scripts(root)`, on the same port as `start`.
10. **Routes**, all under `/api/v1/projects/:id/processes`:

    | Route | Answer |
    |---|---|
    | `POST /` | 201 `{ processId }` |
    | `POST /:procId/input` `{ data: string(0..65536) }` | 204; 409 `process_not_running` for a finished process |
    | `POST /:procId/stop` | 204, also for a finished process |
    | `GET /` | `ProcessSummary[]`: running first, then finished, newest first in each |
    | `GET /scripts` | `ProjectScripts` |
    | `GET /:procId` | `ProcessDetail` |

    - An unknown project or process answers 404 `not_found`.
    - `ProcessSummary = { id, projectId, label, command, cwd, status: 'running' | 'exited' | 'failed', exitCode: number | null, signal: string | null, startedAt, endedAt? }`.
    - `failed` means it never started (a spawn error). Its message, `Could not start: <reason>`, goes into the output on `stderr`, so the terminal tab shows it (§10).
11. **Frames.** Two transient frames on the `project` scope:
    - `process.output { projectId, processId, stream: 'stdout' | 'stderr', data }`;
    - `process.exited { projectId, processId, exitCode, signal, status: 'exited' | 'failed' }`.

    Both are added to `PROJECT_EVENT_FRAME_SCHEMAS`, `PROJECT_EVENT_TYPES` and `TRANSIENT_EVENT_TYPES`, and emitted through `bus.emitTransient`. The hub already routes them by `payload.projectId`. The hub's `onProjectWatch` stays the file watcher's: processes run whether or not anyone watches.
12. **The WebSocket Origin check** (§7).
    - `isOriginAllowed(deps, origin): Promise<boolean>` is extracted from the gateway's `originGuard` and `corsLayer`, which keep using it. A missing or empty Origin is allowed, as in REST.
    - The server's upgrade handler finishes the upgrade, then closes a refused socket at once with `WS_CLOSE_FORBIDDEN_ORIGIN = 4403` (new in contracts), so the client sees a reason.
    - The SDK stops reconnecting on 4403, as on 4401, and reports the status `forbidden_origin`. The run bar shows it.
    - `selfOrigins` uses the port the server actually bound, not the configured one (`port: 0` made them `:0`).
13. **Error codes**, added to `IDE_ERROR_CODES` and the status map:
    - `terminal_disabled` 403;
    - `terminal_restricted` 403;
    - `process_limit` 409;
    - `process_not_running` 409.

    `not_found`, `invalid_path`, `outside_project`, `protected_path` and `validation_failed` are reused.
14. **The web terminal.**
    - xterm renders only. The app's own line discipline does local echo, Backspace, Delete, ←/→/Home/End within the line, ↑/↓ history (per tab, the last **100** entered commands), Enter and Ctrl+C.
    - With nothing running, Enter starts a process in the tab's folder, and Ctrl+C clears the line. While one runs, the typed line plus `\n` goes to its stdin, and Ctrl+C stops it.
    - The built-ins are `cd <dir>` (checked through `GET /files/tree?path=`, so confined to the project), `cd` alone (prints the folder), `cd ..` (stops at the root), `cls` and `clear`. A `cd` chained with `&&`, `|`, `;`, `<` or `>` goes to the shell, so it does not persist (§14).
    - The prompt is `<cwd or ~> $ `.
    - Sessions live in a zustand store keyed by project: tabs, cwd, history, the attached process and a scrollback capped at **1,048,576** characters. The bottom panel unmounts when hidden, so on remount the view writes the stored scrollback back.
    - Several tabs are allowed. Closing a tab whose process runs asks "Stop <label>?".
    - A Processes list shows running processes with Stop, and finished ones with their exit.
    - Script buttons in the terminal header run a script in a new tab.
    - The status bar shows `▶ N running` when N > 0, which opens the Terminal.
    - **Ctrl+`** shows or hides the Terminal: `SHORTCUTS.toggleTerminal = { code: 'Backquote', mod: true }`. `shortcutLabel` prints `` ` `` for `Backquote`.
    - `ForgePanelTab` gains `'terminal'`, and the tabs read **Terminal · Problems · Output**.
    - The `project` socket subscription is shared through `useProjectScope(projectId)`, so files and processes never cut each other's feed.
15. **Trust UI.** `ProjectPage` gets a **Terminal** select (On — any command / Scripts only / Off) next to the budget fields; `SelectField` moves from `settings/SettingsPage.tsx` to `settings/SettingFields.tsx`. With `scripts` or `off`, the Terminal header says so and links to the project page. With `off`, typing and New terminal are disabled. With `scripts`, a typed command prints the 403's message in the tab.
16. **stdin line ending:** `\n` on every platform.
17. **Unit tests mock xterm** with `FakeTerminal` (`apps/web/src/test/FakeTerminal.ts`), registered globally in `test/setup.tsx` beside `FakeEditorHost`. The real xterm runs in e2e only.

## Review Focus

1. **A command that never ends, or prints megabytes, or leaves grandchildren behind** (`npm run dev` → `vite`). Expect:
   - the engine keeps only the last 1,048,576 characters;
   - a terminal tab keeps only the last 1,048,576 characters, so the browser stays responsive;
   - Stop kills the whole tree, grandchildren included, within 2.5 s.

   Pinned by Task 4's test "Stop kills the shell, its child and its grandchild within 2.5 s", Task 6's test "keeps only the last 1,048,576 characters, never half a character" and Task 12's test "a tab keeps only the last 1,048,576 characters".
2. **Windows quoting.** A command line with quotes, `&&`, `|` and an environment variable (`%VAR%` / `$VAR`), and a working folder with spaces and unicode, run exactly as the shell would run them. Pinned by Task 4's tests "runs a line as the shell would: quotes, &&, | and a variable" and "runs in a folder whose name has spaces and unicode".
3. **The engine stops, or the socket reconnects, while processes run.** Expect:
   - stopping the engine leaves no process behind;
   - after a reconnect the tab's output is the engine's copy, shown once, never doubled;
   - a process the engine no longer knows says so and gives the prompt back.

   Pinned by Task 8's test "stopping the engine stops every process it started, grandchildren included" and Task 12's tests "a re-attach replaces the tab's output with the engine's copy, once" and "a process the engine no longer knows ends the tab's run with a note".
4. **Output split mid-character or mid-colour.** A process writes `é`, `✓`, `😀` and `\x1b[31m…\x1b[0m` in pieces that cut through a multibyte sequence. Expect the text unmangled, with no `�`. Pinned by Task 4's test "never splits a character or an ANSI colour across chunks".
5. **Secrets in the engine's environment.** `ANTHROPIC_API_KEY` or `ACE_SESSION_TOKEN` must never reach a terminal process; `SSH_AUTH_SOCK`, `PATH` and `HOME` must. Pinned by Task 4's tests "a process never sees a secret-shaped variable, but keeps SSH_AUTH_SOCK, PATH and HOME" and Task 4's `scrubSecrets` table.

## File Map

**Contracts** (`packages/contracts/src`)
- Modify:
  - `graph.ts`: `TERMINAL_TRUST_LEVELS`, `TerminalTrustSchema`, `DEFAULT_TERMINAL_TRUST`, and `Project.terminal`;
  - `api.ts`: `UpdateProjectRequest.terminal`;
  - `workspace.ts`: the process limits, the start union, input, summary, detail, scripts and the two frame payloads;
  - `errors.ts`: four `IDE_ERROR_CODES` and their statuses;
  - `events.ts`: `process.output` and `process.exited` as transient project frames;
  - `ws.ts`: `WS_CLOSE_FORBIDDEN_ORIGIN`.
- Tests: extend `__tests__/workspace.test.ts`, `errors.test.ts`, `events.test.ts`, `ws.test.ts`, `graph.test.ts`, `api.test.ts` and `index.test.ts`.

**Storage** (`packages/storage-local/src`)
- Modify `migrations.ts` (`FORGE_TERMINAL_MIGRATION_ID`), `schema.ts` (`projects.terminal`) and `repository.ts` (`toProject`, `create`, `update`).
- Tests: create `__tests__/migration-forge-terminal.test.ts`. In `migration-round-3`, `migration-round-4`, `migration-round-5`, `migration-x1` and `migration-chat-sessions`, add the new id to the expected chain.

**Engine** (`packages/engine/src`)
- Create:
  - `ports/processes.ts`: `ProcessSpec`, `ProcessHandlers`, `RunningProcess`, `ProcessRunner`;
  - `processes/errors.ts`: the four refusals and the unsafe script name;
  - `processes/service.ts`: `createProcessService`;
  - `processes/routes.ts`: `createProcessRoutes`.
- Modify:
  - `ports/index.ts` and `ports/repository.ts`: the port, and `terminal` in the project patch;
  - `graph/index.ts`: `updateProject` takes `terminal`;
  - `gateway/index.ts`: `isOriginAllowed`, `EngineDeps.processes`, the mount, and the widened `PATCH /projects/:id`;
  - `index.ts`: the barrel;
  - `__tests__/fake-repository.ts`: `terminal` in `projects.update`.
- Tests: create `processes/__tests__/fake-runner.ts`, `service.test.ts`, `routes.test.ts`, `terminal-off.test.ts` and `gateway/__tests__/origin.test.ts`; extend `__tests__/graph.test.ts` and `__tests__/events.test.ts`.

**Tools** (`packages/tools/src`)
- Create `process/runner.ts` (`createProcessRunner`, `resolveWorkingFolder`, `shellCommand`) and `process/scripts.ts` (`readProjectScripts`).
- Modify `sandbox/env.ts` (`SECRET_SHAPED` exported, `SCRUB_KEEP`, `scrubSecrets`), `sandbox/runner.ts` (`windowsHide` on `taskkill`) and `index.ts`.
- Tests: create `process/runner.test.ts`, `process/scripts.test.ts` and `sandbox/kill-tree.test.ts`; extend `sandbox/env.test.ts`.

**Server** (`apps/server/src`)
- Modify `server.ts`: the process service, shutdown, the real-port `selfOrigins`, and the upgrade's Origin check.
- Create `__tests__/processes.integration.test.ts` and `__tests__/ws-origin.integration.test.ts`.

**SDK** (`packages/sdk/src`)
- Modify `socket.ts` (`forbidden_origin`, no reconnect on 4403) and `client.ts` (six process methods).
- Tests: extend `__tests__/socket.test.ts`; create `__tests__/processes.test.ts`.

**Web** (`apps/web`)
- `package.json`: the four xterm packages, pinned exactly.
- Modify `src/forge/editor/language-defaults.ts` (`noImplicitAny: false`) and its test (Task 1).
- Create `src/runs/SocketNotice.tsx` and its test; modify `src/runs/RunBar.tsx` (Task 9).
- Mocks:
  - create `src/mocks/processes.ts` (`MockProcesses`) and `src/mocks/handlers-processes.ts`;
  - modify `src/mocks/db.ts` (`terminal` on projects) and `src/mocks/browser.ts` (handlers and `__aceMock.setTerminal`).
- Forge, new:
  - `src/forge/project-scope.ts`: `useProjectScope`, `retainProjectScope`;
  - `src/forge/terminal/`:
    - `hooks.ts`: `processKeys`, `useProcessList`, `useProjectScripts`, `useStopProcess`, `runningCount`;
    - `terminal-store.ts`: `useTerminalStore` and its helpers;
    - `line-discipline.ts`: `LineState`, `feed`, `promptFor`;
    - `builtins.ts`: `parseBuiltin`, `resolveCd`;
    - `process-events.ts`: `useProcessEvents`, `reattach`;
    - `session.ts`: `typed`, `runScript`, `openProcessInTab`;
    - `xterm-theme.ts`;
    - `TerminalView.tsx`, `TerminalPanel.tsx`, `TerminalTabs.tsx`, `ProcessesList.tsx`, `ScriptButtons.tsx`, `TrustNotice.tsx`.
- Forge, modified:
  - `src/forge/files/project-socket.ts`: through `useProjectScope`;
  - `src/forge/ForgePage.tsx`: `useProcessEvents`;
  - `src/forge/ForgeWorkbench.tsx`: Ctrl+`;
  - `src/forge/panel/BottomPanel.tsx`: the Terminal tab;
  - `src/forge/layout/StatusBar.tsx`: the running count;
  - `src/forge/editor/EmptyEditor.tsx`: Toggle terminal;
  - `src/app/stores/layout.ts`: `'terminal'`, `toggleTerminal`;
  - `src/app/shortcuts.ts`: `toggleTerminal` and the `` ` `` label.
- Settings and projects: modify `src/settings/SettingFields.tsx` (gains `SelectField`), `src/settings/SettingsPage.tsx` (loses it) and `src/projects/ProjectPage.tsx` (the Terminal select).
- Tests:
  - create `src/test/FakeTerminal.ts`;
  - modify `src/test/setup.tsx` (xterm mocked globally) and `src/test/app.tsx` (process handlers, `installMockSocket`, store resets);
  - create the `*.test.ts(x)` files named in each task, `e2e/terminal.spec.ts`, and extend `e2e/helpers.ts`.

**Docs**
- Modify `docs/DECISIONS.md` (the D301 row), `docs/user-guide/forge.md` (a Terminal section) and `CLAUDE.md` §9 (a Feature Log row `IDE | F2`).

---

### Task 0: Worktree and baseline (the controller runs this)

**Files:** none.

- [ ] **Step 1: Check the worktree**

```bash
cd "D:/ACE offcl/wt/forge2"
git status --short
git log --oneline -1
```

Expected: a clean tree (this plan file may show as untracked until the controller commits it), and `fab26e4 docs: the guide says a save refuses a rename, move or delete; D299 lists every Phase 1 refinement [D299]` on `feat/forge-phase-2`.

- [ ] **Step 2: Install and build**

```bash
pnpm install --prefer-offline
pnpm --filter "./packages/**" build
```

Expected: `pnpm install` finishes without a network error, and every package builds.

- [ ] **Step 3: Record the baseline**

```bash
pnpm typecheck 2>&1 | tail -5
pnpm lint 2>&1 | tail -5
pnpm test 2>&1 | tail -40
```

Expected: all green. Write the per-package pass counts into the task ledger, so later regressions are visible. If anything is red on the untouched branch, stop and report. Do not fix unrelated failures inside this plan.

- [ ] **Step 4: Confirm the person's ACE is left alone**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4747/api/v1/health
```

Expected: `401` if the person's ACE is running, or `000` if it is not. Either way, nothing in this plan binds 4747 or 5173.

---

### Task 1: Web — Monaco stops flagging implicit `any` in a project's own files (Phase 1's N1)

Monaco loads one file at a time, so a parameter whose type lives in an unloaded module reads as implicit `any` (TS 7006/7031) and fills Problems with false errors. `strict` stays on, so every other strict check still reports.

**Files:**
- Modify: `apps/web/src/forge/editor/language-defaults.ts:31-43`
- Test: `apps/web/src/forge/editor/language-defaults.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `configureLanguageDefaults` sets `noImplicitAny: false` beside `strict: true` for TypeScript and JavaScript.

- [ ] **Step 1: Write the failing test**

In `apps/web/src/forge/editor/language-defaults.test.ts`, inside `describe('review I3: …')`, append:

```ts
  it('N1: keeps strict on but does not report implicit any, which only means "that module is not loaded"', () => {
    const fake = createFakeMonaco();
    configureLanguageDefaults(asMonaco(fake));

    for (const defaults of [fake.typescript.typescriptDefaults, fake.typescript.javascriptDefaults]) {
      expect(defaults.getCompilerOptions()).toMatchObject({ strict: true, noImplicitAny: false });
    }
  });
```

- [ ] **Step 2: Run it to watch it fail**

Run: `pnpm --filter @ace/web exec vitest run src/forge/editor/language-defaults.test.ts`
Expected: FAIL. `noImplicitAny` is `undefined`, not `false`.

- [ ] **Step 3: Implement**

In `apps/web/src/forge/editor/language-defaults.ts`, in the `setCompilerOptions` call, change:

```ts
      strict: true,
      skipLibCheck: true,
    });
```

to:

```ts
      strict: true,
      // N1: a parameter typed by a module Monaco has not loaded reads as implicit any (7006,
      // 7031). Strict stays on for everything else; cross-file types arrive in Phase 4.
      noImplicitAny: false,
      skipLibCheck: true,
    });
```

- [ ] **Step 4: Run it to watch it pass**

Run: `pnpm --filter @ace/web exec vitest run src/forge/editor/language-defaults.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
npx prettier --write --config packages/config/prettier.config.js apps/web/src/forge/editor/language-defaults.ts apps/web/src/forge/editor/language-defaults.test.ts
git add apps/web/src/forge/editor/language-defaults.ts apps/web/src/forge/editor/language-defaults.test.ts
git commit -m "fix(web): Monaco keeps strict on but stops reporting implicit any from unloaded modules [D299] [FR-GIT-004]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 2: Contracts — processes, the trust level, four error codes, two frames and 4403

**Files:**
- Modify:
  - `packages/contracts/src/graph.ts:41-51` (`ProjectSchema`, plus the trust level above it);
  - `packages/contracts/src/api.ts:3-9` (import) and `:71-76` (`UpdateProjectRequestSchema`);
  - `packages/contracts/src/workspace.ts` (append after line 175);
  - `packages/contracts/src/errors.ts:54-65` and `:94-98`;
  - `packages/contracts/src/events.ts:24`, `:321-327`, `:380-385`;
  - `packages/contracts/src/ws.ts:23-24`.
- Test: extend `packages/contracts/src/__tests__/workspace.test.ts`, `errors.test.ts`, `events.test.ts`, `ws.test.ts`, `graph.test.ts`, `api.test.ts` and `index.test.ts`.

**Interfaces:**
- Consumes: the existing `IdSchema`, `TimestampSchema`, `ProjectPathSchema` and the `transientFrame` helper in `events.ts`.
- Produces, from `graph.ts`:
  - `TERMINAL_TRUST_LEVELS = ['on', 'scripts', 'off']`, `TerminalTrustSchema`, `type TerminalTrust`, `DEFAULT_TERMINAL_TRUST = 'on'`;
  - `Project.terminal?: TerminalTrust`.
- Produces, from `api.ts`: `UpdateProjectRequest.terminal?: TerminalTrust`.
- Produces, from `workspace.ts`:
  - `PROCESS_COMMAND_MAX = 8_000`, `PROCESS_INPUT_MAX = 65_536`, `PROCESS_OUTPUT_MAX_CHARS = 1_048_576`, `PROCESS_RUNNING_MAX = 8`, `PROCESS_RECENT_MAX = 20`, `PROCESS_OUTPUT_BATCH_MS = 50`;
  - `PROCESS_STATUSES`, `ProcessStatusSchema`, `ProcessStatus` (`'running' | 'exited' | 'failed'`);
  - `PROCESS_STREAMS`, `ProcessStreamSchema`, `ProcessStream` (`'stdout' | 'stderr'`);
  - `PACKAGE_MANAGERS`, `PackageManagerSchema`, `PackageManager` (`'npm' | 'pnpm' | 'yarn' | 'bun'`);
  - `ProcessStartRequestSchema` / `ProcessStartRequest` = `{ command, cwd?, label? } | { script, cwd?, label? }`;
  - `ProcessStartResponseSchema` / `ProcessStartResponse` = `{ processId }`;
  - `ProcessInputRequestSchema` / `ProcessInputRequest` = `{ data }`;
  - `ProcessSummarySchema` / `ProcessSummary`, `ProcessDetailSchema` / `ProcessDetail`;
  - `ProjectScriptSchema` / `ProjectScript`, `ProjectScriptsSchema` / `ProjectScripts`;
  - `ProcessOutputPayloadSchema` / `ProcessOutputPayload`, `ProcessExitedPayloadSchema` / `ProcessExitedPayload`.
- Produces, from `errors.ts`: `terminal_disabled` 403, `terminal_restricted` 403, `process_limit` 409, `process_not_running` 409, appended to `IDE_ERROR_CODES`.
- Produces, from `events.ts`: `process.output` and `process.exited` in `PROJECT_EVENT_FRAME_SCHEMAS`, `PROJECT_EVENT_TYPES` and `TRANSIENT_EVENT_TYPES`.
- Produces, from `ws.ts`: `WS_CLOSE_FORBIDDEN_ORIGIN = 4403`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/contracts/src/__tests__/workspace.test.ts`. First add these names to its import from `'../workspace.js'`: `PACKAGE_MANAGERS`, `PROCESS_COMMAND_MAX`, `PROCESS_INPUT_MAX`, `PROCESS_OUTPUT_BATCH_MS`, `PROCESS_OUTPUT_MAX_CHARS`, `PROCESS_RECENT_MAX`, `PROCESS_RUNNING_MAX`, `ProcessDetailSchema`, `ProcessExitedPayloadSchema`, `ProcessInputRequestSchema`, `ProcessOutputPayloadSchema`, `ProcessStartRequestSchema`, `ProcessStartResponseSchema`, `ProcessSummarySchema`, `ProjectScriptsSchema`. Then append:

```ts
describe('D301 the terminal’s processes contract (design §6.3)', () => {
  const summary = {
    id: ID,
    projectId: ID,
    label: 'dev',
    command: 'pnpm run dev',
    cwd: '',
    status: 'running',
    exitCode: null,
    signal: null,
    startedAt: AT,
  };

  it('pins the limits D301 gives', () => {
    expect(PROCESS_COMMAND_MAX).toBe(8_000);
    expect(PROCESS_INPUT_MAX).toBe(65_536);
    expect(PROCESS_OUTPUT_MAX_CHARS).toBe(1_048_576);
    expect(PROCESS_RUNNING_MAX).toBe(8);
    expect(PROCESS_RECENT_MAX).toBe(20);
    expect(PROCESS_OUTPUT_BATCH_MS).toBe(50);
    expect([...PACKAGE_MANAGERS]).toEqual(['npm', 'pnpm', 'yarn', 'bun']);
  });

  it('starts either a typed command or a package.json script, never both', () => {
    const typed = { command: 'node -v', cwd: 'src', label: 'version' };
    const script = { script: 'dev' };
    expect(ProcessStartRequestSchema.parse(typed)).toEqual(typed);
    expect(ProcessStartRequestSchema.parse(script)).toEqual(script);
    expect(ProcessStartRequestSchema.safeParse({ command: 'a', script: 'dev' }).success).toBe(false);
    expect(ProcessStartRequestSchema.safeParse({}).success).toBe(false);
  });

  it('refuses an empty or blank command, and one over 8,000 characters', () => {
    expect(ProcessStartRequestSchema.safeParse({ command: '' }).success).toBe(false);
    expect(ProcessStartRequestSchema.safeParse({ command: '   ' }).success).toBe(false);
    expect(ProcessStartRequestSchema.safeParse({ command: 'x'.repeat(8_000) }).success).toBe(true);
    expect(ProcessStartRequestSchema.safeParse({ command: 'x'.repeat(8_001) }).success).toBe(false);
  });

  it('answers a start with the process id, and takes up to 64 KB of input at a time', () => {
    expect(ProcessStartResponseSchema.parse({ processId: ID })).toEqual({ processId: ID });
    expect(ProcessInputRequestSchema.parse({ data: 'Ada\n' })).toEqual({ data: 'Ada\n' });
    expect(ProcessInputRequestSchema.safeParse({ data: 'x'.repeat(65_536) }).success).toBe(true);
    expect(ProcessInputRequestSchema.safeParse({ data: 'x'.repeat(65_537) }).success).toBe(false);
  });

  it('summarises a process, and the detail adds its kept output', () => {
    expect(ProcessSummarySchema.parse(summary)).toEqual(summary);
    const finished = { ...summary, status: 'exited', exitCode: 0, endedAt: AT };
    expect(ProcessSummarySchema.parse(finished)).toEqual(finished);
    expect(ProcessSummarySchema.safeParse({ ...summary, status: 'stopped' }).success).toBe(false);
    expect(ProcessSummarySchema.safeParse({ ...summary, pid: 12 }).success, 'no pid on the wire').toBe(
      false,
    );
    const detail = { ...summary, output: 'listening on 3000\n', truncated: false };
    expect(ProcessDetailSchema.parse(detail)).toEqual(detail);
    expect(ProcessDetailSchema.safeParse({ ...detail, extra: 1 }).success).toBe(false);
  });

  it('lists the project’s scripts with the package manager they run with', () => {
    const scripts = {
      packageManager: 'pnpm',
      scripts: [{ name: 'dev', command: 'vite' }],
    };
    expect(ProjectScriptsSchema.parse(scripts)).toEqual(scripts);
    expect(ProjectScriptsSchema.safeParse({ ...scripts, packageManager: 'deno' }).success).toBe(false);
  });

  it('streams output and an end, each naming the project and the process', () => {
    const output = { projectId: ID, processId: ID, stream: 'stderr', data: '\u001b[31mred\u001b[0m' };
    expect(ProcessOutputPayloadSchema.parse(output)).toEqual(output);
    const exited = { projectId: ID, processId: ID, exitCode: null, signal: 'SIGKILL', status: 'exited' };
    expect(ProcessExitedPayloadSchema.parse(exited)).toEqual(exited);
    expect(
      ProcessExitedPayloadSchema.safeParse({ ...exited, status: 'running' }).success,
      'an end is never "running"',
    ).toBe(false);
  });
});
```

In `packages/contracts/src/__tests__/errors.test.ts`, replace the test `'adds the five codes Forge’s file API names (D299, design §6.1)'` with:

```ts
  it('adds the codes Forge’s file API names (D299, §6.1) and the terminal’s (D301, §6.3)', () => {
    expect([...IDE_ERROR_CODES]).toEqual([
      'file_changed',
      'exists',
      'file_too_large',
      'outside_project',
      'protected_path',
      'terminal_disabled',
      'terminal_restricted',
      'process_limit',
      'process_not_running',
    ]);
  });
```

In the same file, in `'maps every code to the HTTP status §2.3 gives it'`, change the end of the expected map from:

```ts
      outside_project: 403,
      protected_path: 403,
    });
```

to:

```ts
      outside_project: 403,
      protected_path: 403,
      terminal_disabled: 403,
      terminal_restricted: 403,
      process_limit: 409,
      process_not_running: 409,
    });
```

In `packages/contracts/src/__tests__/events.test.ts`, in `'names the two types that carry no seq'`, change:

```ts
    expect([...TRANSIENT_EVENT_TYPES]).toEqual(['node.token', 'chat.token', 'files.changed']);
    expect([...PROJECT_EVENT_TYPES]).toEqual(['files.changed']);
```

to:

```ts
    expect([...TRANSIENT_EVENT_TYPES]).toEqual([
      'node.token',
      'chat.token',
      'files.changed',
      'process.output',
      'process.exited',
    ]);
    expect([...PROJECT_EVENT_TYPES]).toEqual(['files.changed', 'process.output', 'process.exited']);
```

In `packages/contracts/src/__tests__/ws.test.ts`, add `WS_CLOSE_FORBIDDEN_ORIGIN` to the import from `'../ws.js'`, and append inside `describe('FR-EXE-014 WebSocket client frames', …)`:

```ts
  it('carries process.output and process.exited on the project scope without a seq (D301)', () => {
    const output = {
      type: 'process.output',
      payload: { projectId: WORKFLOW_ID, processId: WORKFLOW_ID, stream: 'stdout', data: 'hi\n' },
    };
    const exited = {
      type: 'process.exited',
      payload: {
        projectId: WORKFLOW_ID,
        processId: WORKFLOW_ID,
        exitCode: 0,
        signal: null,
        status: 'exited',
      },
    };
    expect(ServerFrameSchema.parse(output)).toEqual(output);
    expect(ServerFrameSchema.parse(exited)).toEqual(exited);
    expect(ServerFrameSchema.safeParse({ ...output, seq: 4 }).success, 'transient: no seq').toBe(
      false,
    );
  });
```

and append inside `describe('FR-SYS-002 WebSocket auth', …)`:

```ts
  it('closes a socket from an origin not on the allow-list with 4403 (FR-SYS-003, D301)', () => {
    expect(WS_CLOSE_FORBIDDEN_ORIGIN).toBe(4403);
  });
```

In `packages/contracts/src/__tests__/graph.test.ts`, add `DEFAULT_TERMINAL_TRUST`, `TERMINAL_TRUST_LEVELS` and `TerminalTrustSchema` to the import from `'../graph.js'`, and append after `describe('FR-GRD-008 a project can cap what one run may cost', …)`:

```ts
describe('D301 a project says how far it trusts its terminal', () => {
  const project = {
    id: PROJECT_ID,
    name: 'Demo',
    folderPath: 'D:/projects/demo',
    createdAt: NOW,
    updatedAt: NOW,
  };

  it('is on, scripts or off; absent reads as on', () => {
    expect([...TERMINAL_TRUST_LEVELS]).toEqual(['on', 'scripts', 'off']);
    expect(DEFAULT_TERMINAL_TRUST).toBe('on');
    expect(ProjectSchema.parse(project).terminal).toBeUndefined();
    expect(ProjectSchema.parse({ ...project, terminal: 'scripts' }).terminal).toBe('scripts');
    expect(ProjectSchema.safeParse({ ...project, terminal: 'sometimes' }).success).toBe(false);
    expect(TerminalTrustSchema.safeParse(null).success).toBe(false);
  });
});
```

In `packages/contracts/src/__tests__/api.test.ts`, append after `describe('FR-GRD-008 PATCH /projects/:id takes a run cost cap (round 3 §2.3)', …)`:

```ts
describe('D301 PATCH /projects/:id takes the terminal trust level', () => {
  it('sets on, scripts or off, and refuses anything else', () => {
    for (const terminal of ['on', 'scripts', 'off'] as const) {
      expect(UpdateProjectRequestSchema.parse({ terminal })).toEqual({ terminal });
    }
    expect(UpdateProjectRequestSchema.safeParse({ terminal: 'all' }).success).toBe(false);
    expect(UpdateProjectRequestSchema.safeParse({ terminal: null }).success).toBe(false);
  });
});
```

In `packages/contracts/src/__tests__/index.test.ts`, add these rows to the `it.each([...])` table, after `['events', 'PROJECT_EVENT_TYPES'],`:

```ts
    ['workspace', 'ProcessStartRequestSchema'],
    ['workspace', 'ProcessSummarySchema'],
    ['workspace', 'ProcessDetailSchema'],
    ['workspace', 'ProjectScriptsSchema'],
    ['workspace', 'ProcessOutputPayloadSchema'],
    ['workspace', 'ProcessExitedPayloadSchema'],
    ['workspace', 'PROCESS_OUTPUT_MAX_CHARS'],
    ['graph', 'TerminalTrustSchema'],
    ['ws', 'WS_CLOSE_FORBIDDEN_ORIGIN'],
```

- [ ] **Step 2: Run them to watch them fail**

Run: `pnpm --filter @ace/contracts exec vitest run src/__tests__`
Expected: FAIL. The process schemas, `TerminalTrustSchema` and `WS_CLOSE_FORBIDDEN_ORIGIN` are undefined; the code lists and the transient list are short.

- [ ] **Step 3: The trust level on the project**

In `packages/contracts/src/graph.ts`, insert before `export const ProjectSchema = z.object({` (line 41):

```ts
/**
 * D301: how far a project trusts its terminal (design §6.3). `on` runs any command a person types
 * and the project's scripts; `scripts` runs only the root package.json scripts; `off` runs nothing.
 * Absent reads as `on`, so a project stored before Forge needs no backfill.
 */
export const TERMINAL_TRUST_LEVELS = ['on', 'scripts', 'off'] as const;
export const TerminalTrustSchema = z.enum(TERMINAL_TRUST_LEVELS);
export type TerminalTrust = z.infer<typeof TerminalTrustSchema>;
export const DEFAULT_TERMINAL_TRUST: TerminalTrust = 'on';

```

and in `ProjectSchema`, after the `maxCostPerRunUsd` line, add:

```ts
  /** D301: absent is `on`. */
  terminal: TerminalTrustSchema.optional(),
```

In `packages/contracts/src/api.ts`, change the import from `'./graph.js'` to:

```ts
import {
  BudgetUsdSchema,
  EdgeSchema,
  EntityNameSchema,
  NodeSchema,
  TerminalTrustSchema,
  WorkflowSchema,
} from './graph.js';
```

and change `UpdateProjectRequestSchema` to:

```ts
export const UpdateProjectRequestSchema = z.object({
  name: EntityNameSchema.optional(),
  /** Round 3 §2.3: the run cost cap; `null` removes it (D72). */
  maxCostPerRunUsd: BudgetUsdSchema.nullable().optional(),
  /** D301: the terminal trust level. `off` also stops what runs (the gateway's PATCH route). */
  terminal: TerminalTrustSchema.optional(),
});
```

- [ ] **Step 4: The process schemas**

Append to `packages/contracts/src/workspace.ts`:

```ts

/* -------------------------------------------------------------------------- */
/* Processes: Forge's terminal (D301, design §6.3)                             */
/* -------------------------------------------------------------------------- */

/** The longest command line a start takes: the same bound as `run_command`. */
export const PROCESS_COMMAND_MAX = 8_000;
/** The most one `POST /input` writes to a process's stdin, in characters. */
export const PROCESS_INPUT_MAX = 65_536;
/** How much of a process's output the engine keeps, and a terminal tab shows, in UTF-16 code units. */
export const PROCESS_OUTPUT_MAX_CHARS = 1_048_576;
/** How many processes may run at once in one project; the next start answers 409 `process_limit`. */
export const PROCESS_RUNNING_MAX = 8;
/** How many finished processes per project the engine remembers, in memory only. */
export const PROCESS_RECENT_MAX = 20;
/** Output is collected this long before it goes out as `process.output` frames. */
export const PROCESS_OUTPUT_BATCH_MS = 50;

/** `failed` means it never started (a spawn error); its reason is in the output. */
export const PROCESS_STATUSES = ['running', 'exited', 'failed'] as const;
export const ProcessStatusSchema = z.enum(PROCESS_STATUSES);
export type ProcessStatus = z.infer<typeof ProcessStatusSchema>;

export const PROCESS_STREAMS = ['stdout', 'stderr'] as const;
export const ProcessStreamSchema = z.enum(PROCESS_STREAMS);
export type ProcessStream = z.infer<typeof ProcessStreamSchema>;

export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;
export const PackageManagerSchema = z.enum(PACKAGE_MANAGERS);
export type PackageManager = z.infer<typeof PackageManagerSchema>;

const ProcessLabelSchema = z.string().min(1).max(120);

/**
 * `POST /projects/:id/processes`. Either the line a person typed, run through the platform shell,
 * or the name of a root package.json script, which the engine runs as `<pm> run <script>`. `cwd`
 * is project-relative and confined by the engine; the root when omitted.
 */
export const ProcessStartRequestSchema = z.union([
  z.strictObject({
    command: z
      .string()
      .min(1)
      .max(PROCESS_COMMAND_MAX)
      .regex(/\S/, 'A command needs a character that is not a space.'),
    cwd: ProjectPathSchema.optional(),
    label: ProcessLabelSchema.optional(),
  }),
  z.strictObject({
    script: z.string().min(1).max(200),
    cwd: ProjectPathSchema.optional(),
    label: ProcessLabelSchema.optional(),
  }),
]);
export type ProcessStartRequest = z.infer<typeof ProcessStartRequestSchema>;

export const ProcessStartResponseSchema = z.strictObject({ processId: IdSchema });
export type ProcessStartResponse = z.infer<typeof ProcessStartResponseSchema>;

/** `POST /projects/:id/processes/:procId/input`: written to stdin as given; a line ends in `\n`. */
export const ProcessInputRequestSchema = z.strictObject({
  data: z.string().max(PROCESS_INPUT_MAX),
});
export type ProcessInputRequest = z.infer<typeof ProcessInputRequestSchema>;

/** One row of `GET /projects/:id/processes`. No pid crosses the wire. */
export const ProcessSummarySchema = z.strictObject({
  id: IdSchema,
  projectId: IdSchema,
  label: z.string(),
  command: z.string(),
  cwd: ProjectPathSchema,
  status: ProcessStatusSchema,
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  startedAt: TimestampSchema,
  endedAt: TimestampSchema.optional(),
});
export type ProcessSummary = z.infer<typeof ProcessSummarySchema>;

/**
 * `GET /projects/:id/processes/:procId`: the summary plus the output the engine kept — the last
 * {@link PROCESS_OUTPUT_MAX_CHARS} characters — for a terminal tab that re-attaches (design §6.3).
 */
export const ProcessDetailSchema = z.strictObject({
  ...ProcessSummarySchema.shape,
  output: z.string(),
  /** Earlier output was dropped to keep the last {@link PROCESS_OUTPUT_MAX_CHARS} characters. */
  truncated: z.boolean(),
});
export type ProcessDetail = z.infer<typeof ProcessDetailSchema>;

export const ProjectScriptSchema = z.strictObject({ name: z.string(), command: z.string() });
export type ProjectScript = z.infer<typeof ProjectScriptSchema>;

/** `GET /projects/:id/processes/scripts`: the root package.json scripts, in file order. */
export const ProjectScriptsSchema = z.strictObject({
  packageManager: PackageManagerSchema,
  scripts: z.array(ProjectScriptSchema),
});
export type ProjectScripts = z.infer<typeof ProjectScriptsSchema>;

/** The transient `process.output` frame on the `project` scope: one 50 ms batch of one stream. */
export const ProcessOutputPayloadSchema = z.strictObject({
  projectId: IdSchema,
  processId: IdSchema,
  stream: ProcessStreamSchema,
  data: z.string(),
});
export type ProcessOutputPayload = z.infer<typeof ProcessOutputPayloadSchema>;

/** The transient `process.exited` frame: the process ended, or never started (`failed`). */
export const ProcessExitedPayloadSchema = z.strictObject({
  projectId: IdSchema,
  processId: IdSchema,
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  status: z.enum(['exited', 'failed']),
});
export type ProcessExitedPayload = z.infer<typeof ProcessExitedPayloadSchema>;
```

- [ ] **Step 5: The error codes**

In `packages/contracts/src/errors.ts`, replace the `IDE_ERROR_CODES` block (lines 54-65) with:

```ts
/**
 * Codes Forge adds. The file API (D299, design §6.1): a save on a stale base (409, with the disk's
 * version in `details`), a create or move onto an existing path (409), a save over the editable
 * size (413), a path outside the project folder (403) and a write into `.git`/`.ace` (403). The
 * terminal (D301, §6.3): a start the project's trust level refuses (403 `terminal_disabled` when
 * it is off, 403 `terminal_restricted` for a typed command when only scripts may run), a ninth
 * running process (409) and input to a process that has finished (409).
 */
export const IDE_ERROR_CODES = [
  'file_changed',
  'exists',
  'file_too_large',
  'outside_project',
  'protected_path',
  'terminal_disabled',
  'terminal_restricted',
  'process_limit',
  'process_not_running',
] as const;
```

and in `ERROR_CODE_HTTP_STATUS`, after `protected_path: 403,` add:

```ts
  terminal_disabled: 403,
  terminal_restricted: 403,
  process_limit: 409,
  process_not_running: 409,
```

- [ ] **Step 6: The frames**

In `packages/contracts/src/events.ts`, change the workspace import (line 24) to:

```ts
import {
  FilesChangedPayloadSchema,
  ProcessExitedPayloadSchema,
  ProcessOutputPayloadSchema,
} from './workspace.js';
```

Replace `PROJECT_EVENT_FRAME_SCHEMAS` (lines 321-327) with:

```ts
/**
 * Forge's frames (D299, D301). They ride the `project` scope and are never persisted: a watcher's
 * burst and a process's output are worth sending to a client that is looking and worth nothing in
 * the log — and terminal output must never reach it (design §7).
 */
export const PROJECT_EVENT_FRAME_SCHEMAS = [
  transientFrame('files.changed', FilesChangedPayloadSchema),
  transientFrame('process.output', ProcessOutputPayloadSchema),
  transientFrame('process.exited', ProcessExitedPayloadSchema),
] as const;
```

Replace the two lists at lines 380-385 with:

```ts
export const PROJECT_EVENT_TYPES = ['files.changed', 'process.output', 'process.exited'] as const;
export type ProjectEventType = (typeof PROJECT_EVENT_TYPES)[number];

/** Not persisted, no `seq`, never replayed by `resume` (§2.4, round 4 §2.5, D299, D301). */
export const TRANSIENT_EVENT_TYPES = [
  'node.token',
  'chat.token',
  'files.changed',
  'process.output',
  'process.exited',
] as const;
export type TransientEventType = (typeof TRANSIENT_EVENT_TYPES)[number];
```

- [ ] **Step 7: The close code**

In `packages/contracts/src/ws.ts`, after `export const WS_CLOSE_UNAUTHORIZED = 4401;` add:

```ts

/**
 * Close code for a socket opened from an origin not on the allow-list (FR-SYS-003, design §7).
 * The upgrade completes and is closed at once, so the client learns why instead of seeing a
 * failed connection; the SDK does not reconnect after it.
 */
export const WS_CLOSE_FORBIDDEN_ORIGIN = 4403;
```

- [ ] **Step 8: Run the tests**

Run: `pnpm --filter @ace/contracts exec vitest run src/__tests__`
Expected: PASS.

- [ ] **Step 9: Full suite, typecheck, build, commit**

Run: `pnpm --filter @ace/contracts test && pnpm --filter @ace/contracts typecheck && pnpm --filter @ace/contracts build`
Expected: PASS, and `packages/contracts/dist` rebuilt. Every later engine-side task resolves the contracts from there.

```bash
npx prettier --write --config packages/config/prettier.config.js packages/contracts/src/workspace.ts packages/contracts/src/errors.ts packages/contracts/src/events.ts packages/contracts/src/ws.ts packages/contracts/src/graph.ts packages/contracts/src/api.ts packages/contracts/src/__tests__
git add packages/contracts
git commit -m "feat(contracts): the terminal's processes, the project trust level, four error codes, process frames and close code 4403 [D301] [FR-SYS-003]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Storage and the project update — `projects.terminal`

**Files:**
- Modify:
  - `packages/storage-local/src/migrations.ts:40` (a new id after it) and `:574-575` (the new migration, last in the list);
  - `packages/storage-local/src/schema.ts:33`;
  - `packages/storage-local/src/repository.ts:3-18` (imports), `:129-140` (`toProject`), `:490-503` (`create`), `:539-563` (`update`);
  - `packages/engine/src/ports/repository.ts:1-20` (imports) and `:97-110` (`ProjectRepository.update`);
  - `packages/engine/src/graph/index.ts:68-72` and `:165-173` (`updateProject`);
  - `packages/engine/src/gateway/index.ts:469-478` (`PATCH /projects/:id`);
  - `packages/engine/src/__tests__/fake-repository.ts:264-279` (`projects.update`).
- Test:
  - create `packages/storage-local/src/__tests__/migration-forge-terminal.test.ts`;
  - modify the expected migration chains in `migration-round-3.test.ts` (two lists), `migration-round-4.test.ts`, `migration-round-5.test.ts`, `migration-x1.test.ts` and `migration-chat-sessions.test.ts`;
  - extend `packages/engine/src/__tests__/graph.test.ts`.

**Interfaces:**
- Consumes (Task 2): `TerminalTrust`, `TerminalTrustSchema`, `UpdateProjectRequest.terminal`.
- Produces:
  - `FORGE_TERMINAL_MIGRATION_ID = '20261010T120000_forge_terminal_trust'`;
  - `ProjectRepository.update(scope, id, patch: { name?, lastOpenedAt?, maxCostPerRunUsd?, terminal?: TerminalTrust, updatedAt })`;
  - `GraphService.updateProject(id, patch: { name?, maxCostPerRunUsd?, terminal? })`;
  - `PATCH /projects/:id` applies a patch that names only `terminal`. Stopping processes on `off` comes in Task 8.

- [ ] **Step 1: Write the failing storage test**

Create `packages/storage-local/src/__tests__/migration-forge-terminal.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../db.js';
import { FORGE_TERMINAL_MIGRATION_ID, MIGRATIONS } from '../migrations.js';
import { SqliteRepository } from '../repository.js';
import { makeProject, scope } from './fixtures.js';

const BEFORE = MIGRATIONS.slice(
  0,
  MIGRATIONS.findIndex((migration) => migration.id === FORGE_TERMINAL_MIGRATION_ID),
);
const PROJECT_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRJC';
const NOW = '2026-10-10T10:00:00.000Z';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-terminal-'));
  path = join(dir, 'ace.sqlite');
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows can hold the WAL a moment longer; the OS reclaims temp itself.
  }
});

describe('D301 migration: projects.terminal', () => {
  it('adds the column; a project stored before it reads back with no trust level, which means on', async () => {
    const before = openDatabase({ path, migrations: BEFORE });
    expect(before.appliedMigrations).not.toContain(FORGE_TERMINAL_MIGRATION_ID);
    before.sqlite
      .prepare(
        `INSERT INTO projects (id, workspace_id, name, folder_path, last_opened_at,
           max_cost_per_run_usd, created_at, updated_at)
         VALUES (?, ?, 'Old', 'D:/projects/old', NULL, NULL, ?, ?)`,
      )
      .run(PROJECT_ID, scope.workspaceId, NOW, NOW);
    before.sqlite.close();

    const after = openDatabase({ path });
    expect(after.appliedMigrations).toEqual([FORGE_TERMINAL_MIGRATION_ID]);
    const columns = (
      after.sqlite.prepare('PRAGMA table_info(projects)').all() as { name: string }[]
    ).map((column) => column.name);
    expect(columns).toContain('terminal');

    const read = await new SqliteRepository(after.db, after.sqlite).projects.get(scope, PROJECT_ID);
    expect(read).toMatchObject({ id: PROJECT_ID, name: 'Old' });
    expect(read).not.toHaveProperty('terminal');
    after.sqlite.close();
  });

  it('writes the trust level on create and on update, and a patch without it leaves it alone', async () => {
    const db = openDatabase({ path });
    const repository = new SqliteRepository(db.db, db.sqlite);
    const created = await repository.projects.create(scope, makeProject({ terminal: 'scripts' }));
    expect((await repository.projects.get(scope, created.id))?.terminal).toBe('scripts');

    await repository.projects.update(scope, created.id, { terminal: 'off', updatedAt: NOW });
    expect((await repository.projects.get(scope, created.id))?.terminal).toBe('off');

    await repository.projects.update(scope, created.id, { name: 'Renamed', updatedAt: NOW });
    expect(await repository.projects.get(scope, created.id)).toMatchObject({
      name: 'Renamed',
      terminal: 'off',
    });
    db.sqlite.close();
  });

  it('reads a stored value the contract does not name as no trust level, never as itself', async () => {
    const db = openDatabase({ path });
    const repository = new SqliteRepository(db.db, db.sqlite);
    const created = await repository.projects.create(scope, makeProject());
    db.sqlite.prepare('UPDATE projects SET terminal = ? WHERE id = ?').run('everything', created.id);
    expect(await repository.projects.get(scope, created.id)).not.toHaveProperty('terminal');
    db.sqlite.close();
  });
});
```

Then append `FORGE_TERMINAL_MIGRATION_ID` to every expected chain that lists the migrations after one under test, and import it from `'../migrations.js'` in each file:
- `migration-round-3.test.ts`, both `toEqual([...])` lists (around lines 100 and 269): after `CHAT_SESSIONS_CLI_MODELS_MIGRATION_ID,` add `FORGE_TERMINAL_MIGRATION_ID,`.
- `migration-round-4.test.ts` (around line 64): the same.
- `migration-round-5.test.ts` (around line 105): the same.
- `migration-x1.test.ts` (line 52): change the list to `[X1_CLI_PROVIDERS_MIGRATION_ID, CHAT_SESSIONS_CLI_MODELS_MIGRATION_ID, FORGE_TERMINAL_MIGRATION_ID]`.
- `migration-chat-sessions.test.ts` (line 53): change it to `[CHAT_SESSIONS_CLI_MODELS_MIGRATION_ID, FORGE_TERMINAL_MIGRATION_ID]`.

- [ ] **Step 2: Write the failing engine test**

In `packages/engine/src/__tests__/graph.test.ts`, inside `describe('TC-PRJ-001 Create project', …)`, after `it('renames a project', …)`, add:

```ts
  it('D301 stores the terminal trust level a PATCH sets, and refuses one it does not know', async () => {
    const project = await createProject(h.app, projectFolder());

    const scripts = ProjectSchema.parse(
      await body(await patch(h.app, `/api/v1/projects/${project.id}`, { terminal: 'scripts' })),
    );
    expect(scripts.terminal).toBe('scripts');
    const read = ProjectSchema.parse(await body(await get(h.app, `/api/v1/projects/${project.id}`)));
    expect(read.terminal).toBe('scripts');

    const refused = await patch(h.app, `/api/v1/projects/${project.id}`, { terminal: 'sometimes' });
    expect(refused.status).toBe(400);
    expect(ApiErrorSchema.parse(await body(refused)).error.code).toBe('validation_failed');
  });
```

- [ ] **Step 3: Run them to watch them fail**

Run: `pnpm --filter @ace/engine exec vitest run src/__tests__/graph.test.ts`
Expected: FAIL. The PATCH names only `terminal`, so the route's early return answers the project unchanged: `expected undefined to be 'scripts'`.

Run: `pnpm --filter @ace/storage-local exec vitest run src/__tests__/migration-forge-terminal.test.ts`
Expected: FAIL. `FORGE_TERMINAL_MIGRATION_ID` is not exported.

- [ ] **Step 4: The engine side**

In `packages/engine/src/ports/repository.ts`, add `TerminalTrust,` to the type import from `'@ace/contracts'` (after `Settings, SettingsPatch,`), and change `ProjectRepository.update`'s patch to:

```ts
    patch: {
      name?: string;
      lastOpenedAt?: Timestamp;
      /** Round 3 §2.3: the per-run cost cap. `null` removes it, `undefined` leaves it (D72). */
      maxCostPerRunUsd?: number | null;
      /** D301: the terminal trust level; `undefined` leaves it. */
      terminal?: TerminalTrust;
      updatedAt: Timestamp;
    },
```

In `packages/engine/src/graph/index.ts`, add `type TerminalTrust,` to the import from `'@ace/contracts'`, and change the interface method (lines 68-72) to:

```ts
  /**
   * `PATCH /projects/:id` — the whole patch, not only the name. `maxCostPerRunUsd: null` removes the
   * per-run cap and `undefined` leaves it alone, the way D72 reads a removed budget (FR-GRD-008).
   * `terminal` is the trust level (D301).
   */
  updateProject(
    id: Id,
    patch: { name?: string; maxCostPerRunUsd?: number | null; terminal?: TerminalTrust },
  ): Promise<Project>;
```

and the implementation (lines 165-173) to:

```ts
    async updateProject(id, patch) {
      const updated = await repository.projects.update(scope, id, {
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.maxCostPerRunUsd === undefined ? {} : { maxCostPerRunUsd: patch.maxCostPerRunUsd }),
        ...(patch.terminal === undefined ? {} : { terminal: patch.terminal }),
        updatedAt: now(),
      });
      if (updated === null) throw notFound(`Project ${id}`);
      return updated;
    },
```

In `packages/engine/src/gateway/index.ts`, change the `PATCH /projects/:id` route (lines 469-478) to:

```ts
  api.patch('/projects/:id', async (c) => {
    const patch = UpdateProjectRequestSchema.parse(await readJson(c));
    const id = c.req.param('id');
    // Every field of the patch, not just the name: `maxCostPerRunUsd` is the cap FR-GRD-008 halts a
    // run against, and `terminal` the trust level D301 starts processes by. Reading only `name`
    // here made the others unsettable through the API.
    if (
      patch.name === undefined &&
      patch.maxCostPerRunUsd === undefined &&
      patch.terminal === undefined
    ) {
      return c.json(await deps.graph.getProject(id));
    }
    return c.json(await deps.graph.updateProject(id, patch));
  });
```

In `packages/engine/src/__tests__/fake-repository.ts`, add `type TerminalTrust,` to the import from `'@ace/contracts'`, and change `projects.update` (lines 264-279) to:

```ts
    update: async (
      scope: Scope,
      id: Id,
      patch: {
        name?: string;
        lastOpenedAt?: Timestamp;
        terminal?: TerminalTrust;
        updatedAt: Timestamp;
      },
    ) => {
      const current = this.#for(scope).projects.get(id);
      if (current === undefined) return null;
      const next: Project = {
        ...current,
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.lastOpenedAt === undefined ? {} : { lastOpenedAt: patch.lastOpenedAt }),
        ...(patch.terminal === undefined ? {} : { terminal: patch.terminal }),
        updatedAt: patch.updatedAt,
      };
      this.#for(scope).projects.set(id, next);
      return next;
    },
```

- [ ] **Step 5: Run the engine test, then build the engine**

Run: `pnpm --filter @ace/engine exec vitest run src/__tests__/graph.test.ts && pnpm --filter @ace/engine build`
Expected: PASS, then a clean build. `@ace/storage-local` reads the new `ProjectRepository` type from there.

- [ ] **Step 6: The storage side**

In `packages/storage-local/src/migrations.ts`, after `CHAT_SESSIONS_CLI_MODELS_MIGRATION_ID` (line 40), add:

```ts

/** D301: a project's terminal trust level. Named so a test can apply the chain before it. */
export const FORGE_TERMINAL_MIGRATION_ID = '20261010T120000_forge_terminal_trust';
```

and append this entry as the last element of `MIGRATIONS`, after the chat-sessions entry (before the closing `];` at line 575):

```ts
  {
    id: FORGE_TERMINAL_MIGRATION_ID,
    up: `
      -- D301: how far the project trusts its terminal: 'on', 'scripts' or 'off'. NULL reads as
      -- 'on' (absent in the contract), so no row needs a backfill.
      ALTER TABLE projects ADD COLUMN terminal TEXT;
    `,
  },
```

In `packages/storage-local/src/schema.ts`, after the `maxCostPerRunUsd` column (line 33), add:

```ts
    /** D301: the terminal trust level, null when the project has none (it reads as `on`). */
    terminal: text('terminal'),
```

In `packages/storage-local/src/repository.ts`:

1. Add `TerminalTrustSchema,` after `THREAD_EVENT_TYPES,` and `type TerminalTrust,` after `type SettingsPatch,` in the import from `'@ace/contracts'`.
2. Replace `toProject` (lines 129-140) with:

```ts
/** D301: NULL, or anything the contract does not name, reads as no trust level — `on`. */
function terminalOf(value: string | null): TerminalTrust | undefined {
  const parsed = TerminalTrustSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function toProject(row: ProjectRow): Project {
  const terminal = terminalOf(row.terminal);
  return {
    id: row.id,
    name: row.name,
    folderPath: row.folderPath,
    ...(row.lastOpenedAt === null ? {} : { lastOpenedAt: row.lastOpenedAt }),
    // A cap that was never set and one that was removed read the same: no cap (D72).
    ...(row.maxCostPerRunUsd === null ? {} : { maxCostPerRunUsd: row.maxCostPerRunUsd }),
    ...(terminal === undefined ? {} : { terminal }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
```

3. In `projects.create`'s `.values({ … })`, after `maxCostPerRunUsd: project.maxCostPerRunUsd ?? null,` add `terminal: project.terminal ?? null,`.
4. In `projects.update`, add `terminal?: TerminalTrust;` to the patch type after `maxCostPerRunUsd?: number | null;`, and in `.set({ … })`, after the `maxCostPerRunUsd` spread, add:

```ts
          ...(patch.terminal === undefined ? {} : { terminal: patch.terminal }),
```

- [ ] **Step 7: Run the storage tests**

Run: `pnpm --filter @ace/storage-local exec vitest run src/__tests__/migration-forge-terminal.test.ts src/__tests__/migration-round-3.test.ts src/__tests__/migration-round-4.test.ts src/__tests__/migration-round-5.test.ts src/__tests__/migration-x1.test.ts src/__tests__/migration-chat-sessions.test.ts`
Expected: PASS.

- [ ] **Step 8: Full suites, build, commit**

Run: `pnpm --filter @ace/storage-local test && pnpm --filter @ace/storage-local build && pnpm --filter @ace/engine test`
Expected: PASS.

```bash
npx prettier --write --config packages/config/prettier.config.js packages/storage-local/src/__tests__/migration-forge-terminal.test.ts
git add packages/storage-local packages/engine
git commit -m "feat(storage-local,engine): a project's terminal trust level is stored and set by PATCH /projects/:id [D301]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 4: Engine port and tools runner — a supervised process on the platform shell

**Files:**
- Create: `packages/engine/src/ports/processes.ts`, `packages/tools/src/process/runner.ts`
- Modify:
  - `packages/engine/src/ports/index.ts:27` (export the port);
  - `packages/tools/src/sandbox/env.ts:60-65` (`SECRET_SHAPED` exported) and append `SCRUB_KEEP` and `scrubSecrets`;
  - `packages/tools/src/sandbox/runner.ts:40-55` (`killTree`'s `taskkill` gains `windowsHide: true`);
  - `packages/tools/src/index.ts:13-14` (export the runner).
- Test: create `packages/tools/src/process/runner.test.ts` and `packages/tools/src/sandbox/kill-tree.test.ts`; extend `packages/tools/src/sandbox/env.test.ts`.

**Interfaces:**
- Consumes:
  - from Task 2: `ProcessStream` from `@ace/contracts`;
  - existing: `WorkspaceFsError` and `isWorkspaceFsError` from `@ace/engine`, `toAbsolute(root, rel, { allowRoot })` from `tools/src/workspace/resolve.ts`, `killTree(pid, platform)` from `tools/src/sandbox/runner.ts`.
- Produces, in `@ace/engine` (`ports/processes.ts`), the names every later task uses:

  ```ts
  interface ProcessSpec { root: string; cwd: string; command: string; env?: Record<string, string> }
  interface ProcessHandlers {
    onOutput(stream: ProcessStream, chunk: string): void;
    onExit(code: number | null, signal: string | null): void;
    onError(error: Error): void;
  }
  interface RunningProcess { readonly pid: number | undefined; write(data: string): void; stop(): void }
  interface ProcessRunner { start(spec: ProcessSpec, handlers: ProcessHandlers): RunningProcess }
  ```

  Task 5 adds `scripts(root)` to `ProcessRunner`.
- Produces, in `@ace/tools`:
  - `SECRET_SHAPED: RegExp` (now exported), `SCRUB_KEEP: readonly string[]`, `scrubSecrets(env, platform?): Record<string, string>`;
  - `ProcessRunnerOptions { platform?, env?, shell? }`;
  - `createProcessRunner(options?): ProcessRunner`;
  - `resolveWorkingFolder(root, cwd): string`, which throws `WorkspaceFsError` `outside_project` / `protected_path` / `invalid_path`;
  - `shellCommand(command, platform, env, shell?): [string, string[]]`.
- Guarantees, which Task 6 relies on:
  - `start` throws a `WorkspaceFsError` for a refused working folder before anything is spawned;
  - otherwise the handlers are called in order: any number of `onOutput`, then exactly one of `onExit` or `onError`;
  - `onError` means it never started, and `pid` is `undefined` then;
  - after `stop()`, `onExit` follows within 1.5 s even when the kill does not take, with `(null, 'SIGKILL')` if the shell never reported.

- [ ] **Step 1: Write the port**

Create `packages/engine/src/ports/processes.ts`:

```ts
import type { ProcessStream } from '@ace/contracts';

/**
 * What the terminal asks to run (D301, design §6.3). The engine names the folder and the line; the
 * adapter — `createProcessRunner` in `@ace/tools` — confines `cwd` to `root` (FR-GIT-008), runs the
 * line through the platform shell with a scrubbed environment, and kills the whole tree on stop.
 */
export interface ProcessSpec {
  /** The project's folder, absolute. */
  root: string;
  /**
   * Project-relative; `''` is the root. The adapter refuses one that escapes the project, names
   * `.git`, or is not an existing folder, with a `WorkspaceFsError` thrown from `start`.
   */
  cwd: string;
  /** The line the person typed, or `<pm> run <script>`, run through the platform shell. */
  command: string;
  /** Extra variables for this one process, scrubbed like the inherited ones. */
  env?: Record<string, string>;
}

/** Called in order: any number of `onOutput`, then exactly one of `onExit` or `onError`. */
export interface ProcessHandlers {
  /** Decoded text. A multibyte character is never split across two calls. */
  onOutput(stream: ProcessStream, chunk: string): void;
  /** It ran and ended. `code` is null when a signal, or a stop, ended it. */
  onExit(code: number | null, signal: string | null): void;
  /** It never started: the shell could not be spawned. */
  onError(error: Error): void;
}

export interface RunningProcess {
  /** The shell's pid; `undefined` when it never started. */
  readonly pid: number | undefined;
  /** Writes to stdin. Ignored once the process has ended. */
  write(data: string): void;
  /** Kills the whole process tree. `onExit` follows within 1.5 s, even if the kill does not take. */
  stop(): void;
}

/** The terminal's process runner (D301). `apps/server` wires `@ace/tools`' adapter in. */
export interface ProcessRunner {
  /** Throws a `WorkspaceFsError` for a refused `cwd`, before anything is spawned. */
  start(spec: ProcessSpec, handlers: ProcessHandlers): RunningProcess;
}
```

In `packages/engine/src/ports/index.ts`, after `export * from './workspace.js';`, add:

```ts
export * from './processes.js';
```

Then build the engine, because `@ace/tools` reads the port from `dist`:

Run: `pnpm --filter @ace/engine build`
Expected: a clean build.

- [ ] **Step 2: Write the failing tests**

Append to `packages/tools/src/sandbox/env.test.ts`. Add `SCRUB_KEEP`, `SECRET_SHAPED` and `scrubSecrets` to its import from `'./env.js'`, then append:

```ts
describe('D301 scrubSecrets — a terminal process gets the engine’s environment minus its secrets', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/ada',
    LANG: 'en_GB.UTF-8',
    ANTHROPIC_API_KEY: 'not-a-real-key',
    AWS_SECRET_ACCESS_KEY: 'not-a-real-secret',
    ACE_SESSION_TOKEN: 'not-a-real-token',
    GITHUB_TOKEN: 'not-a-real-token',
    DB_PASSWORD: 'not-a-real-password',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    SSH_AGENT_PID: '42',
    XAUTHORITY: '/home/ada/.Xauthority',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    SESSIONNAME: 'Console',
    UNSET: undefined,
  };

  it('keeps what does not look like a secret, and the five sockets and paths that only look like one', () => {
    expect(scrubSecrets(source, 'linux')).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/ada',
      LANG: 'en_GB.UTF-8',
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
      SSH_AGENT_PID: '42',
      XAUTHORITY: '/home/ada/.Xauthority',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      SESSIONNAME: 'Console',
      FORCE_COLOR: '1',
    });
  });

  it('needs the exception list: each kept socket name but one matches the secret rule', () => {
    expect(SECRET_SHAPED.source).toBe('KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|SESSION|AUTH|COOKIE');
    expect([...SCRUB_KEEP]).toEqual([
      'SSH_AUTH_SOCK',
      'SSH_AGENT_PID',
      'XAUTHORITY',
      'DBUS_SESSION_BUS_ADDRESS',
      'SESSIONNAME',
    ]);
    expect(SCRUB_KEEP.filter((name) => SECRET_SHAPED.test(name))).toEqual([
      'SSH_AUTH_SOCK',
      'XAUTHORITY',
      'DBUS_SESSION_BUS_ADDRESS',
      'SESSIONNAME',
    ]);
  });

  it('matches the kept names case-insensitively on Windows only', () => {
    expect(scrubSecrets({ SessionName: 'Console' }, 'win32')).toEqual({
      SessionName: 'Console',
      FORCE_COLOR: '1',
    });
    expect(scrubSecrets({ SessionName: 'Console' }, 'linux')).toEqual({ FORCE_COLOR: '1' });
  });

  it('sets FORCE_COLOR=1 even over an inherited 0', () => {
    expect(scrubSecrets({ FORCE_COLOR: '0' }, 'linux').FORCE_COLOR).toBe('1');
  });
});
```

Create `packages/tools/src/sandbox/kill-tree.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { killTree } from './runner.js';

const spawned = vi.hoisted(
  () => [] as Array<{ command: string; args: readonly string[]; options: unknown }>,
);

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: readonly string[], options: unknown) => {
    spawned.push({ command, args, options });
    return { on: () => undefined };
  },
}));

describe('D301 killTree on Windows', () => {
  it('runs taskkill on the whole tree with no console window flashing up', () => {
    killTree(4321, 'win32');
    expect(spawned).toEqual([
      {
        command: 'taskkill',
        args: ['/pid', '4321', '/T', '/F'],
        options: { stdio: 'ignore', windowsHide: true },
      },
    ]);
  });
});
```

Create `packages/tools/src/process/runner.test.ts`:

```ts
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProcessStream } from '@ace/contracts';
import { isWorkspaceFsError, type ProcessHandlers, type ProcessRunner } from '@ace/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProcessRunner, shellCommand } from './runner.js';

let root: string;
let project: string;
const stops: Array<() => void> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ace-proc-'));
  project = join(root, 'demo project');
  mkdirSync(join(project, 'src'), { recursive: true });
});
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

/** A `node -e` command line that survives both cmd.exe and /bin/sh. */
const node = (script: string) => `"${process.execPath}" -e "${script}"`;

type Event =
  | [stream: ProcessStream, chunk: string]
  | [kind: 'exit', code: number | null, signal: string | null]
  | [kind: 'error', message: string];

/** Handlers that record every call, with a promise for the end and the text of each stream. */
function collect() {
  const events: Event[] = [];
  let end: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  const handlers: ProcessHandlers = {
    onOutput: (stream, chunk) => events.push([stream, chunk]),
    onExit: (code, signal) => {
      events.push(['exit', code, signal]);
      end();
    },
    onError: (error) => {
      events.push(['error', error.message]);
      end();
    },
  };
  const text = (stream: ProcessStream = 'stdout'): string =>
    events
      .filter((event) => event[0] === stream)
      .map((event) => String(event[1]))
      .join('')
      .replace(/\r/g, '');
  return { events, handlers, ended, text };
}

const runner = createProcessRunner();

function start(command: string, cwd = '', using: ProcessRunner = runner) {
  const run = collect();
  const handle = using.start({ root: project, cwd, command }, run.handlers);
  stops.push(() => handle.stop());
  return { ...run, handle };
}

/** The refusal code `start` throws for a working folder, or undefined when it starts. */
function refusalFor(cwd: string): string | undefined {
  try {
    const handle = runner.start({ root: project, cwd, command: node('1') }, collect().handlers);
    stops.push(() => handle.stop());
  } catch (error) {
    return isWorkspaceFsError(error) ? error.code : 'not a WorkspaceFsError';
  }
  return undefined;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

describe('D301 the platform shell, exactly as run_command spawns it', () => {
  it('wraps the line for cmd.exe /d /s /c on Windows and /bin/sh -c elsewhere', () => {
    expect(shellCommand('a && b', 'win32', { ComSpec: 'C:\\Windows\\system32\\cmd.exe' })).toEqual([
      'C:\\Windows\\system32\\cmd.exe',
      ['/d', '/s', '/c', '"a && b"'],
    ]);
    expect(shellCommand('a && b', 'win32', {})).toEqual(['cmd.exe', ['/d', '/s', '/c', '"a && b"']]);
    expect(shellCommand('a && b', 'linux', {})).toEqual(['/bin/sh', ['-c', 'a && b']]);
    expect(shellCommand('a', 'linux', {}, '/opt/sh')).toEqual(['/opt/sh', ['-c', 'a']]);
  });
});

describe('D301 the terminal’s process runner', () => {
  it('streams output in order and reports the exit code after the last of it', async () => {
    const run = start(
      node(
        "let i = 0; const t = setInterval(() => { console.log('tick ' + i); i += 1; if (i === 3) clearInterval(t); }, 30)",
      ),
    );
    await run.ended;
    expect(run.text()).toBe('tick 0\ntick 1\ntick 2\n');
    expect(run.events.at(-1)).toEqual(['exit', 0, null]);
  });

  it('keeps stdout and stderr apart and reports a failing exit code', async () => {
    const run = start(node("console.error('bad'); process.exit(3)"));
    await run.ended;
    expect(run.text('stderr')).toBe('bad\n');
    expect(run.text('stdout')).toBe('');
    expect(run.events.at(-1)).toEqual(['exit', 3, null]);
  });

  it('writes what the person types to stdin, so a line prompt is answered', async () => {
    const run = start(
      node(
        "process.stdout.write('name? '); process.stdin.once('data', (d) => { console.log('hello ' + String(d).trim()); process.exit(0); })",
      ),
    );
    expect(await until(() => run.text().includes('name? '), 10_000)).toBe(true);
    run.handle.write('Ada\n');
    await run.ended;
    expect(run.text()).toBe('name? hello Ada\n');
  });

  it('Stop kills the shell, its child and its grandchild within 2.5 s', async () => {
    const run = start(
      node(
        "require('child_process').spawn(process.execPath, ['-e', 'console.log([process.pid]); setInterval(() => {}, 1000)'], { stdio: 'inherit' }); console.log('parent ' + process.pid); setInterval(() => {}, 1000)",
      ),
    );
    expect(
      await until(() => /parent \d+/.test(run.text()) && /\[ \d+ \]/.test(run.text()), 10_000),
    ).toBe(true);
    const parent = Number(/parent (\d+)/.exec(run.text())?.[1]);
    const grandchild = Number(/\[ (\d+) \]/.exec(run.text())?.[1]);
    expect(isAlive(parent)).toBe(true);
    expect(isAlive(grandchild)).toBe(true);

    const stoppedAt = Date.now();
    run.handle.stop();
    await run.ended;
    expect(run.events.at(-1)?.[0]).toBe('exit');
    expect(await until(() => !isAlive(parent) && !isAlive(grandchild), 2_500)).toBe(true);
    expect(Date.now() - stoppedAt).toBeLessThan(2_500);
  }, 20_000);

  it('never splits a character or an ANSI colour across chunks', async () => {
    // é, ✓ and 😀 are 2, 3 and 4 bytes of UTF-8; each write ends inside one of them, and the
    // fourth inside the colour escape.
    const run = start(
      node(
        "const b = Buffer.from('h\\u00e9 \\u2713 \\ud83d\\ude00 \\u001b[31mred\\u001b[0m\\n'); const cuts = [2, 6, 10, 14]; let at = 0; const next = () => { const end = cuts.shift() ?? b.length; process.stdout.write(b.subarray(at, end)); at = end; if (at < b.length) setTimeout(next, 40); }; next()",
      ),
    );
    await run.ended;
    expect(run.text()).toBe('h\u00e9 \u2713 \ud83d\ude00 \u001b[31mred\u001b[0m\n');
    expect(run.text()).not.toContain('\ufffd');
  });

  it('a process never sees a secret-shaped variable, but keeps SSH_AUTH_SOCK, PATH and HOME', async () => {
    const scrubbing = createProcessRunner({
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: 'sk-ant-not-real',
        ACE_SESSION_TOKEN: 'not-real',
        SSH_AUTH_SOCK: '/tmp/agent.sock',
        HOME: '/home/ada',
      },
    });
    const run = start(
      node(
        "console.log(JSON.stringify({ key: process.env.ANTHROPIC_API_KEY || null, token: process.env.ACE_SESSION_TOKEN || null, sock: process.env.SSH_AUTH_SOCK || null, home: process.env.HOME || null, path: (process.env.PATH || '').length > 0, color: process.env.FORCE_COLOR || null }))",
      ),
      '',
      scrubbing,
    );
    await run.ended;
    expect(JSON.parse(run.text())).toEqual({
      key: null,
      token: null,
      sock: '/tmp/agent.sock',
      home: '/home/ada',
      path: true,
      color: '1',
    });
  });

  it('runs a line as the shell would: quotes, &&, | and a variable', async () => {
    const variable = process.platform === 'win32' ? '%ACE_DEMO_VAR%' : '$ACE_DEMO_VAR';
    const withVariable = createProcessRunner({ env: { ...process.env, ACE_DEMO_VAR: 'from-env' } });
    const upper = node(
      "process.stdin.on('data', (d) => process.stdout.write(String(d).toUpperCase()))",
    );
    const line = `${node("console.log('a & b')")} && ${node("console.log('piped')")} | ${upper} && echo ${variable}`;
    const run = start(line, '', withVariable);
    await run.ended;
    expect(
      run
        .text()
        .split('\n')
        .map((each) => each.trim())
        .filter(Boolean),
    ).toEqual(['a & b', 'PIPED', 'from-env']);
    expect(run.events.at(-1)).toEqual(['exit', 0, null]);
  });

  it('runs in a folder whose name has spaces and unicode', async () => {
    mkdirSync(join(project, 'my dir ü'));
    const run = start(node('console.log(process.cwd())'), 'my dir ü');
    await run.ended;
    expect(realpathSync(run.text().trim())).toBe(realpathSync(join(project, 'my dir ü')));
  });

  it('runs in the project folder itself when the working folder is empty', async () => {
    const run = start(node('console.log(process.cwd())'));
    await run.ended;
    expect(realpathSync(run.text().trim())).toBe(realpathSync(project));
  });

  it('refuses a folder outside the project, .git and a link out, as a file read would (FR-GIT-008)', () => {
    mkdirSync(join(project, '.git'));
    const outside = join(root, 'outside');
    mkdirSync(outside);
    // a junction needs no privilege on Windows; elsewhere the type argument is ignored
    symlinkSync(outside, join(project, 'out'), 'junction');

    expect(refusalFor('..')).toBe('outside_project');
    expect(refusalFor('src/../..')).toBe('outside_project');
    expect(refusalFor('C:/Windows')).toBe('outside_project');
    expect(refusalFor('.git')).toBe('protected_path');
    expect(refusalFor('out')).toBe('outside_project');
    expect(refusalFor('src')).toBeUndefined();
  });

  it('refuses a folder that does not exist, and a file, as invalid_path', () => {
    writeFileSync(join(project, 'README.md'), '# hi');
    expect(refusalFor('missing')).toBe('invalid_path');
    expect(refusalFor('README.md')).toBe('invalid_path');
  });

  it('reports a shell that cannot start to onError, never onExit', async () => {
    const broken = createProcessRunner({ shell: join(root, 'no-such-shell') });
    const run = start(node('1'), '', broken);
    await run.ended;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(run.events).toHaveLength(1);
    expect(run.events[0]?.[0]).toBe('error');
    expect(String(run.events[0]?.[1])).toMatch(/ENOENT/);
    expect(run.handle.pid).toBeUndefined();
  });

  it('drops input once the process has ended, without throwing', async () => {
    const run = start(node('1'));
    await run.ended;
    expect(() => run.handle.write('late\n')).not.toThrow();
    expect(() => run.handle.stop()).not.toThrow();
  });
});
```

- [ ] **Step 3: Run them to watch them fail**

Run: `pnpm --filter @ace/tools exec vitest run src/process/runner.test.ts src/sandbox/env.test.ts src/sandbox/kill-tree.test.ts`
Expected: FAIL. `./runner.js` does not exist, `scrubSecrets` and `SCRUB_KEEP` are not exported, and `killTree`'s options lack `windowsHide`.

- [ ] **Step 4: The environment and the kill**

In `packages/tools/src/sandbox/env.ts`, change line 65 from `const SECRET_SHAPED = …` to:

```ts
export const SECRET_SHAPED = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|SESSION|AUTH|COOKIE/i;
```

and append to the end of the file:

```ts

/**
 * Names kept although some match {@link SECRET_SHAPED}: they hold sockets and paths, never a
 * secret's value, and git over ssh needs the agent (D301 decision 3).
 */
export const SCRUB_KEEP: readonly string[] = [
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'SESSIONNAME',
];

/**
 * The environment a terminal process gets (D301, design §6.3): the engine's own, minus every name
 * that looks like a secret, so `ANTHROPIC_API_KEY` and the engine's `ACE_*TOKEN` never reach a
 * command a person typed. Unlike {@link sandboxEnv} this is a deny rule, not an allow-list: a
 * person's toolchain needs `PATH`, `HOME` and whatever else their shell set. Names compare
 * case-insensitively on Windows, as Windows reads them. `FORCE_COLOR=1` asks for colour, which the
 * terminal renders.
 */
export function scrubSecrets(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const fold = (name: string): string => (platform === 'win32' ? name.toUpperCase() : name);
  const keep = new Set(SCRUB_KEEP.map(fold));
  const scrubbed: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (SECRET_SHAPED.test(name) && !keep.has(fold(name))) continue;
    scrubbed[name] = value;
  }
  scrubbed.FORCE_COLOR = '1';
  return scrubbed;
}
```

In `packages/tools/src/sandbox/runner.ts`, in `killTree`, change the Windows line:

```ts
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => undefined);
```

to:

```ts
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        // No console window flashes up for the kill (D301), as the providers' copy already does.
        windowsHide: true,
      }).on('error', () => undefined);
```

- [ ] **Step 5: The runner**

Create `packages/tools/src/process/runner.ts`:

```ts
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

import type { ProcessStream } from '@ace/contracts';
import {
  WorkspaceFsError,
  type ProcessHandlers,
  type ProcessRunner,
  type RunningProcess,
} from '@ace/engine';

import { scrubSecrets } from '../sandbox/env.js';
import { killTree } from '../sandbox/runner.js';
import { toAbsolute } from '../workspace/resolve.js';

/**
 * The terminal's process runner (D301, design §6.3): one line a person typed, run through the
 * platform shell in a folder confined to the project, with stdin open for prompts and REPL lines,
 * output decoded as UTF-8 across chunk boundaries, and the whole tree killed on Stop. There is no
 * TTY (design §14): full-screen programs do not render, line prompts work.
 *
 * Like `run_command`, a run ends when the shell exits, not when its output closes: something the
 * command left running holds the pipes and would otherwise hold the run open forever.
 */

/** After the shell exits, how long its last output may take to arrive before the pipes are dropped. */
const EXIT_DRAIN_MS = 300;
/** After a stop, how long to wait for the shell to go before reporting the end anyway. */
const KILL_SETTLE_MS = 1_500;

export interface ProcessRunnerOptions {
  platform?: NodeJS.Platform;
  /** What a process inherits before scrubbing. Default: the engine's own, read at each start. */
  env?: Record<string, string | undefined>;
  /** The shell binary. Default: `ComSpec` (else `cmd.exe`) on Windows, `/bin/sh` elsewhere. */
  shell?: string;
}

/**
 * Where a process runs (FR-GIT-008, D301 decision 4): confined exactly as a file read is — `..`,
 * absolute and drive paths, links out and `.git` are refused — and an existing folder.
 */
export function resolveWorkingFolder(root: string, cwd: string): string {
  const absolute = toAbsolute(root, cwd, { allowRoot: true });
  let isFolder = false;
  try {
    isFolder = statSync(absolute).isDirectory();
  } catch {
    isFolder = false;
  }
  if (!isFolder) {
    throw new WorkspaceFsError(
      'invalid_path',
      cwd === '' ? 'The project folder is missing.' : `${cwd} is not a folder in the project.`,
      { path: cwd },
    );
  }
  return absolute;
}

/** The platform shell and its arguments, exactly as `run_command` spawns them (D301 decision 2). */
export function shellCommand(
  command: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  shell?: string,
): [string, string[]] {
  // cmd.exe /s strips exactly the outer quotes we add, so the line runs as written.
  return platform === 'win32'
    ? [shell ?? env['ComSpec'] ?? env['COMSPEC'] ?? 'cmd.exe', ['/d', '/s', '/c', `"${command}"`]]
    : [shell ?? '/bin/sh', ['-c', command]];
}

function spawnShell(
  shell: string,
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  platform: NodeJS.Platform,
) {
  return spawn(shell, argv, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: platform === 'win32',
    // POSIX: lead a process group so one kill reaches everything the command started.
    detached: platform !== 'win32',
  });
}

type ShellChild = ReturnType<typeof spawnShell>;

const NOT_STARTED: RunningProcess = { pid: undefined, write: () => undefined, stop: () => undefined };

export function createProcessRunner(options: ProcessRunnerOptions = {}): ProcessRunner {
  const platform = options.platform ?? process.platform;
  return {
    start(spec, handlers) {
      const cwd = resolveWorkingFolder(spec.root, spec.cwd);
      const source = options.env ?? process.env;
      const env = scrubSecrets({ ...source, ...(spec.env ?? {}) }, platform);
      const [shell, argv] = shellCommand(spec.command, platform, source, options.shell);
      let child: ShellChild;
      try {
        child = spawnShell(shell, argv, cwd, env, platform);
      } catch (error) {
        // An argument Node refuses outright: still "never started", and still said asynchronously.
        const reason = error instanceof Error ? error : new Error(String(error));
        queueMicrotask(() => handlers.onError(reason));
        return NOT_STARTED;
      }
      return supervise(child, handlers, platform);
    },
  };
}

function supervise(
  child: ShellChild,
  handlers: ProcessHandlers,
  platform: NodeJS.Platform,
): RunningProcess {
  const decoders: Record<ProcessStream, StringDecoder> = {
    stdout: new StringDecoder('utf8'),
    stderr: new StringDecoder('utf8'),
  };
  const timers: NodeJS.Timeout[] = [];
  let settled = false;

  const say = (stream: ProcessStream, text: string): void => {
    if (!settled && text !== '') handlers.onOutput(stream, text);
  };

  const finish = (report: () => void): void => {
    if (settled) return;
    // A character the last chunk cut in half is said (as U+FFFD) rather than lost.
    say('stdout', decoders.stdout.end());
    say('stderr', decoders.stderr.end());
    settled = true;
    for (const timer of timers) clearTimeout(timer);
    child.stdout.destroy();
    child.stderr.destroy();
    child.stdin.destroy();
    report();
  };

  child.stdout.on('data', (chunk: Buffer) => say('stdout', decoders.stdout.write(chunk)));
  child.stderr.on('data', (chunk: Buffer) => say('stderr', decoders.stderr.write(chunk)));
  // EPIPE once the process is gone: input to a finished process is dropped, never thrown.
  child.stdin.on('error', () => undefined);
  child.on('error', (error) => {
    // Only a spawn failure means "never started"; any later error is followed by exit or close.
    if (child.pid === undefined) finish(() => handlers.onError(error));
  });
  child.on('exit', (code, signal) => {
    timers.push(setTimeout(() => finish(() => handlers.onExit(code, signal)), EXIT_DRAIN_MS));
  });
  child.on('close', (code, signal) => finish(() => handlers.onExit(code, signal)));

  return {
    pid: child.pid,
    write(data) {
      if (!settled && child.stdin.writable) child.stdin.write(data);
    },
    stop() {
      if (settled) return;
      if (child.pid !== undefined) killTree(child.pid, platform);
      // A shell that outlives its kill must not leave the run open.
      timers.push(setTimeout(() => finish(() => handlers.onExit(null, 'SIGKILL')), KILL_SETTLE_MS));
    },
  };
}
```

In `packages/tools/src/index.ts`, after `export * from './workspace/project-files.js';`, add:

```ts
/* D301: the terminal's supervised processes. */
export * from './process/runner.js';
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @ace/tools exec vitest run src/process/runner.test.ts src/sandbox/env.test.ts src/sandbox/kill-tree.test.ts`
Expected: PASS. The tree-kill test takes about a second; the whole file under 15 s.

If the tree-kill test fails on Windows because the grandchild survives, confirm with `tasklist /FI "PID eq <pid>"`. Fix the runner, never the test: the grandchild must die.

- [ ] **Step 7: Full suites, typecheck, build, commit**

Run: `pnpm --filter @ace/tools test && pnpm --filter @ace/tools typecheck && pnpm --filter @ace/tools build && pnpm --filter @ace/engine test`
Expected: PASS.

```bash
npx prettier --write --config packages/config/prettier.config.js packages/engine/src/ports/processes.ts packages/tools/src/process packages/tools/src/sandbox/kill-tree.test.ts packages/tools/src/sandbox/env.ts packages/tools/src/sandbox/env.test.ts
git add packages/engine/src/ports packages/tools
git commit -m "feat(tools): a supervised process runner — the platform shell, a confined folder, a scrubbed environment, tree kill [D301] [FR-GIT-008]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Tools — the project's own scripts and their package manager

**Files:**
- Create: `packages/tools/src/process/scripts.ts`
- Modify:
  - `packages/engine/src/ports/processes.ts` (`ProcessRunner.scripts`);
  - `packages/tools/src/process/runner.ts` (`createProcessRunner` answers `scripts`);
  - `packages/tools/src/index.ts` (export the reader).
- Test: create `packages/tools/src/process/scripts.test.ts`.

**Interfaces:**
- Consumes:
  - from Task 2: `PACKAGE_MANAGERS`, `PackageManager`, `ProjectScript`, `ProjectScripts`;
  - from Task 4: `ProcessRunner`, `createProcessRunner`;
  - existing: `toAbsolute` from `tools/src/workspace/resolve.ts`.
- Produces:
  - **This plan's choice (D301 decision 9):** the reader goes on the same port as `start`, as `ProcessRunner.scripts(root: string): Promise<ProjectScripts>`. One port, one wiring line in the server, one fake in the engine's tests.
  - `readProjectScripts(root: string): Promise<ProjectScripts>`; it never throws.
  - `LOCKFILES: ReadonlyArray<readonly [file: string, manager: PackageManager]>`, in the order they are read.

- [ ] **Step 1: Write the failing tests**

Create `packages/tools/src/process/scripts.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProcessRunner } from './runner.js';
import { LOCKFILES, readProjectScripts } from './scripts.js';

/** A file symlink needs a privilege on Windows; without it the link test is skipped. */
const canFileSymlink = ((): boolean => {
  const dir = mkdtempSync(join(tmpdir(), 'ace-link-probe-'));
  try {
    writeFileSync(join(dir, 't'), '');
    symlinkSync(join(dir, 't'), join(dir, 'l'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

let root: string;
let project: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ace-scripts-'));
  project = join(root, 'demo project');
  mkdirSync(project);
});
afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));

const put = (name: string, text: string) => writeFileSync(join(project, name), text);
const manifest = (body: Record<string, unknown>) => put('package.json', JSON.stringify(body));
const managerOf = async () => (await readProjectScripts(project)).packageManager;

describe('D301 the project’s own scripts (design §6.3)', () => {
  it('lists the root package.json scripts in file order, skipping anything that is not a command', async () => {
    manifest({ scripts: { dev: 'vite', build: 'tsc && vite build', odd: 3 } });
    expect(await readProjectScripts(project)).toEqual({
      packageManager: 'npm',
      scripts: [
        { name: 'dev', command: 'vite' },
        { name: 'build', command: 'tsc && vite build' },
      ],
    });
  });

  it('reads the lockfiles in D301’s order', () => {
    expect(LOCKFILES.map(([file, manager]) => `${file}:${manager}`)).toEqual([
      'pnpm-lock.yaml:pnpm',
      'yarn.lock:yarn',
      'bun.lock:bun',
      'bun.lockb:bun',
      'package-lock.json:npm',
    ]);
  });

  it.each(LOCKFILES.map(([file, manager]) => [file, manager] as const))(
    'reads %s as %s',
    async (lockfile, manager) => {
      manifest({ scripts: {} });
      put(lockfile, '');
      expect(await managerOf()).toBe(manager);
    },
  );

  it('prefers pnpm, then yarn, then bun, then npm, when several lockfiles are there', async () => {
    manifest({});
    put('package-lock.json', '{}');
    put('bun.lockb', '');
    expect(await managerOf()).toBe('bun');
    put('yarn.lock', '');
    expect(await managerOf()).toBe('yarn');
    put('pnpm-lock.yaml', '');
    expect(await managerOf()).toBe('pnpm');
  });

  it('takes the packageManager field first, ignoring its version and hash', async () => {
    manifest({ packageManager: 'pnpm@9.15.9+sha512.abc' });
    put('yarn.lock', '');
    expect(await managerOf()).toBe('pnpm');
  });

  it('falls through to the lockfiles for a manager D301 does not name', async () => {
    manifest({ packageManager: 'deno@2.0.0' });
    put('yarn.lock', '');
    expect(await managerOf()).toBe('yarn');
  });

  it('is npm with neither a field nor a lockfile', async () => {
    manifest({ scripts: { test: 'vitest' } });
    expect(await managerOf()).toBe('npm');
  });

  it('answers an empty list, never an error, with no package.json, a broken one, or a folder of that name', async () => {
    expect(await readProjectScripts(project)).toEqual({ packageManager: 'npm', scripts: [] });
    put('package.json', '{ "scripts": ');
    expect(await readProjectScripts(project)).toEqual({ packageManager: 'npm', scripts: [] });
    rmSync(join(project, 'package.json'));
    mkdirSync(join(project, 'package.json'));
    expect(await readProjectScripts(project)).toEqual({ packageManager: 'npm', scripts: [] });
  });

  it('reads a package.json that starts with a byte-order mark', async () => {
    put('package.json', '\uFEFF{"scripts":{"test":"vitest"}}');
    expect((await readProjectScripts(project)).scripts).toEqual([{ name: 'test', command: 'vitest' }]);
  });

  it('reads only the root package.json, never a nested one', async () => {
    mkdirSync(join(project, 'web'));
    writeFileSync(join(project, 'web', 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    expect((await readProjectScripts(project)).scripts).toEqual([]);
  });

  it.skipIf(!canFileSymlink)(
    'never reads a package.json linked from outside the project (FR-GIT-008)',
    async () => {
      const outside = join(root, 'outside.json');
      writeFileSync(outside, JSON.stringify({ scripts: { leak: 'cat ~/.ssh/id_rsa' } }));
      symlinkSync(outside, join(project, 'package.json'), 'file');
      expect(await readProjectScripts(project)).toEqual({ packageManager: 'npm', scripts: [] });
    },
  );

  it('is what the runner answers for scripts(root)', async () => {
    manifest({ scripts: { dev: 'vite' } });
    put('pnpm-lock.yaml', '');
    expect(await createProcessRunner().scripts(project)).toEqual({
      packageManager: 'pnpm',
      scripts: [{ name: 'dev', command: 'vite' }],
    });
  });
});
```

- [ ] **Step 2: Run them to watch them fail**

Run: `pnpm --filter @ace/tools exec vitest run src/process/scripts.test.ts`
Expected: FAIL. `./scripts.js` does not exist, and the runner has no `scripts`.

- [ ] **Step 3: The port gains `scripts`**

In `packages/engine/src/ports/processes.ts`, change the contracts import to `import type { ProcessStream, ProjectScripts } from '@ace/contracts';` and change `ProcessRunner` to:

```ts
/** The terminal's process runner (D301). `apps/server` wires `@ace/tools`' adapter in. */
export interface ProcessRunner {
  /** Throws a `WorkspaceFsError` for a refused `cwd`, before anything is spawned. */
  start(spec: ProcessSpec, handlers: ProcessHandlers): RunningProcess;
  /**
   * The root package.json's scripts and the package manager they run with (D301 decision 9). It
   * never throws: no package.json, an unparsable one, or one linked from outside is an empty list.
   */
  scripts(root: string): Promise<ProjectScripts>;
}
```

Run: `pnpm --filter @ace/engine build`
Expected: a clean build.

- [ ] **Step 4: The reader**

Create `packages/tools/src/process/scripts.ts`:

```ts
import { readFile, stat } from 'node:fs/promises';

import {
  PACKAGE_MANAGERS,
  type PackageManager,
  type ProjectScript,
  type ProjectScripts,
} from '@ace/contracts';

import { toAbsolute } from '../workspace/resolve.js';

/**
 * The project's own scripts for the terminal's script buttons and its `scripts` trust level
 * (D301, design §6.3): the root package.json's `scripts`, and the package manager they run with —
 * the `packageManager` field first, then the lockfiles in this order, then npm.
 */
export const LOCKFILES: ReadonlyArray<readonly [file: string, manager: PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
];

/** A file in the project root, read only when it resolves inside the project (FR-GIT-008). */
async function rootText(root: string, name: string): Promise<string | undefined> {
  try {
    return await readFile(toAbsolute(root, name), 'utf8');
  } catch {
    // Missing, a folder, unreadable, or a link out of the project: no answer, never an error.
    return undefined;
  }
}

async function rootFileExists(root: string, name: string): Promise<boolean> {
  try {
    return (await stat(toAbsolute(root, name))).isFile();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `"pnpm@9.15.9+sha512.…"` → `pnpm`. A manager D301 does not name is no answer. */
function managerNamed(field: unknown): PackageManager | undefined {
  if (typeof field !== 'string') return undefined;
  const name = field.split('@')[0]?.trim();
  return PACKAGE_MANAGERS.find((manager) => manager === name);
}

function parsed(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    // A byte-order mark is legal in a file and fatal to JSON.parse.
    return JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
  } catch {
    return undefined;
  }
}

export async function readProjectScripts(root: string): Promise<ProjectScripts> {
  const manifest = parsed(await rootText(root, 'package.json'));
  const scripts: ProjectScript[] = [];
  if (isRecord(manifest) && isRecord(manifest['scripts'])) {
    for (const [name, command] of Object.entries(manifest['scripts'])) {
      if (typeof command === 'string') scripts.push({ name, command });
    }
  }
  let packageManager = isRecord(manifest) ? managerNamed(manifest['packageManager']) : undefined;
  for (const [file, manager] of LOCKFILES) {
    if (packageManager !== undefined) break;
    if (await rootFileExists(root, file)) packageManager = manager;
  }
  return { packageManager: packageManager ?? 'npm', scripts };
}
```

In `packages/tools/src/process/runner.ts`, add `import { readProjectScripts } from './scripts.js';` after the `../workspace/resolve.js` import, and in `createProcessRunner`'s returned object, after `start(spec, handlers) { … },`, add:

```ts
    scripts: (root) => readProjectScripts(root),
```

In `packages/tools/src/index.ts`, after `export * from './process/runner.js';`, add:

```ts
export * from './process/scripts.js';
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @ace/tools exec vitest run src/process`
Expected: PASS.

- [ ] **Step 6: Full suite, build, commit**

Run: `pnpm --filter @ace/tools test && pnpm --filter @ace/tools build`
Expected: PASS.

```bash
npx prettier --write --config packages/config/prettier.config.js packages/tools/src/process packages/engine/src/ports/processes.ts
git add packages/tools packages/engine/src/ports/processes.ts
git commit -m "feat(tools): the project's own scripts and the package manager they run with [D301] [FR-GIT-008]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 6: Engine — `ProcessService`: trust, the limit, the kept output, the frames

**Files:**
- Create:
  - `packages/engine/src/processes/errors.ts`;
  - `packages/engine/src/processes/service.ts`;
  - `packages/engine/src/processes/__tests__/fake-runner.ts`.
- Test: create `packages/engine/src/processes/__tests__/service.test.ts`; extend `packages/engine/src/__tests__/events.test.ts`.

**Interfaces:**
- Consumes:
  - from Task 2: `DEFAULT_TERMINAL_TRUST`, `PROCESS_*` limits, `ProcessStartRequest`, `ProcessStartResponse`, `ProcessSummary`, `ProcessDetail`, `ProjectScripts`, `ProcessOutputPayload`, `ProcessExitedPayload`, and the four error codes;
  - from Task 4–5: `ProcessRunner`, `ProcessHandlers`, `RunningProcess`, `ProcessSpec`;
  - existing: `createBatcher`, `EventBus.emitTransient`, `HttpError`, `notFound`, `invalidPath`, `newId`, `Repository.projects.get`, `FakeRepository`, `InProcessPubSubStub`.
- Produces:
  - from `processes/errors.ts`: `terminalDisabled()`, `terminalRestricted()`, `processLimit(max)`, `processNotRunning(processId)`, `unsafeScriptName(name)`, each an `HttpError`. Their messages are what a terminal tab prints, and the mock engine (Task 11) repeats them word for word:
    - `terminal_disabled`: `The terminal is off for this project. Turn it on in the project's settings to run commands.`
    - `terminal_restricted`: `This project runs only its own package.json scripts in the terminal. Pick a script, or allow every command in the project's settings.`
    - `process_limit`: `This project already runs 8 processes. Stop one before starting another.`
  - from `processes/service.ts`:

    ```ts
    interface ProcessService {
      start(projectId: Id, request: ProcessStartRequest): Promise<ProcessStartResponse>;
      input(projectId: Id, processId: Id, data: string): Promise<void>;
      stop(projectId: Id, processId: Id): Promise<void>;
      list(projectId: Id): Promise<ProcessSummary[]>;
      get(projectId: Id, processId: Id): Promise<ProcessDetail>;
      scripts(projectId: Id): Promise<ProjectScripts>;
      stopProject(projectId: Id): Promise<void>;
      stopAll(): Promise<void>;
    }
    createProcessService(deps: {
      repository, scope, runner, bus, logger,
      maxRunning?: number /* 8 */, outputCapChars?: number /* 1_048_576 */,
      keepRecent?: number /* 20 */, batchMs?: number /* 50 */, now?: () => string,
    }): ProcessService
    tailOf(text: string, max: number): string
    ```

  - Behaviour later tasks rely on:
    - `stop` of a finished process resolves; `input` to one rejects 409 `process_not_running`;
    - `stopProject` and `stopAll` resolve once every process they stopped has ended;
    - a spawn error records `Could not start: <reason>\r\n` on `stderr` and ends `failed`;
    - an unknown project or process is 404 `not_found`.
  - from `__tests__/fake-runner.ts`: `fakeRunner(options?: { scripts?; refuse?; exitOnStop? }): FakeRunner`, where `FakeRunner = ProcessRunner & { started: FakeProcess[]; last(): FakeProcess }` and `FakeProcess = { spec; written: string[]; stops: number; print(text, stream?); exit(code, signal?); fail(message) }`. Tasks 7 and 8 reuse it.

- [ ] **Step 1: Write the test double**

Create `packages/engine/src/processes/__tests__/fake-runner.ts`:

```ts
import type { ProcessStream, ProjectScripts } from '@ace/contracts';

import type {
  ProcessHandlers,
  ProcessRunner,
  ProcessSpec,
  RunningProcess,
} from '../../ports/index.js';

/** One process the fake started; the test plays its side. */
export interface FakeProcess {
  readonly spec: ProcessSpec;
  /** What was written to stdin, in order. */
  readonly written: string[];
  /** How many times Stop was asked for. */
  stops: number;
  print(text: string, stream?: ProcessStream): void;
  exit(code: number | null, signal?: string | null): void;
  /** It never started: the runner reports a spawn error. */
  fail(message: string): void;
}

export type FakeRunner = ProcessRunner & {
  readonly started: FakeProcess[];
  /** The newest process started. */
  last(): FakeProcess;
};

export interface FakeRunnerOptions {
  scripts?: ProjectScripts;
  /** Refuse a start the way the real runner refuses a working folder: throw from `start`. */
  refuse?: (spec: ProcessSpec) => Error | undefined;
  /** A Stop ends the process on the next microtask, as a kill would. Default true. */
  exitOnStop?: boolean;
}

/** A `ProcessRunner` with no processes in it: every output and every end is the test's to play. */
export function fakeRunner(options: FakeRunnerOptions = {}): FakeRunner {
  const started: FakeProcess[] = [];
  return {
    started,
    last() {
      const newest = started.at(-1);
      if (newest === undefined) throw new Error('the fake runner started nothing');
      return newest;
    },
    start(spec: ProcessSpec, handlers: ProcessHandlers): RunningProcess {
      const refusal = options.refuse?.(spec);
      if (refusal !== undefined) throw refusal;
      let ended = false;
      const played: FakeProcess = {
        spec,
        written: [],
        stops: 0,
        print: (text, stream = 'stdout') => {
          if (!ended) handlers.onOutput(stream, text);
        },
        exit: (code, signal = null) => {
          if (ended) return;
          ended = true;
          handlers.onExit(code, signal);
        },
        fail: (message) => {
          if (ended) return;
          ended = true;
          handlers.onError(new Error(message));
        },
      };
      started.push(played);
      return {
        pid: 1000 + started.length,
        write: (data) => {
          if (!ended) played.written.push(data);
        },
        stop: () => {
          played.stops += 1;
          if (options.exitOnStop !== false) queueMicrotask(() => played.exit(null, 'SIGKILL'));
        },
      };
    },
    scripts: async () => options.scripts ?? { packageManager: 'npm', scripts: [] },
  };
}
```

- [ ] **Step 2: Write the failing service tests**

Create `packages/engine/src/processes/__tests__/service.test.ts`:

```ts
import type { Project, TerminalTrust } from '@ace/contracts';
import { describe, expect, it, vi } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { InProcessPubSubStub } from '../../__tests__/pubsub-stub.js';
import { createEventBus } from '../../events/index.js';
import { HttpError } from '../../gateway/errors.js';
import { newId } from '../../ids.js';
import { createLogger } from '../../logging/index.js';
import {
  LOCAL_SCOPE,
  WorkspaceFsError,
  isWorkspaceFsError,
  type EngineEvent,
} from '../../ports/index.js';
import { createProcessService, tailOf, type ProcessServiceDeps } from '../service.js';
import { fakeRunner, type FakeRunner } from './fake-runner.js';

const FOLDER = 'D:/projects/demo';
const AT = '2026-10-10T10:00:00.000Z';
const logger = createLogger({ level: 'silent', destination: { write: () => undefined } });

async function harness(
  options: {
    trust?: TerminalTrust;
    runner?: FakeRunner;
    deps?: Partial<ProcessServiceDeps>;
  } = {},
) {
  const repository = new FakeRepository();
  const project: Project = {
    id: newId(),
    name: 'Demo',
    folderPath: FOLDER,
    createdAt: AT,
    updatedAt: AT,
    ...(options.trust === undefined ? {} : { terminal: options.trust }),
  };
  await repository.projects.create(LOCAL_SCOPE, project);
  const events: EngineEvent[] = [];
  const bus = createEventBus({
    repository,
    scope: LOCAL_SCOPE,
    pubsub: new InProcessPubSubStub<EngineEvent>(),
  });
  await bus.subscribe((event) => events.push(event));
  const runner = options.runner ?? fakeRunner();
  const service = createProcessService({
    repository,
    scope: LOCAL_SCOPE,
    runner,
    bus,
    logger,
    batchMs: 5,
    ...options.deps,
  });
  const payloads = (type: string) =>
    events.filter((event) => event.type === type).map((event) => event.payload);
  return { repository, project, events, runner, service, payloads };
}

/** The code and status a call was refused with; fails when it resolves. */
async function refusal(promise: Promise<unknown>): Promise<{ code: string; status?: number }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError) return { code: error.code, status: error.status };
    if (isWorkspaceFsError(error)) return { code: error.code };
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('D301 a typed command runs as a supervised process', () => {
  it('runs in the project folder and the asked-for working folder, and lists it as running', async () => {
    const { project, runner, service } = await harness();
    const { processId } = await service.start(project.id, { command: 'node -v', cwd: 'src' });

    expect(runner.last().spec).toEqual({ root: FOLDER, cwd: 'src', command: 'node -v' });
    expect(await service.list(project.id)).toEqual([
      {
        id: processId,
        projectId: project.id,
        label: 'node -v',
        command: 'node -v',
        cwd: 'src',
        status: 'running',
        exitCode: null,
        signal: null,
        startedAt: expect.any(String),
      },
    ]);
  });

  it('labels a long command by its first 80 characters, and keeps a label it was given', async () => {
    const { project, service } = await harness();
    const long = `node ${'x'.repeat(200)}`;
    const a = await service.start(project.id, { command: long });
    const b = await service.start(project.id, { command: 'pnpm dev', label: 'web' });
    expect((await service.get(project.id, a.processId)).label).toBe(`${long.slice(0, 79)}…`);
    expect((await service.get(project.id, b.processId)).label).toBe('web');
  });

  it('streams output as transient process.output frames, one per stream run in a batch, then process.exited', async () => {
    const { project, runner, service, events, payloads } = await harness();
    const { processId } = await service.start(project.id, { command: 'build' });
    runner.last().print('compiling ');
    runner.last().print('done\n');
    runner.last().print('1 warning\n', 'stderr');

    await vi.waitFor(() =>
      expect(payloads('process.output')).toEqual([
        { projectId: project.id, processId, stream: 'stdout', data: 'compiling done\n' },
        { projectId: project.id, processId, stream: 'stderr', data: '1 warning\n' },
      ]),
    );
    runner.last().exit(0);
    await vi.waitFor(() =>
      expect(payloads('process.exited')).toEqual([
        { projectId: project.id, processId, exitCode: 0, signal: null, status: 'exited' },
      ]),
    );
    expect(events.every((event) => event.transient === true)).toBe(true);
    expect(events.at(-1)?.type).toBe('process.exited');
    expect(await service.get(project.id, processId)).toMatchObject({
      status: 'exited',
      exitCode: 0,
      endedAt: expect.any(String),
      output: 'compiling done\n1 warning\n',
      truncated: false,
    });
  });

  it('flushes output that is still batched before it says the process ended', async () => {
    const { project, runner, service, events } = await harness({ deps: { batchMs: 10_000 } });
    await service.start(project.id, { command: 'echo hi' });
    runner.last().print('hi\n');
    runner.last().exit(0);
    await vi.waitFor(() =>
      expect(events.map((event) => event.type)).toEqual(['process.output', 'process.exited']),
    );
  });

  it('writes nothing to the event log, whatever it prints (design §7)', async () => {
    const { project, runner, service, repository } = await harness();
    const before = await repository.events.currentSeq(LOCAL_SCOPE);
    await service.start(project.id, { command: 'echo token=abc' });
    runner.last().print('token=abc\n');
    runner.last().exit(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await repository.events.currentSeq(LOCAL_SCOPE)).toBe(before);
  });

  it('keeps only the last 1,048,576 characters, never half a character', async () => {
    const { project, runner, service } = await harness();
    const { processId } = await service.start(project.id, { command: 'flood' });
    runner.last().print('x'.repeat(1_048_576));
    runner.last().print('END');
    const detail = await service.get(project.id, processId);
    expect(detail.output).toHaveLength(1_048_576);
    expect(detail.output.endsWith('xEND')).toBe(true);
    expect(detail.truncated).toBe(true);

    const small = await harness({ deps: { outputCapChars: 3 } });
    const cut = await small.service.start(small.project.id, { command: 'emoji' });
    // 'ab😀cd' is six code units; the last three start with the second half of 😀.
    small.runner.last().print('ab\ud83d\ude00cd');
    expect((await small.service.get(small.project.id, cut.processId)).output).toBe('cd');
    expect(tailOf('ab\ud83d\ude00cd', 4)).toBe('\ud83d\ude00cd');
  });

  it('a process that never started is failed, with its reason in the output (design §10)', async () => {
    const { project, runner, service, payloads } = await harness();
    const { processId } = await service.start(project.id, { command: 'x' });
    runner.last().fail('spawn /bin/sh ENOENT');

    await vi.waitFor(() =>
      expect(payloads('process.exited')).toEqual([
        { projectId: project.id, processId, exitCode: null, signal: null, status: 'failed' },
      ]),
    );
    expect(payloads('process.output')).toEqual([
      {
        projectId: project.id,
        processId,
        stream: 'stderr',
        data: 'Could not start: spawn /bin/sh ENOENT\r\n',
      },
    ]);
    expect(await service.get(project.id, processId)).toMatchObject({
      status: 'failed',
      output: 'Could not start: spawn /bin/sh ENOENT\r\n',
    });
  });

  it('writes input to stdin while it runs; a finished process answers 409 process_not_running', async () => {
    const { project, runner, service } = await harness();
    const { processId } = await service.start(project.id, { command: 'ask' });
    await service.input(project.id, processId, 'Ada\n');
    expect(runner.last().written).toEqual(['Ada\n']);

    runner.last().exit(0);
    expect(await refusal(service.input(project.id, processId, 'late\n'))).toEqual({
      code: 'process_not_running',
      status: 409,
    });
  });

  it('stops a running process, and a second stop of a finished one does nothing', async () => {
    const { project, runner, service } = await harness();
    const { processId } = await service.start(project.id, { command: 'serve' });
    await service.stop(project.id, processId);
    await vi.waitFor(async () =>
      expect(await service.get(project.id, processId)).toMatchObject({
        status: 'exited',
        exitCode: null,
        signal: 'SIGKILL',
      }),
    );
    await service.stop(project.id, processId);
    expect(runner.last().stops).toBe(1);
  });

  it('refuses a ninth running process with 409 process_limit; a finished one frees a place', async () => {
    const { project, runner, service } = await harness();
    for (let i = 0; i < 8; i += 1) await service.start(project.id, { command: `serve ${i}` });
    expect(await refusal(service.start(project.id, { command: 'one more' }))).toEqual({
      code: 'process_limit',
      status: 409,
    });
    runner.started[0]?.exit(0);
    await expect(service.start(project.id, { command: 'one more' })).resolves.toEqual({
      processId: expect.any(String),
    });
  });

  it('remembers the last 20 finished processes; running ones list first, each group newest first', async () => {
    const { project, runner, service } = await harness();
    const finished: string[] = [];
    for (let i = 0; i < 22; i += 1) {
      finished.push((await service.start(project.id, { command: `job ${i}` })).processId);
      runner.last().exit(0);
    }
    const running = (await service.start(project.id, { command: 'serve' })).processId;

    const listed = (await service.list(project.id)).map((summary) => summary.id);
    expect(listed).toEqual([running, ...finished.slice(2).reverse()]);
    expect(await refusal(service.get(project.id, finished[0] ?? ''))).toEqual({
      code: 'not_found',
      status: 404,
    });
  });

  it('answers 404 for a project or a process it does not know', async () => {
    const { project, service } = await harness();
    const unknown = newId();
    expect((await refusal(service.list(unknown))).code).toBe('not_found');
    expect((await refusal(service.start(unknown, { command: 'x' }))).code).toBe('not_found');
    expect((await refusal(service.get(project.id, unknown))).code).toBe('not_found');
    expect((await refusal(service.input(project.id, unknown, 'x'))).code).toBe('not_found');
    expect((await refusal(service.stop(project.id, unknown))).code).toBe('not_found');
  });

  it('keeps the runner’s refusal of a working folder, and remembers nothing', async () => {
    const runner = fakeRunner({
      refuse: (spec) =>
        spec.cwd === '..'
          ? new WorkspaceFsError('outside_project', 'That path is outside the project folder.')
          : undefined,
    });
    const { project, service } = await harness({ runner });
    expect(await refusal(service.start(project.id, { command: 'ls', cwd: '..' }))).toEqual({
      code: 'outside_project',
    });
    expect(await service.list(project.id)).toEqual([]);
  });

  it('refuses a project with no folder as invalid_path', async () => {
    const { repository, service } = await harness();
    const bare: Project = { id: newId(), name: 'Bare', folderPath: '', createdAt: AT, updatedAt: AT };
    await repository.projects.create(LOCAL_SCOPE, bare);
    expect((await refusal(service.start(bare.id, { command: 'x' }))).code).toBe('invalid_path');
  });
});

describe('D301 the project’s trust level governs a start, never a stop', () => {
  const scripts = {
    packageManager: 'pnpm' as const,
    scripts: [
      { name: 'dev', command: 'vite' },
      { name: 'x & y', command: 'echo odd' },
    ],
  };

  it('scripts: refuses a typed command with 403 terminal_restricted, and runs a script as <pm> run <name>', async () => {
    const { project, runner, service } = await harness({
      trust: 'scripts',
      runner: fakeRunner({ scripts }),
    });
    expect(await refusal(service.start(project.id, { command: 'rm -rf /' }))).toEqual({
      code: 'terminal_restricted',
      status: 403,
    });
    const { processId } = await service.start(project.id, { script: 'dev' });
    expect(runner.last().spec.command).toBe('pnpm run dev');
    expect(await service.get(project.id, processId)).toMatchObject({
      label: 'dev',
      command: 'pnpm run dev',
    });
  });

  it('a script package.json does not have is 404; a name a shell would split is refused before a shell sees it', async () => {
    const { project, runner, service } = await harness({ runner: fakeRunner({ scripts }) });
    expect(await refusal(service.start(project.id, { script: 'nope' }))).toEqual({
      code: 'not_found',
      status: 404,
    });
    expect(await refusal(service.start(project.id, { script: 'x & y' }))).toEqual({
      code: 'validation_failed',
      status: 400,
    });
    expect(runner.started).toEqual([]);
  });

  it('off: refuses every start with 403 terminal_disabled, while list, get, input and stop still work', async () => {
    const { project, repository, runner, service } = await harness({ runner: fakeRunner({ scripts }) });
    const { processId } = await service.start(project.id, { command: 'serve' });
    await repository.projects.update(LOCAL_SCOPE, project.id, { terminal: 'off', updatedAt: AT });

    expect(await refusal(service.start(project.id, { command: 'ls' }))).toEqual({
      code: 'terminal_disabled',
      status: 403,
    });
    expect((await refusal(service.start(project.id, { script: 'dev' }))).code).toBe(
      'terminal_disabled',
    );
    expect(await service.list(project.id)).toHaveLength(1);
    await service.input(project.id, processId, 'q\n');
    expect(runner.last().written).toEqual(['q\n']);
    await service.stop(project.id, processId);
    await vi.waitFor(async () =>
      expect((await service.get(project.id, processId)).status).toBe('exited'),
    );
  });

  it('answers the runner’s scripts for the project’s folder', async () => {
    const { project, service } = await harness({ runner: fakeRunner({ scripts }) });
    expect(await service.scripts(project.id)).toEqual(scripts);
    expect((await refusal(service.scripts(newId()))).code).toBe('not_found');
  });
});

describe('D301 stopping everything', () => {
  it('stopProject stops every running process of that project only, and resolves when they have ended', async () => {
    const one = await harness();
    const other = await one.repository.projects.create(LOCAL_SCOPE, {
      id: newId(),
      name: 'Other',
      folderPath: 'D:/projects/other',
      createdAt: AT,
      updatedAt: AT,
    });
    const a = await one.service.start(one.project.id, { command: 'serve a' });
    const b = await one.service.start(one.project.id, { command: 'serve b' });
    const c = await one.service.start(other.id, { command: 'serve c' });

    await one.service.stopProject(one.project.id);
    expect((await one.service.get(one.project.id, a.processId)).status).toBe('exited');
    expect((await one.service.get(one.project.id, b.processId)).status).toBe('exited');
    expect((await one.service.get(other.id, c.processId)).status).toBe('running');
  });

  it('stopAll stops every process and resolves once each has ended (FR-SYS-008)', async () => {
    const { project, service } = await harness();
    await service.start(project.id, { command: 'serve a' });
    await service.start(project.id, { command: 'serve b' });
    await service.stopAll();
    expect((await service.list(project.id)).map((summary) => summary.status)).toEqual([
      'exited',
      'exited',
    ]);
  });

  it('stopAll resolves at once with nothing running', async () => {
    const { service } = await harness();
    await expect(service.stopAll()).resolves.toBeUndefined();
  });
});
```

Append to `packages/engine/src/__tests__/events.test.ts`:

```ts
describe('D301 process frames ride the project scope', () => {
  const PROJECT = newId();
  const PROCESS = newId();
  const output = {
    type: 'process.output',
    payload: { projectId: PROJECT, processId: PROCESS, stream: 'stdout', data: 'hi\n' },
  };
  const exited = {
    type: 'process.exited',
    payload: { projectId: PROJECT, processId: PROCESS, exitCode: 0, signal: null, status: 'exited' },
  };

  it('delivers process.output and process.exited to the project’s subscribers only, without a seq', async () => {
    const watching = await connect();
    const engineOnly = await connect();
    await watching.receive({ type: 'subscribe', payload: { scope: 'project', id: PROJECT } });
    await engineOnly.receive({ type: 'subscribe', payload: { scope: 'engine' } });

    await bus.emitTransient(output);
    await bus.emitTransient(exited);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(watching.frames().filter((frame) => frame.type.startsWith('process.'))).toEqual([
      output,
      exited,
    ]);
    expect(engineOnly.frames().some((frame) => frame.type.startsWith('process.'))).toBe(false);
  });
});
```

- [ ] **Step 3: Run them to watch them fail**

Run: `pnpm --filter @ace/engine exec vitest run src/processes src/__tests__/events.test.ts`
Expected: FAIL. `../service.js` does not exist. The new `events.test.ts` case already passes: the hub routes every `PROJECT_EVENT_TYPES` member since Task 2, and the case pins it.

- [ ] **Step 4: The refusals**

Create `packages/engine/src/processes/errors.ts`:

```ts
import { HttpError } from '../gateway/errors.js';

/*
 * The terminal's refusals (D301, design §6.3). Each message is what the person reads in their
 * terminal tab, so it says what to do next. The mock engine repeats them word for word.
 */

export const terminalDisabled = (): HttpError =>
  new HttpError(
    'invalid_config',
    'terminal_disabled',
    "The terminal is off for this project. Turn it on in the project's settings to run commands.",
    undefined,
    false,
  );

export const terminalRestricted = (): HttpError =>
  new HttpError(
    'invalid_config',
    'terminal_restricted',
    "This project runs only its own package.json scripts in the terminal. Pick a script, or allow every command in the project's settings.",
    undefined,
    false,
  );

export const processLimit = (max: number): HttpError =>
  new HttpError(
    'workflow',
    'process_limit',
    `This project already runs ${max} processes. Stop one before starting another.`,
    { max },
    false,
  );

export const processNotRunning = (processId: string): HttpError =>
  new HttpError(
    'workflow',
    'process_not_running',
    'That process has finished, so it reads no more input.',
    { processId },
    false,
  );

/** A script name a shell would read as more than one word is never handed to a shell. */
export const unsafeScriptName = (name: string): HttpError =>
  new HttpError(
    'invalid_config',
    'validation_failed',
    `The script "${name}" has a name a shell would read as more than a name. Rename it in package.json to run it here.`,
    { script: name },
    false,
  );
```

- [ ] **Step 5: The service**

Create `packages/engine/src/processes/service.ts`:

```ts
import {
  DEFAULT_TERMINAL_TRUST,
  PROCESS_OUTPUT_BATCH_MS,
  PROCESS_OUTPUT_MAX_CHARS,
  PROCESS_RECENT_MAX,
  PROCESS_RUNNING_MAX,
  type Id,
  type ProcessDetail,
  type ProcessExitedPayload,
  type ProcessOutputPayload,
  type ProcessStartRequest,
  type ProcessStartResponse,
  type ProcessStream,
  type ProcessSummary,
  type Project,
  type ProjectScripts,
} from '@ace/contracts';

import { createBatcher, type Batcher } from '../events/batcher.js';
import type { EventBus } from '../events/index.js';
import { invalidPath, notFound } from '../gateway/errors.js';
import { newId } from '../ids.js';
import type { Logger } from '../logging/index.js';
import type { ProcessRunner, Repository, RunningProcess, Scope } from '../ports/index.js';
import {
  processLimit,
  processNotRunning,
  terminalDisabled,
  terminalRestricted,
  unsafeScriptName,
} from './errors.js';

/**
 * Forge's terminal (D301, design §6.3): a person's commands as supervised processes. Every call
 * names a project; a start is governed by the project's trust level (`on` / `scripts` / `off`),
 * while list, get, input and stop always work so a person can stop what runs.
 *
 * Output streams as transient `process.output` frames, batched at 50 ms, and the run ends with a
 * transient `process.exited`. Nothing reaches the database or the event log: the last 1,048,576
 * characters of each process, and the last 20 finished processes per project, live in memory only
 * and are gone when the engine restarts. Agents never use this service.
 */
export interface ProcessService {
  start(projectId: Id, request: ProcessStartRequest): Promise<ProcessStartResponse>;
  /** Writes to stdin; 409 `process_not_running` once it has ended. */
  input(projectId: Id, processId: Id, data: string): Promise<void>;
  /** Kills the whole tree. Stopping a finished process does nothing. */
  stop(projectId: Id, processId: Id): Promise<void>;
  /** Running first, then finished; newest first in each. */
  list(projectId: Id): Promise<ProcessSummary[]>;
  /** The summary and the kept output, for a terminal tab that re-attaches. */
  get(projectId: Id, processId: Id): Promise<ProcessDetail>;
  scripts(projectId: Id): Promise<ProjectScripts>;
  /** Stops every running process of the project; resolves when each has ended. */
  stopProject(projectId: Id): Promise<void>;
  /** Shutdown (FR-SYS-008): stops every running process; resolves when each has ended. */
  stopAll(): Promise<void>;
}

export interface ProcessServiceDeps {
  repository: Repository;
  scope: Scope;
  runner: ProcessRunner;
  bus: EventBus;
  logger: Logger;
  /** Running processes per project; the next start answers 409 `process_limit`. */
  maxRunning?: number;
  /** Output kept per process, in UTF-16 code units. */
  outputCapChars?: number;
  /** Finished processes remembered per project. */
  keepRecent?: number;
  /** How long output collects before it goes out as frames. */
  batchMs?: number;
  now?: () => string;
}

/** A script name every platform's shell reads as one word. */
const SAFE_SCRIPT_NAME = /^[\w:.@/+-]+$/;
const LABEL_MAX = 80;

interface Chunk {
  stream: ProcessStream;
  data: string;
}

interface Supervised {
  summary: ProcessSummary;
  /** Start order: "newest first" even when two start in the same millisecond. */
  order: number;
  output: string;
  truncated: boolean;
  handle: RunningProcess | undefined;
  batcher: Batcher<Chunk>;
  ended: Promise<void>;
  markEnded: () => void;
}

const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** The last `max` UTF-16 code units of `text`, never starting with the second half of a pair. */
export function tailOf(text: string, max: number): string {
  if (text.length <= max) return text;
  const tail = text.slice(text.length - max);
  return isLowSurrogate(tail.charCodeAt(0)) ? tail.slice(1) : tail;
}

const labelOf = (command: string): string => {
  const line = command.trim().replace(/\s+/g, ' ');
  return line.length <= LABEL_MAX ? line : `${line.slice(0, LABEL_MAX - 1)}…`;
};

export function createProcessService(deps: ProcessServiceDeps): ProcessService {
  const { repository, scope, runner, bus, logger } = deps;
  const maxRunning = deps.maxRunning ?? PROCESS_RUNNING_MAX;
  const outputCap = deps.outputCapChars ?? PROCESS_OUTPUT_MAX_CHARS;
  const keepRecent = deps.keepRecent ?? PROCESS_RECENT_MAX;
  const batchMs = deps.batchMs ?? PROCESS_OUTPUT_BATCH_MS;
  const now = deps.now ?? (() => new Date().toISOString());
  const byProject = new Map<Id, Map<Id, Supervised>>();
  let starts = 0;

  function recordsOf(projectId: Id): Map<Id, Supervised> {
    let records = byProject.get(projectId);
    if (records === undefined) {
      records = new Map();
      byProject.set(projectId, records);
    }
    return records;
  }

  async function existing(projectId: Id): Promise<Project> {
    const project = await repository.projects.get(scope, projectId);
    if (project === null) throw notFound(`Project ${projectId}`);
    return project;
  }

  async function folderOf(projectId: Id): Promise<Project> {
    const project = await existing(projectId);
    if (project.folderPath === '') throw invalidPath('(none)', 'this project has no folder.');
    return project;
  }

  function find(projectId: Id, processId: Id): Supervised {
    const record = byProject.get(projectId)?.get(processId);
    if (record === undefined) throw notFound(`Process ${processId}`);
    return record;
  }

  function emitOutput(summary: ProcessSummary, chunk: Chunk): void {
    const payload: ProcessOutputPayload = {
      projectId: summary.projectId,
      processId: summary.id,
      stream: chunk.stream,
      data: chunk.data,
    };
    void bus.emitTransient({ type: 'process.output', payload });
  }

  /** One frame per run of one stream within a batch, so stdout and stderr keep their order. */
  const flushTo =
    (summary: ProcessSummary) =>
    (chunks: Chunk[]): void => {
      let current: Chunk | undefined;
      for (const chunk of chunks) {
        if (current !== undefined && current.stream === chunk.stream) {
          current = { stream: current.stream, data: current.data + chunk.data };
          continue;
        }
        if (current !== undefined) emitOutput(summary, current);
        current = chunk;
      }
      if (current !== undefined) emitOutput(summary, current);
    };

  function keep(record: Supervised, text: string): void {
    record.output += text;
    if (record.output.length > outputCap) record.truncated = true;
    // Trimmed at twice the cap, so a flood of small chunks costs one copy per cap's worth, not one
    // per chunk. Every read takes the tail.
    if (record.output.length > outputCap * 2) record.output = tailOf(record.output, outputCap);
  }

  function prune(projectId: Id): void {
    const records = recordsOf(projectId);
    const finished = [...records.values()]
      .filter((record) => record.summary.status !== 'running')
      .sort((a, b) => a.order - b.order);
    for (const old of finished.slice(0, Math.max(0, finished.length - keepRecent))) {
      records.delete(old.summary.id);
    }
  }

  function end(
    record: Supervised,
    status: 'exited' | 'failed',
    exitCode: number | null,
    signal: string | null,
  ): void {
    if (record.summary.status !== 'running') return;
    // Whatever output is still batched goes out before the end does.
    record.batcher.stop();
    record.summary.status = status;
    record.summary.exitCode = exitCode;
    record.summary.signal = signal;
    record.summary.endedAt = now();
    record.output = tailOf(record.output, outputCap);
    record.handle = undefined;
    const payload: ProcessExitedPayload = {
      projectId: record.summary.projectId,
      processId: record.summary.id,
      exitCode,
      signal,
      status,
    };
    void bus.emitTransient({ type: 'process.exited', payload });
    record.markEnded();
    prune(record.summary.projectId);
  }

  async function stopRunning(records: Iterable<Supervised>): Promise<void> {
    const waits: Array<Promise<void>> = [];
    for (const record of records) {
      if (record.summary.status !== 'running') continue;
      record.handle?.stop();
      waits.push(record.ended);
    }
    await Promise.all(waits);
  }

  return {
    async start(projectId, request) {
      const project = await folderOf(projectId);
      const trust = project.terminal ?? DEFAULT_TERMINAL_TRUST;
      if (trust === 'off') throw terminalDisabled();

      let command: string;
      let label: string;
      if ('script' in request) {
        const known = await runner.scripts(project.folderPath);
        if (!known.scripts.some((script) => script.name === request.script)) {
          throw notFound(`Script "${request.script}"`);
        }
        if (!SAFE_SCRIPT_NAME.test(request.script)) throw unsafeScriptName(request.script);
        command = `${known.packageManager} run ${request.script}`;
        label = request.label ?? request.script;
      } else {
        if (trust === 'scripts') throw terminalRestricted();
        command = request.command;
        label = request.label ?? labelOf(request.command);
      }

      const records = recordsOf(projectId);
      const running = [...records.values()].filter((r) => r.summary.status === 'running').length;
      if (running >= maxRunning) throw processLimit(maxRunning);

      const summary: ProcessSummary = {
        id: newId(),
        projectId,
        label,
        command,
        cwd: request.cwd ?? '',
        status: 'running',
        exitCode: null,
        signal: null,
        startedAt: now(),
      };
      let markEnded: () => void = () => undefined;
      const ended = new Promise<void>((resolve) => {
        markEnded = resolve;
      });
      starts += 1;
      const record: Supervised = {
        summary,
        order: starts,
        output: '',
        truncated: false,
        handle: undefined,
        batcher: createBatcher<Chunk>({ intervalMs: batchMs, flush: flushTo(summary) }),
        ended,
        markEnded,
      };
      records.set(summary.id, record);

      try {
        record.handle = runner.start(
          { root: project.folderPath, cwd: summary.cwd, command },
          {
            onOutput(stream, chunk) {
              if (record.summary.status !== 'running') return;
              keep(record, chunk);
              record.batcher.push({ stream, data: chunk });
            },
            onExit: (code, signal) => end(record, 'exited', code, signal),
            onError(error) {
              if (record.summary.status !== 'running') return;
              logger.warn(
                { subsystem: 'processes', projectId, processId: summary.id, reason: error.message },
                'a process could not start',
              );
              // design §10: the tab says why it failed to start.
              const message = `Could not start: ${error.message}\r\n`;
              keep(record, message);
              record.batcher.push({ stream: 'stderr', data: message });
              end(record, 'failed', null, null);
            },
          },
        );
      } catch (error) {
        // A refused working folder: nothing ran, so nothing is remembered.
        records.delete(summary.id);
        throw error;
      }
      return { processId: summary.id };
    },

    async input(projectId, processId, data) {
      const record = find(projectId, processId);
      if (record.summary.status !== 'running') throw processNotRunning(processId);
      record.handle?.write(data);
    },

    async stop(projectId, processId) {
      const record = find(projectId, processId);
      // Idempotent: a finished process is already stopped.
      if (record.summary.status === 'running') record.handle?.stop();
    },

    async list(projectId) {
      await existing(projectId);
      return [...recordsOf(projectId).values()]
        .sort(
          (a, b) =>
            Number(b.summary.status === 'running') - Number(a.summary.status === 'running') ||
            b.order - a.order,
        )
        .map((record) => ({ ...record.summary }));
    },

    async get(projectId, processId) {
      const record = find(projectId, processId);
      return {
        ...record.summary,
        output: tailOf(record.output, outputCap),
        truncated: record.truncated,
      };
    },

    scripts: async (projectId) => runner.scripts((await folderOf(projectId)).folderPath),

    stopProject: (projectId) => stopRunning(byProject.get(projectId)?.values() ?? []),

    stopAll: () => stopRunning([...byProject.values()].flatMap((records) => [...records.values()])),
  };
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @ace/engine exec vitest run src/processes src/__tests__/events.test.ts`
Expected: PASS.

- [ ] **Step 7: Full suite, typecheck, commit**

Run: `pnpm --filter @ace/engine test && pnpm --filter @ace/engine typecheck`
Expected: PASS.

```bash
npx prettier --write --config packages/config/prettier.config.js packages/engine/src/processes packages/engine/src/__tests__/events.test.ts
git add packages/engine
git commit -m "feat(engine): the process service — trust levels, eight at a time, the last megabyte of output, transient frames [D301]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Engine — the process routes, mounted in the gateway

**Files:**
- Create: `packages/engine/src/processes/routes.ts`
- Modify:
  - `packages/engine/src/gateway/index.ts:66-67` (imports), `:164-171` (`EngineDeps.processes`), `:810-811` (the mount);
  - `packages/engine/src/index.ts:40-42` (the barrel).
- Test: create `packages/engine/src/processes/__tests__/routes.test.ts`

**Interfaces:**
- Consumes:
  - from Task 2: `ProcessStartRequestSchema`, `ProcessInputRequestSchema`;
  - from Task 6: `ProcessService`, `createProcessService`, `fakeRunner`;
  - existing: `notImplemented`, `readJson`, `routeApp` / `send` / `errorCode` (test helpers).
- Produces:
  - `createProcessRoutes(service: ProcessService | undefined): ProcessRouter`;
  - `EngineDeps.processes?: ProcessService`;
  - the routes, all under `/api/v1`:
    - `GET /projects/:id/processes/scripts`
    - `GET /projects/:id/processes`
    - `POST /projects/:id/processes` → 201 `{ processId }`
    - `GET /projects/:id/processes/:procId`
    - `POST /projects/:id/processes/:procId/input` → 204
    - `POST /projects/:id/processes/:procId/stop` → 204
  - `@ace/engine` exports `createProcessService`, `createProcessRoutes`, `tailOf`, `ProcessService` and the error helpers.

- [ ] **Step 1: Write the failing route tests**

Create `packages/engine/src/processes/__tests__/routes.test.ts`:

```ts
import type { Project } from '@ace/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { InProcessPubSubStub } from '../../__tests__/pubsub-stub.js';
import { errorCode, routeApp, send } from '../../__tests__/route-app.js';
import { createEventBus } from '../../events/index.js';
import { newId } from '../../ids.js';
import * as engine from '../../index.js';
import { createLogger } from '../../logging/index.js';
import { LOCAL_SCOPE, type EngineEvent } from '../../ports/index.js';
import { createProcessRoutes } from '../routes.js';
import { createProcessService } from '../service.js';
import { fakeRunner, type FakeRunner } from './fake-runner.js';

const FOLDER = 'D:/projects/demo';
const AT = '2026-10-10T10:00:00.000Z';
const logger = createLogger({ level: 'silent', destination: { write: () => undefined } });

let repository: FakeRepository;
let project: Project;
let runner: FakeRunner;
let app: ReturnType<typeof routeApp>;

beforeEach(async () => {
  repository = new FakeRepository();
  project = { id: newId(), name: 'Demo', folderPath: FOLDER, createdAt: AT, updatedAt: AT };
  await repository.projects.create(LOCAL_SCOPE, project);
  runner = fakeRunner({
    scripts: { packageManager: 'pnpm', scripts: [{ name: 'dev', command: 'vite' }] },
  });
  const bus = createEventBus({
    repository,
    scope: LOCAL_SCOPE,
    pubsub: new InProcessPubSubStub<EngineEvent>(),
  });
  app = routeApp(
    createProcessRoutes(
      createProcessService({ repository, scope: LOCAL_SCOPE, runner, bus, logger, batchMs: 5 }),
    ),
  );
});

const base = () => `/projects/${project.id}/processes`;

async function started(body: unknown = { command: 'node -v' }): Promise<string> {
  const response = await send(app, 'POST', base(), body);
  expect(response.status).toBe(201);
  return ((await response.json()) as { processId: string }).processId;
}

describe('D301 the process routes (design §6.3)', () => {
  it('answers 501 when the engine has no process service (D121)', async () => {
    const response = await send(routeApp(createProcessRoutes(undefined)), 'GET', base());
    expect(response.status).toBe(501);
    expect(await errorCode(response)).toBe('not_implemented');
  });

  it('starts a command with 201 and its id, and lists it', async () => {
    const processId = await started({ command: 'node -v', cwd: 'src' });
    expect(runner.last().spec).toEqual({ root: FOLDER, cwd: 'src', command: 'node -v' });
    const listed = (await (await send(app, 'GET', base())).json()) as Array<{ id: string }>;
    expect(listed.map((summary) => summary.id)).toEqual([processId]);
  });

  it('refuses a body that names both a command and a script, or neither', async () => {
    for (const body of [{ command: 'a', script: 'b' }, {}, { command: '' }]) {
      const response = await send(app, 'POST', base(), body);
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe('validation_failed');
    }
  });

  it('answers the scripts at /scripts, not as a process id', async () => {
    const response = await send(app, 'GET', `${base()}/scripts`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      packageManager: 'pnpm',
      scripts: [{ name: 'dev', command: 'vite' }],
    });
  });

  it('answers a process’s detail with the output it kept', async () => {
    const processId = await started();
    runner.last().print('v24.0.0\n');
    const detail = await (await send(app, 'GET', `${base()}/${processId}`)).json();
    expect(detail).toMatchObject({ id: processId, status: 'running', output: 'v24.0.0\n', truncated: false });
  });

  it('writes input with 204, and answers 409 process_not_running once it has ended', async () => {
    const processId = await started({ command: 'ask' });
    expect((await send(app, 'POST', `${base()}/${processId}/input`, { data: 'Ada\n' })).status).toBe(
      204,
    );
    expect(runner.last().written).toEqual(['Ada\n']);
    runner.last().exit(0);
    const late = await send(app, 'POST', `${base()}/${processId}/input`, { data: 'x\n' });
    expect(late.status).toBe(409);
    expect(await errorCode(late)).toBe('process_not_running');
    const tooBig = await send(app, 'POST', `${base()}/${processId}/input`, {
      data: 'x'.repeat(65_537),
    });
    expect(tooBig.status).toBe(400);
  });

  it('stops with 204, and stopping again is 204 too', async () => {
    const processId = await started({ command: 'serve' });
    expect((await send(app, 'POST', `${base()}/${processId}/stop`)).status).toBe(204);
    await vi.waitFor(async () => {
      const detail = (await (await send(app, 'GET', `${base()}/${processId}`)).json()) as {
        status: string;
      };
      expect(detail.status).toBe('exited');
    });
    expect((await send(app, 'POST', `${base()}/${processId}/stop`)).status).toBe(204);
  });

  it('answers 404 for an unknown project or process', async () => {
    for (const [method, path] of [
      ['GET', `/projects/${newId()}/processes`],
      ['GET', `${base()}/${newId()}`],
      ['POST', `${base()}/${newId()}/stop`],
    ] as const) {
      const response = await send(app, method, path);
      expect(response.status, path).toBe(404);
      expect(await errorCode(response)).toBe('not_found');
    }
  });

  it('answers 403 terminal_disabled for a project whose terminal is off', async () => {
    await repository.projects.update(LOCAL_SCOPE, project.id, { terminal: 'off', updatedAt: AT });
    const response = await send(app, 'POST', base(), { command: 'ls' });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('terminal_disabled');
  });

  it('is exported from @ace/engine', () => {
    expect(engine.createProcessRoutes).toBe(createProcessRoutes);
    expect(engine.createProcessService).toBe(createProcessService);
  });
});
```

- [ ] **Step 2: Run them to watch them fail**

Run: `pnpm --filter @ace/engine exec vitest run src/processes/__tests__/routes.test.ts`
Expected: FAIL. `../routes.js` does not exist.

- [ ] **Step 3: The routes**

Create `packages/engine/src/processes/routes.ts`:

```ts
import { ProcessInputRequestSchema, ProcessStartRequestSchema } from '@ace/contracts';
import { Hono } from 'hono';

import { notImplemented } from '../gateway/errors.js';
import { readJson } from '../gateway/read-json.js';
import type { ProcessService } from './service.js';

export type ProcessRouter = Hono<{ Variables: { requestId: string } }>;

/**
 * `/api/v1/projects/:id/processes/*` (D301, design §6.3). Mounted inside the gateway's token,
 * Origin and request-id middleware; answers 501 when the engine was built without a terminal
 * (D121).
 */
export function createProcessRoutes(processService: ProcessService | undefined): ProcessRouter {
  const router: ProcessRouter = new Hono<{ Variables: { requestId: string } }>();
  const processes = (): ProcessService => {
    if (processService === undefined) throw notImplemented('The terminal');
    return processService;
  };
  const base = '/projects/:id/processes';

  // Registered before `/:procId`, which would otherwise read "scripts" as a process id.
  router.get(`${base}/scripts`, async (c) => c.json(await processes().scripts(c.req.param('id'))));

  router.get(base, async (c) => c.json(await processes().list(c.req.param('id'))));

  router.post(base, async (c) => {
    const service = processes();
    const body = ProcessStartRequestSchema.parse(await readJson(c));
    return c.json(await service.start(c.req.param('id'), body), 201);
  });

  router.get(`${base}/:procId`, async (c) =>
    c.json(await processes().get(c.req.param('id'), c.req.param('procId'))),
  );

  router.post(`${base}/:procId/input`, async (c) => {
    const service = processes();
    const { data } = ProcessInputRequestSchema.parse(await readJson(c));
    await service.input(c.req.param('id'), c.req.param('procId'), data);
    return c.body(null, 204);
  });

  router.post(`${base}/:procId/stop`, async (c) => {
    await processes().stop(c.req.param('id'), c.req.param('procId'));
    return c.body(null, 204);
  });

  return router;
}
```

- [ ] **Step 4: Mount it**

In `packages/engine/src/gateway/index.ts`:
1. After `import type { WorkspaceService } from '../workspace/service.js';` (line 67), add:

```ts
import { createProcessRoutes } from '../processes/routes.js';
import type { ProcessService } from '../processes/service.js';
```

2. In `EngineDeps`, after `workspace?: WorkspaceService;`, add:

```ts
  /** `/projects/:id/processes/*`: Forge's terminal (D301). Agents never reach it. */
  processes?: ProcessService;
```

3. After `api.route('/', createWorkspaceRoutes(deps.workspace));`, add:

```ts
  /* IDE (D301): Forge's terminal, inside the same middleware. */
  api.route('/', createProcessRoutes(deps.processes));
```

In `packages/engine/src/index.ts`, after the two workspace lines at the end, add:

```ts

/* IDE (D301): Forge's terminal. */
export * from './processes/service.js';
export * from './processes/routes.js';
export * from './processes/errors.js';
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @ace/engine exec vitest run src/processes`
Expected: PASS.

- [ ] **Step 6: Full suite, build, commit**

Run: `pnpm --filter @ace/engine test && pnpm --filter @ace/engine build`
Expected: PASS.

```bash
npx prettier --write --config packages/config/prettier.config.js packages/engine/src/processes packages/engine/src/gateway/index.ts packages/engine/src/index.ts
git add packages/engine
git commit -m "feat(engine): the process routes under /projects/:id/processes, behind the gateway's middleware [D301]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 8: Server — wiring, shutdown, "off" stops what runs, and a real-engine integration test

**Files:**
- Modify:
  - `packages/engine/src/gateway/index.ts` (the `PATCH /projects/:id` route from Task 3);
  - `apps/server/src/server.ts:23-81` (imports), `:108-115` (imports), `:377-400` (the service), `:1005-1006` (the app's deps), `:1102` (shutdown).
- Test: create `packages/engine/src/processes/__tests__/terminal-off.test.ts` and `apps/server/src/__tests__/processes.integration.test.ts`.

**Interfaces:**
- Consumes:
  - from Task 3: the widened `PATCH /projects/:id`;
  - from Tasks 4–7: `createProcessRunner()`, `createProcessService(...)`, `ProcessService.stopProject`, `ProcessService.stopAll`, `EngineDeps.processes`, `fakeRunner`.
- Produces:
  - `PATCH /projects/:id` with `terminal: 'off'` awaits `deps.processes.stopProject(id)` after the update, so the answer comes once everything has stopped (D301 decision 6);
  - the server's engine has a process service on the real runner, and `stop()` awaits `processes.stopAll()` after `workspace.stopAll()` and before the database closes (FR-SYS-008).

- [ ] **Step 1: Write the failing gateway test**

Create `packages/engine/src/processes/__tests__/terminal-off.test.ts`:

```ts
import type { Project } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { InProcessPubSubStub } from '../../__tests__/pubsub-stub.js';
import { createEventBus } from '../../events/index.js';
import { createEngineApp } from '../../gateway/index.js';
import { createGraphService } from '../../graph/index.js';
import { newId } from '../../ids.js';
import { createLogger } from '../../logging/index.js';
import { LOCAL_SCOPE, type Auth, type EngineEvent, type Scope } from '../../ports/index.js';
import { createProcessService, type ProcessService } from '../service.js';
import { fakeRunner } from './fake-runner.js';

const TOKEN = 'a'.repeat(64);
const HEADERS = { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const AT = '2026-10-10T10:00:00.000Z';
const auth: Auth = {
  verifyToken: async (_scope: Scope, token: string | undefined) => token === TOKEN,
};
const logger = createLogger({ level: 'silent', destination: { write: () => undefined } });

async function harness(options: { withTerminal?: boolean } = {}) {
  const repository = new FakeRepository();
  const project: Project = {
    id: newId(),
    name: 'Demo',
    folderPath: 'D:/projects/demo',
    createdAt: AT,
    updatedAt: AT,
  };
  await repository.projects.create(LOCAL_SCOPE, project);
  const bus = createEventBus({
    repository,
    scope: LOCAL_SCOPE,
    pubsub: new InProcessPubSubStub<EngineEvent>(),
  });
  const runner = fakeRunner();
  const processes: ProcessService = createProcessService({
    repository,
    scope: LOCAL_SCOPE,
    runner,
    bus,
    logger,
  });
  const app = createEngineApp({
    repository,
    auth,
    logger,
    scope: LOCAL_SCOPE,
    version: '0.1.0',
    graph: createGraphService({ repository, scope: LOCAL_SCOPE, logger }),
    bus,
    ...(options.withTerminal === false ? {} : { processes }),
  });
  const patch = (body: unknown) =>
    app.request(`/api/v1/projects/${project.id}`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify(body),
    });
  return { project, runner, processes, patch };
}

describe('D301 turning the terminal off stops what runs, now', () => {
  it('a PATCH to off stops every running process of the project before it answers', async () => {
    const { project, runner, processes, patch } = await harness();
    const { processId } = await processes.start(project.id, { command: 'serve' });

    const response = await patch({ terminal: 'off' });

    expect(response.status).toBe(200);
    expect(((await response.json()) as Project).terminal).toBe('off');
    expect(runner.last().stops).toBe(1);
    expect((await processes.get(project.id, processId)).status).toBe('exited');
  });

  it('a PATCH to scripts, or one that does not name the terminal, stops nothing', async () => {
    const { project, runner, processes, patch } = await harness();
    await processes.start(project.id, { command: 'serve' });
    expect((await patch({ terminal: 'scripts' })).status).toBe(200);
    expect((await patch({ name: 'Renamed' })).status).toBe(200);
    expect(runner.last().stops).toBe(0);
  });

  it('an engine built without the terminal still takes the PATCH (D121)', async () => {
    const { patch } = await harness({ withTerminal: false });
    const response = await patch({ terminal: 'off' });
    expect(response.status).toBe(200);
    expect(((await response.json()) as Project).terminal).toBe('off');
  });
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `pnpm --filter @ace/engine exec vitest run src/processes/__tests__/terminal-off.test.ts`
Expected: FAIL in the first test: `expected 0 to be 1`. The PATCH stores `off` but stops nothing.

- [ ] **Step 3: Stop on off**

In `packages/engine/src/gateway/index.ts`, change the last line of the `PATCH /projects/:id` handler from:

```ts
    return c.json(await deps.graph.updateProject(id, patch));
  });
```

to:

```ts
    const updated = await deps.graph.updateProject(id, patch);
    // D301: off disables the terminal now, not only for new processes. Answered once all have ended.
    if (patch.terminal === 'off') await deps.processes?.stopProject(id);
    return c.json(updated);
  });
```

Run: `pnpm --filter @ace/engine exec vitest run src/processes && pnpm --filter @ace/engine build`
Expected: PASS, then a clean build.

- [ ] **Step 4: Write the failing integration test**

Create `apps/server/src/__tests__/processes.integration.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LOCAL_SCOPE } from '@ace/engine';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { startEngine, type RunningEngine } from '../server.js';

interface Frame {
  type: string;
  payload: { processId?: string; data?: string; [key: string]: unknown };
  seq?: number;
}

let engine: RunningEngine;
let dataDir: string;
let projectId: string;

async function api<T>(
  method: string,
  path: string,
  body?: unknown,
  target: RunningEngine = engine,
): Promise<{ status: number; json: T }> {
  const response = await fetch(`${target.url}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${target.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: (text === '' ? undefined : JSON.parse(text)) as T };
}

/** A `node -e` command line that survives both cmd.exe and /bin/sh. */
const node = (script: string) => `"${process.execPath}" -e "${script}"`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function until(check: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

async function newProject(target: RunningEngine, folder: string): Promise<string> {
  mkdirSync(folder, { recursive: true });
  return (await api<{ id: string }>('POST', '/projects', { name: 'Terminal', folderPath: folder }, target))
    .json.id;
}

async function watch(id: string): Promise<{ socket: WebSocket; frames: Frame[] }> {
  const socket = new WebSocket(`${engine.wsUrl}?token=${engine.token}`);
  const frames: Frame[] = [];
  socket.on('message', (data) => frames.push(JSON.parse(String(data)) as Frame));
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve());
    socket.on('error', reject);
  });
  socket.send(JSON.stringify({ type: 'subscribe', payload: { scope: 'project', id } }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  return { socket, frames };
}

const statusOf = async (id: string, processId: string): Promise<string> =>
  (await api<{ status: string }>('GET', `/projects/${id}/processes/${processId}`)).json.status;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ace-terminal-int-'));
  engine = await startEngine({ dataDir, port: 0, env: {} });
  projectId = await newProject(engine, join(dataDir, 'Terminal Project'));
});

afterAll(async () => {
  await engine.stop();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

describe('D301 the terminal through the real engine', () => {
  it('streams a real process’s output as process.output frames without a seq, then process.exited 0', async () => {
    const { socket, frames } = await watch(projectId);
    try {
      const before = await engine.ports.repository.events.currentSeq(LOCAL_SCOPE);
      const started = await api<{ processId: string }>('POST', `/projects/${projectId}/processes`, {
        command: node("console.log('one'); console.log('two'); console.log('three')"),
      });
      expect(started.status).toBe(201);
      const { processId } = started.json;

      await vi.waitFor(
        () =>
          expect(
            frames.some((f) => f.type === 'process.exited' && f.payload.processId === processId),
          ).toBe(true),
        { timeout: 10_000 },
      );
      const mine = frames.filter((frame) => frame.payload.processId === processId);
      const output = mine
        .filter((frame) => frame.type === 'process.output')
        .map((frame) => frame.payload.data)
        .join('')
        .replace(/\r/g, '');
      expect(output).toBe('one\ntwo\nthree\n');
      for (const frame of mine) expect(frame).not.toHaveProperty('seq');
      expect(mine.at(-1)).toEqual({
        type: 'process.exited',
        payload: { projectId, processId, exitCode: 0, signal: null, status: 'exited' },
      });

      const detail = await api<{ status: string; output: string }>(
        'GET',
        `/projects/${projectId}/processes/${processId}`,
      );
      expect(detail.json.status).toBe('exited');
      expect(detail.json.output.replace(/\r/g, '')).toBe('one\ntwo\nthree\n');
      // design §7: terminal output never reaches the event log.
      expect(await engine.ports.repository.events.currentSeq(LOCAL_SCOPE)).toBe(before);
    } finally {
      socket.close();
    }
  }, 30_000);

  it('a long-running process stops through /stop in under 3 s', async () => {
    const started = await api<{ processId: string }>('POST', `/projects/${projectId}/processes`, {
      command: node('setInterval(() => {}, 1000)'),
    });
    const { processId } = started.json;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await statusOf(projectId, processId)).toBe('running');

    const stoppedAt = Date.now();
    expect((await api('POST', `/projects/${projectId}/processes/${processId}/stop`)).status).toBe(204);
    expect(await until(async () => (await statusOf(projectId, processId)) !== 'running', 3_000)).toBe(
      true,
    );
    expect(Date.now() - stoppedAt).toBeLessThan(3_000);
  }, 30_000);

  it('turning the terminal off stops what runs, and refuses a new start', async () => {
    const started = await api<{ processId: string }>('POST', `/projects/${projectId}/processes`, {
      command: node('setInterval(() => {}, 1000)'),
    });
    const { processId } = started.json;
    try {
      expect((await api('PATCH', `/projects/${projectId}`, { terminal: 'off' })).status).toBe(200);
      expect(await statusOf(projectId, processId)).not.toBe('running');
      const refused = await api<{ error: { code: string } }>(
        'POST',
        `/projects/${projectId}/processes`,
        { command: node('1') },
      );
      expect(refused.status).toBe(403);
      expect(refused.json.error.code).toBe('terminal_disabled');
    } finally {
      await api('PATCH', `/projects/${projectId}`, { terminal: 'on' });
    }
  }, 30_000);

  it('refuses a working folder outside the project, as a file read would (FR-GIT-008)', async () => {
    const refused = await api<{ error: { code: string } }>('POST', `/projects/${projectId}/processes`, {
      command: node('1'),
      cwd: '..',
    });
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe('outside_project');
  });

  it('stopping the engine stops every process it started, grandchildren included', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ace-terminal-stop-'));
    const second = await startEngine({ dataDir: dir, port: 0, env: {} });
    try {
      const id = await newProject(second, join(dir, 'p'));
      const started = await api<{ processId: string }>(
        'POST',
        `/projects/${id}/processes`,
        {
          command: node(
            "require('child_process').spawn(process.execPath, ['-e', 'console.log([process.pid]); setInterval(() => {}, 1000)'], { stdio: 'inherit' }); console.log('parent ' + process.pid); setInterval(() => {}, 1000)",
          ),
        },
        second,
      );
      let output = '';
      expect(
        await until(async () => {
          output = (
            await api<{ output: string }>(
              'GET',
              `/projects/${id}/processes/${started.json.processId}`,
              undefined,
              second,
            )
          ).json.output;
          return /parent \d+/.test(output) && /\[ \d+ \]/.test(output);
        }, 10_000),
      ).toBe(true);
      const parent = Number(/parent (\d+)/.exec(output)?.[1]);
      const grandchild = Number(/\[ (\d+) \]/.exec(output)?.[1]);

      await second.stop();

      expect(await until(() => !isAlive(parent) && !isAlive(grandchild), 3_000)).toBe(true);
    } finally {
      await second.stop();
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, 30_000);
});
```

- [ ] **Step 5: Run it to watch it fail**

Run: `pnpm --filter @ace/server exec vitest run src/__tests__/processes.integration.test.ts`
Expected: FAIL. Every start answers 501 `not_implemented`: the server has no process service.

- [ ] **Step 6: Wire the server**

In `apps/server/src/server.ts`:
1. Add `createProcessService,` to the import from `'@ace/engine'`, after `createPolicyService,`.
2. Add `createProcessRunner,` to the import from `'@ace/tools'`, after `createFsProjectFiles,`.
3. After the `const workspace = createWorkspaceService({ … });` block (it ends at line 385), add:

```ts
  // Forge's terminal (D301): a person's commands as supervised processes. Agents never get it.
  const processes = createProcessService({
    repository,
    scope: LOCAL_SCOPE,
    runner: createProcessRunner(),
    bus,
    logger: logger.child({ subsystem: 'processes' }),
  });
```

4. In the `createEngineApp({ … })` call, after `workspace,`, add:

```ts
    /* IDE (D301): Forge's terminal. */
    processes,
```

5. In `shutdown()`, change:

```ts
    workspace.stopAll();
    hub.closeAll();
```

to:

```ts
    workspace.stopAll();
    // FR-SYS-008, D301: every terminal process stops, its whole tree with it, before the
    // database closes; none outlives the engine.
    await processes.stopAll();
    hub.closeAll();
```

- [ ] **Step 7: Run the integration test**

Run: `pnpm --filter @ace/server exec vitest run src/__tests__/processes.integration.test.ts`
Expected: PASS, in under 30 s.

- [ ] **Step 8: Full suites, typecheck, commit**

Run: `pnpm --filter @ace/server test && pnpm --filter @ace/server typecheck`
Expected: PASS. If an unrelated server test fails, re-run it alone before reporting; the known Windows EPERM on temp-dir cleanup is reported with the rerun's result.

```bash
npx prettier --write --config packages/config/prettier.config.js apps/server/src/server.ts apps/server/src/__tests__/processes.integration.test.ts packages/engine/src/processes/__tests__/terminal-off.test.ts packages/engine/src/gateway/index.ts
git add apps/server packages/engine
git commit -m "feat(server): the terminal on the real engine — off stops what runs, shutdown stops every process tree [D301] [FR-SYS-008]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: The WebSocket checks `Origin` (design §7)

**Files:**
- Modify:
  - `packages/engine/src/gateway/index.ts:186-232` (`isOriginAllowed`, `corsLayer`, `originGuard`);
  - `apps/server/src/server.ts:6-14` (imports), `:976` (`selfOrigins`), `:1017-1046` (the real port and the upgrade);
  - `packages/sdk/src/socket.ts:21-26` and `:157-169`;
  - `apps/web/src/runs/RunBar.tsx:128-136`.
- Create: `apps/web/src/runs/SocketNotice.tsx`
- Test:
  - create `packages/engine/src/gateway/__tests__/origin.test.ts`;
  - create `apps/server/src/__tests__/ws-origin.integration.test.ts`;
  - extend `packages/sdk/src/__tests__/socket.test.ts`;
  - create `apps/web/src/runs/SocketNotice.test.tsx`.

**Interfaces:**
- Consumes (Task 2): `WS_CLOSE_FORBIDDEN_ORIGIN = 4403`.
- Produces:
  - `type OriginDeps = Pick<EngineDeps, 'repository' | 'scope' | 'selfOrigins'>`;
  - `isOriginAllowed(deps: OriginDeps, origin: string | undefined): Promise<boolean>`, exported from `@ace/engine`. A missing or empty Origin is allowed; otherwise the stored `settings.allowedOrigins` plus `selfOrigins` decide;
  - the server finishes a refused upgrade and closes it with 4403, before the hub sees it;
  - `selfOrigins` holds `http://127.0.0.1:<bound port>` and `http://localhost:<bound port>`;
  - `AceSocketStatus` gains `'forbidden_origin'`; the SDK never reconnects after 4403;
  - `SocketNotice({ status })` in `apps/web/src/runs/`, which the run bar shows.

- [ ] **Step 1: Write the failing tests**

Create `packages/engine/src/gateway/__tests__/origin.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { LOCAL_SCOPE } from '../../ports/index.js';
import { isOriginAllowed } from '../index.js';

describe('FR-SYS-003 D301 one Origin rule for REST and the WebSocket', () => {
  const deps = {
    repository: new FakeRepository(),
    scope: LOCAL_SCOPE,
    selfOrigins: ['http://127.0.0.1:47490', 'http://localhost:47490'],
  };

  it.each([
    [undefined, true],
    ['', true],
    ['http://localhost:5173', true],
    ['http://127.0.0.1:5173', true],
    ['http://127.0.0.1:47490', true],
    ['http://localhost:47490', true],
    ['https://evil.example', false],
    ['http://localhost:5174', false],
    ['null', false],
  ] as const)('Origin %j is allowed: %s', async (origin, allowed) => {
    expect(await isOriginAllowed(deps, origin)).toBe(allowed);
  });

  it('follows the stored allow-list, not a hard-coded one', async () => {
    const repository = new FakeRepository();
    await repository.settings.update(LOCAL_SCOPE, { allowedOrigins: ['https://ace.example'] });
    const own = { repository, scope: LOCAL_SCOPE };
    expect(await isOriginAllowed(own, 'https://ace.example')).toBe(true);
    expect(await isOriginAllowed(own, 'http://localhost:5173')).toBe(false);
  });
});
```

Create `apps/server/src/__tests__/ws-origin.integration.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WS_CLOSE_FORBIDDEN_ORIGIN } from '@ace/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { startEngine, type RunningEngine } from '../server.js';

let engine: RunningEngine;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ace-ws-origin-'));
  engine = await startEngine({ dataDir, port: 0, env: {} });
});

afterAll(async () => {
  await engine.stop();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

/** Opens a socket, closes it after the first frame, and answers the close code and the frames. */
function connect(origin?: string): Promise<{ code: number; frames: string[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `${engine.wsUrl}?token=${engine.token}`,
      origin === undefined ? {} : { origin },
    );
    const frames: string[] = [];
    socket.on('message', (data) => {
      frames.push(String(data));
      if (frames.length === 1) socket.close(1000);
    });
    socket.on('close', (code) => resolve({ code, frames }));
    socket.on('error', reject);
  });
}

describe('FR-SYS-003 D301 the WebSocket checks Origin like REST (design §7)', () => {
  it('closes a socket from a foreign origin with 4403, before a single frame', async () => {
    const refused = await connect('https://evil.example');
    expect(refused.code).toBe(WS_CLOSE_FORBIDDEN_ORIGIN);
    expect(refused.frames).toEqual([]);
  });

  it('greets a socket with no Origin, as curl and the CLI open one', async () => {
    const opened = await connect();
    expect(opened.code).toBe(1000);
    expect(JSON.parse(opened.frames[0] ?? '{}')).toMatchObject({ type: 'hello' });
  });

  it('greets an origin from the allow-list', async () => {
    const opened = await connect('http://localhost:5173');
    expect(JSON.parse(opened.frames[0] ?? '{}')).toMatchObject({ type: 'hello' });
  });

  it('greets the engine’s own origin on the port it really bound (port 0 here)', async () => {
    const opened = await connect(engine.url);
    expect(JSON.parse(opened.frames[0] ?? '{}')).toMatchObject({ type: 'hello' });
  });

  it('answers REST from the engine’s own origin on that real port too', async () => {
    const response = await fetch(`${engine.url}/api/v1/health`, {
      headers: { Authorization: `Bearer ${engine.token}`, Origin: engine.url },
    });
    expect(response.status).toBe(200);
  });
});
```

In `packages/sdk/src/__tests__/socket.test.ts`, change the first import to `import { WS_CLOSE_FORBIDDEN_ORIGIN, WS_CLOSE_UNAUTHORIZED, type WsServerFrame } from '@ace/contracts';`, and after the test `'does not reconnect after close code 4401 and reports unauthorized'`, add:

```ts
  it('does not reconnect after close code 4403 and reports forbidden_origin (FR-SYS-003, D301)', () => {
    const socket = makeSocket();
    const statuses: AceSocketStatus[] = [];
    socket.onStatus((s) => statuses.push(s));
    socket.connect();
    latest().serverOpen();
    latest().serverClose(WS_CLOSE_FORBIDDEN_ORIGIN);
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(statuses.at(-1)).toBe('forbidden_origin');
    expect(socket.status).toBe('forbidden_origin');
  });
```

Create `apps/web/src/runs/SocketNotice.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SocketNotice } from './SocketNotice';

describe('the run bar says what is wrong with the connection', () => {
  it('says reconnecting while the socket retries (FR-EXE-014)', () => {
    render(<SocketNotice status="reconnecting" />);
    expect(screen.getByTestId('socket-reconnecting')).toHaveTextContent('reconnecting…');
  });

  it('says this address may not connect after a 4403, and how to fix it (FR-SYS-003, D301)', () => {
    render(<SocketNotice status="forbidden_origin" />);
    const notice = screen.getByRole('alert');
    expect(notice).toHaveAttribute('data-testid', 'socket-forbidden-origin');
    expect(notice).toHaveTextContent('this address may not connect to the engine');
    expect(notice).toHaveAttribute('title', expect.stringContaining('allowedOrigins'));
  });

  it('says nothing while the connection is fine', () => {
    const { container } = render(<SocketNotice status="open" />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run them to watch them fail**

Run: `pnpm --filter @ace/engine exec vitest run src/gateway/__tests__/origin.test.ts`
Expected: FAIL. `isOriginAllowed` is not exported.

Run: `pnpm --filter @ace/server exec vitest run src/__tests__/ws-origin.integration.test.ts`
Expected: FAIL. The foreign origin is greeted (`expected 1000 to be 4403`), and the engine's own origin answers 403 on REST, because `selfOrigins` names port 0.

Run: `pnpm --filter @ace/sdk exec vitest run src/__tests__/socket.test.ts`
Expected: FAIL. The socket schedules a reconnect after 4403.

Run: `pnpm --filter @ace/web exec vitest run src/runs/SocketNotice.test.tsx`
Expected: FAIL. `./SocketNotice` does not exist.

- [ ] **Step 3: One Origin rule in the gateway**

In `packages/engine/src/gateway/index.ts`, insert before the `corsLayer` doc comment (line 186):

```ts
/** What the Origin rule reads: the stored allow-list and the engine's own origins. */
export type OriginDeps = Pick<EngineDeps, 'repository' | 'scope' | 'selfOrigins'>;

/**
 * FR-SYS-003: may a request from this `Origin` come in? One rule for REST (`originGuard`, and
 * `corsLayer` for what the browser may read) and for the WebSocket upgrade (design §7), so the
 * three can never disagree. A missing or empty Origin is allowed: curl and the CLI send none, and
 * a page cannot forge an allowed one.
 */
export async function isOriginAllowed(
  deps: OriginDeps,
  origin: string | undefined,
): Promise<boolean> {
  if (origin === undefined || origin === '') return true;
  const settings = await deps.repository.settings.get(deps.scope);
  return settings.allowedOrigins.includes(origin) || (deps.selfOrigins ?? []).includes(origin);
}

```

In `corsLayer`, replace the `origin:` callback with:

```ts
    origin: async (origin) =>
      origin !== '' && (await isOriginAllowed(deps, origin)) ? origin : null,
```

and replace the body of `originGuard` with:

```ts
  return async (c, next) => {
    const origin = c.req.header('Origin');
    if (!(await isOriginAllowed(deps, origin))) throw forbiddenOrigin(origin ?? '');
    return next();
  };
```

Run: `pnpm --filter @ace/engine exec vitest run src/gateway src/__tests__/gateway.test.ts && pnpm --filter @ace/engine build`
Expected: PASS (the existing CORS and foreign-origin tests are unchanged), then a clean build.

- [ ] **Step 4: The server**

In `apps/server/src/server.ts`:
1. Change the contracts import (lines 6-14) to add `WS_CLOSE_FORBIDDEN_ORIGIN,` after `WS_PATH,`.
2. Add `isOriginAllowed,` to the import from `'@ace/engine'`, after `haltActiveRuns,`.
3. Replace line 976:

```ts
  const selfOrigins = [`http://${BIND_HOST}:${port}`, `http://localhost:${port}`];
```

with:

```ts
  // Filled once the server is bound: with `port: 0` the configured port is not the real one
  // (D301). The gateway reads this array on every request, so filling it in place is enough.
  const selfOrigins: string[] = [];
```

4. After `const actualPort = bound.port;` add:

```ts
  selfOrigins.push(`http://${BIND_HOST}:${actualPort}`, `http://localhost:${actualPort}`);
```

5. Replace the whole `server.on('upgrade', …)` handler with:

```ts
  const originDeps = { repository, scope: LOCAL_SCOPE, selfOrigins };

  server.on('upgrade', (request, socket, head) => {
    const requestUrl = new URL(request.url ?? '/', url);
    if (requestUrl.pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    const origin = request.headers.origin;

    isOriginAllowed(originDeps, origin).then(
      (allowed) => {
        wss.handleUpgrade(request, socket, head, (ws) => {
          if (!allowed) {
            // design §7: the same allow-list as REST. Completed, then closed rather than
            // destroyed, so the client learns why and does not retry (FR-SYS-003).
            logger.warn({ subsystem: 'ws', origin }, 'refused a WebSocket from a foreign origin');
            ws.close(WS_CLOSE_FORBIDDEN_ORIGIN, 'forbidden origin');
            return;
          }
          void hub.handleConnection(
            {
              send: (data) => ws.send(data),
              close: (code, reason) => ws.close(code, reason),
              on: (event, handler) => {
                if (event === 'message') ws.on('message', (data) => handler(String(data)));
                else ws.on('close', () => handler(''));
              },
            },
            requestUrl.searchParams.get('token') ?? undefined,
          );
        });
      },
      () => socket.destroy(),
    );
  });
```

- [ ] **Step 5: The SDK**

In `packages/sdk/src/socket.ts`:
1. Add `WS_CLOSE_FORBIDDEN_ORIGIN,` to the import from `'@ace/contracts'`, before `WS_CLOSE_UNAUTHORIZED,`.
2. In the file's doc comment, change `A drop (any close but our own or 4401)` to `A drop (any close but our own, 4401 or 4403)`.
3. Change the status type to:

```ts
export type AceSocketStatus =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed'
  | 'unauthorized'
  /** 4403: this page's origin is not on the engine's allow-list (FR-SYS-003, D301). */
  | 'forbidden_origin';
```

4. In `socket.onclose`, after the `WS_CLOSE_UNAUTHORIZED` branch, add:

```ts
      if (event.code === WS_CLOSE_FORBIDDEN_ORIGIN) {
        // Retrying cannot change the page's origin; say so instead.
        setStatus('forbidden_origin');
        return;
      }
```

- [ ] **Step 6: The web's notice**

Create `apps/web/src/runs/SocketNotice.tsx`:

```tsx
import type { AceSocketStatus } from '@ace/sdk';

/**
 * What the run bar says about the connection: reconnecting while the socket retries (FR-EXE-014),
 * or that this page's address may not connect at all (FR-SYS-003, D301), which no retry fixes.
 */
export function SocketNotice({ status }: { status: AceSocketStatus }) {
  if (status === 'reconnecting') {
    return (
      <span role="status" data-testid="socket-reconnecting" className="font-machine text-xs text-fg-muted">
        reconnecting…
      </span>
    );
  }
  if (status === 'forbidden_origin') {
    return (
      <span
        role="alert"
        data-testid="socket-forbidden-origin"
        title="This page's address is not on the engine's allowed origins (settings.allowedOrigins). Add it there, then reload."
        className="font-machine text-xs text-danger"
      >
        this address may not connect to the engine
      </span>
    );
  }
  return null;
}
```

In `apps/web/src/runs/RunBar.tsx`, add `import { SocketNotice } from './SocketNotice';` beside the other local imports, and replace:

```tsx
      {socketStatus === 'reconnecting' && (
        <span
          role="status"
          data-testid="socket-reconnecting"
          className="font-machine text-xs text-fg-muted"
        >
          reconnecting…
        </span>
      )}
```

with:

```tsx
      <SocketNotice status={socketStatus} />
```

- [ ] **Step 7: Run every test of this task**

Run:

```bash
pnpm --filter @ace/engine exec vitest run src/gateway/__tests__/origin.test.ts
pnpm --filter @ace/server exec vitest run src/__tests__/ws-origin.integration.test.ts src/__tests__/workspace.integration.test.ts
pnpm --filter @ace/sdk exec vitest run src/__tests__/socket.test.ts
pnpm --filter @ace/web exec vitest run src/runs
```

Expected: PASS. The workspace integration test still opens its socket with no Origin, so it is unchanged.

- [ ] **Step 8: Full suites, build, commit**

Run: `pnpm --filter @ace/engine test && pnpm --filter @ace/server test && pnpm --filter @ace/sdk test && pnpm --filter @ace/sdk build && pnpm --filter @ace/web typecheck`
Expected: PASS.

```bash
npx prettier --write --config packages/config/prettier.config.js packages/engine/src/gateway apps/server/src/server.ts apps/server/src/__tests__/ws-origin.integration.test.ts packages/sdk/src/socket.ts packages/sdk/src/__tests__/socket.test.ts apps/web/src/runs/SocketNotice.tsx apps/web/src/runs/SocketNotice.test.tsx apps/web/src/runs/RunBar.tsx
git add packages/engine apps/server packages/sdk apps/web/src/runs
git commit -m "feat(server): the WebSocket checks Origin like REST and closes a foreign page with 4403; selfOrigins use the real port [D301] [FR-SYS-003]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 10: SDK — the six terminal methods

**Files:**
- Modify: `packages/sdk/src/client.ts:78-96` (imports), `:244-247` (a list schema), `:759-761` (the methods, after `repoStatus`)
- Test: create `packages/sdk/src/__tests__/processes.test.ts`

**Interfaces:**
- Consumes (Task 2): `ProcessStartRequestSchema`, `ProcessStartResponseSchema`, `ProcessInputRequestSchema`, `ProcessSummarySchema`, `ProcessDetailSchema`, `ProjectScriptsSchema` and their types.
- Produces, on `AceClient`:
  - `startProcess(projectId: Id, body: ProcessStartRequest): Promise<ProcessStartResponse>`;
  - `processInput(projectId: Id, processId: Id, data: string): Promise<void>`;
  - `stopProcess(projectId: Id, processId: Id): Promise<void>`;
  - `listProcesses(projectId: Id): Promise<ProcessSummary[]>`;
  - `getProcess(projectId: Id, processId: Id): Promise<ProcessDetail>`;
  - `projectScripts(projectId: Id): Promise<ProjectScripts>`.

- [ ] **Step 1: Write the failing tests**

Create `packages/sdk/src/__tests__/processes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { createAceClient } from '../client.js';
import { AceApiError } from '../errors.js';

const PID = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';
const PROC = '01J9YYYYYYYYYYYYYYYYYYYYYY';
const AT = '2026-10-10T10:00:00.000Z';
const BASE = `http://127.0.0.1:4747/api/v1/projects/${PID}/processes`;
const SUMMARY = {
  id: PROC,
  projectId: PID,
  label: 'dev',
  command: 'pnpm run dev',
  cwd: '',
  status: 'running',
  exitCode: null,
  signal: null,
  startedAt: AT,
};

interface Seen {
  method: string;
  url: string;
  body: unknown;
}

function clientAnswering(status: number, answer: unknown) {
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
      return new Response(answer === undefined ? null : JSON.stringify(answer), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return { client, seen };
}

describe('D301 the SDK’s terminal methods', () => {
  it('starts a typed command with POST and the validated body, and answers its id', async () => {
    const { client, seen } = clientAnswering(201, { processId: PROC });
    expect(await client.startProcess(PID, { command: 'node -v', cwd: 'src' })).toEqual({
      processId: PROC,
    });
    expect(seen).toEqual([{ method: 'POST', url: BASE, body: { command: 'node -v', cwd: 'src' } }]);
  });

  it('starts a script by name', async () => {
    const { client, seen } = clientAnswering(201, { processId: PROC });
    await client.startProcess(PID, { script: 'dev' });
    expect(seen[0]?.body).toEqual({ script: 'dev' });
  });

  it('refuses a body the contract refuses, before anything leaves', async () => {
    const { client, seen } = clientAnswering(201, { processId: PROC });
    const error = await client.startProcess(PID, { command: '   ' }).catch((e: unknown) => e);
    expect(AceApiError.is(error) && error.code).toBe('validation_failed');
    expect(seen).toEqual([]);
  });

  it('writes a line to stdin as { data }, and a 204 answers nothing', async () => {
    const { client, seen } = clientAnswering(204, undefined);
    await expect(client.processInput(PID, PROC, 'Ada\n')).resolves.toBeUndefined();
    expect(seen).toEqual([{ method: 'POST', url: `${BASE}/${PROC}/input`, body: { data: 'Ada\n' } }]);
  });

  it('stops with POST and no body', async () => {
    const { client, seen } = clientAnswering(204, undefined);
    await expect(client.stopProcess(PID, PROC)).resolves.toBeUndefined();
    expect(seen).toEqual([{ method: 'POST', url: `${BASE}/${PROC}/stop`, body: undefined }]);
  });

  it('lists the processes, reads one with its output, and reads the scripts', async () => {
    expect(await clientAnswering(200, [SUMMARY]).client.listProcesses(PID)).toEqual([SUMMARY]);
    const detail = { ...SUMMARY, output: 'listening on 3000\n', truncated: false };
    const reading = clientAnswering(200, detail);
    expect(await reading.client.getProcess(PID, PROC)).toEqual(detail);
    expect(reading.seen[0]?.url).toBe(`${BASE}/${PROC}`);
    const scripts = { packageManager: 'pnpm', scripts: [{ name: 'dev', command: 'vite' }] };
    const listing = clientAnswering(200, scripts);
    expect(await listing.client.projectScripts(PID)).toEqual(scripts);
    expect(listing.seen[0]?.url).toBe(`${BASE}/scripts`);
  });

  it('refuses an answer the contract does not describe', async () => {
    const { client } = clientAnswering(200, [{ ...SUMMARY, status: 'paused' }]);
    const error = await client.listProcesses(PID).catch((e: unknown) => e);
    expect(AceApiError.is(error) && error.code).toBe('invalid_response');
  });

  it('turns a 403 terminal_restricted into an AceApiError carrying the engine’s words', async () => {
    const message =
      "This project runs only its own package.json scripts in the terminal. Pick a script, or allow every command in the project's settings.";
    const { client } = clientAnswering(403, {
      error: { kind: 'invalid_config', code: 'terminal_restricted', message, retryable: false },
    });
    const error = await client.startProcess(PID, { command: 'ls' }).catch((e: unknown) => e);
    expect(AceApiError.is(error) && [error.status, error.code, error.message]).toEqual([
      403,
      'terminal_restricted',
      message,
    ]);
  });
});
```

- [ ] **Step 2: Run them to watch them fail**

Run: `pnpm --filter @ace/sdk exec vitest run src/__tests__/processes.test.ts`
Expected: FAIL. `client.startProcess is not a function`.

- [ ] **Step 3: The methods**

In `packages/sdk/src/client.ts`, after the `// Forge (D299): project files` import group (it ends with `type SaveFileResult,`), add:

```ts
  // Forge (D301): the terminal's processes
  ProcessDetailSchema,
  ProcessInputRequestSchema,
  ProcessStartRequestSchema,
  ProcessStartResponseSchema,
  ProcessSummarySchema,
  ProjectScriptsSchema,
  type ProcessDetail,
  type ProcessStartRequest,
  type ProcessStartResponse,
  type ProcessSummary,
  type ProjectScripts,
```

After `const ChatThreadListSchema = z.array(ChatThreadSchema);`, add:

```ts
/** `GET /projects/:id/processes` answers a bare array, running first (D301). */
const ProcessSummaryListSchema = z.array(ProcessSummarySchema);
```

After the `repoStatus` method, inside the returned object, add:

```ts

    /* IDE — Forge's terminal (D301, design §6.3) */
    startProcess: (projectId: Id, body: ProcessStartRequest): Promise<ProcessStartResponse> =>
      request('POST', `/projects/${projectId}/processes`, ProcessStartResponseSchema, {
        schema: ProcessStartRequestSchema,
        value: body,
      }),
    /** Writes `data` to the process's stdin as given; a line ends in `\n` on every platform. */
    processInput: (projectId: Id, processId: Id, data: string): Promise<void> =>
      request('POST', `/projects/${projectId}/processes/${processId}/input`, NoContentSchema, {
        schema: ProcessInputRequestSchema,
        value: { data },
      }),
    /** Kills the whole process tree; stopping a finished process is a 204 too. */
    stopProcess: (projectId: Id, processId: Id): Promise<void> =>
      request('POST', `/projects/${projectId}/processes/${processId}/stop`, NoContentSchema),
    listProcesses: (projectId: Id): Promise<ProcessSummary[]> =>
      request('GET', `/projects/${projectId}/processes`, ProcessSummaryListSchema),
    /** The summary and the kept output, for a terminal tab that re-attaches. */
    getProcess: (projectId: Id, processId: Id): Promise<ProcessDetail> =>
      request('GET', `/projects/${projectId}/processes/${processId}`, ProcessDetailSchema),
    projectScripts: (projectId: Id): Promise<ProjectScripts> =>
      request('GET', `/projects/${projectId}/processes/scripts`, ProjectScriptsSchema),
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @ace/sdk exec vitest run src/__tests__/processes.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite, build, commit**

Run: `pnpm --filter @ace/sdk test && pnpm --filter @ace/sdk build`
Expected: PASS.

```bash
npx prettier --write --config packages/config/prettier.config.js packages/sdk/src/client.ts packages/sdk/src/__tests__/processes.test.ts
git add packages/sdk
git commit -m "feat(sdk): start, input, stop, list and read processes, and the project's scripts [D301]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Web mocks — a scripted process runner on the mock engine

**Files:**
- Create: `apps/web/src/mocks/processes.ts`, `apps/web/src/mocks/handlers-processes.ts`
- Modify:
  - `apps/web/src/mocks/db.ts:1-33` (import) and `:281-290` (`updateProject` takes `terminal`);
  - `apps/web/src/mocks/browser.ts` (the handlers, `reset`, and `__aceMock.setTerminal`);
  - `apps/web/src/test/app.tsx` (the handlers and `processes.reset()`).
- Test: create `apps/web/src/mocks/handlers-processes.test.ts`

**Interfaces:**
- Consumes (Task 2): the process schemas, `PROCESS_*` limits, `PACKAGE_MANAGERS`, `TerminalTrust`, and the frames' shapes; the existing `MockDb.emit`, `filesOf`, `getProject`, `updateProject`.
- Produces:
  - `class MockProcesses(db: MockDb, options?: { tickMs?: number /* 500 */ })` with `start`, `input`, `stop`, `stopProject`, `list`, `get`, `scripts` and `reset`;
  - `MockProcessError(status, code, message, details?)`;
  - `MOCK_MESSAGES`: the engine's refusal messages, word for word (Task 6);
  - `createProcessHandlers(db: MockDb, processes: MockProcesses): HttpHandler[]`;
  - `MockDb.updateProject(id, patch: { name?, lastOpenedAt?, maxCostPerRunUsd?, terminal? })`;
  - `window.__aceMock.setTerminal(projectId, level: TerminalTrust)`;
  - from `test/app.tsx`: `export const processes: MockProcesses`, reset before every test.
- The scripted commands, which later web tests and e2e rely on:

  | Typed | Output | End |
  |---|---|---|
  | `echo <text>` | `<text>\n` | exit 0 |
  | `node -v` | `v24.0.0\n` | exit 0 |
  | `serve` | `listening on 3000\n`, then `GET / 200 (<n>)\n` every tick | until stopped: exit `null`, `SIGKILL` |
  | `ask` | `name? `, then `hello <line>\n` after one line of input | exit 0 |
  | `fail` | `something went wrong\n` on stderr | exit 1 |
  | `broken` | `Could not start: spawn /bin/sh ENOENT\r\n` on stderr | `failed` |
  | `<pm> run <script>` | `\n> <name>\n> <command>\n\n`, then that command's play | as that command |
  | anything else | `mock: <first word>: not found\n` on stderr | exit 127 |

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/mocks/handlers-processes.test.ts`:

```ts
import type { ServerFrame } from '@ace/contracts';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { MockDb } from './db';
import { createFakeWebSocket, type FakeWebSocketInstance } from './fake-socket';
import { createHandlers } from './handlers';
import { createProcessHandlers } from './handlers-processes';
import { MOCK_MESSAGES, MockProcesses } from './processes';

const db = new MockDb({ persist: false });
const processes = new MockProcesses(db, { tickMs: 20 });
const server = setupServer(...createProcessHandlers(db, processes), ...createHandlers(db));
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

const PACKAGE = JSON.stringify({
  packageManager: 'pnpm@9.15.9',
  scripts: { hello: 'echo hi from a script', dev: 'serve' },
});

let projectId: string;
let frames: ServerFrame[];
let socket: FakeWebSocketInstance;

beforeEach(async () => {
  db.reset();
  projectId = db.createProject({ name: 'P' }).id;
  db.seedFiles(projectId, { 'src/app.ts': 'export {};\n', 'package.json': PACKAGE });
  frames = [];
  const Socket = createFakeWebSocket(db);
  socket = new Socket('ws://mock/ws?token=t');
  socket.onmessage = (event) => frames.push(JSON.parse(String(event.data)) as ServerFrame);
  await new Promise((resolve) => setTimeout(resolve, 5));
  socket.send(JSON.stringify({ type: 'subscribe', payload: { scope: 'project', id: projectId } }));
});
afterEach(() => {
  socket.close();
  processes.reset();
  server.resetHandlers();
});

const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`http://mock.local/api/v1/projects/${projectId}${path}`, {
    method,
    headers: {
      authorization: 'Bearer t',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: (text === '' ? undefined : JSON.parse(text)) as Record<string, unknown> | undefined,
  };
};

const start = async (body: unknown): Promise<string> => {
  const answer = await call('POST', '/processes', body);
  expect(answer.status).toBe(201);
  return String(answer.json?.processId);
};

const outputOf = (processId: string, stream?: 'stdout' | 'stderr'): string =>
  frames
    .flatMap((frame) =>
      frame.type === 'process.output' &&
      frame.payload.processId === processId &&
      (stream === undefined || frame.payload.stream === stream)
        ? [frame.payload.data]
        : [],
    )
    .join('');

const exitOf = (processId: string) =>
  frames.flatMap((frame) =>
    frame.type === 'process.exited' && frame.payload.processId === processId ? [frame.payload] : [],
  )[0];

const ended = (processId: string) => vi.waitFor(() => expect(exitOf(processId)).toBeDefined());

describe('D301 the mock engine’s scripted processes', () => {
  it('echo prints its text and exits 0, on the project scope, transient', async () => {
    const id = await start({ command: 'echo hello' });
    await ended(id);
    expect(outputOf(id)).toBe('hello\n');
    expect(exitOf(id)).toEqual({ projectId, processId: id, exitCode: 0, signal: null, status: 'exited' });
    expect(frames.filter((frame) => frame.type.startsWith('process.')).every((f) => !('seq' in f))).toBe(
      true,
    );
  });

  it('node -v answers v24.0.0; fail writes stderr and exits 1; an unknown command exits 127', async () => {
    const node = await start({ command: 'node -v' });
    const fail = await start({ command: 'fail' });
    const unknown = await start({ command: 'nosuch --flag' });
    await ended(node);
    await ended(fail);
    await ended(unknown);
    expect(outputOf(node)).toBe('v24.0.0\n');
    expect(outputOf(fail, 'stderr')).toBe('something went wrong\n');
    expect(exitOf(fail)?.exitCode).toBe(1);
    expect(outputOf(unknown, 'stderr')).toBe('mock: nosuch: not found\n');
    expect(exitOf(unknown)?.exitCode).toBe(127);
  });

  it('broken never starts: its reason on stderr and status failed (design §10)', async () => {
    const id = await start({ command: 'broken' });
    await ended(id);
    expect(outputOf(id, 'stderr')).toBe('Could not start: spawn /bin/sh ENOENT\r\n');
    expect(exitOf(id)).toMatchObject({ status: 'failed', exitCode: null });
  });

  it('ask prompts, reads one line of input and greets it; input to a finished process is 409', async () => {
    const id = await start({ command: 'ask' });
    await vi.waitFor(() => expect(outputOf(id)).toBe('name? '));
    expect((await call('POST', `/processes/${id}/input`, { data: 'Ada\n' })).status).toBe(204);
    await ended(id);
    expect(outputOf(id)).toBe('name? hello Ada\n');
    const late = await call('POST', `/processes/${id}/input`, { data: 'x\n' });
    expect(late.status).toBe(409);
    expect(late.json).toMatchObject({
      error: { code: 'process_not_running', message: MOCK_MESSAGES.process_not_running },
    });
  });

  it('serve prints a line every tick until Stop, which ends it SIGKILL; stopping again is 204', async () => {
    const id = await start({ command: 'serve' });
    await vi.waitFor(() => expect(outputOf(id)).toContain('GET / 200 (2)'));
    expect(outputOf(id).startsWith('listening on 3000\n')).toBe(true);
    expect((await call('POST', `/processes/${id}/stop`)).status).toBe(204);
    await ended(id);
    expect(exitOf(id)).toMatchObject({ exitCode: null, signal: 'SIGKILL', status: 'exited' });
    expect((await call('POST', `/processes/${id}/stop`)).status).toBe(204);
  });

  it('reads the scripts from the seeded package.json and runs one as <pm> run <name>', async () => {
    expect((await call('GET', '/processes/scripts')).json).toEqual({
      packageManager: 'pnpm',
      scripts: [
        { name: 'hello', command: 'echo hi from a script' },
        { name: 'dev', command: 'serve' },
      ],
    });
    const script = await start({ script: 'hello' });
    const typed = await start({ command: 'pnpm run hello' });
    await ended(script);
    await ended(typed);
    const expected = '\n> hello\n> echo hi from a script\n\nhi from a script\n';
    expect(outputOf(script)).toBe(expected);
    expect(outputOf(typed)).toBe(expected);
    expect((await call('GET', `/processes/${script}`)).json).toMatchObject({
      label: 'hello',
      command: 'pnpm run hello',
      output: expected,
    });
  });

  it('answers npm and no scripts without a package.json, and reads a lockfile', async () => {
    delete db.filesOf(projectId)['package.json'];
    expect((await call('GET', '/processes/scripts')).json).toEqual({ packageManager: 'npm', scripts: [] });
    db.seedFiles(projectId, { 'yarn.lock': '' });
    expect((await call('GET', '/processes/scripts')).json).toMatchObject({ packageManager: 'yarn' });
  });

  it('scripts trust refuses a typed command with the engine’s words, and still runs a script', async () => {
    db.updateProject(projectId, { terminal: 'scripts' });
    const refused = await call('POST', '/processes', { command: 'echo hi' });
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({
      error: { code: 'terminal_restricted', message: MOCK_MESSAGES.terminal_restricted },
    });
    await start({ script: 'hello' });
  });

  it('off refuses every start; a PATCH to off stops what runs, as the engine does', async () => {
    const id = await start({ command: 'serve' });
    const patched = await call('PATCH', '', { terminal: 'off' });
    expect(patched.status).toBe(200);
    expect(patched.json).toMatchObject({ terminal: 'off' });
    await ended(id);
    const refused = await call('POST', '/processes', { script: 'hello' });
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({ error: { code: 'terminal_disabled' } });
  });

  it('refuses a ninth running process with 409 process_limit', async () => {
    for (let i = 0; i < 8; i += 1) await start({ command: 'serve' });
    const ninth = await call('POST', '/processes', { command: 'serve' });
    expect(ninth.status).toBe(409);
    expect(ninth.json).toMatchObject({ error: { code: 'process_limit' } });
  });

  it('confines the working folder as the engine does', async () => {
    expect((await call('POST', '/processes', { command: 'echo', cwd: '..' })).json).toMatchObject({
      error: { code: 'outside_project' },
    });
    expect((await call('POST', '/processes', { command: 'echo', cwd: 'missing' })).status).toBe(400);
    expect((await call('POST', '/processes', { command: 'echo', cwd: 'src' })).status).toBe(201);
  });

  it('lists running first, then finished, newest first; an unknown process is 404', async () => {
    const done = await start({ command: 'echo a' });
    await ended(done);
    const running = await start({ command: 'serve' });
    const listed = (await call('GET', '/processes')).json as unknown as Array<{ id: string }>;
    expect(listed.map((summary) => summary.id)).toEqual([running, done]);
    expect((await call('GET', `/processes/${db.nextId()}`)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run them to watch them fail**

Run: `pnpm --filter @ace/web exec vitest run src/mocks/handlers-processes.test.ts`
Expected: FAIL. `./handlers-processes` and `./processes` do not exist.

- [ ] **Step 3: The scripted runner**

Create `apps/web/src/mocks/processes.ts`:

```ts
import {
  PACKAGE_MANAGERS,
  PROCESS_OUTPUT_MAX_CHARS,
  PROCESS_RECENT_MAX,
  PROCESS_RUNNING_MAX,
  type PackageManager,
  type ProcessDetail,
  type ProcessStartRequest,
  type ProcessStream,
  type ProcessSummary,
  type ProjectScript,
  type ProjectScripts,
} from '@ace/contracts';

import { newId } from '../lib/ulid';
import type { MockDb } from './db';

/**
 * The terminal's processes on the mock engine (D301, design §6.3), so the web app, its tests and
 * e2e run with zero env vars. Nothing is spawned; each command plays a script (see the table in
 * the Forge Phase 2 plan, Task 11). Frames go out on the project scope, transient, as the
 * engine's do, and everything lives in memory: a reload is an engine restart.
 */

export class MockProcessError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** The engine's refusals, word for word (`packages/engine/src/processes/errors.ts`). */
export const MOCK_MESSAGES = {
  terminal_disabled:
    "The terminal is off for this project. Turn it on in the project's settings to run commands.",
  terminal_restricted:
    "This project runs only its own package.json scripts in the terminal. Pick a script, or allow every command in the project's settings.",
  process_limit: `This project already runs ${PROCESS_RUNNING_MAX} processes. Stop one before starting another.`,
  process_not_running: 'That process has finished, so it reads no more input.',
} as const;

const LOCKFILES: ReadonlyArray<readonly [file: string, manager: PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
];

interface Run {
  summary: ProcessSummary;
  output: string;
  truncated: boolean;
  order: number;
  timers: Array<ReturnType<typeof setTimeout>>;
  /** What `ask` does with the next line typed to it. */
  onLine: ((line: string) => void) | undefined;
  /** Typed text not yet ended by a newline. */
  partial: string;
}

export interface MockProcessesOptions {
  /** How often `serve` prints a line. */
  tickMs?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export class MockProcesses {
  private readonly runs = new Map<string, Run>();
  private order = 0;
  private readonly tickMs: number;

  constructor(
    private readonly db: MockDb,
    options: MockProcessesOptions = {},
  ) {
    this.tickMs = options.tickMs ?? 500;
  }

  /** Forget every process and cancel every timer (tests, `__aceMock.reset`). */
  reset(): void {
    for (const run of this.runs.values()) this.clearTimers(run);
    this.runs.clear();
  }

  scripts(projectId: string): ProjectScripts {
    const fs = this.db.filesOf(projectId);
    const file = fs['package.json'];
    let manifest: unknown;
    try {
      manifest =
        file?.kind === 'file' ? (JSON.parse(file.content.replace(/^\uFEFF/, '')) as unknown) : undefined;
    } catch {
      manifest = undefined;
    }
    const scripts: ProjectScript[] = [];
    if (isRecord(manifest) && isRecord(manifest['scripts'])) {
      for (const [name, command] of Object.entries(manifest['scripts'])) {
        if (typeof command === 'string') scripts.push({ name, command });
      }
    }
    const field = isRecord(manifest) ? manifest['packageManager'] : undefined;
    const named =
      typeof field === 'string'
        ? PACKAGE_MANAGERS.find((manager) => manager === field.split('@')[0])
        : undefined;
    const locked = LOCKFILES.find(([lockfile]) => fs[lockfile]?.kind === 'file')?.[1];
    return { packageManager: named ?? locked ?? 'npm', scripts };
  }

  start(projectId: string, request: ProcessStartRequest): { processId: string } {
    const project = this.db.getProject(projectId);
    if (project === undefined) throw new MockProcessError(404, 'not_found', 'Project not found.');
    const trust = project.terminal ?? 'on';
    if (trust === 'off') {
      throw new MockProcessError(403, 'terminal_disabled', MOCK_MESSAGES.terminal_disabled);
    }
    let command: string;
    let label: string;
    if ('script' in request) {
      const known = this.scripts(projectId);
      if (!known.scripts.some((script) => script.name === request.script)) {
        throw new MockProcessError(404, 'not_found', `Script "${request.script}" was not found.`);
      }
      command = `${known.packageManager} run ${request.script}`;
      label = request.label ?? request.script;
    } else {
      if (trust === 'scripts') {
        throw new MockProcessError(403, 'terminal_restricted', MOCK_MESSAGES.terminal_restricted);
      }
      command = request.command;
      label = request.label ?? request.command.trim();
    }
    if (this.running(projectId).length >= PROCESS_RUNNING_MAX) {
      throw new MockProcessError(409, 'process_limit', MOCK_MESSAGES.process_limit, {
        max: PROCESS_RUNNING_MAX,
      });
    }
    const cwd = this.checkCwd(projectId, request.cwd ?? '');
    this.order += 1;
    const run: Run = {
      summary: {
        id: newId(),
        projectId,
        label,
        command,
        cwd,
        status: 'running',
        exitCode: null,
        signal: null,
        startedAt: new Date().toISOString(),
      },
      output: '',
      truncated: false,
      order: this.order,
      timers: [],
      onLine: undefined,
      partial: '',
    };
    this.runs.set(run.summary.id, run);
    // After the 201 is on its way, as a real process's first output would be.
    this.later(run, 0, () => this.play(run, command));
    return { processId: run.summary.id };
  }

  input(projectId: string, processId: string, data: string): void {
    const run = this.find(projectId, processId);
    if (run.summary.status !== 'running') {
      throw new MockProcessError(409, 'process_not_running', MOCK_MESSAGES.process_not_running, {
        processId,
      });
    }
    run.partial += data;
    let newline = run.partial.indexOf('\n');
    while (newline !== -1) {
      const line = run.partial.slice(0, newline).replace(/\r$/, '');
      run.partial = run.partial.slice(newline + 1);
      run.onLine?.(line);
      newline = run.partial.indexOf('\n');
    }
  }

  stop(projectId: string, processId: string): void {
    const run = this.find(projectId, processId);
    if (run.summary.status === 'running') this.end(run, 'exited', null, 'SIGKILL');
  }

  stopProject(projectId: string): void {
    for (const run of this.running(projectId)) this.end(run, 'exited', null, 'SIGKILL');
  }

  list(projectId: string): ProcessSummary[] {
    return [...this.runs.values()]
      .filter((run) => run.summary.projectId === projectId)
      .sort(
        (a, b) =>
          Number(b.summary.status === 'running') - Number(a.summary.status === 'running') ||
          b.order - a.order,
      )
      .map((run) => ({ ...run.summary }));
  }

  get(projectId: string, processId: string): ProcessDetail {
    const run = this.find(projectId, processId);
    return { ...run.summary, output: run.output, truncated: run.truncated };
  }

  private find(projectId: string, processId: string): Run {
    const run = this.runs.get(processId);
    if (run === undefined || run.summary.projectId !== projectId) {
      throw new MockProcessError(404, 'not_found', `Process ${processId} was not found.`);
    }
    return run;
  }

  private running(projectId: string): Run[] {
    return [...this.runs.values()].filter(
      (run) => run.summary.projectId === projectId && run.summary.status === 'running',
    );
  }

  /** The engine's confinement, in miniature (FR-GIT-008). */
  private checkCwd(projectId: string, cwd: string): string {
    const clean = cwd.split('\\').join('/').replace(/\/+$/, '');
    if (clean === '' || clean === '.') return '';
    const escapes =
      clean.includes('\u0000') ||
      clean.startsWith('/') ||
      /^[A-Za-z]:/.test(clean) ||
      clean.startsWith('~') ||
      clean.split('/').includes('..');
    if (escapes) {
      throw new MockProcessError(403, 'outside_project', 'That path is outside the project folder.');
    }
    if (clean.split('/').some((segment) => segment.toLowerCase() === '.git')) {
      throw new MockProcessError(403, 'protected_path', 'Forge does not read anything inside .git/.');
    }
    if (this.db.filesOf(projectId)[clean]?.kind !== 'folder') {
      throw new MockProcessError(400, 'invalid_path', `${clean} is not a folder in the project.`, {
        path: clean,
      });
    }
    return clean;
  }

  private play(run: Run, command: string): void {
    const line = command.trim();
    const script = /^(npm|pnpm|yarn|bun) run (\S+)$/.exec(line);
    if (script) {
      const body = this.scripts(run.summary.projectId).scripts.find(
        (each) => each.name === script[2],
      );
      if (body === undefined) {
        this.print(run, `mock: no script named "${script[2] ?? ''}"\n`, 'stderr');
        this.end(run, 'exited', 1, null);
        return;
      }
      this.print(run, `\n> ${body.name}\n> ${body.command}\n\n`);
      this.play(run, body.command);
      return;
    }
    const echo = /^echo(?:\s+(.*))?$/.exec(line);
    if (echo) {
      this.print(run, `${echo[1] ?? ''}\n`);
      this.end(run, 'exited', 0, null);
      return;
    }
    if (line === 'node -v' || line === 'node --version') {
      this.print(run, 'v24.0.0\n');
      this.end(run, 'exited', 0, null);
      return;
    }
    if (line === 'serve') {
      this.print(run, 'listening on 3000\n');
      let requests = 0;
      const tick = (): void => {
        requests += 1;
        this.print(run, `GET / 200 (${requests})\n`);
        this.later(run, this.tickMs, tick);
      };
      this.later(run, this.tickMs, tick);
      return;
    }
    if (line === 'ask') {
      this.print(run, 'name? ');
      run.onLine = (name) => {
        run.onLine = undefined;
        this.print(run, `hello ${name}\n`);
        this.end(run, 'exited', 0, null);
      };
      return;
    }
    if (line === 'fail') {
      this.print(run, 'something went wrong\n', 'stderr');
      this.end(run, 'exited', 1, null);
      return;
    }
    if (line === 'broken') {
      this.print(run, 'Could not start: spawn /bin/sh ENOENT\r\n', 'stderr');
      this.end(run, 'failed', null, null);
      return;
    }
    this.print(run, `mock: ${line.split(/\s+/)[0] ?? line}: not found\n`, 'stderr');
    this.end(run, 'exited', 127, null);
  }

  private print(run: Run, data: string, stream: ProcessStream = 'stdout'): void {
    if (run.summary.status !== 'running') return;
    run.output += data;
    if (run.output.length > PROCESS_OUTPUT_MAX_CHARS) {
      run.output = run.output.slice(-PROCESS_OUTPUT_MAX_CHARS);
      run.truncated = true;
    }
    const { projectId, id: processId } = run.summary;
    this.db.emit({
      type: 'process.output',
      payload: { projectId, processId, stream, data },
      scope: 'project',
      projectId,
      transient: true,
    });
  }

  private end(
    run: Run,
    status: 'exited' | 'failed',
    exitCode: number | null,
    signal: string | null,
  ): void {
    if (run.summary.status !== 'running') return;
    this.clearTimers(run);
    run.onLine = undefined;
    Object.assign(run.summary, { status, exitCode, signal, endedAt: new Date().toISOString() });
    const { projectId, id: processId } = run.summary;
    this.db.emit({
      type: 'process.exited',
      payload: { projectId, processId, exitCode, signal, status },
      scope: 'project',
      projectId,
      transient: true,
    });
    const finished = [...this.runs.values()]
      .filter((each) => each.summary.projectId === projectId && each.summary.status !== 'running')
      .sort((a, b) => a.order - b.order);
    for (const old of finished.slice(0, Math.max(0, finished.length - PROCESS_RECENT_MAX))) {
      this.runs.delete(old.summary.id);
    }
  }

  private later(run: Run, ms: number, fn: () => void): void {
    run.timers.push(setTimeout(fn, ms));
  }

  private clearTimers(run: Run): void {
    for (const timer of run.timers) clearTimeout(timer);
    run.timers = [];
  }
}
```

- [ ] **Step 4: The handlers**

Create `apps/web/src/mocks/handlers-processes.ts`:

```ts
import { ProcessInputRequestSchema, ProcessStartRequestSchema, aceError } from '@ace/contracts';
import { http, HttpResponse, type HttpHandler, type PathParams } from 'msw';

import type { MockDb } from './db';
import { MockProcessError, type MockProcesses } from './processes';

/**
 * Forge's terminal routes on the mock engine (D301, design §6.3), over a scripted `MockProcesses`.
 * Listed before the round handlers, so its PATCH hook sees a project update first.
 */

const API = '*/api/v1';

type Ctx = { request: Request; params: PathParams };

const hasToken = (request: Request): boolean =>
  /^Bearer\s+\S+$/.test(request.headers.get('authorization') ?? '');

function fail(status: number, code: string, message: string, details?: unknown): Response {
  const kind =
    status === 401 ? 'auth' : code === 'not_found' || status === 409 ? 'workflow' : 'invalid_config';
  return HttpResponse.json(aceError(kind, code, message, { details, retryable: false }), { status });
}

export function createProcessHandlers(db: MockDb, processes: MockProcesses): HttpHandler[] {
  const route =
    (handle: (projectId: string, ctx: Ctx) => Response | Promise<Response>) =>
    async (ctx: Ctx): Promise<Response> => {
      if (!hasToken(ctx.request)) return fail(401, 'unauthorized', 'Missing or invalid session token.');
      db.load();
      if (db.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, db.latencyMs));
      const projectId = String(ctx.params.id ?? '');
      if (db.getProject(projectId) === undefined) return fail(404, 'not_found', 'Project not found.');
      try {
        return await handle(projectId, ctx);
      } catch (error) {
        if (error instanceof MockProcessError) {
          return fail(error.status, error.code, error.message, error.details);
        }
        throw error;
      }
    };

  const invalid = (issues: unknown) =>
    fail(400, 'validation_failed', 'Request body is invalid.', issues);

  return [
    // Not a terminal route: a PATCH that turns the terminal off stops what runs first, as the
    // engine does (D301). It answers nothing, so the projects handler still applies the patch.
    http.patch(`${API}/projects/:id`, async ({ request, params }) => {
      const patch = (await request
        .clone()
        .json()
        .catch(() => undefined)) as { terminal?: unknown } | undefined;
      if (patch?.terminal === 'off') processes.stopProject(String(params.id ?? ''));
      return undefined;
    }),

    // Before `/:procId`, which would otherwise read "scripts" as a process id.
    http.get(
      `${API}/projects/:id/processes/scripts`,
      route((projectId) => HttpResponse.json(processes.scripts(projectId))),
    ),

    http.get(
      `${API}/projects/:id/processes`,
      route((projectId) => HttpResponse.json(processes.list(projectId))),
    ),

    http.post(
      `${API}/projects/:id/processes`,
      route(async (projectId, { request }) => {
        const parsed = ProcessStartRequestSchema.safeParse(await request.json().catch(() => undefined));
        if (!parsed.success) return invalid(parsed.error.issues);
        return HttpResponse.json(processes.start(projectId, parsed.data), { status: 201 });
      }),
    ),

    http.get(
      `${API}/projects/:id/processes/:procId`,
      route((projectId, { params }) =>
        HttpResponse.json(processes.get(projectId, String(params.procId ?? ''))),
      ),
    ),

    http.post(
      `${API}/projects/:id/processes/:procId/input`,
      route(async (projectId, { request, params }) => {
        const parsed = ProcessInputRequestSchema.safeParse(await request.json().catch(() => undefined));
        if (!parsed.success) return invalid(parsed.error.issues);
        processes.input(projectId, String(params.procId ?? ''), parsed.data.data);
        return new HttpResponse(null, { status: 204 });
      }),
    ),

    http.post(
      `${API}/projects/:id/processes/:procId/stop`,
      route((projectId, { params }) => {
        processes.stop(projectId, String(params.procId ?? ''));
        return new HttpResponse(null, { status: 204 });
      }),
    ),
  ];
}
```

- [ ] **Step 5: The mock database, the browser hooks and the test harness**

In `apps/web/src/mocks/db.ts`, add `type TerminalTrust,` to the import from `'@ace/contracts'` (after `type Settings,`), and change `updateProject`'s signature (line 281) to:

```ts
  updateProject(
    id: string,
    patch: {
      name?: string;
      lastOpenedAt?: string;
      maxCostPerRunUsd?: number | null;
      /** D301: the terminal trust level; the PATCH handler passes it through. */
      terminal?: TerminalTrust;
    },
  ): Project | undefined {
```

In `apps/web/src/mocks/browser.ts`:
1. Change the first import to `import { derivePorts, type GuardrailCheckType, type RepoFileStatus, type TerminalTrust } from '@ace/contracts';`.
2. After `import { createForgeHandlers } from './handlers-forge';` add:

```ts
import { createProcessHandlers } from './handlers-processes';
import { MockProcesses } from './processes';
```

3. In the `__aceMock` type, after `setRepoStatus(…): void;`, add:

```ts
      /** Forge's terminal (D301): set a project's trust level; `off` stops what runs, as a PATCH does. */
      setTerminal(projectId: string, level: TerminalTrust): void;
```

4. In `startMocks`, change:

```ts
  const db = new MockDb({ persist: true });
  restoreScenario();
  const worker = setupWorker(
    ...createForgeHandlers(db),
```

to:

```ts
  const db = new MockDb({ persist: true });
  // In memory, like the engine's: a reload is an engine restart (D301).
  const processes = new MockProcesses(db);
  restoreScenario();
  const worker = setupWorker(
    ...createProcessHandlers(db, processes),
    ...createForgeHandlers(db),
```

5. In `reset()`, after `db.reset();`, add `processes.reset();`.
6. After the `setRepoStatus(projectId, files) { … },` member, add:

```ts
    setTerminal(projectId, level) {
      db.load();
      db.updateProject(projectId, { terminal: level });
      if (level === 'off') processes.stopProject(projectId);
    },
```

In `apps/web/src/test/app.tsx`:
1. After `import { createForgeHandlers } from '../mocks/handlers-forge';` add:

```ts
import { createProcessHandlers } from '../mocks/handlers-processes';
import { MockProcesses } from '../mocks/processes';
```

2. Change the server to:

```ts
export const db = new MockDb({ persist: false });
/** The mock engine's terminal processes (D301); reset before every test. */
export const processes = new MockProcesses(db);
/** Newest round first: a round 3 route wins over a round 2 stand-in for the same path. */
export const server = setupServer(
  ...createProcessHandlers(db, processes),
  ...createForgeHandlers(db),
```

(the rest of the list unchanged).
3. In `beforeEach`, after `db.reset();`, add `processes.reset();`.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @ace/web exec vitest run src/mocks/handlers-processes.test.ts src/mocks/handlers-forge.test.ts src/mocks/handlers.test.ts`
Expected: PASS.

- [ ] **Step 7: Full web suite, typecheck, commit**

Run: `pnpm --filter @ace/web test && pnpm --filter @ace/web typecheck`
Expected: PASS.

```bash
npx prettier --write --config packages/config/prettier.config.js apps/web/src/mocks/processes.ts apps/web/src/mocks/handlers-processes.ts apps/web/src/mocks/handlers-processes.test.ts apps/web/src/mocks/db.ts apps/web/src/mocks/browser.ts apps/web/src/test/app.tsx
git add apps/web/src/mocks apps/web/src/test/app.tsx
git commit -m "feat(web): the mock engine runs scripted terminal processes, reads package.json scripts and honours the trust level [D301]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 12: Web — the terminal's data layer: the shared project scope, the tab store, process frames and re-attach

**Files:**
- Create:
  - `apps/web/src/forge/project-scope.ts`;
  - `apps/web/src/forge/terminal/hooks.ts`;
  - `apps/web/src/forge/terminal/line-discipline.ts` (the state a tab keeps; Task 13 adds `feed`);
  - `apps/web/src/forge/terminal/terminal-store.ts`;
  - `apps/web/src/forge/terminal/process-events.ts`.
- Modify:
  - `apps/web/src/forge/files/project-socket.ts:66-106` (`useProjectFiles` through `useProjectScope`);
  - `apps/web/src/forge/ForgePage.tsx:5,11` (`useProcessEvents`);
  - `apps/web/src/test/app.tsx` (`installMockSocket`, the store reset).
- Test: create `apps/web/src/forge/project-scope.test.ts`, `apps/web/src/forge/terminal/terminal-store.test.ts`, `apps/web/src/forge/terminal/process-events.test.tsx`.

**Interfaces:**
- Consumes:
  - from Task 2: `PROCESS_OUTPUT_MAX_CHARS`, `ProcessSummary`;
  - from Task 10: `api().getProcess`, `listProcesses`, `projectScripts`, `stopProcess`;
  - from Task 11: `processes` (the mock runner) in `test/app.tsx`;
  - existing: `getSocket()`, `startSocket`, `stopSocket`, `createFakeWebSocket`, `dropMockSockets`, `AceApiError`.
- Produces:
  - `forge/project-scope.ts`: `retainProjectScope(socket: AceSocket, projectId: string): () => void` and `useProjectScope(projectId: string | undefined): void`;
  - `forge/terminal/hooks.ts`:
    - `processKeys.all | list | scripts (projectId)`;
    - `useProcessList(projectId)`, `useProjectScripts(projectId, enabled?)`, `useStopProcess(projectId)`;
    - `runningCount(list?: readonly ProcessSummary[]): number`;
  - `forge/terminal/line-discipline.ts`:
    - `HISTORY_MAX = 100`;
    - `LineState { line, cursor, history, recall, draft, busy }`;
    - `initialLineState(history?)`, `settleLine(state)`, `busyLine(state)`, `promptFor(cwd)` (`'~ $ '` at the root, `'src $ '` in `src`);
  - `forge/terminal/terminal-store.ts`:
    - `TERMINAL_SCROLLBACK_MAX = 1_048_576`, `UNOWNED_MAX = 20`;
    - `ExitInfo { exitCode, signal, status: 'exited' | 'failed' }`;
    - `TerminalTab { id, label, cwd, line, processId, base, live, total, epoch }`;
    - `ProjectTerminals { tabs, active, next }`, `UnownedProcess { output, exit }`, `EMPTY_TERMINALS`;
    - `scrollbackOf(tab)`, `exitLine(exit)`, `errorLine(message)`, `DROPPED_NOTE`, `LOST_NOTE`;
    - `useTerminalStore` with `newTab(projectId, { label?, cwd? }): string`, `closeTab`, `activate`, `rename`, `setLine`, `setCwd`, `write`, `clearScreen`, `idle`, `attach`, `output`, `exited`, `replaceLive`, `lost`, `reset`;
    - `useProjectTerminals(projectId)`, `tabOf(projectId, tabId)`, `ownerOf(projectId, processId)`;
  - `forge/terminal/process-events.ts`: `reattach(projectId, queryClient): Promise<void>` and `useProcessEvents(projectId): void`;
  - `test/app.tsx`: `installMockSocket()`, which starts the fake socket before each test and stops it after.
- **Task boundary.** `line-discipline.ts` is created here with only the state a tab keeps, because the store holds it; Task 13 adds `feed` and its key table to the same file.
- **How a tab holds its text.**
  - `base` is everything shown before the attached process's output: prompts, echo, earlier runs.
  - `live` is the attached process's output since it started, plus what was typed to it. A re-attach replaces `live` with the engine's copy.
  - `total` counts characters ever appended; `epoch` changes when text is replaced rather than appended (`clearScreen`, `replaceLive`).
  - The view writes `total` deltas, and rewrites everything when `epoch` changes (Task 13).

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/forge/project-scope.test.ts`:

```ts
import type { AceSocket } from '@ace/sdk';
import { describe, expect, it, vi } from 'vitest';

import { retainProjectScope } from './project-scope';

function stubSocket() {
  const subscribe = vi.fn();
  const unsubscribe = vi.fn();
  return { socket: { subscribe, unsubscribe } as unknown as AceSocket, subscribe, unsubscribe };
}

describe('D301 files and processes share one project subscription', () => {
  it('the first holder subscribes, and only the last to let go unsubscribes', () => {
    const { socket, subscribe, unsubscribe } = stubSocket();
    const files = retainProjectScope(socket, 'P');
    const terminal = retainProjectScope(socket, 'P');
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith({ scope: 'project', id: 'P' });

    files();
    expect(unsubscribe).not.toHaveBeenCalled();
    terminal();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledWith({ scope: 'project', id: 'P' });
  });

  it('a release called twice counts once', () => {
    const { socket, unsubscribe } = stubSocket();
    const first = retainProjectScope(socket, 'P');
    const second = retainProjectScope(socket, 'P');
    first();
    first();
    expect(unsubscribe).not.toHaveBeenCalled();
    second();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('counts each project and each socket apart', () => {
    const one = stubSocket();
    const two = stubSocket();
    retainProjectScope(one.socket, 'P');
    retainProjectScope(one.socket, 'Q');
    retainProjectScope(two.socket, 'P');
    expect(one.subscribe).toHaveBeenCalledTimes(2);
    expect(two.subscribe).toHaveBeenCalledTimes(1);
  });
});
```

Create `apps/web/src/forge/terminal/terminal-store.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';

import { busyLine, promptFor } from './line-discipline';
import {
  LOST_NOTE,
  TERMINAL_SCROLLBACK_MAX,
  UNOWNED_MAX,
  exitLine,
  scrollbackOf,
  useTerminalStore,
} from './terminal-store';

const P = 'p1';
const store = () => useTerminalStore.getState();
const tab = (id = 't1') => {
  const found = store().projects[P]?.tabs.find((each) => each.id === id);
  if (found === undefined) throw new Error(`no tab ${id}`);
  return found;
};
const shown = (id = 't1') => scrollbackOf(tab(id));

/** A tab running process X, as a start would leave it. */
function running(processId = 'X'): void {
  store().newTab(P);
  store().setLine(P, 't1', busyLine(tab().line));
  store().attach(P, 't1', processId);
}

beforeEach(() => store().reset());

describe('D301 terminal tabs live outside the view, per project', () => {
  it('prompts with the working folder, or ~ at the root', () => {
    expect(promptFor('')).toBe('~ $ ');
    expect(promptFor('src/app')).toBe('src/app $ ');
  });

  it('a new tab shows its prompt, becomes active and is named in order', () => {
    expect(store().newTab(P)).toBe('t1');
    expect(store().newTab(P, { label: 'dev', cwd: 'web' })).toBe('t2');
    expect(store().projects[P]).toMatchObject({ active: 't2', next: 3 });
    expect(tab('t1').label).toBe('Terminal 1');
    expect(shown('t1')).toBe('~ $ ');
    expect(tab('t2')).toMatchObject({ label: 'dev', cwd: 'web' });
    expect(shown('t2')).toBe('web $ ');
  });

  it('closing a tab activates its right neighbour, else its left', () => {
    store().newTab(P);
    store().newTab(P);
    store().newTab(P);
    store().activate(P, 't2');
    store().closeTab(P, 't2');
    expect(store().projects[P]?.active).toBe('t3');
    store().closeTab(P, 't3');
    expect(store().projects[P]?.active).toBe('t1');
    store().closeTab(P, 't1');
    expect(store().projects[P]).toMatchObject({ tabs: [], active: undefined });
  });

  it('renames a tab, ignoring a blank name', () => {
    store().newTab(P);
    store().rename(P, 't1', '  api  ');
    expect(tab().label).toBe('api');
    store().rename(P, 't1', '   ');
    expect(tab().label).toBe('api');
  });

  it('output of the attached process goes to its tab; its end says how it ended and prompts again', () => {
    running();
    store().output(P, 'X', 'boom\n');
    store().exited(P, 'X', { exitCode: 2, signal: null, status: 'exited' });
    expect(shown()).toBe('~ $ boom\n\u001b[2m[exit 2]\u001b[0m\r\n~ $ ');
    expect(tab()).toMatchObject({ processId: undefined, live: '' });
    expect(tab().line.busy).toBe(false);
  });

  it('starts the prompt on a new line when the output did not end one', () => {
    running();
    store().output(P, 'X', 'no newline');
    store().exited(P, 'X', { exitCode: 0, signal: null, status: 'exited' });
    expect(shown()).toBe('~ $ no newline\r\n~ $ ');
  });

  it('output that beats the start’s answer waits for the tab, and so does an early end', () => {
    store().newTab(P);
    store().output(P, 'X', 'hi\n');
    store().exited(P, 'X', { exitCode: 0, signal: null, status: 'exited' });
    expect(store().unowned['X']).toEqual({
      output: 'hi\n',
      exit: { exitCode: 0, signal: null, status: 'exited' },
    });

    store().setLine(P, 't1', busyLine(tab().line));
    store().attach(P, 't1', 'X');
    expect(shown()).toBe('~ $ hi\n~ $ ');
    expect(store().unowned['X']).toBeUndefined();
    expect(tab().processId).toBeUndefined();
    expect(tab().line.busy).toBe(false);
  });

  it('a tab keeps only the last 1,048,576 characters', () => {
    expect(TERMINAL_SCROLLBACK_MAX).toBe(1_048_576);
    running();
    store().output(P, 'X', 'x'.repeat(TERMINAL_SCROLLBACK_MAX));
    store().output(P, 'X', 'END');
    expect(shown()).toHaveLength(TERMINAL_SCROLLBACK_MAX);
    expect(shown().endsWith('xEND')).toBe(true);
    expect(tab().total).toBe('~ $ '.length + TERMINAL_SCROLLBACK_MAX + 'END'.length);
  });

  it('never keeps half a character at the front', () => {
    running();
    store().output(P, 'X', `😀${'x'.repeat(TERMINAL_SCROLLBACK_MAX - 2)}`);
    expect(shown().startsWith('😀')).toBe(true);
    // one more character cuts through 😀: its second half must not stay behind
    store().output(P, 'X', '!');
    expect(shown().charCodeAt(0)).toBe('x'.charCodeAt(0));
    expect(shown()).toHaveLength(TERMINAL_SCROLLBACK_MAX - 1);
  });

  it('a re-attach replaces only the process’s part, and tells the view to redraw', () => {
    store().newTab(P);
    store().write(P, 't1', 'serve\r\n');
    store().setLine(P, 't1', busyLine(tab().line));
    store().attach(P, 't1', 'X');
    store().output(P, 'X', 'a\n');
    const { epoch } = tab();
    store().replaceLive(P, 'X', 'a\nb\n');
    expect(shown()).toBe('~ $ serve\r\na\nb\n');
    expect(tab().epoch).toBe(epoch + 1);
  });

  it('clearScreen empties the tab and redraws; idle puts the prompt back', () => {
    store().newTab(P, { cwd: 'src' });
    store().write(P, 't1', 'old\r\n');
    const { epoch } = tab();
    store().clearScreen(P, 't1');
    expect(shown()).toBe('');
    expect(tab().epoch).toBe(epoch + 1);
    store().idle(P, 't1');
    expect(shown()).toBe('src $ ');
  });

  it('a lost process ends the run with a note and the prompt', () => {
    running();
    store().lost(P, 'X');
    expect(shown()).toBe(`~ $ \r\n${LOST_NOTE}~ $ `);
    expect(tab().processId).toBeUndefined();
  });

  it('holds at most 20 processes no tab owns, dropping the oldest', () => {
    for (let i = 0; i < UNOWNED_MAX + 5; i += 1) store().output(P, `p${i}`, 'x');
    const kept = Object.keys(store().unowned);
    expect(kept).toHaveLength(UNOWNED_MAX);
    expect(kept[0]).toBe('p5');
  });

  it('says how a process ended: nothing for 0, the code, the signal, or that it never started', () => {
    expect(exitLine({ exitCode: 0, signal: null, status: 'exited' })).toBe('');
    expect(exitLine({ exitCode: 1, signal: null, status: 'exited' })).toBe(
      '\u001b[2m[exit 1]\u001b[0m\r\n',
    );
    expect(exitLine({ exitCode: null, signal: 'SIGKILL', status: 'exited' })).toBe(
      '\u001b[2m[stopped (SIGKILL)]\u001b[0m\r\n',
    );
    expect(exitLine({ exitCode: null, signal: null, status: 'failed' })).toBe(
      '\u001b[2m[could not start]\u001b[0m\r\n',
    );
  });
});
```

Create `apps/web/src/forge/terminal/process-events.test.tsx`:

```tsx
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { getSocket } from '../../app/socket';
import { dropMockSockets } from '../../mocks/fake-socket';
import { db, installMockServer, installMockSocket, processes, queryClient } from '../../test/app';
import { processKeys } from './hooks';
import { busyLine } from './line-discipline';
import { useProcessEvents } from './process-events';
import { LOST_NOTE, scrollbackOf, useTerminalStore } from './terminal-store';

installMockServer();
installMockSocket();

function Harness({ projectId }: { projectId: string }) {
  useProcessEvents(projectId);
  return null;
}

const mount = (projectId: string) =>
  render(
    <QueryClientProvider client={queryClient}>
      <Harness projectId={projectId} />
    </QueryClientProvider>,
  );

const store = () => useTerminalStore.getState();

const shown = (projectId: string): string => {
  const tab = store().projects[projectId]?.tabs[0];
  return tab === undefined ? '' : scrollbackOf(tab);
};

/** A tab attached to a process, as a start from the tab would leave it. */
function attachedTab(projectId: string, processId: string): string {
  const tabId = store().newTab(projectId);
  const tab = store().projects[projectId]?.tabs[0];
  if (tab !== undefined) store().setLine(projectId, tabId, busyLine(tab.line));
  store().attach(projectId, tabId, processId);
  return tabId;
}

const socketOpen = () =>
  vi.waitFor(() => expect(getSocket()?.status).toBe('open'), { timeout: 5_000 });

describe('D301 process frames reach the tab that owns the process', () => {
  it('folds the output and the end into the owning tab', async () => {
    const projectId = db.createProject({ name: 'P' }).id;
    mount(projectId);
    await socketOpen();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const { processId } = processes.start(projectId, { command: 'echo hello' });
    attachedTab(projectId, processId);
    await vi.waitFor(() => expect(shown(projectId)).toBe('~ $ hello\n~ $ '));
  });

  it('keeps the output of a process no tab owns, for the Processes list', async () => {
    const projectId = db.createProject({ name: 'P' }).id;
    mount(projectId);
    await socketOpen();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const { processId } = processes.start(projectId, { command: 'serve' });
    await vi.waitFor(() =>
      expect(store().unowned[processId]?.output).toContain('listening on 3000'),
    );
    processes.stop(projectId, processId);
  });

  it("a re-attach replaces the tab's output with the engine's copy, once", async () => {
    const projectId = db.createProject({ name: 'P' }).id;
    // It prints while nobody watches: as in Ideate, or with the socket down.
    const { processId } = processes.start(projectId, { command: 'serve' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    attachedTab(projectId, processId);
    expect(shown(projectId)).toBe('~ $ ');

    mount(projectId);
    await vi.waitFor(() =>
      expect(shown(projectId).startsWith('~ $ listening on 3000\n')).toBe(true),
    );

    // The engine went away and came back: hello re-attaches again, and nothing doubles.
    act(() => dropMockSockets());
    await vi.waitFor(() => expect(getSocket()?.status).toBe('reconnecting'));
    await socketOpen();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(shown(projectId).match(/listening on 3000/g)).toHaveLength(1);
    processes.stop(projectId, processId);
  });

  it('a process that ended while nobody looked ends the tab’s run on re-attach', async () => {
    const projectId = db.createProject({ name: 'P' }).id;
    const { processId } = processes.start(projectId, { command: 'echo hello' });
    await vi.waitFor(() => expect(processes.get(projectId, processId).status).toBe('exited'));
    attachedTab(projectId, processId);

    mount(projectId);
    await vi.waitFor(() => expect(shown(projectId)).toBe('~ $ hello\n~ $ '));
    expect(store().projects[projectId]?.tabs[0]?.processId).toBeUndefined();
  });

  it("a process the engine no longer knows ends the tab's run with a note", async () => {
    const projectId = db.createProject({ name: 'P' }).id;
    attachedTab(projectId, '01J9ZZZZZZZZZZZZZZZZZZZZZZ');

    mount(projectId);
    await vi.waitFor(() => expect(shown(projectId)).toBe(`~ $ \r\n${LOST_NOTE}~ $ `));
    expect(store().projects[projectId]?.tabs[0]?.processId).toBeUndefined();
  });

  it('refreshes the scripts when package.json changes on disk', async () => {
    const projectId = db.createProject({ name: 'P' }).id;
    mount(projectId);
    await socketOpen();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    act(() => db.writeFileExternally(projectId, 'package.json', '{"scripts":{"dev":"serve"}}'));
    await vi.waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: processKeys.scripts(projectId) }),
    );
    invalidate.mockRestore();
  });
});
```

- [ ] **Step 2: Run them to watch them fail**

Run: `pnpm --filter @ace/web exec vitest run src/forge/project-scope.test.ts src/forge/terminal`
Expected: FAIL. `./project-scope`, `./terminal-store`, `./line-discipline`, `./process-events` and `installMockSocket` do not exist.

- [ ] **Step 3: The shared project scope**

Create `apps/web/src/forge/project-scope.ts`:

```ts
import type { AceSocket } from '@ace/sdk';
import { useEffect } from 'react';

import { getSocket } from '../app/socket';

/** Per socket, so a restarted socket (tests) starts from zero. */
const holders = new WeakMap<AceSocket, Map<string, number>>();

/**
 * Holds the socket's `project` subscription while anyone needs it (D299, D301). The Explorer's
 * `files.changed` and the terminal's process frames share one subscription, so one consumer
 * leaving never cuts the other's feed: the first holder subscribes, the last to let go
 * unsubscribes. Answers the release, which counts once however often it is called.
 */
export function retainProjectScope(socket: AceSocket, projectId: string): () => void {
  const counts = holders.get(socket) ?? new Map<string, number>();
  holders.set(socket, counts);
  const payload = { scope: 'project' as const, id: projectId };
  const count = counts.get(projectId) ?? 0;
  counts.set(projectId, count + 1);
  if (count === 0) socket.subscribe(payload);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (counts.get(projectId) ?? 1) - 1;
    if (left > 0) {
      counts.set(projectId, left);
      return;
    }
    counts.delete(projectId);
    socket.unsubscribe(payload);
  };
}

/** While mounted, this component holds the project's scope. */
export function useProjectScope(projectId: string | undefined): void {
  useEffect(() => {
    const socket = getSocket();
    if (projectId === undefined || projectId === '' || socket === undefined) return;
    return retainProjectScope(socket, projectId);
  }, [projectId]);
}
```

In `apps/web/src/forge/files/project-socket.ts`:
1. Remove the `import type { AceSocket } from '@ace/sdk';` line, and add `import { useProjectScope } from '../project-scope';` after the `../../app/socket` import.
2. Replace everything from `/** Per socket, so a restarted socket (tests) starts from zero. */` (line 66) to the end of the file with:

```ts
/**
 * While mounted: hold the project's scope — the engine watches its folder meanwhile — and fold
 * each `files.changed` into the cache. Mounting also refreshes every file query of the project,
 * and so does a reconnect (`hello`): frames missed while away are never replayed, because they
 * are transient. The subscription is shared with the terminal (`useProjectScope`, D301).
 */
export function useProjectFiles(projectId: string | undefined): void {
  const queryClient = useQueryClient();
  useProjectScope(projectId);
  useEffect(() => {
    if (!projectId) return;
    void queryClient.invalidateQueries({ queryKey: fileKeys.all(projectId) });
    const socket = getSocket();
    if (!socket) return;
    const offChanged = socket.on('files.changed', (frame) => {
      if (frame.projectId === projectId) applyFilesChanged(queryClient, frame);
    });
    const offHello = socket.on('hello', () => {
      void queryClient.invalidateQueries({ queryKey: fileKeys.all(projectId) });
    });
    return () => {
      offChanged();
      offHello();
    };
  }, [projectId, queryClient]);
}
```

- [ ] **Step 4: The line state and the query hooks**

Create `apps/web/src/forge/terminal/line-discipline.ts`:

```ts
/**
 * The terminal's line discipline (D301, design §6.3). xterm only renders; this decides what a key
 * does — local echo, editing within the line, history, Enter and Ctrl+C. A tab keeps its state in
 * the terminal store, so a half-typed line survives the panel being hidden. `feed` (the key table)
 * is below the state.
 */

/** Entered commands a tab remembers for ↑/↓. */
export const HISTORY_MAX = 100;

export interface LineState {
  /** The line being typed. */
  line: string;
  /** Where the cursor is in `line`, 0…line.length. */
  cursor: number;
  /** Entered commands, oldest first, at most {@link HISTORY_MAX}. */
  history: readonly string[];
  /** Where ↑/↓ is in `history`; `history.length` is the line being typed. */
  recall: number;
  /** The line being typed when ↑ was first pressed; ↓ past the newest entry gives it back. */
  draft: string;
  /** A process runs, or is starting: Enter feeds its stdin and Ctrl+C stops it. */
  busy: boolean;
}

export function initialLineState(history: readonly string[] = []): LineState {
  return { line: '', cursor: 0, history, recall: history.length, draft: '', busy: false };
}

/** A run or a built-in finished: an empty line at a fresh prompt, history kept. */
export function settleLine(state: LineState): LineState {
  return { ...state, line: '', cursor: 0, recall: state.history.length, draft: '', busy: false };
}

/** A process started without typing (a script button): what is typed now goes to it. */
export function busyLine(state: LineState): LineState {
  return { ...settleLine(state), busy: true };
}

/** `~ $ ` at the project root, `src/app $ ` in a folder. */
export const promptFor = (cwd: string): string => `${cwd === '' ? '~' : cwd} $ `;
```

Create `apps/web/src/forge/terminal/hooks.ts`:

```ts
import type { ProcessSummary } from '@ace/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../../app/api';

/** Query keys for the terminal, under `['processes', projectId]`. */
export const processKeys = {
  all: (projectId: string) => ['processes', projectId] as const,
  list: (projectId: string) => ['processes', projectId, 'list'] as const,
  scripts: (projectId: string) => ['processes', projectId, 'scripts'] as const,
};

/** Running and recent processes; process frames and the mutations keep it fresh. */
export function useProcessList(projectId: string) {
  return useQuery({
    queryKey: processKeys.list(projectId),
    queryFn: () => api().listProcesses(projectId),
    enabled: projectId !== '',
    staleTime: 5_000,
  });
}

/** The project's own scripts; a change to package.json or a lockfile refreshes it. */
export function useProjectScripts(projectId: string, enabled = true) {
  return useQuery({
    queryKey: processKeys.scripts(projectId),
    queryFn: () => api().projectScripts(projectId),
    enabled: enabled && projectId !== '',
    staleTime: 30_000,
  });
}

export function useStopProcess(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (processId: string) => api().stopProcess(projectId, processId),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: processKeys.list(projectId) }),
  });
}

export const runningCount = (list: readonly ProcessSummary[] | undefined): number =>
  list?.filter((summary) => summary.status === 'running').length ?? 0;
```

- [ ] **Step 5: The tab store**

Create `apps/web/src/forge/terminal/terminal-store.ts`:

```ts
import { PROCESS_OUTPUT_MAX_CHARS } from '@ace/contracts';
import { create } from 'zustand';

import { initialLineState, promptFor, settleLine, type LineState } from './line-discipline';

/**
 * Terminal tabs, per project (D301, design §2.3): outside every component, so a tab's scrollback,
 * folder, history and half-typed line survive Ideate ↔ Forge and a hidden panel. In memory only:
 * a reload starts with no tabs, and the engine's processes show in the Processes list.
 */

/** A tab keeps as much as the engine keeps per process. */
export const TERMINAL_SCROLLBACK_MAX = PROCESS_OUTPUT_MAX_CHARS;
/** Processes no tab owns, whose output is held for the Processes list. */
export const UNOWNED_MAX = 20;

export interface ExitInfo {
  exitCode: number | null;
  signal: string | null;
  status: 'exited' | 'failed';
}

export interface TerminalTab {
  id: string;
  label: string;
  /** Project-relative; `''` is the root. Changed by the `cd` built-in only. */
  cwd: string;
  line: LineState;
  /** The process this tab runs, while it runs. */
  processId: string | undefined;
  /** What the tab shows before the attached process's output: prompts, echo, earlier runs. */
  base: string;
  /** The attached process's output, and what was typed to it; a re-attach replaces it. */
  live: string;
  /** Characters ever appended: what a view has not written yet is the difference. */
  total: number;
  /** Bumped when the text is replaced rather than appended; a view then rewrites it all. */
  epoch: number;
}

export interface ProjectTerminals {
  tabs: TerminalTab[];
  active: string | undefined;
  /** The number the next new tab is named by. */
  next: number;
}

export interface UnownedProcess {
  output: string;
  exit: ExitInfo | undefined;
}

export const EMPTY_TERMINALS: ProjectTerminals = { tabs: [], active: undefined, next: 1 };

export const scrollbackOf = (tab: TerminalTab): string => tab.base + tab.live;

const DIM = '\u001b[2m';
const RED = '\u001b[31m';
const RESET = '\u001b[0m';

/** What a tab prints when its process ends: nothing for a clean exit. */
export function exitLine(exit: ExitInfo): string {
  if (exit.status === 'failed') return `${DIM}[could not start]${RESET}\r\n`;
  if (exit.signal !== null) return `${DIM}[stopped (${exit.signal})]${RESET}\r\n`;
  if (exit.exitCode !== null && exit.exitCode !== 0) {
    return `${DIM}[exit ${exit.exitCode}]${RESET}\r\n`;
  }
  return '';
}

/** A refusal or failure, in red, on a line of its own (design §10). */
export const errorLine = (message: string): string => `${RED}${message}${RESET}\r\n`;

export const DROPPED_NOTE = `${DIM}[earlier output dropped: the engine keeps the last 1 MB]${RESET}\r\n`;
export const LOST_NOTE = `${DIM}[the engine no longer knows this process: it stopped when the engine restarted]${RESET}\r\n`;

const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** Drops a lone second half of a surrogate pair from the front of a cut. */
const clean = (text: string): string =>
  text !== '' && isLowSurrogate(text.charCodeAt(0)) ? text.slice(1) : text;

/** `base + live` cut to the last {@link TERMINAL_SCROLLBACK_MAX} characters, base first. */
function capped(base: string, live: string): { base: string; live: string } {
  const excess = base.length + live.length - TERMINAL_SCROLLBACK_MAX;
  if (excess <= 0) return { base, live };
  if (excess <= base.length) return { base: clean(base.slice(excess)), live };
  return { base: '', live: clean(live.slice(excess - base.length)) };
}

const keepLast = (text: string): string =>
  text.length <= TERMINAL_SCROLLBACK_MAX ? text : clean(text.slice(-TERMINAL_SCROLLBACK_MAX));

/** Appends to the process's part while one is attached, else before it. */
function append(tab: TerminalTab, text: string, into: 'auto' | 'base' = 'auto'): TerminalTab {
  if (text === '') return tab;
  const toLive = into === 'auto' && tab.processId !== undefined;
  const next = toLive ? capped(tab.base, tab.live + text) : capped(tab.base + text, tab.live);
  return { ...tab, ...next, total: tab.total + text.length };
}

/** The attached process ended: its output joins the rest, how it ended is said, the prompt is back. */
function finish(tab: TerminalTab, ending: string): TerminalTab {
  const shown = scrollbackOf(tab);
  const lineBreak = shown !== '' && !shown.endsWith('\n') ? '\r\n' : '';
  const folded: TerminalTab = {
    ...tab,
    base: tab.base + tab.live,
    live: '',
    processId: undefined,
    line: settleLine(tab.line),
  };
  return append(folded, `${lineBreak}${ending}${promptFor(tab.cwd)}`, 'base');
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

/** Changes one unowned entry; past {@link UNOWNED_MAX} the oldest is dropped. */
function remember(
  unowned: Record<string, UnownedProcess>,
  processId: string,
  change: (entry: UnownedProcess) => UnownedProcess,
): Record<string, UnownedProcess> {
  const next = { ...unowned, [processId]: change(unowned[processId] ?? { output: '', exit: undefined }) };
  const keys = Object.keys(next);
  for (const key of keys.slice(0, Math.max(0, keys.length - UNOWNED_MAX))) delete next[key];
  return next;
}

interface TerminalData {
  projects: Record<string, ProjectTerminals>;
  unowned: Record<string, UnownedProcess>;
}

interface TerminalState extends TerminalData {
  /** Opens a tab at its prompt, makes it active, and answers its id. */
  newTab(projectId: string, options?: { label?: string; cwd?: string }): string;
  closeTab(projectId: string, tabId: string): void;
  activate(projectId: string, tabId: string): void;
  rename(projectId: string, tabId: string, label: string): void;
  setLine(projectId: string, tabId: string, line: LineState): void;
  setCwd(projectId: string, tabId: string, cwd: string): void;
  /** Echo, a refusal, a built-in's answer: what the person sees next. */
  write(projectId: string, tabId: string, text: string): void;
  /** `cls` / `clear`. */
  clearScreen(projectId: string, tabId: string): void;
  /** Back to an empty prompt, with nothing running. */
  idle(projectId: string, tabId: string): void;
  /** The tab now runs this process; output and an end that came first are taken in. */
  attach(projectId: string, tabId: string, processId: string): void;
  output(projectId: string, processId: string, data: string): void;
  exited(projectId: string, processId: string, exit: ExitInfo): void;
  /** A re-attach: the engine's copy of the process's output replaces the tab's. */
  replaceLive(projectId: string, processId: string, output: string): void;
  /** The engine no longer knows the process: the run ends with a note. */
  lost(projectId: string, processId: string): void;
  reset(): void;
}

function findOwner(state: TerminalData, projectId: string, processId: string): TerminalTab | undefined {
  return state.projects[projectId]?.tabs.find((tab) => tab.processId === processId);
}

function withTab(
  state: TerminalData,
  projectId: string,
  tabId: string,
  change: (tab: TerminalTab) => TerminalTab,
): Partial<TerminalData> {
  const project = state.projects[projectId];
  const index = project?.tabs.findIndex((tab) => tab.id === tabId) ?? -1;
  const current = project?.tabs[index];
  if (project === undefined || current === undefined) return {};
  const tabs = [...project.tabs];
  tabs[index] = change(current);
  return { projects: { ...state.projects, [projectId]: { ...project, tabs } } };
}

export const useTerminalStore = create<TerminalState>()((set) => ({
  projects: {},
  unowned: {},

  newTab(projectId, options = {}) {
    let id = '';
    set((state) => {
      const project = state.projects[projectId] ?? EMPTY_TERMINALS;
      id = `t${project.next}`;
      const cwd = options.cwd ?? '';
      const prompt = promptFor(cwd);
      const tab: TerminalTab = {
        id,
        label: options.label ?? `Terminal ${project.next}`,
        cwd,
        line: initialLineState(),
        processId: undefined,
        base: prompt,
        live: '',
        total: prompt.length,
        epoch: 0,
      };
      return {
        projects: {
          ...state.projects,
          [projectId]: { tabs: [...project.tabs, tab], active: id, next: project.next + 1 },
        },
      };
    });
    return id;
  },

  closeTab: (projectId, tabId) =>
    set((state) => {
      const project = state.projects[projectId];
      if (project === undefined) return {};
      const index = project.tabs.findIndex((tab) => tab.id === tabId);
      if (index === -1) return {};
      const tabs = project.tabs.filter((tab) => tab.id !== tabId);
      const active =
        project.active === tabId ? (tabs[index] ?? tabs[index - 1])?.id : project.active;
      return { projects: { ...state.projects, [projectId]: { ...project, tabs, active } } };
    }),

  activate: (projectId, tabId) =>
    set((state) => {
      const project = state.projects[projectId];
      if (project === undefined || !project.tabs.some((tab) => tab.id === tabId)) return {};
      return { projects: { ...state.projects, [projectId]: { ...project, active: tabId } } };
    }),

  rename: (projectId, tabId, label) =>
    set((state) =>
      label.trim() === ''
        ? {}
        : withTab(state, projectId, tabId, (tab) => ({ ...tab, label: label.trim() })),
    ),

  setLine: (projectId, tabId, line) =>
    set((state) => withTab(state, projectId, tabId, (tab) => ({ ...tab, line }))),

  setCwd: (projectId, tabId, cwd) =>
    set((state) => withTab(state, projectId, tabId, (tab) => ({ ...tab, cwd }))),

  write: (projectId, tabId, text) =>
    set((state) => withTab(state, projectId, tabId, (tab) => append(tab, text))),

  clearScreen: (projectId, tabId) =>
    set((state) =>
      withTab(state, projectId, tabId, (tab) => ({ ...tab, base: '', live: '', epoch: tab.epoch + 1 })),
    ),

  idle: (projectId, tabId) =>
    set((state) =>
      withTab(state, projectId, tabId, (tab) => ({
        ...append(tab, promptFor(tab.cwd), 'base'),
        line: settleLine(tab.line),
      })),
    ),

  attach: (projectId, tabId, processId) =>
    set((state) => {
      const early = state.unowned[processId];
      const change = withTab(state, projectId, tabId, (tab) => {
        const attached = append({ ...tab, processId }, early?.output ?? '');
        return early?.exit === undefined ? attached : finish(attached, exitLine(early.exit));
      });
      return { ...change, unowned: without(state.unowned, processId) };
    }),

  output: (projectId, processId, data) =>
    set((state) => {
      const owner = findOwner(state, projectId, processId);
      if (owner !== undefined) return withTab(state, projectId, owner.id, (tab) => append(tab, data));
      return {
        unowned: remember(state.unowned, processId, (entry) => ({
          ...entry,
          output: keepLast(entry.output + data),
        })),
      };
    }),

  exited: (projectId, processId, exit) =>
    set((state) => {
      const owner = findOwner(state, projectId, processId);
      if (owner !== undefined) {
        return withTab(state, projectId, owner.id, (tab) => finish(tab, exitLine(exit)));
      }
      return { unowned: remember(state.unowned, processId, (entry) => ({ ...entry, exit })) };
    }),

  replaceLive: (projectId, processId, output) =>
    set((state) => {
      const owner = findOwner(state, projectId, processId);
      if (owner === undefined) return {};
      return withTab(state, projectId, owner.id, (tab) => ({
        ...tab,
        ...capped(tab.base, output),
        epoch: tab.epoch + 1,
      }));
    }),

  lost: (projectId, processId) =>
    set((state) => {
      const owner = findOwner(state, projectId, processId);
      if (owner === undefined) return {};
      return withTab(state, projectId, owner.id, (tab) => finish(tab, LOST_NOTE));
    }),

  reset: () => set({ projects: {}, unowned: {} }),
}));

/** One project's tabs; a stable empty value for a project with none. */
export function useProjectTerminals(projectId: string): ProjectTerminals {
  return useTerminalStore((state) => state.projects[projectId] ?? EMPTY_TERMINALS);
}

export function tabOf(projectId: string, tabId: string): TerminalTab | undefined {
  return useTerminalStore.getState().projects[projectId]?.tabs.find((tab) => tab.id === tabId);
}

export function ownerOf(projectId: string, processId: string): TerminalTab | undefined {
  return findOwner(useTerminalStore.getState(), projectId, processId);
}
```

- [ ] **Step 6: Process frames and re-attach**

Create `apps/web/src/forge/terminal/process-events.ts`:

```ts
import { AceApiError } from '@ace/sdk';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { api } from '../../app/api';
import { getSocket } from '../../app/socket';
import { useProjectScope } from '../project-scope';
import { processKeys } from './hooks';
import { DROPPED_NOTE, useTerminalStore } from './terminal-store';

/** A change to one of these, in the project root, can change the scripts or their manager. */
const SCRIPT_FILES = /^(package\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|package-lock\.json)$/;

/**
 * Re-attach every tab that runs a process (D301 decision 8). Process frames are transient, so
 * output printed while nobody watched — in Ideate, or with the socket down — is never replayed;
 * the engine's kept copy replaces what the tab holds for the process instead, so it shows once and
 * never doubles. A process that ended meanwhile ends the tab's run; one the engine no longer knows
 * (it restarted) says so and gives the prompt back.
 *
 * Accepted edge: a batch the engine emits after taking its copy, but which arrives before the HTTP
 * answer, is replaced away at the seam. At worst one 50 ms batch is lost on a reconnect; nothing
 * is ever shown twice.
 */
export async function reattach(projectId: string, queryClient: QueryClient): Promise<void> {
  void queryClient.invalidateQueries({ queryKey: processKeys.list(projectId) });
  const tabs = useTerminalStore.getState().projects[projectId]?.tabs ?? [];
  const attached = tabs.flatMap((tab) => (tab.processId === undefined ? [] : [tab.processId]));
  await Promise.all(
    attached.map(async (processId) => {
      const store = useTerminalStore.getState();
      try {
        const detail = await api().getProcess(projectId, processId);
        store.replaceLive(projectId, processId, (detail.truncated ? DROPPED_NOTE : '') + detail.output);
        if (detail.status !== 'running') {
          store.exited(projectId, processId, {
            exitCode: detail.exitCode,
            signal: detail.signal,
            status: detail.status,
          });
        }
      } catch (error) {
        if (AceApiError.is(error) && error.status === 404) store.lost(projectId, processId);
      }
    }),
  );
}

/**
 * While Forge is open (D301): hold the project's scope, fold each process frame into the tab that
 * owns the process (or keep it for the Processes list), and re-attach on entering and on every
 * reconnect (`hello`).
 */
export function useProcessEvents(projectId: string): void {
  const queryClient = useQueryClient();
  useProjectScope(projectId);
  useEffect(() => {
    if (projectId === '') return;
    void reattach(projectId, queryClient);
    const socket = getSocket();
    if (!socket) return;
    const offs = [
      socket.on('process.output', (payload) => {
        if (payload.projectId !== projectId) return;
        const before = useTerminalStore.getState();
        const known =
          before.projects[projectId]?.tabs.some((tab) => tab.processId === payload.processId) ===
            true || before.unowned[payload.processId] !== undefined;
        before.output(projectId, payload.processId, payload.data);
        // A process this window did not start (another browser tab, or before a reload).
        if (!known) void queryClient.invalidateQueries({ queryKey: processKeys.list(projectId) });
      }),
      socket.on('process.exited', (payload) => {
        if (payload.projectId !== projectId) return;
        useTerminalStore.getState().exited(projectId, payload.processId, {
          exitCode: payload.exitCode,
          signal: payload.signal,
          status: payload.status,
        });
        void queryClient.invalidateQueries({ queryKey: processKeys.list(projectId) });
      }),
      socket.on('files.changed', (payload) => {
        if (payload.projectId !== projectId) return;
        if (payload.resync || payload.changes.some((change) => SCRIPT_FILES.test(change.path))) {
          void queryClient.invalidateQueries({ queryKey: processKeys.scripts(projectId) });
        }
      }),
      socket.on('hello', () => void reattach(projectId, queryClient)),
    ];
    return () => offs.forEach((off) => off());
  }, [projectId, queryClient]);
}
```

In `apps/web/src/forge/ForgePage.tsx`, add `import { useProcessEvents } from './terminal/process-events';` after the `./files/project-socket` import, and after `useProjectFiles(projectId);` add:

```ts
  // D301: process frames reach their tabs while Forge is open; entering re-attaches each tab.
  useProcessEvents(projectId);
```

- [ ] **Step 7: The test harness**

In `apps/web/src/test/app.tsx`:
1. Add these imports:

```ts
import { startSocket, stopSocket } from '../app/socket';
import { useTerminalStore } from '../forge/terminal/terminal-store';
import { createFakeWebSocket } from '../mocks/fake-socket';
```

2. In `installMockServer`'s `beforeEach`, after `useProblemsStore.setState({ byProject: {} });`, add `useTerminalStore.getState().reset();`.
3. Append:

```ts
/**
 * The fake engine socket for tests that need frames (process output, files.changed): started
 * before each test against this file's mock database, stopped after. Call it after
 * `installMockServer()`, so it uses that test's query client.
 */
export function installMockSocket(): void {
  beforeEach(() => {
    startSocket({
      token: 'mock',
      queryClient,
      url: 'ws://mock.local/ws',
      WebSocket: createFakeWebSocket(db) as unknown as typeof WebSocket,
    });
  });
  afterEach(() => stopSocket());
}
```

- [ ] **Step 8: Run the tests**

Run: `pnpm --filter @ace/web exec vitest run src/forge/project-scope.test.ts src/forge/terminal src/forge/files src/forge/ForgeWorkbench.test.tsx`
Expected: PASS. The reconnect test waits for the SDK's 500 ms backoff, so the file takes about two seconds.

- [ ] **Step 9: Full web suite, typecheck, lint, commit**

Run: `pnpm --filter @ace/web test && pnpm --filter @ace/web typecheck && pnpm --filter @ace/web lint`
Expected: PASS.

```bash
npx prettier --write --config packages/config/prettier.config.js apps/web/src/forge/project-scope.ts apps/web/src/forge/project-scope.test.ts apps/web/src/forge/terminal apps/web/src/forge/files/project-socket.ts apps/web/src/forge/ForgePage.tsx apps/web/src/test/app.tsx
git add apps/web/src
git commit -m "feat(web): terminal tabs in a store, process frames to their tab, re-attach on entering and on reconnect, one shared project scope [D301]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 13: Web — the terminal view, the line discipline and the built-ins

**Files:**
- Modify:
  - `apps/web/package.json` (the four xterm packages, exact);
  - `apps/web/src/forge/terminal/line-discipline.ts` (append `feed` and its key table);
  - `apps/web/src/test/setup.tsx` (xterm mocked globally, after line 26);
  - `apps/web/src/test/app.tsx` (reset the fakes before each test);
  - `apps/web/src/app/stores/layout.ts:5` (`'terminal'`);
  - `apps/web/src/forge/panel/BottomPanel.tsx:10-14` and `:61-64` (the Terminal tab, first).
- Create:
  - `apps/web/src/forge/terminal/builtins.ts`;
  - `apps/web/src/forge/terminal/session.ts`;
  - `apps/web/src/forge/terminal/xterm-theme.ts`;
  - `apps/web/src/forge/terminal/TerminalView.tsx`;
  - `apps/web/src/forge/terminal/TerminalPanel.tsx`;
  - `apps/web/src/test/FakeTerminal.ts`.
- Test: create `apps/web/src/forge/terminal/line-discipline.test.ts`, `builtins.test.ts`, `TerminalPanel.test.tsx` and `apps/web/src/test/FakeTerminal.test.ts`.

**Interfaces:**
- Consumes:
  - from Task 12: `LineState`, `initialLineState`, `settleLine`, `promptFor`, `useTerminalStore` and its actions, `tabOf`, `scrollbackOf`, `errorLine`, `processKeys`, `useProcessEvents`, `installMockSocket`;
  - from Task 10: `api().startProcess`, `processInput`, `stopProcess`, `listFolder`;
  - existing: `useResolvedTheme`, `IconAction`, `useLayoutStore`.
- Produces:
  - in `line-discipline.ts`:
    - `type LineAction = { kind: 'run'; line } | { kind: 'input'; data } | { kind: 'stop' } | { kind: 'prompt' }`;
    - `interface LineStep { state: LineState; echo: string; actions: LineAction[] }`;
    - `feed(state: LineState, data: string): LineStep`, pure;
  - in `builtins.ts`: `type Builtin = { kind: 'cd'; arg: string | undefined } | { kind: 'clear' }`, `parseBuiltin(line): Builtin | undefined`, `resolveCd(cwd, arg): string`;
  - in `session.ts`:
    - `typed(projectId, tabId, data, queryClient): Promise<void>`, which settles when the actions this input caused have run;
    - `startInTab(projectId, tabId, request: ProcessStartRequest, queryClient): Promise<void>`;
    - `enqueue(projectId, tabId, work: () => Promise<void>): Promise<void>`;
  - `terminalTheme(theme: 'dark' | 'light'): ITheme`;
  - `TerminalView({ projectId, tabId })`, with the test ids `terminal-view` (its host) and, under `FakeTerminal`, `terminal-screen`;
  - `TerminalPanel({ projectId })`, test id `terminal-panel`. On mount it opens a first tab when the project has none;
  - `ForgePanelTab = 'terminal' | 'problems' | 'output'`; the panel's tabs read Terminal · Problems · Output;
  - the test double:
    - `FakeTerminal` (static `instances`, `latest()`; `options`, `written`, `disposed`, `type(data)`, `press(init): boolean`, `plain()`) and `screenText(stream)`;
    - `FakeFitAddon`, `FakeWebLinksAddon`, `FakeSearchAddon` (static `instances`, `calls`, `cleared`);
    - all registered in `setup.tsx` for every unit test.

**The line discipline's key table** (input as xterm's `onData` reports it):

| Input | Idle | Busy (a process runs) |
|---|---|---|
| printable text | inserted at the cursor, echoed with the rest of the line | the same |
| `\x7f` or `\b` (Backspace) | deletes left of the cursor | the same |
| `\x1b[3~` (Delete) | deletes at the cursor | the same |
| `\x1b[D` / `\x1b[C`, or `\x1bOD` / `\x1bOC` (←/→) | moves within the line | the same |
| `\x1b[H` / `\x1b[F` (Home/End) | to the start / end | the same |
| `\x1b[A` / `\x1b[B` (↑/↓) | walks the history; ↓ past the newest gives the draft back | the same |
| `\r`, `\r\n` or `\n` (Enter) | empty line: `prompt`; else `run` and remember it (no repeat of the last, at most 100) | `input` `line + '\n'`, not remembered |
| `\x03` (Ctrl+C) | echoes `^C`, clears the line: `prompt` | echoes `^C`, clears the line: `stop` |
| any other control character or escape | dropped | dropped |

A run sets `busy`, so the rest of a pasted block goes to the process it started.

- [ ] **Step 1: Add the dependencies**

```bash
pnpm --filter @ace/web add -E @xterm/xterm@6.0.0 @xterm/addon-fit@0.11.0 @xterm/addon-web-links@0.12.0 @xterm/addon-search@0.16.0
```

Expected: `apps/web/package.json` gains, under `dependencies`, `"@xterm/addon-fit": "0.11.0"`, `"@xterm/addon-search": "0.16.0"`, `"@xterm/addon-web-links": "0.12.0"` and `"@xterm/xterm": "6.0.0"`, and the lockfile updates. These versions were all released on 2025-12-22, checked on 2026-10-10 with `pnpm view <pkg> time --json`. If the registry is unreachable, stop and report; do not hand-edit the lockfile.

- [ ] **Step 2: Write the test double and register it**

Create `apps/web/src/test/FakeTerminal.ts`:

```ts
/**
 * xterm.js stands in as this in unit tests (registered in `setup.tsx`), so `TerminalView` runs for
 * real without a browser's canvas. What is written shows as plain text in a
 * `<pre data-testid="terminal-screen">`, and a test types with `FakeTerminal.latest().type(data)`,
 * exactly as xterm's `onData` reports keys. The real xterm runs in e2e.
 */

type Listener<T> = (value: T) => void;

interface Disposable {
  dispose(): void;
}

interface Addon {
  activate(terminal: FakeTerminal): void;
  dispose(): void;
}

/**
 * What a person would see: CR, LF (as CR LF, like xterm's `convertEol`), Backspace, cursor left
 * and right (`ESC [ n D`, `ESC [ n C`) and erase-to-end (`ESC [ K`) are applied; colours and every
 * other escape are dropped. Trailing spaces stay.
 */
export function screenText(stream: string): string {
  const lines: string[][] = [[]];
  let row = 0;
  let col = 0;
  const lineAt = (index: number): string[] => {
    let found = lines[index];
    if (found === undefined) {
      found = [];
      lines[index] = found;
    }
    return found;
  };
  for (let i = 0; i < stream.length; i += 1) {
    const ch = stream.charAt(i);
    if (ch === '\u001b') {
      // eslint-disable-next-line no-control-regex -- escape sequences are exactly what is parsed
      const match = /^\u001b\[([0-9;?]*)([A-Za-z~])/.exec(stream.slice(i));
      if (match !== null) {
        const n = Number(match[1] === '' ? '1' : match[1]);
        if (match[2] === 'D') col = Math.max(0, col - n);
        else if (match[2] === 'C') col += n;
        else if (match[2] === 'K') lineAt(row).length = Math.min(lineAt(row).length, col);
        i += match[0].length - 1;
      }
      continue;
    }
    if (ch === '\r') {
      col = 0;
      continue;
    }
    if (ch === '\n') {
      row += 1;
      col = 0;
      lineAt(row);
      continue;
    }
    if (ch === '\b') {
      col = Math.max(0, col - 1);
      continue;
    }
    const line = lineAt(row);
    while (line.length < col) line.push(' ');
    line[col] = ch;
    col += 1;
  }
  return lines.map((chars) => chars.join('')).join('\n');
}

export class FakeTerminal {
  static instances: FakeTerminal[] = [];

  /** The terminal opened last. */
  static latest(): FakeTerminal {
    const last = FakeTerminal.instances.at(-1);
    if (last === undefined) throw new Error('no terminal was opened');
    return last;
  }

  readonly options: Record<string, unknown>;
  cols = 80;
  rows = 24;
  /** Everything written since the last reset or clear. */
  written = '';
  disposed = false;
  focused = 0;
  keyHandler: ((event: KeyboardEvent) => boolean) | undefined;
  readonly addons: Addon[] = [];
  private screen: HTMLPreElement | undefined;
  private readonly dataListeners = new Set<Listener<string>>();

  constructor(options: Record<string, unknown> = {}) {
    this.options = { ...options };
    FakeTerminal.instances.push(this);
  }

  open(parent: HTMLElement): void {
    const screen = document.createElement('pre');
    screen.setAttribute('data-testid', 'terminal-screen');
    parent.appendChild(screen);
    this.screen = screen;
    this.render();
  }

  write(data: string | Uint8Array, callback?: () => void): void {
    this.written += typeof data === 'string' ? data : new TextDecoder().decode(data);
    this.render();
    callback?.();
  }

  writeln(data: string): void {
    this.write(`${data}\r\n`);
  }

  clear(): void {
    this.written = '';
    this.render();
  }

  reset(): void {
    this.written = '';
    this.render();
  }

  focus(): void {
    this.focused += 1;
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  hasSelection(): boolean {
    return false;
  }

  getSelection(): string {
    return '';
  }

  onData(listener: Listener<string>): Disposable {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onResize(): Disposable {
    return { dispose: () => undefined };
  }

  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
    this.keyHandler = handler;
  }

  loadAddon(addon: Addon): void {
    addon.activate(this);
    this.addons.push(addon);
  }

  dispose(): void {
    this.disposed = true;
    this.dataListeners.clear();
    for (const addon of this.addons) addon.dispose();
    this.screen?.remove();
  }

  /** Test: what the person types, as `onData` reports it (Enter is `\r`, Ctrl+C is `\x03`). */
  type(data: string): void {
    // Like xterm, a terminal with stdin disabled reports nothing typed.
    if (this.options['disableStdin'] === true) return;
    for (const listener of [...this.dataListeners]) listener(data);
  }

  /** Test: a key as the custom key handler sees it; answers whether xterm would handle it. */
  press(init: KeyboardEventInit): boolean {
    return this.keyHandler?.(new KeyboardEvent('keydown', init)) ?? true;
  }

  /** Test: the screen as a person reads it. */
  plain(): string {
    return screenText(this.written);
  }

  private render(): void {
    if (this.screen !== undefined) this.screen.textContent = this.plain();
  }
}

export class FakeFitAddon {
  fits = 0;
  activate = (): void => undefined;
  dispose = (): void => undefined;
  fit(): void {
    this.fits += 1;
  }
  proposeDimensions(): { cols: number; rows: number } {
    return { cols: 80, rows: 24 };
  }
}

export class FakeWebLinksAddon {
  constructor(readonly handler?: (event: MouseEvent, uri: string) => void) {}
  activate = (): void => undefined;
  dispose = (): void => undefined;
}

export class FakeSearchAddon {
  static instances: FakeSearchAddon[] = [];
  readonly calls: Array<[direction: 'next' | 'previous', term: string]> = [];
  cleared = 0;
  constructor() {
    FakeSearchAddon.instances.push(this);
  }
  activate = (): void => undefined;
  dispose = (): void => undefined;
  findNext(term: string): boolean {
    this.calls.push(['next', term]);
    return true;
  }
  findPrevious(term: string): boolean {
    this.calls.push(['previous', term]);
    return true;
  }
  clearDecorations(): void {
    this.cleared += 1;
  }
  clearActiveDecoration = (): void => undefined;
  onDidChangeResults = (): Disposable => ({ dispose: () => undefined });
}
```

In `apps/web/src/test/setup.tsx`, after the `EditorHost` mock (line 26), add:

```tsx
// Forge's terminal (D301): xterm needs a browser's canvas; every test gets FakeTerminal.
vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./FakeTerminal')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({
  FitAddon: (await import('./FakeTerminal')).FakeFitAddon,
}));
vi.mock('@xterm/addon-web-links', async () => ({
  WebLinksAddon: (await import('./FakeTerminal')).FakeWebLinksAddon,
}));
vi.mock('@xterm/addon-search', async () => ({
  SearchAddon: (await import('./FakeTerminal')).FakeSearchAddon,
}));
```

In `apps/web/src/test/app.tsx`, add `import { FakeSearchAddon, FakeTerminal } from './FakeTerminal';` and, in `installMockServer`'s `beforeEach`, after `useTerminalStore.getState().reset();`:

```ts
    FakeTerminal.instances = [];
    FakeSearchAddon.instances = [];
```

- [ ] **Step 3: Write the failing tests**

Create `apps/web/src/test/FakeTerminal.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { FakeTerminal, screenText } from './FakeTerminal';

describe('the FakeTerminal double shows what a person would see', () => {
  it('applies CR, LF, Backspace, cursor moves and erase-to-end, and drops colours', () => {
    expect(screenText('~ $ echo hx\b \bi')).toBe('~ $ echo hi');
    expect(screenText('ab\u001b[1Dc')).toBe('ac');
    expect(screenText('abc\u001b[2D\u001b[K')).toBe('a');
    expect(screenText('\u001b[31mred\u001b[0m\r\nnext')).toBe('red\nnext');
    expect(screenText('one\ntwo')).toBe('one\ntwo');
  });

  it('reports typing to onData, but not with stdin disabled', () => {
    const term = new FakeTerminal();
    const typed: string[] = [];
    term.onData((data) => typed.push(data));
    term.type('ls\r');
    term.options['disableStdin'] = true;
    term.type('no');
    expect(typed).toEqual(['ls\r']);
  });
});
```

Create `apps/web/src/forge/terminal/line-discipline.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { HISTORY_MAX, feed, initialLineState, type LineState } from './line-discipline';

const state = (overrides: Partial<LineState> = {}): LineState => {
  const base = initialLineState(overrides.history ?? []);
  return { ...base, ...overrides, recall: overrides.recall ?? (overrides.history ?? []).length };
};

describe('D301 the line discipline: keys to echo and actions', () => {
  it.each([
    {
      name: 'printable text at the end is echoed as typed',
      from: state(),
      input: 'ls',
      line: 'ls',
      cursor: 2,
      echo: 'ls',
    },
    {
      name: 'text inserted mid-line redraws the rest and steps back',
      from: state({ line: 'lx', cursor: 1 }),
      input: 's',
      line: 'lsx',
      cursor: 2,
      echo: 'sx\u001b[1D',
    },
    {
      name: 'Backspace at the end rubs out one character',
      from: state({ line: 'ls', cursor: 2 }),
      input: '\u007f',
      line: 'l',
      cursor: 1,
      echo: '\b \u001b[1D',
    },
    {
      name: 'Backspace mid-line pulls the rest left',
      from: state({ line: 'lsx', cursor: 2 }),
      input: '\b',
      line: 'lx',
      cursor: 1,
      echo: '\bx \u001b[2D',
    },
    {
      name: 'Backspace at the start does nothing',
      from: state({ line: 'ls', cursor: 0 }),
      input: '\u007f',
      line: 'ls',
      cursor: 0,
      echo: '',
    },
    {
      name: 'Delete removes the character under the cursor',
      from: state({ line: 'abc', cursor: 1 }),
      input: '\u001b[3~',
      line: 'ac',
      cursor: 1,
      echo: 'c \u001b[2D',
    },
    {
      name: '← moves left, and stops at the start',
      from: state({ line: 'ls', cursor: 1 }),
      input: '\u001b[D\u001b[D',
      line: 'ls',
      cursor: 0,
      echo: '\u001b[1D',
    },
    {
      name: '→ moves right in application mode too, and stops at the end',
      from: state({ line: 'ls', cursor: 1 }),
      input: '\u001bOC\u001b[C',
      line: 'ls',
      cursor: 2,
      echo: '\u001b[1C',
    },
    {
      name: 'Home and End jump to the ends',
      from: state({ line: 'abc', cursor: 3 }),
      input: '\u001b[H',
      line: 'abc',
      cursor: 0,
      echo: '\u001b[3D',
    },
    {
      name: 'other escapes and control characters are dropped',
      from: state({ line: 'ls', cursor: 2 }),
      input: '\u001b[15~\u001bOP\t\u0001',
      line: 'ls',
      cursor: 2,
      echo: '',
    },
  ])('$name', ({ from, input, line, cursor, echo }) => {
    const step = feed(from, input);
    expect(step.state.line).toBe(line);
    expect(step.state.cursor).toBe(cursor);
    expect(step.echo).toBe(echo);
    expect(step.actions).toEqual([]);
  });

  it('↑ recalls the newest command, ↑ again an older one, ↓ walks back to the draft', () => {
    let current = state({ history: ['a', 'bb'], line: 'x', cursor: 1 });
    const up = feed(current, '\u001b[A');
    expect(up.state).toMatchObject({ line: 'bb', cursor: 2, recall: 1, draft: 'x' });
    expect(up.echo).toBe('\u001b[1Dbb\u001b[K');
    current = feed(up.state, '\u001b[A').state;
    expect(current).toMatchObject({ line: 'a', recall: 0 });
    expect(feed(current, '\u001b[A').state).toMatchObject({ line: 'a', recall: 0 });
    current = feed(current, '\u001b[B').state;
    expect(current).toMatchObject({ line: 'bb', recall: 1 });
    const down = feed(current, '\u001b[B');
    expect(down.state).toMatchObject({ line: 'x', cursor: 1, recall: 2 });
    expect(down.echo).toBe('\u001b[2Dx\u001b[K');
    expect(feed(down.state, '\u001bOB').state).toMatchObject({ line: 'x', recall: 2 });
  });

  it('Enter with a command runs it, remembers it and goes busy', () => {
    const step = feed(state({ history: ['ls'], line: 'echo hi', cursor: 7 }), '\r');
    expect(step.actions).toEqual([{ kind: 'run', line: 'echo hi' }]);
    expect(step.echo).toBe('\r\n');
    expect(step.state).toMatchObject({ line: '', cursor: 0, busy: true, history: ['ls', 'echo hi'], recall: 2 });
  });

  it('Enter on an empty line only asks for a fresh prompt', () => {
    const step = feed(state({ line: '   ', cursor: 3 }), '\r');
    expect(step.actions).toEqual([{ kind: 'prompt' }]);
    expect(step.state).toMatchObject({ busy: false, history: [] });
  });

  it('Enter while a process runs sends the line and a newline to its stdin, unremembered', () => {
    const step = feed(state({ busy: true, line: 'Ada', cursor: 3 }), '\r');
    expect(step.actions).toEqual([{ kind: 'input', data: 'Ada\n' }]);
    expect(step.state).toMatchObject({ line: '', busy: true, history: [] });
  });

  it('Ctrl+C with nothing running clears the line and prompts again', () => {
    const step = feed(state({ line: 'oops', cursor: 4 }), '\u0003');
    expect(step.echo).toBe('^C\r\n');
    expect(step.actions).toEqual([{ kind: 'prompt' }]);
    expect(step.state).toMatchObject({ line: '', busy: false });
  });

  it('Ctrl+C while a process runs stops it, and stays busy until it has ended', () => {
    const step = feed(state({ busy: true, line: 'x', cursor: 1 }), '\u0003');
    expect(step.echo).toBe('^C\r\n');
    expect(step.actions).toEqual([{ kind: 'stop' }]);
    expect(step.state).toMatchObject({ line: '', busy: true });
  });

  it('a pasted block runs its first line, and its other lines go to what that started', () => {
    const step = feed(state(), 'echo a\r\necho b\r');
    expect(step.echo).toBe('echo a\r\necho b\r\n');
    expect(step.actions).toEqual([
      { kind: 'run', line: 'echo a' },
      { kind: 'input', data: 'echo b\n' },
    ]);
    expect(step.state.history).toEqual(['echo a']);
  });

  it('a pasted line ending in a bare \\n counts as Enter too', () => {
    expect(feed(state(), 'pwd\n').actions).toEqual([{ kind: 'run', line: 'pwd' }]);
  });

  it('remembers at most 100 commands and never the same one twice in a row', () => {
    let current = state();
    for (let i = 0; i < HISTORY_MAX + 5; i += 1) {
      current = { ...feed(current, `cmd ${i}\r`).state, busy: false };
    }
    current = { ...feed(current, `cmd ${HISTORY_MAX + 4}\r`).state, busy: false };
    expect(current.history).toHaveLength(HISTORY_MAX);
    expect(current.history[0]).toBe('cmd 5');
    expect(current.history.at(-1)).toBe(`cmd ${HISTORY_MAX + 4}`);
  });
});
```

Create `apps/web/src/forge/terminal/builtins.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { parseBuiltin, resolveCd } from './builtins';

describe('D301 the terminal’s built-ins: cd, cls and clear', () => {
  it.each([
    ['cd', { kind: 'cd', arg: undefined }],
    ['  cd   src  ', { kind: 'cd', arg: 'src' }],
    ['cd..', { kind: 'cd', arg: '..' }],
    ['CD "My Dir"', { kind: 'cd', arg: 'My Dir' }],
    ["cd 'a b'", { kind: 'cd', arg: 'a b' }],
    ['cls', { kind: 'clear' }],
    ['CLEAR', { kind: 'clear' }],
  ] as const)('%j is a built-in', (line, builtin) => {
    expect(parseBuiltin(line)).toEqual(builtin);
  });

  it.each(['cdx', 'echo cd', 'cd src && npm test', 'cd src | x', 'cd a; ls', 'cd > out', 'clear all'])(
    '%j goes to the shell (a chained cd does not persist, design §14)',
    (line) => {
      expect(parseBuiltin(line)).toBeUndefined();
    },
  );

  it.each([
    ['', 'src', 'src'],
    ['src', 'deep', 'src/deep'],
    ['src/deep', '..', 'src'],
    ['src', '../..', ''],
    ['', '..', ''],
    ['src', '/', ''],
    ['src', '~', ''],
    ['src', '~/web', 'web'],
    ['src', './a/./b/', 'src/a/b'],
    ['src', 'a\\b', 'src/a/b'],
  ])('from %j, cd %j leads to %j, never above the root', (cwd, arg, target) => {
    expect(resolveCd(cwd, arg)).toBe(target);
  });
});
```

Create `apps/web/src/forge/terminal/TerminalPanel.test.tsx`:

```tsx
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { api } from '../../app/api';
import { getSocket } from '../../app/socket';
import { useLayoutStore } from '../../app/stores/layout';
import {
  db,
  installMockServer,
  installMockSocket,
  processes,
  renderApp,
  renderWithQuery,
} from '../../test/app';
import { FakeSearchAddon, FakeTerminal } from '../../test/FakeTerminal';
import { BottomPanel } from '../panel/BottomPanel';
import { useProcessEvents } from './process-events';
import { TerminalPanel } from './TerminalPanel';

installMockServer();
installMockSocket();

vi.mock('../../canvas/Canvas', () => ({
  Canvas: ({ workflowId }: { workflowId: string }) => <div data-testid="canvas">{workflowId}</div>,
}));

function Harness({ projectId }: { projectId: string }) {
  useProcessEvents(projectId);
  return <TerminalPanel projectId={projectId} />;
}

async function open(): Promise<string> {
  const projectId = db.createProject({ name: 'Shop' }).id;
  db.seedFiles(projectId, { 'src/app.ts': 'export {};\n', 'src/deep/x.ts': '' });
  renderWithQuery(<Harness projectId={projectId} />);
  await screen.findByTestId('terminal-screen');
  await vi.waitFor(() => expect(getSocket()?.status).toBe('open'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  return projectId;
}

const term = () => FakeTerminal.latest();
const shown = () => term().plain();
const type = (data: string) => act(() => term().type(data));

describe('D301 a terminal tab runs what is typed', () => {
  it('shows a prompt at the project root', async () => {
    await open();
    expect(shown()).toBe('~ $ ');
  });

  it('typing echo hi and Enter starts it in the tab’s folder, shows its output and prompts again', async () => {
    const start = vi.spyOn(api(), 'startProcess');
    const projectId = await open();
    type('echo hi');
    expect(shown()).toBe('~ $ echo hi');
    type('\r');
    await waitFor(() => expect(shown()).toBe('~ $ echo hi\nhi\n~ $ '));
    expect(start).toHaveBeenCalledWith(projectId, { command: 'echo hi', cwd: '' });
    start.mockRestore();
  });

  it('what is typed while it runs goes to its stdin', async () => {
    await open();
    type('ask\r');
    await waitFor(() => expect(shown()).toContain('name? '));
    type('Ada\r');
    await waitFor(() => expect(shown()).toBe('~ $ ask\nname? Ada\nhello Ada\n~ $ '));
  });

  it('Ctrl+C stops what runs, and the tab says how it ended', async () => {
    const stop = vi.spyOn(api(), 'stopProcess');
    await open();
    type('serve\r');
    await waitFor(() => expect(shown()).toContain('listening on 3000'));
    type('\u0003');
    await waitFor(() => expect(shown()).toMatch(/\^C\n\[stopped \(SIGKILL\)\]\n~ \$ $/));
    expect(stop).toHaveBeenCalledTimes(1);
    stop.mockRestore();
  });

  it('Ctrl+C with nothing running clears the line and asks nothing of the engine', async () => {
    const start = vi.spyOn(api(), 'startProcess');
    await open();
    type('oops\u0003');
    await waitFor(() => expect(shown()).toBe('~ $ oops^C\n~ $ '));
    expect(start).not.toHaveBeenCalled();
    start.mockRestore();
  });

  it('cd moves the prompt and the next command’s folder; cd .. stops at the root; a missing folder says why', async () => {
    const start = vi.spyOn(api(), 'startProcess');
    const projectId = await open();
    type('cd src\r');
    await waitFor(() => expect(shown().endsWith('\nsrc $ ')).toBe(true));
    type('echo here\r');
    await waitFor(() => expect(shown().endsWith('here\nsrc $ ')).toBe(true));
    expect(start).toHaveBeenCalledWith(projectId, { command: 'echo here', cwd: 'src' });
    type('cd\r');
    await waitFor(() => expect(shown().endsWith('src $ cd\nsrc\nsrc $ ')).toBe(true));
    type('cd ../..\r');
    await waitFor(() => expect(shown().endsWith('src $ cd ../..\n~ $ ')).toBe(true));
    type('cd nope\r');
    await waitFor(() => expect(shown()).toContain('cd: nope: nope was not found.'));
    expect(shown().endsWith('~ $ ')).toBe(true);
    start.mockRestore();
  });

  it('cls clears the screen and leaves a prompt', async () => {
    await open();
    type('echo a\r');
    await waitFor(() => expect(shown()).toContain('a\n~ $ '));
    type('cls\r');
    await waitFor(() => expect(shown()).toBe('~ $ '));
  });

  it('a refusal, and a process that never started, say so in the tab (design §10)', async () => {
    const projectId = await open();
    for (let i = 0; i < 8; i += 1) processes.start(projectId, { command: 'serve' });
    type('echo nine\r');
    await waitFor(() =>
      expect(shown()).toContain('This project already runs 8 processes. Stop one before starting another.'),
    );
    expect(shown().endsWith('~ $ ')).toBe(true);

    processes.stopProject(projectId);
    type('broken\r');
    await waitFor(() => expect(shown()).toContain('Could not start: spawn /bin/sh ENOENT'));
    await waitFor(() => expect(shown()).toMatch(/\[could not start\]\n~ \$ $/));
  });

  it('Ctrl+F finds in the scrollback', async () => {
    const user = userEvent.setup();
    await open();
    act(() => {
      expect(term().press({ key: 'f', ctrlKey: true })).toBe(false);
    });
    const find = await screen.findByRole('textbox', { name: 'Find in terminal' });
    await user.type(find, 'hello{Enter}');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    const search = FakeSearchAddon.instances.at(-1);
    expect(search?.calls).toEqual([
      ['next', 'hello'],
      ['previous', 'hello'],
    ]);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Find in terminal' })).toBeNull();
    expect(search?.cleared).toBe(1);
  });

  it('copies with Ctrl+C only when text is selected, and lets the browser paste', async () => {
    await open();
    expect(term().press({ key: 'c', ctrlKey: true })).toBe(true);
    expect(term().press({ key: 'v', ctrlKey: true })).toBe(false);
  });
});

describe('D301 a terminal tab survives the panel and the mode (design §2.3, §11)', () => {
  it('reads Terminal · Problems · Output in the panel', async () => {
    const user = userEvent.setup();
    const projectId = db.createProject({ name: 'Shop' }).id;
    renderWithQuery(<BottomPanel projectId={projectId} />);
    const tabs = within(screen.getByRole('tablist', { name: 'Panel views' })).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Terminal', 'Problems', 'Output']);
    await user.click(tabs[0] as HTMLElement);
    expect(await screen.findByTestId('terminal-screen')).toBeInTheDocument();
    expect(useLayoutStore.getState().panelTab).toBe('terminal');
  });

  it('keeps a half-typed line while the panel is hidden', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'Shop' });
    const workflow = db.createWorkflow(project.id, 'Main');
    useLayoutStore.setState({ panelOpen: true, panelTab: 'terminal' });
    renderApp(`/projects/${project.id}/workflows/${workflow.id}/forge`);
    await screen.findByTestId('terminal-screen');
    await vi.waitFor(() => expect(getSocket()?.status).toBe('open'));

    type('ech');
    await user.keyboard('{Control>}j{/Control}');
    await user.keyboard('{Control>}j{/Control}');
    await screen.findByTestId('terminal-screen');
    type('o hi\r');
    await waitFor(() => expect(shown()).toBe('~ $ echo hi\nhi\n~ $ '));
  });

  it('scrollback survives the panel being hidden and shown, and Ideate ↔ Forge', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'Shop' });
    const workflow = db.createWorkflow(project.id, 'Main');
    useLayoutStore.setState({ panelOpen: true, panelTab: 'terminal' });
    renderApp(`/projects/${project.id}/workflows/${workflow.id}/forge`);
    await screen.findByTestId('terminal-screen');
    await vi.waitFor(() => expect(getSocket()?.status).toBe('open'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    type('echo kept\r');
    await waitFor(() => expect(shown()).toBe('~ $ echo kept\nkept\n~ $ '));

    await user.keyboard('{Control>}j{/Control}');
    expect(screen.queryByTestId('terminal-screen')).toBeNull();
    await user.keyboard('{Control>}j{/Control}');
    await screen.findByTestId('terminal-screen');
    expect(shown()).toBe('~ $ echo kept\nkept\n~ $ ');

    await user.keyboard('{Control>}{Shift>}1{/Shift}{/Control}');
    expect(await screen.findByTestId('canvas')).toBeInTheDocument();
    await user.keyboard('{Control>}{Shift>}2{/Shift}{/Control}');
    await screen.findByTestId('terminal-screen');
    expect(shown()).toBe('~ $ echo kept\nkept\n~ $ ');
  });
});
```

- [ ] **Step 4: Run them to watch them fail**

Run: `pnpm --filter @ace/web exec vitest run src/test/FakeTerminal.test.ts src/forge/terminal`
Expected: `FakeTerminal.test.ts` passes (the double is written). The others FAIL: `feed`, `./builtins` and `./TerminalPanel` do not exist, and the panel has no Terminal tab.

- [ ] **Step 5: The key table**

Append to `apps/web/src/forge/terminal/line-discipline.ts`:

```ts

/** What a line asks for. `run` and `prompt` happen with nothing running; `input` and `stop` while busy. */
export type LineAction =
  | { kind: 'run'; line: string }
  | { kind: 'input'; data: string }
  | { kind: 'stop' }
  | { kind: 'prompt' };

export interface LineStep {
  state: LineState;
  /** What to write to the screen now: local echo, before any action has an answer. */
  echo: string;
  actions: LineAction[];
}

type Key =
  | { kind: 'text'; text: string }
  | { kind: 'enter' | 'backspace' | 'delete' | 'left' | 'right' | 'home' | 'end' }
  | { kind: 'up' | 'down' | 'interrupt' };

const left = (n: number): string => (n > 0 ? `\u001b[${n}D` : '');
const right = (n: number): string => (n > 0 ? `\u001b[${n}C` : '');
const ERASE_TO_END = '\u001b[K';

/** The key a CSI or SS3 sequence names, by its final character and parameters. */
function keyOfSequence(final: string, params: string): Key | undefined {
  switch (final) {
    case 'A':
      return { kind: 'up' };
    case 'B':
      return { kind: 'down' };
    case 'C':
      return { kind: 'right' };
    case 'D':
      return { kind: 'left' };
    case 'H':
      return { kind: 'home' };
    case 'F':
      return { kind: 'end' };
    case '~':
      if (params === '3') return { kind: 'delete' };
      if (params === '1' || params === '7') return { kind: 'home' };
      if (params === '4' || params === '8') return { kind: 'end' };
      return undefined;
    default:
      return undefined;
  }
}

/** xterm's `onData` string as keys. Unknown sequences and other control characters are dropped. */
function keysOf(data: string): Key[] {
  const keys: Key[] = [];
  let text = '';
  const flush = (): void => {
    if (text !== '') keys.push({ kind: 'text', text });
    text = '';
  };
  for (let i = 0; i < data.length; i += 1) {
    const ch = data.charAt(i);
    if (ch === '\u001b') {
      flush();
      const introducer = data.charAt(i + 1);
      if (introducer === '[' || introducer === 'O') {
        // CSI: parameter bytes 0x20–0x3F, then one final byte. SS3: one final byte.
        let end = i + 2;
        if (introducer === '[') {
          while (end < data.length && data.charCodeAt(end) >= 0x20 && data.charCodeAt(end) <= 0x3f) {
            end += 1;
          }
        }
        const key = end < data.length ? keyOfSequence(data.charAt(end), data.slice(i + 2, end)) : undefined;
        if (key !== undefined) keys.push(key);
        i = end;
        continue;
      }
      // A lone ESC, or Alt+key: dropped with the key it modifies.
      if (introducer !== '') i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      flush();
      keys.push({ kind: 'enter' });
      if (ch === '\r' && data.charAt(i + 1) === '\n') i += 1;
      continue;
    }
    if (ch === '\u007f' || ch === '\b') {
      flush();
      keys.push({ kind: 'backspace' });
      continue;
    }
    if (ch === '\u0003') {
      flush();
      keys.push({ kind: 'interrupt' });
      continue;
    }
    // Tab and the other control characters do nothing in line mode.
    if (ch < ' ') continue;
    text += ch;
  }
  flush();
  return keys;
}

function remember(history: readonly string[], line: string): readonly string[] {
  if (history.at(-1) === line) return history;
  return [...history, line].slice(-HISTORY_MAX);
}

/**
 * One `onData` string through the line discipline (D301): the state after it, what to echo, and
 * what to do — in order, so a pasted block runs its first line and feeds the rest to what that
 * started. Pure: the caller stores the state and performs the actions.
 */
export function feed(state: LineState, data: string): LineStep {
  let s = state;
  let echo = '';
  const actions: LineAction[] = [];
  for (const key of keysOf(data)) {
    switch (key.kind) {
      case 'text': {
        const rest = s.line.slice(s.cursor);
        echo += key.text + rest + left(rest.length);
        s = {
          ...s,
          line: s.line.slice(0, s.cursor) + key.text + rest,
          cursor: s.cursor + key.text.length,
        };
        break;
      }
      case 'backspace': {
        if (s.cursor === 0) break;
        const rest = s.line.slice(s.cursor);
        echo += `\b${rest} ${left(rest.length + 1)}`;
        s = { ...s, line: s.line.slice(0, s.cursor - 1) + rest, cursor: s.cursor - 1 };
        break;
      }
      case 'delete': {
        if (s.cursor === s.line.length) break;
        const rest = s.line.slice(s.cursor + 1);
        echo += `${rest} ${left(rest.length + 1)}`;
        s = { ...s, line: s.line.slice(0, s.cursor) + rest };
        break;
      }
      case 'left':
        if (s.cursor > 0) {
          echo += left(1);
          s = { ...s, cursor: s.cursor - 1 };
        }
        break;
      case 'right':
        if (s.cursor < s.line.length) {
          echo += right(1);
          s = { ...s, cursor: s.cursor + 1 };
        }
        break;
      case 'home':
        echo += left(s.cursor);
        s = { ...s, cursor: 0 };
        break;
      case 'end':
        echo += right(s.line.length - s.cursor);
        s = { ...s, cursor: s.line.length };
        break;
      case 'up':
      case 'down': {
        const recall = key.kind === 'up' ? s.recall - 1 : s.recall + 1;
        if (recall < 0 || recall > s.history.length) break;
        const draft = s.recall === s.history.length ? s.line : s.draft;
        const next = recall === s.history.length ? draft : (s.history[recall] ?? '');
        echo += left(s.cursor) + next + ERASE_TO_END;
        s = { ...s, line: next, cursor: next.length, recall, draft };
        break;
      }
      case 'enter': {
        echo += '\r\n';
        const line = s.line;
        const blank = line.trim() === '';
        if (s.busy) actions.push({ kind: 'input', data: `${line}\n` });
        else if (blank) actions.push({ kind: 'prompt' });
        else actions.push({ kind: 'run', line });
        const history = !s.busy && !blank ? remember(s.history, line) : s.history;
        s = {
          ...s,
          line: '',
          cursor: 0,
          history,
          recall: history.length,
          draft: '',
          busy: s.busy || !blank,
        };
        break;
      }
      case 'interrupt':
        echo += '^C\r\n';
        actions.push(s.busy ? { kind: 'stop' } : { kind: 'prompt' });
        s = { ...s, line: '', cursor: 0, recall: s.history.length, draft: '' };
        break;
    }
  }
  return { state: s, echo, actions };
}
```

- [ ] **Step 6: The built-ins**

Create `apps/web/src/forge/terminal/builtins.ts`:

```ts
/**
 * What a terminal tab does itself rather than hand to a shell (D301, design §6.3): `cd`, so the
 * folder persists between commands, and `cls` / `clear`. Other shell state does not carry over
 * (design §14); a `cd` chained with `&&`, `|`, `;`, `<` or `>` runs in the shell, where it lasts
 * only for that line.
 */

export type Builtin = { kind: 'cd'; arg: string | undefined } | { kind: 'clear' };

const SHELL_SYNTAX = /[&|;<>]/;

const unquote = (text: string): string => (/^(["']).*\1$/.test(text) ? text.slice(1, -1) : text);

export function parseBuiltin(line: string): Builtin | undefined {
  const trimmed = line.trim();
  if (/^(cls|clear)$/i.test(trimmed)) return { kind: 'clear' };
  const cd = /^cd(?:(\.\.?)|\s+(.*))?$/i.exec(trimmed);
  if (cd === null) return undefined;
  const raw = (cd[1] ?? cd[2] ?? '').trim();
  if (SHELL_SYNTAX.test(raw)) return undefined;
  return { kind: 'cd', arg: raw === '' ? undefined : unquote(raw) };
}

/**
 * Where `cd <arg>` leads from `cwd`, project-relative. `/` and `~` are the project root, `..` at the
 * root stays there. The files API then confines the result exactly as the engine confines a
 * process's folder, and refuses one that is outside or missing.
 */
export function resolveCd(cwd: string, arg: string): string {
  const path = arg.split('\\').join('/');
  const fromRoot = path.startsWith('/') || path === '~' || path.startsWith('~/');
  const parts = fromRoot ? [] : cwd.split('/').filter((segment) => segment !== '');
  for (const segment of path.replace(/^~/, '').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}
```

- [ ] **Step 7: The session**

Create `apps/web/src/forge/terminal/session.ts`:

```ts
import type { ProcessStartRequest } from '@ace/contracts';
import type { QueryClient } from '@tanstack/react-query';

import { api } from '../../app/api';
import { parseBuiltin, resolveCd } from './builtins';
import { processKeys } from './hooks';
import { feed, type LineAction } from './line-discipline';
import { errorLine, tabOf, useTerminalStore } from './terminal-store';

/**
 * What a terminal tab does with what is typed (D301, design §6.3): the line discipline echoes at
 * once, then each action runs in order, per tab — so input typed while a start is still in flight
 * waits for the process it is meant for.
 */

const queues = new Map<string, Promise<void>>();

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Runs `work` after everything this tab was already doing. */
export function enqueue(projectId: string, tabId: string, work: () => Promise<void>): Promise<void> {
  const key = `${projectId}\u0000${tabId}`;
  const next = (queues.get(key) ?? Promise.resolve()).then(work).catch(() => undefined);
  queues.set(key, next);
  return next;
}

/** Starts a process for the tab and attaches it; a refusal or failure is printed in the tab (§10). */
export async function startInTab(
  projectId: string,
  tabId: string,
  request: ProcessStartRequest,
  queryClient: QueryClient,
): Promise<void> {
  const store = useTerminalStore.getState();
  try {
    const { processId } = await api().startProcess(projectId, request);
    store.attach(projectId, tabId, processId);
  } catch (error) {
    store.write(projectId, tabId, errorLine(messageOf(error)));
    store.idle(projectId, tabId);
  } finally {
    void queryClient.invalidateQueries({ queryKey: processKeys.list(projectId) });
  }
}

async function changeDirectory(projectId: string, tabId: string, arg: string | undefined): Promise<void> {
  const store = useTerminalStore.getState();
  const tab = tabOf(projectId, tabId);
  if (tab === undefined) return;
  if (arg === undefined) {
    store.write(projectId, tabId, `${tab.cwd === '' ? '~' : tab.cwd}\r\n`);
    store.idle(projectId, tabId);
    return;
  }
  const target = resolveCd(tab.cwd, arg);
  try {
    // Listing it is the check: the files API confines it as the engine confines a process (FR-GIT-008).
    await api().listFolder(projectId, target);
    store.setCwd(projectId, tabId, target);
  } catch (error) {
    store.write(projectId, tabId, errorLine(`cd: ${arg}: ${messageOf(error)}`));
  }
  store.idle(projectId, tabId);
}

async function runLine(projectId: string, tabId: string, line: string, queryClient: QueryClient): Promise<void> {
  const builtin = parseBuiltin(line);
  if (builtin?.kind === 'clear') {
    const store = useTerminalStore.getState();
    store.clearScreen(projectId, tabId);
    store.idle(projectId, tabId);
    return;
  }
  if (builtin?.kind === 'cd') {
    await changeDirectory(projectId, tabId, builtin.arg);
    return;
  }
  const cwd = tabOf(projectId, tabId)?.cwd ?? '';
  await startInTab(projectId, tabId, { command: line, cwd }, queryClient);
}

async function perform(
  projectId: string,
  tabId: string,
  action: LineAction,
  queryClient: QueryClient,
): Promise<void> {
  const store = useTerminalStore.getState();
  switch (action.kind) {
    case 'prompt':
      store.idle(projectId, tabId);
      return;
    case 'run':
      await runLine(projectId, tabId, action.line, queryClient);
      return;
    case 'input': {
      const processId = tabOf(projectId, tabId)?.processId;
      // No process: its start was refused, or it has already ended.
      if (processId === undefined) return;
      try {
        await api().processInput(projectId, processId, action.data);
      } catch {
        // It ended in the meantime; its process.exited says so.
      }
      return;
    }
    case 'stop': {
      const processId = tabOf(projectId, tabId)?.processId;
      if (processId === undefined) return;
      try {
        await api().stopProcess(projectId, processId);
      } catch (error) {
        store.write(projectId, tabId, errorLine(`Could not stop it: ${messageOf(error)}`));
      }
      return;
    }
  }
}

/**
 * What xterm reported the person typed. Echoes at once; answers once every action it caused has
 * run (tests await it).
 */
export function typed(
  projectId: string,
  tabId: string,
  data: string,
  queryClient: QueryClient,
): Promise<void> {
  const tab = tabOf(projectId, tabId);
  if (tab === undefined) return Promise.resolve();
  const step = feed(tab.line, data);
  const store = useTerminalStore.getState();
  store.setLine(projectId, tabId, step.state);
  if (step.echo !== '') store.write(projectId, tabId, step.echo);
  let last: Promise<void> = Promise.resolve();
  for (const action of step.actions) {
    last = enqueue(projectId, tabId, () => perform(projectId, tabId, action, queryClient));
  }
  return last;
}
```

- [ ] **Step 8: The theme, the view and the panel**

Create `apps/web/src/forge/terminal/xterm-theme.ts`:

```ts
import type { ITheme } from '@xterm/xterm';

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

const token = (name: string, fallback: string): string => {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return HEX.test(value) ? value : fallback;
};

/** Night and Paper for xterm, from `@ace/ui`'s tokens, as the editor's themes are (design §6.2). */
export function terminalTheme(theme: 'dark' | 'light'): ITheme {
  const light = theme === 'light';
  const background = token('--color-panel', light ? '#fbfaf7' : '#0e0e10');
  const foreground = token('--color-fg', light ? '#1b1a1e' : '#f6f5f2');
  const muted = token('--color-fg-faint', light ? '#8d8a93' : '#7d7c82');
  const selection = token('--color-selection', light ? '#7c6fd6' : '#c4b5fd');
  const danger = token('--color-danger', '#f0563f');
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: `${selection.slice(0, 7)}55`,
    black: light ? '#1b1a1e' : '#232327',
    brightBlack: muted,
    red: danger,
    brightRed: danger,
    green: light ? '#1f7a4d' : '#5fd29a',
    yellow: light ? '#8a6a00' : '#e8c35a',
    blue: light ? '#2a5bd7' : '#7aa2f7',
    magenta: light ? '#8e44ad' : '#c792ea',
    cyan: light ? '#127a8a' : '#6fd3e0',
    white: light ? '#46444c' : '#d8d6d0',
    brightWhite: foreground,
  };
}
```

Create `apps/web/src/forge/terminal/TerminalView.tsx`:

```tsx
import '@xterm/xterm/css/xterm.css';

import { useQueryClient } from '@tanstack/react-query';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useResolvedTheme } from '../../app/theme';
import { IconAction } from '../layout/IconAction';
import { typed } from './session';
import { scrollbackOf, tabOf, useTerminalStore } from './terminal-store';
import { terminalTheme } from './xterm-theme';

/**
 * One terminal tab on screen (D301, design §6.3). xterm only renders: what is typed goes to the
 * line discipline (`typed`), and what the tab shows comes from the terminal store, so unmounting
 * (a hidden panel, Ideate) loses nothing — on mount the stored scrollback is written back.
 */
export function TerminalView({ projectId, tabId }: { projectId: string; tabId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>();
  const finder = useRef<SearchAddon>();
  const queryClient = useQueryClient();
  const theme = useResolvedTheme();
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace',
      fontSize: 12,
      scrollback: 10_000,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri, '_blank', 'noopener,noreferrer')));
    term.loadAddon(search);
    term.open(element);
    const refit = (): void => {
      try {
        fit.fit();
      } catch {
        // Not laid out yet; the next resize fits it.
      }
    };
    refit();

    // Write back what the tab holds, then follow it: appends as deltas, a replacement in full.
    const start = tabOf(projectId, tabId);
    let seen = { epoch: start?.epoch ?? 0, total: start?.total ?? 0 };
    if (start !== undefined) term.write(scrollbackOf(start));
    const unsubscribe = useTerminalStore.subscribe((state) => {
      const tab = state.projects[projectId]?.tabs.find((each) => each.id === tabId);
      if (tab === undefined || (tab.epoch === seen.epoch && tab.total === seen.total)) return;
      const text = scrollbackOf(tab);
      const delta = tab.total - seen.total;
      if (tab.epoch !== seen.epoch || delta > text.length) {
        term.reset();
        term.write(text);
      } else if (delta > 0) {
        term.write(text.slice(text.length - delta));
      }
      seen = { epoch: tab.epoch, total: tab.total };
    });

    const input = term.onData((data) => void typed(projectId, tabId, data, queryClient));
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      // With a selection Ctrl+C copies, as in VS Code; without one it is ^C.
      if (mod && key === 'c' && term.hasSelection()) return false;
      // The browser pastes; xterm reports the pasted text as typed.
      if (mod && key === 'v') return false;
      if (mod && key === 'f') {
        event.preventDefault();
        setFinding(true);
        return false;
      }
      return true;
    });
    const observer = new ResizeObserver(refit);
    observer.observe(element);
    terminal.current = term;
    finder.current = search;
    term.focus();

    return () => {
      observer.disconnect();
      unsubscribe();
      input.dispose();
      term.dispose();
      terminal.current = undefined;
      finder.current = undefined;
    };
  }, [projectId, tabId, queryClient]);

  useEffect(() => {
    if (terminal.current !== undefined) terminal.current.options.theme = terminalTheme(theme);
  }, [theme]);

  const find = (direction: 'next' | 'previous'): void => {
    if (query === '') return;
    if (direction === 'next') finder.current?.findNext(query);
    else finder.current?.findPrevious(query);
  };
  const closeFind = (): void => {
    setFinding(false);
    finder.current?.clearDecorations();
    terminal.current?.focus();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {finding && (
        <div role="search" className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
          <input
            aria-label="Find in terminal"
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') find(event.shiftKey ? 'previous' : 'next');
              if (event.key === 'Escape') closeFind();
            }}
            className="h-6 w-48 rounded border border-border bg-canvas px-2 font-machine text-[12px] text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          />
          <IconAction label="Previous match" Icon={ChevronUp} onClick={() => find('previous')} />
          <IconAction label="Next match" Icon={ChevronDown} onClick={() => find('next')} />
          <IconAction label="Close find" Icon={X} onClick={closeFind} />
        </div>
      )}
      <div ref={host} data-testid="terminal-view" className="min-h-0 flex-1 px-2 py-1" />
    </div>
  );
}
```

Create `apps/web/src/forge/terminal/TerminalPanel.tsx`:

```tsx
import { useEffect } from 'react';

import { TerminalView } from './TerminalView';
import { useProjectTerminals, useTerminalStore } from './terminal-store';

/** The bottom panel's Terminal view (D301): the active tab. Opening it with none opens one. */
export function TerminalPanel({ projectId }: { projectId: string }) {
  const terminals = useProjectTerminals(projectId);
  useEffect(() => {
    const store = useTerminalStore.getState();
    if ((store.projects[projectId]?.tabs.length ?? 0) === 0) store.newTab(projectId);
  }, [projectId]);
  const active = terminals.tabs.find((tab) => tab.id === terminals.active) ?? terminals.tabs[0];
  return (
    <div data-testid="terminal-panel" className="flex h-full min-h-0 flex-col">
      {active !== undefined && (
        <TerminalView key={active.id} projectId={projectId} tabId={active.id} />
      )}
    </div>
  );
}
```

- [ ] **Step 9: The Terminal tab in the panel**

In `apps/web/src/app/stores/layout.ts`, change line 5 to:

```ts
export type ForgePanelTab = 'terminal' | 'problems' | 'output';
```

In `apps/web/src/forge/panel/BottomPanel.tsx`, add `import { TerminalPanel } from '../terminal/TerminalPanel';`, and replace the `TABS` block (lines 10-14) with:

```ts
/** Terminal · Problems · Output, as VS Code orders them (design §2.2). */
const TABS: ReadonlyArray<{ tab: ForgePanelTab; label: string }> = [
  { tab: 'terminal', label: 'Terminal' },
  { tab: 'problems', label: 'Problems' },
  { tab: 'output', label: 'Output' },
];
```

and in the `tabpanel`, before `{panelTab === 'problems' && …}`, add:

```tsx
        {panelTab === 'terminal' && <TerminalPanel projectId={projectId} />}
```

- [ ] **Step 10: Run the tests**

Run: `pnpm --filter @ace/web exec vitest run src/test/FakeTerminal.test.ts src/forge/terminal src/forge/ForgeWorkbench.test.tsx src/forge/layout`
Expected: PASS.

- [ ] **Step 11: Full web suite, typecheck, lint, commit**

Run: `pnpm --filter @ace/web test && pnpm --filter @ace/web typecheck && pnpm --filter @ace/web lint`
Expected: PASS. If a Phase 1 test assumed Problems was the panel's first tab, it is wrong now (design §2.2): change its expectation, not the order.

```bash
npx prettier --write --config packages/config/prettier.config.js apps/web/src/forge/terminal apps/web/src/test/FakeTerminal.ts apps/web/src/test/FakeTerminal.test.ts apps/web/src/test/setup.tsx apps/web/src/test/app.tsx apps/web/src/forge/panel/BottomPanel.tsx apps/web/src/app/stores/layout.ts
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): the Terminal — xterm over a line discipline, cd/cls/clear, find, and scrollback that survives the panel and Ideate [D301]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 14: Web — several tabs, the Processes list, script buttons, the status bar's count and Ctrl+`

**Files:**
- Create:
  - `apps/web/src/forge/terminal/TerminalTabs.tsx`;
  - `apps/web/src/forge/terminal/ProcessesList.tsx`;
  - `apps/web/src/forge/terminal/ScriptButtons.tsx`.
- Modify:
  - `apps/web/src/forge/terminal/session.ts` (append `runScript` and `openProcessInTab`);
  - `apps/web/src/forge/terminal/TerminalPanel.tsx` (the header, the list, an empty state);
  - `apps/web/src/forge/layout/StatusBar.tsx:1-27` and `:55` (the running count);
  - `apps/web/src/app/shortcuts.ts:39-63` (`toggleTerminal` and the backquote label);
  - `apps/web/src/app/stores/layout.ts:7-24` and `:57-71` (`toggleTerminal`);
  - `apps/web/src/forge/ForgeWorkbench.tsx:43-72` (the binding);
  - `apps/web/src/forge/editor/EmptyEditor.tsx` (the Terminal action and hint).
- Test:
  - create `apps/web/src/forge/terminal/TerminalTabs.test.tsx`, `ProcessesList.test.tsx`, `ScriptButtons.test.tsx`;
  - extend `apps/web/src/forge/layout/StatusBar.test.tsx`, `apps/web/src/app/shortcuts.test.tsx`, `apps/web/src/app/stores/layout.test.ts`, `apps/web/src/forge/ForgeWorkbench.test.tsx`.

**Interfaces:**
- Consumes:
  - from Task 12: `useProcessList`, `useProjectScripts`, `useStopProcess`, `runningCount`, `useProjectTerminals`, `useTerminalStore`, `TerminalTab`, `reattach`, `useProcessEvents`;
  - from Task 13: `enqueue`, `startInTab`, `busyLine`, `TerminalView`, `TerminalPanel`, `FakeTerminal`;
  - existing: `Dialog*` and `Button` from `@ace/ui`, `IconAction`, `useLayoutStore`.
- Produces:
  - in `session.ts`:
    - `runScript(projectId, name, packageManager: PackageManager, queryClient): Promise<void>`: a new tab named after the script, `<pm> run <name>` echoed, `{ script: name, cwd: '' }` started;
    - `openProcessInTab(projectId, summary: ProcessSummary, queryClient): Promise<void>`;
  - `TerminalTabs({ projectId, disabled? })`: a `tablist` named "Terminals", a "New terminal" button, double-click to rename, "Close <label>", and the "Stop <label>?" dialog;
  - `ProcessesList({ projectId })`: a `region` named "Processes"; rows have test id `process-<id>`; running rows have "Stop <label>", and "Show <label>" when no tab owns them;
  - `ScriptButtons({ projectId, disabled? })`: a `group` named "Scripts", one button per script, named by the script;
  - `SHORTCUTS.toggleTerminal = { code: 'Backquote', mod: true }`; `shortcutLabel` prints `` Ctrl+` ``;
  - `useLayoutStore().toggleTerminal()`;
  - a status-bar button named `<n> running` when n > 0.
- Task 15 passes `disabled` to `TerminalTabs` and `ScriptButtons`, and adds the trust notice to `TerminalPanel`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/forge/terminal/TerminalTabs.test.tsx`:

```tsx
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { api } from '../../app/api';
import { getSocket } from '../../app/socket';
import { db, installMockServer, installMockSocket, renderWithQuery } from '../../test/app';
import { FakeTerminal } from '../../test/FakeTerminal';
import { useProcessEvents } from './process-events';
import { TerminalPanel } from './TerminalPanel';

installMockServer();
installMockSocket();

function Harness({ projectId }: { projectId: string }) {
  useProcessEvents(projectId);
  return <TerminalPanel projectId={projectId} />;
}

async function open(): Promise<string> {
  const projectId = db.createProject({ name: 'Shop' }).id;
  renderWithQuery(<Harness projectId={projectId} />);
  await screen.findByTestId('terminal-screen');
  await vi.waitFor(() => expect(getSocket()?.status).toBe('open'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  return projectId;
}

const tabs = () => within(screen.getByRole('tablist', { name: 'Terminals' })).getAllByRole('tab');

describe('D301 several terminal tabs', () => {
  it('New terminal opens another tab at its prompt and makes it the one shown', async () => {
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole('button', { name: 'New terminal' }));
    expect(tabs().map((tab) => tab.textContent)).toEqual(['Terminal 1', 'Terminal 2']);
    expect(tabs()[1]).toHaveAttribute('aria-selected', 'true');
    expect(FakeTerminal.latest().plain()).toBe('~ $ ');
    await user.click(tabs()[0] as HTMLElement);
    expect(tabs()[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('renames a tab by double-clicking its name', async () => {
    const user = userEvent.setup();
    await open();
    await user.dblClick(screen.getByRole('tab', { name: 'Terminal 1' }));
    const input = screen.getByRole('textbox', { name: 'Rename Terminal 1' });
    await user.clear(input);
    await user.type(input, 'api{Enter}');
    expect(screen.getByRole('tab', { name: 'api' })).toBeInTheDocument();
  });

  it('closes an idle tab at once, and the neighbour shows', async () => {
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole('button', { name: 'New terminal' }));
    await user.click(screen.getByRole('button', { name: 'Close Terminal 2' }));
    expect(tabs().map((tab) => tab.textContent)).toEqual(['Terminal 1']);
    expect(tabs()[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('closing a tab whose process runs asks "Stop <label>?"; Cancel keeps it, Stop and close stops it', async () => {
    const user = userEvent.setup();
    const stop = vi.spyOn(api(), 'stopProcess');
    await open();
    act(() => FakeTerminal.latest().type('serve\r'));
    await waitFor(() => expect(FakeTerminal.latest().plain()).toContain('listening on 3000'));

    await user.click(screen.getByRole('button', { name: 'Close Terminal 1' }));
    const asked = await screen.findByRole('dialog', { name: 'Stop Terminal 1?' });
    await user.click(within(asked).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('tab', { name: 'Terminal 1' })).toBeInTheDocument();
    expect(stop).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Close Terminal 1' }));
    const again = await screen.findByRole('dialog', { name: 'Stop Terminal 1?' });
    await user.click(within(again).getByRole('button', { name: 'Stop and close' }));
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'Terminal 1' })).toBeNull());
    expect(stop).toHaveBeenCalledTimes(1);
    expect(screen.getByText('No terminal open.')).toBeInTheDocument();
    stop.mockRestore();
  });
});
```

Create `apps/web/src/forge/terminal/ProcessesList.test.tsx`:

```tsx
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { getSocket } from '../../app/socket';
import { db, installMockServer, installMockSocket, processes, renderWithQuery } from '../../test/app';
import { FakeTerminal } from '../../test/FakeTerminal';
import { useProcessEvents } from './process-events';
import { TerminalPanel } from './TerminalPanel';

installMockServer();
installMockSocket();

function Harness({ projectId }: { projectId: string }) {
  useProcessEvents(projectId);
  return <TerminalPanel projectId={projectId} />;
}

async function open(projectId: string) {
  renderWithQuery(<Harness projectId={projectId} />);
  await screen.findByTestId('terminal-screen');
  await vi.waitFor(() => expect(getSocket()?.status).toBe('open'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  return screen.getByRole('region', { name: 'Processes' });
}

describe('D301 the Processes list', () => {
  it('lists running processes with Stop, and finished ones with how they ended', async () => {
    const user = userEvent.setup();
    const projectId = db.createProject({ name: 'Shop' }).id;
    const done = processes.start(projectId, { command: 'echo a' }).processId;
    const failed = processes.start(projectId, { command: 'fail' }).processId;
    await vi.waitFor(() => expect(processes.get(projectId, failed).status).toBe('exited'));
    const serve = processes.start(projectId, { command: 'serve', label: 'dev server' }).processId;

    const list = await open(projectId);
    await within(list).findByText('dev server');
    expect(within(list).getByTestId(`process-${done}`)).toHaveTextContent('exit 0');
    expect(within(list).getByTestId(`process-${failed}`)).toHaveTextContent('exit 1');

    await user.click(within(list).getByRole('button', { name: 'Stop dev server' }));
    await waitFor(() =>
      expect(within(list).getByTestId(`process-${serve}`)).toHaveTextContent('stopped'),
    );
  });

  it('says so when nothing has run', async () => {
    const projectId = db.createProject({ name: 'Shop' }).id;
    const list = await open(projectId);
    expect(await within(list).findByText('Nothing has run yet.')).toBeInTheDocument();
  });

  it('shows the latest line of a process no tab owns, and Show opens it in a tab with what it printed', async () => {
    const user = userEvent.setup();
    const projectId = db.createProject({ name: 'Shop' }).id;
    const list = await open(projectId);
    const serve = processes.start(projectId, { command: 'serve' }).processId;

    await waitFor(() =>
      expect(within(list).getByTestId(`process-${serve}`)).toHaveTextContent('listening on 3000'),
    );
    await user.click(within(list).getByRole('button', { name: 'Show serve' }));
    expect(await screen.findByRole('tab', { name: 'serve' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(FakeTerminal.latest().plain()).toContain('listening on 3000'));
    expect(within(list).queryByRole('button', { name: 'Show serve' })).toBeNull();
    processes.stop(projectId, serve);
  });
});
```

Create `apps/web/src/forge/terminal/ScriptButtons.test.tsx`:

```tsx
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { getSocket } from '../../app/socket';
import { db, installMockServer, installMockSocket, renderWithQuery } from '../../test/app';
import { FakeTerminal } from '../../test/FakeTerminal';
import { useProcessEvents } from './process-events';
import { TerminalPanel } from './TerminalPanel';

installMockServer();
installMockSocket();

function Harness({ projectId }: { projectId: string }) {
  useProcessEvents(projectId);
  return <TerminalPanel projectId={projectId} />;
}

describe('D301 script buttons run the project’s own scripts', () => {
  it('runs a script in a new tab named after it, as <pm> run <name>', async () => {
    const user = userEvent.setup();
    const projectId = db.createProject({ name: 'Shop' }).id;
    db.seedFiles(projectId, {
      'package.json': JSON.stringify({
        packageManager: 'pnpm@9.15.9',
        scripts: { hello: 'echo hi from a script', dev: 'serve' },
      }),
    });
    renderWithQuery(<Harness projectId={projectId} />);
    await vi.waitFor(() => expect(getSocket()?.status).toBe('open'));

    const scripts = await screen.findByRole('group', { name: 'Scripts' });
    expect(within(scripts).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'hello',
      'dev',
    ]);
    await user.click(within(scripts).getByRole('button', { name: 'hello' }));
    expect(await screen.findByRole('tab', { name: 'hello' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() =>
      expect(FakeTerminal.latest().plain()).toBe(
        '~ $ pnpm run hello\n\n> hello\n> echo hi from a script\n\nhi from a script\n~ $ ',
      ),
    );
  });

  it('shows no script buttons when package.json has no scripts', async () => {
    const projectId = db.createProject({ name: 'Shop' }).id;
    renderWithQuery(<Harness projectId={projectId} />);
    await screen.findByTestId('terminal-screen');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('group', { name: 'Scripts' })).toBeNull();
  });
});
```

In `apps/web/src/forge/layout/StatusBar.test.tsx`, add `processes` to the import from `'../../test/app'`, and append inside the `describe`:

```tsx
  it('D301 counts the running processes, and a click opens the Terminal', async () => {
    const user = userEvent.setup();
    const projectId = db.createProject({ name: 'P' }).id;
    processes.start(projectId, { command: 'serve' });
    processes.start(projectId, { command: 'serve' });
    renderWithQuery(<StatusBar projectId={projectId} />);
    await user.click(await screen.findByRole('button', { name: '2 running' }));
    expect(useLayoutStore.getState()).toMatchObject({ panelOpen: true, panelTab: 'terminal' });
    processes.stopProject(projectId);
  });

  it('D301 says nothing about processes when none runs', async () => {
    const projectId = db.createProject({ name: 'P' }).id;
    renderWithQuery(<StatusBar projectId={projectId} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('button', { name: /running$/ })).toBeNull();
  });
```

In `apps/web/src/app/shortcuts.test.tsx`, append inside the `describe`:

```tsx
  it('D301 Ctrl+` and ⌘+` toggle the terminal, labelled with the backquote itself', () => {
    const backquote = (init: KeyboardEventInit) =>
      new KeyboardEvent('keydown', { code: 'Backquote', key: '`', ...init });
    expect(matches(backquote({ ctrlKey: true }), SHORTCUTS.toggleTerminal)).toBe(true);
    expect(matches(backquote({ metaKey: true }), SHORTCUTS.toggleTerminal)).toBe(true);
    expect(matches(backquote({}), SHORTCUTS.toggleTerminal)).toBe(false);
    expect(shortcutLabel(SHORTCUTS.toggleTerminal)).toBe('Ctrl+`');
  });
```

In `apps/web/src/app/stores/layout.test.ts`, append inside the `describe`:

```ts
  it('D301 Ctrl+` shows the Terminal, and hides the panel when the Terminal is what shows', () => {
    useLayoutStore.getState().toggleTerminal();
    expect(useLayoutStore.getState()).toMatchObject({ panelOpen: true, panelTab: 'terminal' });
    useLayoutStore.getState().toggleTerminal();
    expect(useLayoutStore.getState().panelOpen).toBe(false);
    useLayoutStore.getState().showPanel('problems');
    useLayoutStore.getState().toggleTerminal();
    expect(useLayoutStore.getState()).toMatchObject({ panelOpen: true, panelTab: 'terminal' });
  });
```

In `apps/web/src/forge/ForgeWorkbench.test.tsx`, append inside the `describe`:

```tsx
  it('D301 Ctrl+` opens the Terminal, and closes it again', async () => {
    const user = userEvent.setup();
    renderApp(seed());
    await screen.findByTestId('forge');
    await user.keyboard('{Control>}`{/Control}');
    expect(await screen.findByTestId('terminal-panel')).toBeInTheDocument();
    expect(useLayoutStore.getState().panelTab).toBe('terminal');
    await user.keyboard('{Control>}`{/Control}');
    expect(screen.queryByTestId('terminal-panel')).toBeNull();
  });

  it('D301 the empty editor offers the Terminal with its key', async () => {
    const user = userEvent.setup();
    renderApp(seed());
    await screen.findByTestId('forge');
    await user.click(screen.getByRole('button', { name: /^Terminal/ }));
    expect(await screen.findByTestId('terminal-panel')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run them to watch them fail**

Run: `pnpm --filter @ace/web exec vitest run src/forge/terminal src/forge/layout src/app src/forge/ForgeWorkbench.test.tsx`
Expected: FAIL. There is no tab list, Processes list or script group; `toggleTerminal` is undefined; the status bar has no running count.

- [ ] **Step 3: Scripts and processes in tabs**

In `apps/web/src/forge/terminal/session.ts`:
1. Change the contracts import to `import type { PackageManager, ProcessStartRequest, ProcessSummary } from '@ace/contracts';`.
2. Change the line-discipline import to `import { busyLine, feed, type LineAction } from './line-discipline';`.
3. Add `import { reattach } from './process-events';` after the `./hooks` import.
4. Append:

```ts

/** A script button (D301): the script runs in a new tab named after it, as `<pm> run <name>`. */
export function runScript(
  projectId: string,
  name: string,
  packageManager: PackageManager,
  queryClient: QueryClient,
): Promise<void> {
  const store = useTerminalStore.getState();
  const tabId = store.newTab(projectId, { label: name });
  store.write(projectId, tabId, `${packageManager} run ${name}\r\n`);
  const tab = tabOf(projectId, tabId);
  if (tab !== undefined) store.setLine(projectId, tabId, busyLine(tab.line));
  return enqueue(projectId, tabId, () =>
    startInTab(projectId, tabId, { script: name, cwd: '' }, queryClient),
  );
}

/**
 * A process no tab owns — started from another browser tab, or before a reload — opens in a new
 * tab with what the engine kept of its output, and takes typing from then on.
 */
export async function openProcessInTab(
  projectId: string,
  summary: ProcessSummary,
  queryClient: QueryClient,
): Promise<void> {
  const store = useTerminalStore.getState();
  const tabId = store.newTab(projectId, { label: summary.label, cwd: summary.cwd });
  store.write(projectId, tabId, `${summary.command}\r\n`);
  const tab = tabOf(projectId, tabId);
  if (tab !== undefined) store.setLine(projectId, tabId, busyLine(tab.line));
  store.attach(projectId, tabId, summary.id);
  await reattach(projectId, queryClient);
}
```

- [ ] **Step 4: The tabs**

Create `apps/web/src/forge/terminal/TerminalTabs.tsx`:

```tsx
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  cn,
} from '@ace/ui';
import { Plus, X } from 'lucide-react';
import { useState } from 'react';

import { IconAction } from '../layout/IconAction';
import { useStopProcess } from './hooks';
import { useProjectTerminals, useTerminalStore, type TerminalTab } from './terminal-store';

/**
 * The Terminal's tabs (D301): each a line-mode session with its own folder and history. A dot
 * marks one that runs a process; closing it asks first, because closing stops it.
 */
export function TerminalTabs({ projectId, disabled = false }: { projectId: string; disabled?: boolean }) {
  const terminals = useProjectTerminals(projectId);
  const [renaming, setRenaming] = useState<string | undefined>();
  const [closing, setClosing] = useState<TerminalTab | undefined>();
  const stop = useStopProcess(projectId);
  const store = useTerminalStore.getState;

  const commitRename = (tabId: string, label: string): void => {
    store().rename(projectId, tabId, label);
    setRenaming(undefined);
  };
  const close = (tab: TerminalTab): void => {
    if (tab.processId !== undefined) setClosing(tab);
    else store().closeTab(projectId, tab.id);
  };
  const stopAndClose = async (tab: TerminalTab): Promise<void> => {
    if (tab.processId !== undefined) await stop.mutateAsync(tab.processId).catch(() => undefined);
    store().closeTab(projectId, tab.id);
    setClosing(undefined);
  };

  return (
    <div className="flex min-w-0 items-center gap-1">
      <div role="tablist" aria-label="Terminals" className="flex min-w-0 items-center gap-1 overflow-x-auto">
        {terminals.tabs.map((tab) => {
          const active = tab.id === terminals.active;
          return (
            <div
              key={tab.id}
              className={cn(
                'flex h-6 shrink-0 items-center gap-1 rounded px-1.5 font-machine text-[11px]',
                active ? 'bg-card text-fg' : 'text-fg-muted hover:text-fg',
              )}
            >
              {renaming === tab.id ? (
                <input
                  aria-label={`Rename ${tab.label}`}
                  autoFocus
                  defaultValue={tab.label}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitRename(tab.id, event.currentTarget.value);
                    if (event.key === 'Escape') setRenaming(undefined);
                  }}
                  onBlur={(event) => commitRename(tab.id, event.currentTarget.value)}
                  className="h-5 w-28 rounded border border-border bg-canvas px-1 text-fg focus-visible:outline-none"
                />
              ) : (
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  title="Double-click to rename"
                  onClick={() => store().activate(projectId, tab.id)}
                  onDoubleClick={() => setRenaming(tab.id)}
                  className="flex items-center gap-1"
                >
                  {tab.processId !== undefined && (
                    <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent" />
                  )}
                  {tab.label}
                </button>
              )}
              <button
                type="button"
                aria-label={`Close ${tab.label}`}
                onClick={() => close(tab)}
                className="opacity-60 hover:opacity-100"
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
      <IconAction
        label="New terminal"
        Icon={Plus}
        disabled={disabled}
        onClick={() => store().newTab(projectId)}
      />
      {closing !== undefined && (
        <Dialog open onOpenChange={(open) => !open && setClosing(undefined)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{`Stop ${closing.label}?`}</DialogTitle>
              <DialogDescription>
                It is still running. Closing the tab stops it and everything it started.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setClosing(undefined)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => void stopAndClose(closing)}>
                Stop and close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
```

- [ ] **Step 5: The Processes list and the script buttons**

Create `apps/web/src/forge/terminal/ProcessesList.tsx`:

```tsx
import type { ProcessSummary } from '@ace/contracts';
import { useQueryClient } from '@tanstack/react-query';

import { useProcessList, useStopProcess } from './hooks';
import { openProcessInTab } from './session';
import { useProjectTerminals, useTerminalStore } from './terminal-store';

// eslint-disable-next-line no-control-regex -- colour escapes are exactly what is removed
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** The last line a process printed, plain, for its row. */
function lastLine(output: string | undefined): string | undefined {
  const lines = (output ?? '').replace(ANSI, '').split(/\r?\n/).map((line) => line.trim());
  return lines.filter((line) => line !== '').at(-1);
}

function endingOf(summary: ProcessSummary): string {
  if (summary.status === 'failed') return 'could not start';
  if (summary.signal !== null) return 'stopped';
  return `exit ${summary.exitCode ?? '?'}`;
}

/**
 * Running processes with Stop, and recent ones with how they ended (D301, design §6.3). A running
 * one no tab owns — a dev server started from another browser tab, or before a reload — shows its
 * latest line and opens in a tab with Show.
 */
export function ProcessesList({ projectId }: { projectId: string }) {
  const list = useProcessList(projectId);
  const stop = useStopProcess(projectId);
  const queryClient = useQueryClient();
  const tabs = useProjectTerminals(projectId).tabs;
  const unowned = useTerminalStore((state) => state.unowned);
  const items = list.data ?? [];

  return (
    <section aria-label="Processes" className="flex w-60 shrink-0 flex-col border-l border-border">
      <h3 className="shrink-0 px-2 py-1 font-machine text-[10.5px] uppercase tracking-[0.1em] text-fg-muted">
        Processes
      </h3>
      <ul className="min-h-0 flex-1 overflow-auto px-1 pb-1">
        {list.isSuccess && items.length === 0 && (
          <li className="px-1 text-[12px] text-fg-muted">Nothing has run yet.</li>
        )}
        {items.map((summary) => {
          const running = summary.status === 'running';
          const owned = tabs.some((tab) => tab.processId === summary.id);
          const preview = running && !owned ? lastLine(unowned[summary.id]?.output) : undefined;
          return (
            <li
              key={summary.id}
              data-testid={`process-${summary.id}`}
              className="flex items-center gap-1 rounded px-1 py-0.5 text-[12px] hover:bg-card"
            >
              <span
                aria-hidden
                className={running ? 'h-1.5 w-1.5 shrink-0 rounded-full bg-accent' : 'h-1.5 w-1.5 shrink-0'}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-fg" title={summary.command}>
                  {summary.label}
                </span>
                {preview !== undefined && (
                  <span className="block truncate font-machine text-[11px] text-fg-muted">{preview}</span>
                )}
              </span>
              {running ? (
                <>
                  {!owned && (
                    <button
                      type="button"
                      aria-label={`Show ${summary.label}`}
                      onClick={() => void openProcessInTab(projectId, summary, queryClient)}
                      className="font-machine text-[11px] text-fg-muted hover:text-fg"
                    >
                      Show
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`Stop ${summary.label}`}
                    onClick={() => stop.mutate(summary.id)}
                    className="font-machine text-[11px] text-danger hover:underline"
                  >
                    Stop
                  </button>
                </>
              ) : (
                <span className="shrink-0 font-machine text-[11px] text-fg-faint">{endingOf(summary)}</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
```

Create `apps/web/src/forge/terminal/ScriptButtons.tsx`:

```tsx
import { useQueryClient } from '@tanstack/react-query';
import { Play } from 'lucide-react';

import { useProjectScripts } from './hooks';
import { runScript } from './session';

/** The project's own scripts, one button each; a click runs it in a new tab (D301, design §6.3). */
export function ScriptButtons({ projectId, disabled = false }: { projectId: string; disabled?: boolean }) {
  const scripts = useProjectScripts(projectId);
  const queryClient = useQueryClient();
  const manager = scripts.data?.packageManager ?? 'npm';
  const list = scripts.data?.scripts ?? [];
  if (list.length === 0) return null;
  return (
    <div role="group" aria-label="Scripts" className="flex min-w-0 items-center gap-1 overflow-x-auto">
      {list.map((script) => (
        <button
          key={script.name}
          type="button"
          disabled={disabled}
          title={`${manager} run ${script.name}: ${script.command}`}
          onClick={() => void runScript(projectId, script.name, manager, queryClient)}
          className="flex h-6 shrink-0 items-center gap-1 rounded border border-border px-1.5 font-machine text-[11px] text-fg-soft hover:border-fg-muted hover:text-fg disabled:opacity-40"
        >
          <Play className="h-3 w-3" aria-hidden />
          {script.name}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 6: The panel's layout**

Replace `apps/web/src/forge/terminal/TerminalPanel.tsx` with:

```tsx
import { useEffect } from 'react';

import { ProcessesList } from './ProcessesList';
import { ScriptButtons } from './ScriptButtons';
import { TerminalTabs } from './TerminalTabs';
import { TerminalView } from './TerminalView';
import { useProjectTerminals, useTerminalStore } from './terminal-store';

/**
 * The bottom panel's Terminal view (D301, design §6.3): the tabs and the project's script buttons
 * above, the active tab, and the Processes list beside it. Opening it with no tab opens one.
 */
export function TerminalPanel({ projectId }: { projectId: string }) {
  const terminals = useProjectTerminals(projectId);
  useEffect(() => {
    const store = useTerminalStore.getState();
    if ((store.projects[projectId]?.tabs.length ?? 0) === 0) store.newTab(projectId);
  }, [projectId]);
  const active = terminals.tabs.find((tab) => tab.id === terminals.active) ?? terminals.tabs[0];

  return (
    <div data-testid="terminal-panel" className="flex h-full min-h-0 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border px-2">
        <TerminalTabs projectId={projectId} />
        <div className="flex-1" />
        <ScriptButtons projectId={projectId} />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1">
          {active !== undefined ? (
            <TerminalView key={active.id} projectId={projectId} tabId={active.id} />
          ) : (
            <p className="p-3 text-[12px] text-fg-muted">No terminal open.</p>
          )}
        </div>
        <ProcessesList projectId={projectId} />
      </div>
    </div>
  );
}
```

- [ ] **Step 7: The key, the store, the workbench, the status bar and the empty editor**

In `apps/web/src/app/shortcuts.ts`, add to `SHORTCUTS` after `closeTab`:

```ts
  /** D301: shows or hides the Terminal. Not a browser key, so it is safe to bind. */
  toggleTerminal: { code: 'Backquote', mod: true },
```

and replace `shortcutLabel` with:

```ts
/** Keys whose `code` is not what a person reads on the key. */
const KEY_LABELS: Readonly<Record<string, string>> = { Backquote: '`' };

/** "Ctrl+Shift+2" on Windows, "⌘⇧2" on a Mac — for titles and the empty editor's hints. */
export function shortcutLabel(shortcut: Shortcut): string {
  const key = KEY_LABELS[shortcut.code] ?? shortcut.code.replace(/^Key|^Digit/, '');
  if (isMac())
    return `${shortcut.mod ? '⌘' : ''}${shortcut.alt ? '⌥' : ''}${shortcut.shift ? '⇧' : ''}${key}`;
  return [shortcut.mod && 'Ctrl', shortcut.alt && 'Alt', shortcut.shift && 'Shift', key]
    .filter(Boolean)
    .join('+');
}
```

In `apps/web/src/app/stores/layout.ts`, add to `LayoutState` after `toggleMaximized(): void;`:

```ts
  /** Ctrl+`: the Terminal shows; when it is what shows, the panel hides (D301). */
  toggleTerminal(): void;
```

and to the store's actions after `toggleMaximized: …,`:

```ts
      toggleTerminal: () =>
        set((s) =>
          s.panelOpen && s.panelTab === 'terminal'
            ? { panelOpen: false, panelMaximized: false }
            : { panelOpen: true, panelTab: 'terminal' },
        ),
```

In `apps/web/src/forge/ForgeWorkbench.tsx`, after `const togglePanel = useLayoutStore((s) => s.togglePanel);` add `const toggleTerminal = useLayoutStore((s) => s.toggleTerminal);`, and in `useShortcuts([...])`, after `[SHORTCUTS.togglePanel, togglePanel],` add:

```ts
    [SHORTCUTS.toggleTerminal, toggleTerminal],
```

In `apps/web/src/forge/layout/StatusBar.tsx`:
1. Change the lucide import to `import { AlertTriangle, GitBranch, PanelBottom, Play, XCircle } from 'lucide-react';` and add `import { runningCount, useProcessList } from '../terminal/hooks';`.
2. After `const textActive = …;` add `const running = runningCount(useProcessList(projectId).data);`.
3. After the Problems `</button>` (line 55), add:

```tsx
      {running > 0 && (
        <button
          type="button"
          title="Running processes: open the Terminal"
          onClick={() => showPanel('terminal')}
          className="flex items-center gap-1 hover:text-fg"
        >
          <Play className="h-3 w-3" aria-hidden />
          {`${running} running`}
        </button>
      )}
```

In `apps/web/src/forge/editor/EmptyEditor.tsx`:
1. Change the lucide import to `import { FilePlus, Search, SquareTerminal } from 'lucide-react';`.
2. In `HINTS`, after the `togglePanel` row, add `{ label: 'Show or hide the terminal', shortcut: SHORTCUTS.toggleTerminal },`.
3. In the component, after `const showQuickOpen = useQuickOpen((s) => s.show);` add `const toggleTerminal = useLayoutStore((s) => s.toggleTerminal);`.
4. After the New file `<Button>`, add:

```tsx
          <Button variant="secondary" size="sm" onClick={toggleTerminal}>
            <SquareTerminal className="h-3.5 w-3.5" aria-hidden /> Terminal{' '}
            <span className="font-machine text-fg-faint">{shortcutLabel(SHORTCUTS.toggleTerminal)}</span>
          </Button>
```

- [ ] **Step 8: Run the tests**

Run: `pnpm --filter @ace/web exec vitest run src/forge/terminal src/forge/layout src/app src/forge/ForgeWorkbench.test.tsx src/forge/editor`
Expected: PASS.

- [ ] **Step 9: Full web suite, typecheck, lint, commit**

Run: `pnpm --filter @ace/web test && pnpm --filter @ace/web typecheck && pnpm --filter @ace/web lint`
Expected: PASS.

```bash
npx prettier --write --config packages/config/prettier.config.js apps/web/src/forge/terminal apps/web/src/forge/layout/StatusBar.tsx apps/web/src/forge/layout/StatusBar.test.tsx apps/web/src/app/shortcuts.ts apps/web/src/app/shortcuts.test.tsx apps/web/src/app/stores/layout.ts apps/web/src/app/stores/layout.test.ts apps/web/src/forge/ForgeWorkbench.tsx apps/web/src/forge/ForgeWorkbench.test.tsx apps/web/src/forge/editor/EmptyEditor.tsx
git add apps/web/src
git commit -m "feat(web): terminal tabs, the Processes list with Stop, script buttons, a running count in the status bar and Ctrl+\` [D301]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 15: Web — the trust level: the project's Terminal setting and what the Terminal says

**Files:**
- Create: `apps/web/src/forge/terminal/TrustNotice.tsx`
- Modify:
  - `apps/web/src/settings/SettingFields.tsx` (gains `SelectField`);
  - `apps/web/src/settings/SettingsPage.tsx:9-21` (imports) and `:89-131` (`SelectField` moves out);
  - `apps/web/src/projects/ProjectPage.tsx:1-10` (imports) and `:68-78` (the Terminal select after the budget);
  - `apps/web/src/forge/terminal/TerminalPanel.tsx` (the notice; `off` disables);
  - `apps/web/src/forge/terminal/TerminalView.tsx` (`disabled`).
- Test: create `apps/web/src/projects/ProjectPage.test.tsx` and `apps/web/src/forge/terminal/TerminalTrust.test.tsx`; the existing `apps/web/src/settings/SettingsPage.test.tsx` must still pass unchanged.

**Interfaces:**
- Consumes:
  - from Task 2: `TerminalTrust`, `UpdateProjectRequest.terminal`;
  - from Tasks 13–14: `TerminalPanel`, `TerminalView`, `TerminalTabs({ disabled })`, `ScriptButtons({ disabled })`, `FakeTerminal`;
  - existing: `useProject`, `useUpdateProject` (`projects/hooks.ts`), `SettingInput`.
- Produces:
  - `SelectField<T extends string>({ id, label, hint?, testId, value, options, onChange, disabled })`, exported from `settings/SettingFields.tsx`;
  - the project page's select, test id `project-terminal`, with options `On — any command`, `Scripts only` and `Off`;
  - `TrustNotice({ projectId, trust })`, test id `terminal-trust-notice`, `null` for `on`;
  - `TerminalView({ projectId, tabId, disabled? })`: when disabled, xterm's `disableStdin` is set and nothing typed is acted on;
  - with `off`, New terminal and the script buttons are disabled. With `scripts`, the script buttons stay enabled, and a typed command prints the engine's 403 message in the tab (Task 13's `startInTab` already prints a refusal).

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/projects/ProjectPage.test.tsx`:

```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { db, installMockServer, processes, renderApp } from '../test/app';

installMockServer();

async function terminalSelect() {
  const select = await screen.findByTestId('project-terminal');
  await waitFor(() => expect(select).toBeEnabled());
  return select;
}

describe('D301 a project says how far it trusts its terminal', () => {
  it('reads On by default, and saves Scripts only', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'Shop' });
    renderApp(`/projects/${project.id}`);
    const select = await terminalSelect();
    expect(select).toHaveTextContent('On — any command');

    await user.click(select);
    await user.click(await screen.findByRole('option', { name: 'Scripts only' }));
    await waitFor(() => expect(db.getProject(project.id)?.terminal).toBe('scripts'));
    expect(select).toHaveTextContent('Scripts only');
  });

  it('Off stops what runs in the project', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'Shop' });
    const { processId } = processes.start(project.id, { command: 'serve' });
    renderApp(`/projects/${project.id}`);
    const select = await terminalSelect();

    await user.click(select);
    await user.click(await screen.findByRole('option', { name: 'Off' }));
    await waitFor(() => expect(db.getProject(project.id)?.terminal).toBe('off'));
    expect(processes.get(project.id, processId)).toMatchObject({ status: 'exited', signal: 'SIGKILL' });
  });
});
```

Create `apps/web/src/forge/terminal/TerminalTrust.test.tsx`:

```tsx
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { api } from '../../app/api';
import { getSocket } from '../../app/socket';
import { db, installMockServer, installMockSocket, queryClient } from '../../test/app';
import { FakeTerminal } from '../../test/FakeTerminal';
import { useProcessEvents } from './process-events';
import { TerminalPanel } from './TerminalPanel';

installMockServer();
installMockSocket();

const PACKAGE = JSON.stringify({ scripts: { hello: 'echo hi from a script' } });

function Harness({ projectId }: { projectId: string }) {
  useProcessEvents(projectId);
  return <TerminalPanel projectId={projectId} />;
}

async function open(trust: 'on' | 'scripts' | 'off'): Promise<string> {
  const project = db.createProject({ name: 'Shop' });
  db.updateProject(project.id, { terminal: trust });
  db.seedFiles(project.id, { 'package.json': PACKAGE });
  render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <Harness projectId={project.id} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  await screen.findByTestId('terminal-screen');
  await vi.waitFor(() => expect(getSocket()?.status).toBe('open'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  return project.id;
}

const scriptButton = async (name: string) =>
  within(await screen.findByRole('group', { name: 'Scripts' })).findByRole('button', { name });

describe('D301 the Terminal follows the project’s trust level', () => {
  it('off: says so with a link to the project, and neither typing, New terminal nor a script does anything', async () => {
    const start = vi.spyOn(api(), 'startProcess');
    const projectId = await open('off');

    const notice = await screen.findByTestId('terminal-trust-notice');
    expect(notice).toHaveTextContent('The terminal is off for this project.');
    expect(within(notice).getByRole('link')).toHaveAttribute('href', `/projects/${projectId}`);
    await waitFor(() => expect(FakeTerminal.latest().options['disableStdin']).toBe(true));

    act(() => FakeTerminal.latest().type('echo hi\r'));
    expect(FakeTerminal.latest().plain()).toBe('~ $ ');
    expect(screen.getByRole('button', { name: 'New terminal' })).toBeDisabled();
    expect(await scriptButton('hello')).toBeDisabled();
    expect(start).not.toHaveBeenCalled();
    start.mockRestore();
  });

  it('scripts: says so; a typed command prints the refusal in the tab, and a script still runs', async () => {
    const user = userEvent.setup();
    await open('scripts');
    expect(await screen.findByTestId('terminal-trust-notice')).toHaveTextContent(
      'This project runs only its own package.json scripts here.',
    );

    act(() => FakeTerminal.latest().type('echo hi\r'));
    await waitFor(() =>
      expect(FakeTerminal.latest().plain()).toContain(
        "This project runs only its own package.json scripts in the terminal. Pick a script, or allow every command in the project's settings.",
      ),
    );
    expect(FakeTerminal.latest().plain().endsWith('~ $ ')).toBe(true);

    const hello = await scriptButton('hello');
    expect(hello).toBeEnabled();
    await user.click(hello);
    await waitFor(() => expect(FakeTerminal.latest().plain()).toContain('hi from a script'));
  });

  it('on: no notice, and typing runs', async () => {
    await open('on');
    expect(screen.queryByTestId('terminal-trust-notice')).toBeNull();
    act(() => FakeTerminal.latest().type('echo hi\r'));
    await waitFor(() => expect(FakeTerminal.latest().plain()).toBe('~ $ echo hi\nhi\n~ $ '));
  });
});
```

- [ ] **Step 2: Run them to watch them fail**

Run: `pnpm --filter @ace/web exec vitest run src/projects/ProjectPage.test.tsx src/forge/terminal/TerminalTrust.test.tsx`
Expected: FAIL. There is no `project-terminal` select and no `terminal-trust-notice`, and typing with the terminal off still echoes.

- [ ] **Step 3: Move `SelectField`**

In `apps/web/src/settings/SettingFields.tsx`, change the `@ace/ui` import to:

```ts
import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ace/ui';
```

and append the `SelectField` function, moved verbatim from `SettingsPage.tsx` (lines 89-131) with `export` and a comment:

```tsx

/**
 * One choice from a fixed list, saved as it changes (FR-SYS-005). Shared by the settings screen
 * and the project page (D301's Terminal trust level).
 */
export function SelectField<T extends string>({
  id,
  label,
  hint,
  testId,
  value,
  options,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  hint?: string;
  testId: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value}
        onValueChange={(next) => {
          const option = options.find((candidate) => candidate.value === next);
          if (option !== undefined && option.value !== value) onChange(option.value);
        }}
        disabled={disabled}
      >
        <SelectTrigger id={id} className="w-full sm:w-64" data-testid={testId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hint && <p className="text-xs text-fg-muted">{hint}</p>}
    </div>
  );
}
```

In `apps/web/src/settings/SettingsPage.tsx`, delete the local `function SelectField…` (lines 89-131), remove `Select, SelectContent, SelectItem, SelectTrigger, SelectValue,` from the `@ace/ui` import (`Label` and `Input` stay: the data folder and the MCP checkbox use them), and change the local import to:

```ts
import { SelectField, SettingInput, type DraftRead } from './SettingFields';
```

- [ ] **Step 4: The project page's select**

In `apps/web/src/projects/ProjectPage.tsx`, add:

```ts
import type { TerminalTrust } from '@ace/contracts';
```

as the first import, and `import { SelectField } from '../settings/SettingFields';` after the `BudgetFields` import. Above the component, add:

```ts
/** D301: how far this project trusts Forge's terminal. */
const TERMINAL_OPTIONS: ReadonlyArray<{ value: TerminalTrust; label: string }> = [
  { value: 'on', label: 'On — any command' },
  { value: 'scripts', label: 'Scripts only' },
  { value: 'off', label: 'Off' },
];
```

and after the `<BudgetFields … />` element, add:

```tsx
      {/* D301: Forge's terminal. Off disables it now: what runs is stopped. */}
      <SelectField<TerminalTrust>
        id="project-terminal"
        label="Terminal"
        hint="On runs any command typed in Forge's terminal. Scripts only runs this project's package.json scripts. Off turns the terminal off and stops what runs."
        testId="project-terminal"
        value={project.data?.terminal ?? 'on'}
        options={TERMINAL_OPTIONS}
        onChange={(terminal) => updateProject.mutate({ id: projectId, terminal })}
        disabled={!project.data}
      />
```

- [ ] **Step 5: The notice, and off in the Terminal**

Create `apps/web/src/forge/terminal/TrustNotice.tsx`:

```tsx
import type { TerminalTrust } from '@ace/contracts';
import { Link } from 'react-router-dom';

/** With `scripts` or `off`, the Terminal says so, and where to change it (D301). */
export function TrustNotice({ projectId, trust }: { projectId: string; trust: TerminalTrust }) {
  if (trust === 'on') return null;
  return (
    <p
      role="status"
      data-testid="terminal-trust-notice"
      className="shrink-0 border-b border-border px-3 py-1 text-[12px] text-fg-muted"
    >
      {trust === 'off'
        ? 'The terminal is off for this project.'
        : 'This project runs only its own package.json scripts here.'}{' '}
      <Link to={`/projects/${projectId}`} className="underline hover:text-fg">
        Change it in the project’s settings
      </Link>
    </p>
  );
}
```

In `apps/web/src/forge/terminal/TerminalView.tsx`:
1. Change the signature to:

```tsx
export function TerminalView({
  projectId,
  tabId,
  disabled = false,
}: {
  projectId: string;
  tabId: string;
  /** The project's terminal is off: nothing typed is acted on (D301). */
  disabled?: boolean;
}) {
```

2. After `const [query, setQuery] = useState('');` add:

```tsx
  const locked = useRef(disabled);
  locked.current = disabled;
```

3. Change the `onData` line to:

```tsx
    const input = term.onData((data) => {
      if (!locked.current) void typed(projectId, tabId, data, queryClient);
    });
```

4. After the theme effect, add:

```tsx
  useEffect(() => {
    if (terminal.current !== undefined) terminal.current.options.disableStdin = disabled;
  }, [disabled]);
```

In `apps/web/src/forge/terminal/TerminalPanel.tsx`:
1. Add `import { useProject } from '../../projects/hooks';` and `import { TrustNotice } from './TrustNotice';`.
2. After `const terminals = useProjectTerminals(projectId);` add:

```tsx
  const trust = useProject(projectId).data?.terminal ?? 'on';
  const off = trust === 'off';
```

3. Make the returned tree start with the notice and pass `disabled`:

```tsx
    <div data-testid="terminal-panel" className="flex h-full min-h-0 flex-col">
      <TrustNotice projectId={projectId} trust={trust} />
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border px-2">
        <TerminalTabs projectId={projectId} disabled={off} />
        <div className="flex-1" />
        <ScriptButtons projectId={projectId} disabled={off} />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1">
          {active !== undefined ? (
            <TerminalView key={active.id} projectId={projectId} tabId={active.id} disabled={off} />
          ) : (
            <p className="p-3 text-[12px] text-fg-muted">No terminal open.</p>
          )}
        </div>
        <ProcessesList projectId={projectId} />
      </div>
    </div>
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @ace/web exec vitest run src/projects src/settings src/forge/terminal`
Expected: PASS, the settings tests included.

- [ ] **Step 7: Full web suite, typecheck, lint, commit**

Run: `pnpm --filter @ace/web test && pnpm --filter @ace/web typecheck && pnpm --filter @ace/web lint`
Expected: PASS.

```bash
npx prettier --write --config packages/config/prettier.config.js apps/web/src/settings/SettingFields.tsx apps/web/src/settings/SettingsPage.tsx apps/web/src/projects/ProjectPage.tsx apps/web/src/projects/ProjectPage.test.tsx apps/web/src/forge/terminal
git add apps/web/src
git commit -m "feat(web): a project's Terminal setting — on, scripts only or off — and the Terminal says which [D301]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: Web e2e — the Terminal in a real browser, with the real xterm

**Files:**
- Create: `apps/web/e2e/terminal.spec.ts`
- Modify: `apps/web/e2e/helpers.ts` (append the terminal helpers)

**Interfaces:**
- Consumes:
  - from Task 11: the mock's scripted commands and `window.__aceMock.setTerminal`;
  - from Tasks 13–15: the test ids `terminal-view`, `terminal-panel` and `terminal-trust-notice`, the `Terminals` tablist, the `Scripts` group and the `Processes` region;
  - existing: `freshApp`, `seedForge`, `forgeUrl`.
- Produces: `terminalText(page)`, `openTerminal(page, seeded)` and `runLine(page, line)` in `e2e/helpers.ts`, and the spec.

- [ ] **Step 1: The helpers**

Append to `apps/web/e2e/helpers.ts`:

```ts

/** Forge's terminal (D301): the real xterm's rows, as text. */
export const terminalText = (page: Page): Locator =>
  page.locator('[data-testid="terminal-view"] .xterm-rows');

/** Forge with the Terminal open, focused, at its prompt. */
export async function openTerminal(page: Page, seeded: Seeded): Promise<void> {
  await page.goto(forgeUrl(seeded));
  await expect(page.getByTestId('forge')).toBeVisible();
  await page.keyboard.press('Control+Backquote');
  await expect(terminalText(page)).toContainText('~ $');
  await page.getByTestId('terminal-view').click();
}

/** Types a line into the focused terminal and presses Enter, as a person would. */
export async function runLine(page: Page, line: string): Promise<void> {
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
}
```

- [ ] **Step 2: Write the spec**

Create `apps/web/e2e/terminal.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

import { forgeUrl, freshApp, openTerminal, runLine, seedForge, terminalText } from './helpers';

const FILES = {
  'src/app.ts': 'export const app = 1;\n',
  'package.json': JSON.stringify(
    {
      name: 'shop',
      packageManager: 'pnpm@9.15.9',
      scripts: { hello: 'echo hi from a script', dev: 'serve' },
    },
    null,
    2,
  ),
};

test.describe('Forge terminal (D301)', () => {
  test.beforeEach(async ({ page }) => freshApp(page));

  test('runs echo hello and shows its output', async ({ page }) => {
    await openTerminal(page, await seedForge(page, FILES));
    await runLine(page, 'echo hello');
    await expect(terminalText(page)).toContainText('hello');
    await expect(terminalText(page)).toContainText('~ $ echo hello');
  });

  test('a dev server streams until Ctrl+C stops it, and the Processes list shows it ended', async ({
    page,
  }) => {
    await openTerminal(page, await seedForge(page, FILES));
    await runLine(page, 'serve');
    await expect(terminalText(page)).toContainText('listening on 3000');
    await expect(terminalText(page)).toContainText('GET / 200 (2)', { timeout: 5_000 });
    await expect(page.getByRole('button', { name: '1 running' })).toBeVisible();

    await page.keyboard.press('Control+C');
    await expect(terminalText(page)).toContainText('[stopped (SIGKILL)]');
    await expect(page.getByRole('region', { name: 'Processes' }).getByText('stopped')).toBeVisible();
    await expect(page.getByRole('button', { name: /running$/ })).toHaveCount(0);
  });

  test('a line prompt reads what is typed', async ({ page }) => {
    await openTerminal(page, await seedForge(page, FILES));
    await runLine(page, 'ask');
    await expect(terminalText(page)).toContainText('name?');
    await runLine(page, 'Ada');
    await expect(terminalText(page)).toContainText('hello Ada');
  });

  test('cd src changes the prompt, and cd .. comes back', async ({ page }) => {
    await openTerminal(page, await seedForge(page, FILES));
    await runLine(page, 'cd src');
    await expect(terminalText(page)).toContainText('src $');
    await runLine(page, 'cd ..');
    // Row by row (innerText); \s also matches the no-break spaces xterm may render.
    await expect(terminalText(page)).toContainText(/src\s\$\scd\s\.\.\s+~\s\$/, {
      useInnerText: true,
    });
  });

  test('a script button runs the script in a new tab', async ({ page }) => {
    await openTerminal(page, await seedForge(page, FILES));
    await page.getByRole('group', { name: 'Scripts' }).getByRole('button', { name: 'hello' }).click();
    await expect(
      page.getByRole('tablist', { name: 'Terminals' }).getByRole('tab', { name: 'hello' }),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(terminalText(page)).toContainText('pnpm run hello');
    await expect(terminalText(page)).toContainText('hi from a script');
  });

  test('scrollback survives Ideate and back', async ({ page }) => {
    await openTerminal(page, await seedForge(page, FILES));
    await runLine(page, 'echo kept across modes');
    await expect(terminalText(page)).toContainText('kept across modes');
    await page.keyboard.press('Control+Shift+Digit1');
    await expect(page.getByTestId('canvas')).toBeVisible();
    await page.keyboard.press('Control+Shift+Digit2');
    await expect(terminalText(page)).toContainText('kept across modes');
  });

  test('with the terminal off, the notice shows and typing does nothing', async ({ page }) => {
    const seeded = await seedForge(page, FILES);
    await page.evaluate((id) => window.__aceMock!.setTerminal(id, 'off'), seeded.projectId);
    await page.goto(forgeUrl(seeded));
    await expect(page.getByTestId('forge')).toBeVisible();
    await page.keyboard.press('Control+Backquote');
    await expect(page.getByTestId('terminal-trust-notice')).toContainText(
      'The terminal is off for this project.',
    );
    await page.getByTestId('terminal-view').click();
    await page.keyboard.type('echo nope');
    await page.keyboard.press('Enter');
    await expect(terminalText(page)).not.toContainText('echo nope');
    await expect(page.getByRole('button', { name: 'New terminal' })).toBeDisabled();
  });

  test('Ctrl+` shows and hides the Terminal, even with focus in it', async ({ page }) => {
    await openTerminal(page, await seedForge(page, FILES));
    await expect(page.getByTestId('terminal-panel')).toBeVisible();
    await page.keyboard.press('Control+Backquote');
    await expect(page.getByTestId('terminal-panel')).toHaveCount(0);
    await page.keyboard.press('Control+Backquote');
    await expect(page.getByTestId('terminal-panel')).toBeVisible();
  });
});
```

- [ ] **Step 3: Run the spec**

Run (Git Bash, from the worktree root):

```bash
ACE_E2E_PORT=5196 pnpm --filter @ace/web exec playwright test e2e/terminal.spec.ts
```

Expected: 8 passed. The port keeps this run off the person's 5173 and another worktree's 5174. If xterm's DOM differs from `.xterm-rows`, read the real DOM with `--debug` and fix the helper, not the assertions.

- [ ] **Step 4: The whole e2e suite**

```bash
ACE_E2E_PORT=5196 pnpm --filter @ace/web test:e2e
```

Expected: every spec passes. A known flake (Phase 1's TC-EXE-007 in `run.spec.ts`) is reported with its rerun's result, never silently retried.

- [ ] **Step 5: Commit**

```bash
npx prettier --write --config packages/config/prettier.config.js apps/web/e2e/terminal.spec.ts apps/web/e2e/helpers.ts
git add apps/web/e2e
git commit -m "test(web): e2e for the Terminal with the real xterm — run, stream, stop, prompts, cd, scripts, trust and Ctrl+\` [D301]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 17: Docs, the gates, a live check on an isolated real engine, and the hand-off

**Files:**
- Modify: `docs/DECISIONS.md` (the D301 row), `docs/user-guide/forge.md` (the layout line, a Terminal section, the limits), `CLAUDE.md` §9 (a Feature Log row)

**Interfaces:**
- Consumes: the whole branch.
- Produces: the refined D301 row, the user guide's Terminal section, a Feature Log row, green gates, and a live-check report.

- [ ] **Step 1: Refine the D301 row**

In `docs/DECISIONS.md`, replace the D301 row (line 230) with this row. Put the output of `date +%F` in place of `DATE`:

```markdown
| D301 | The terminal runs a person's commands as supervised processes | A process runs through the platform shell (`cmd.exe /d /s /c`, `/bin/sh -c`) with stdin open, in a working folder confined like a file read (`.git` refused), with the engine's environment minus anything secret-shaped (`SSH_AUTH_SOCK`, `SSH_AGENT_PID`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS` and `SESSIONNAME` kept; `FORCE_COLOR=1`). Output streams as transient `process.output` frames batched at 50 ms and ends with a transient `process.exited`; the last 1,048,576 characters per process and the last 20 finished processes per project are kept in memory only; at most 8 run per project; Stop kills the whole tree; every process stops on shutdown before the database closes. A per-project trust level governs a start: `on` (the default), `scripts` (only the root package.json scripts, run as `<pm> run <name>` with the manager from `packageManager`, then the lockfiles, else npm) or `off` (and turning it off stops what runs); input, stop, list and get always work. Agents never use it. No PTY in v1. Phase 2 refinements: the start body is `{ command }` or `{ script }`; `GET /processes/:procId` answers the kept output, which a terminal tab re-fetches on entering Forge and on every reconnect; new codes `terminal_disabled`, `terminal_restricted` (403), `process_limit`, `process_not_running` (409); the WebSocket upgrade checks Origin with REST's allow-list and closes a foreign page with 4403, and `selfOrigins` use the real port; the web terminal is xterm (`@xterm/xterm` 6.0.0 with the fit, web-links and search addons) over the app's own line discipline (echo, editing, ↑/↓ history of 100, Ctrl+C), with `cd`/`cls`/`clear` built in, several tabs, a Processes list, script buttons, a running count in the status bar and Ctrl+`. | design §6.3, §7; FR-GIT-008, FR-SYS-003, FR-SYS-008 | DATE | Arhant (Claude) |
```

- [ ] **Step 2: The user guide**

In `docs/user-guide/forge.md`, under `## The layout`, replace:

```markdown
- **Bottom:** Problems and Output. **Ctrl+J** shows or hides the panel. Your choice is remembered.
```

with:

```markdown
- **Bottom:** the Terminal, Problems and Output. **Ctrl+J** shows or hides the panel, **Ctrl+`**
  the Terminal. Your choice is remembered.
```

Insert this section before `## Keys the browser keeps`:

```markdown
## The terminal

**Ctrl+`** opens the Terminal; so do the status bar's **▶ running** count and **Terminal** in an
empty editor. Type a command and press **Enter**: it runs in the project folder through your
system's shell (`cmd.exe` on Windows, `/bin/sh` elsewhere), and its output streams in, colours
and links included.

- **While it runs**, what you type goes to it: answer its prompt and press **Enter**. **Ctrl+C**
  stops it, and everything it started.
- **`cd src`** moves the tab into a folder of the project, and the prompt says where you are.
  `cd ..` stops at the project folder; `cd` alone prints where you are. **`cls`** or **`clear`**
  clears the tab.
- **↑ / ↓** bring back earlier commands. **Ctrl+F** finds text in the tab.
- **Several tabs:** **+** opens another; double-click a tab to rename it. Closing a tab whose
  command still runs asks before it stops it.
- **Scripts:** the buttons above the terminal run the project's `package.json` scripts, each in its
  own tab, with the package manager the project uses (pnpm, yarn, bun or npm).
- **Processes**, beside the terminal, lists what runs, with **Stop**, and what ran, with how it
  ended. A command started from another browser tab shows there too; **Show** opens it in a tab.
- Up to 8 commands run at once in a project. A tab keeps the last 1 MB of output.

Each project chooses how far it trusts its terminal, on the project page under **Terminal**:

- **On — any command:** what you type, and the scripts.
- **Scripts only:** only the project's own `package.json` scripts.
- **Off:** nothing runs, and turning it off stops what runs.

Commands get your environment minus anything that looks like a secret: API keys, tokens and
passwords never reach them, while `PATH`, `HOME` and your ssh agent do. Agents never use the
terminal.
```

Under `## Limits in this version`, append:

```markdown
- The terminal is line-based: full-screen programs (vim, top, some installers' menus) do not
  render. Prompts that read a line work.
- A tab keeps its `cd`, but nothing else carries from one command to the next (`set`, `export`, an
  activated virtualenv). Chain them on one line instead: `venv\Scripts\activate && python app.py`.
- Processes live in the engine's memory: restarting the engine ends every command.
```

- [ ] **Step 3: Run every gate and record the real output**

```bash
pnpm --filter "./packages/**" build
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @ace/web test:coverage
pnpm --filter @ace/tools test:coverage
pnpm --filter @ace/engine test:coverage
ACE_E2E_PORT=5196 pnpm test:e2e
```

Expected: everything green.
- Coverage is at least 80 % for tools and engine, and at least 60 % for web.
- Paste the real summaries, with the counts per package, into the ledger and the Feature Log row's notes. Never claim green without them (CLAUDE.md §7).
- A Windows flake already known (TC-EXE-007 in `run.spec.ts`; the providers' EPERM on temp-dir cleanup) is reported as such, with the rerun's result.

- [ ] **Step 4: The live check on an isolated real engine**

The person's own ACE runs from `D:\ACE offcl\wt\forge` on 4747 and 5173. **Leave it alone.** This check uses its own data folder and ports 47491 (engine), 5197 (web) and 47592 (a test server).

Start the engine with a fake secret in its environment, so check 8 can look for it. Run each `&` line as a background command:

```bash
cd "D:/ACE offcl/wt/forge2"
LIVE="$(mktemp -d)"; echo "$LIVE"
ANTHROPIC_API_KEY=sk-ant-live-check-not-real ACE_PORT=47491 ACE_DATA_DIR="$(cygpath -w "$LIVE")" \
  pnpm --filter @ace/server exec tsx src/main.ts > "$LIVE/engine.log" 2>&1 &
until grep -q 'ACE engine ready' "$LIVE/engine.log"; do sleep 1; done
TOKEN="$(cat "$LIVE/session-token")"
VITE_ACE_URL=http://127.0.0.1:47491 pnpm --filter @ace/web exec vite --port 5197 --strictPort --host 127.0.0.1 \
  > "$LIVE/web.log" 2>&1 &
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"allowedOrigins":["http://127.0.0.1:5197","http://localhost:5197"]}' \
  http://127.0.0.1:47491/api/v1/settings > /dev/null
```

Make a project folder with a script and a small server:

```bash
mkdir -p "$LIVE/proj/src"
cat > "$LIVE/proj/package.json" <<'JSON'
{ "name": "live", "scripts": { "hello": "node -e \"console.log('hi from npm')\"", "dev": "node server.js" } }
JSON
cat > "$LIVE/proj/server.js" <<'JS'
require('http')
  .createServer((req, res) => { console.log('GET ' + req.url); res.end('ok'); })
  .listen(47592, () => console.log('listening on 47592'));
JS
PROJECT="$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"name\":\"Live\",\"folderPath\":$(node -e "console.log(JSON.stringify(process.argv[1]))" "$(cygpath -w "$LIVE/proj")")}" \
  http://127.0.0.1:47491/api/v1/projects | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).id))")"
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"name":"Main"}' \
  "http://127.0.0.1:47491/api/v1/projects/$PROJECT/workflows"
echo "open: http://127.0.0.1:5197/?token=$TOKEN"
```

Open the printed URL in Playwright's Chromium (Claude in Chrome cannot load local dev servers here), open the project's workflow, switch to Forge and press Ctrl+`. Then check:

1. `node -v` prints the real Node version.
2. `npm run hello` prints `hi from npm`; the **hello** script button does the same in a new tab.
3. The **dev** button prints `listening on 47592`. `curl -s http://127.0.0.1:47592/` answers `ok`, and the tab shows `GET /`. **Stop** in the Processes list ends it. Within 3 s, `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:47592/` answers `000`: the tree is gone (npm, then node) and the port is free.
4. `cd src` changes the prompt to `src $`, and `node -e "console.log(process.cwd())"` prints a path ending in `proj\src`.
5. `node -e "require('readline').createInterface({input:process.stdin}).question('name? ',n=>{console.log('hello '+n);process.exit(0)})"`, then `Ada`: it prints `hello Ada`.
6. Start **dev** again, then on the project page set **Terminal** to **Off**: within 3 s the port answers `000`. Back in Forge the notice shows, and typing does nothing.
7. A foreign page's socket is refused:

   ```bash
   pnpm --filter @ace/server exec node -e "const W=require('ws');const s=new W('ws://127.0.0.1:47491/ws?token=$TOKEN',{origin:'https://evil.example'});s.on('close',(c)=>{console.log(c);process.exit(0)})"
   ```

   It prints `4403`.
8. With the terminal **On** again, `node -e "console.log(process.env.ANTHROPIC_API_KEY || 'absent')"` prints `absent`.

Record each result in the ledger and the Feature Log notes. Anything that fails live is a bug: fix it test-first on this branch.

Then stop only what this check started, by the ports it bound (PowerShell, because Git Bash mangles `taskkill`'s `/T`):

```powershell
Get-NetTCPConnection -LocalPort 47491,5197,47592 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { taskkill /PID $_ /T /F }
```

Expected: the person's ACE on 4747 and 5173 still answers (`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4747/api/v1/health` gives `401` if it was running before).

- [ ] **Step 5: The Feature Log row**

In `CLAUDE.md` §9, append after the `IDE | F1` row, matching the table's columns. Fill the notes from Steps 3 and 4:

`| IDE | F2 | Forge phase 2 — the Terminal: supervised processes, trust levels, xterm tabs, Processes list, script buttons, WS Origin check | Arhant | feat/forge-phase-2 | IN REVIEW | — | DATE | — | Gates (Step 3, real counts per package, coverage) · live check 8 items (Step 4) · deviations: the Phase 2 refinements of D301 |`

- [ ] **Step 6: Commit the docs**

```bash
git add docs/DECISIONS.md docs/user-guide/forge.md CLAUDE.md
git commit -m "docs: Forge phase 2 — D301's refinements, the Terminal in the user guide, the Feature Log row [D301]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Hand off**

Use superpowers:finishing-a-development-branch. Pushing, opening a PR, or merging is the user's decision: report the branch, the gates, the live-check results and the open items, then ask.

---

## Plan self-review

**1. Spec coverage**

| Spec line | Task |
|---|---|
| §6.3 `POST /` `{ command, cwd?, label? }` → `{ processId }` (refined to `{ command } \| { script }`) | 2, 6, 7 |
| §6.3 `POST /:procId/input` `{ data }` | 2, 6, 7, 10 |
| §6.3 `POST /:procId/stop`: tree kill, `taskkill /T /F` / the process group | 4 (tree-kill test), 6, 7 |
| §6.3 `GET /`: running and recent, label, command, status, exit code, times | 2, 6, 7 |
| §6.3 `GET /scripts`: package.json scripts and their package manager | 5, 6, 7 |
| §6.3 the platform shell | 4 |
| §6.3 a working folder confined to the project, no TTY | 4 (confinement tests); 17 (no PTY in the guide) |
| §6.3 the environment minus secrets, `PATH`/`HOME` kept, `FORCE_COLOR=1` | 4 |
| §6.3 output as transient `process.output`, batched at 50 ms; the last 1 MB kept for late subscribers | 2, 6 (batching, cap), 7 and 12 (`GET /:procId`, re-attach) |
| §6.3 `process.exited` when it finishes | 2, 6, 8 (real socket) |
| §6.3 at most 8 at once per project; everything stops at shutdown | 6, 8 |
| §6.3 trust levels `on` / `scripts` / `off` | 2, 3, 6, 8, 15 |
| §6.3 agents never use the service | Global Constraints and decision 1: no tool, no registry entry |
| §6.3 web: xterm with fit; ANSI colour, links and find | 13 |
| §6.3 a tab is a line-mode session with its own folder and history | 12, 13 |
| §6.3 a typed line starts a process; lines go to stdin while it runs; Ctrl+C stops it | 13 |
| §6.3 `cd` built in and confined; `cls` / `clear` | 13 |
| §6.3 several tabs; a Processes list with Stop | 14 |
| §6.3 script buttons run a script in a new tab | 14 |
| §2.2 the status bar's running count opens the Terminal; Ctrl+` (the terminal); the empty editor's Toggle terminal; Terminal · Problems · Output | 13, 14 |
| §2.3 terminal sessions per project, with their scrollback, survive switching | 12, 13 |
| §7 every new route behind the token, Origin and request-id middleware | 7 (mounted on `api`) |
| §7 the WebSocket upgrade checks Origin against the REST allow-list | 9 |
| §7 terminal processes: scrubbed env, confined folder, capped output, limit, tree kill | 4, 6 |
| §7 nothing reaches the database or event log | 6 (zero events), 8 (`currentSeq` unchanged) |
| §8 process start, input and stop; summary; scripts; `process.output` / `process.exited` frames; `Project.terminal` | 2 |
| §8 storage: the project column | 3 |
| §9 `tools/process/`, `engine/processes/`, server wiring and the WS Origin check, SDK methods, the web terminal, the xterm dependencies | 4–5, 6–7, 8–9, 10, 12–15, 13 |
| §10 a process that fails to start says so in its terminal tab | 6 (`Could not start` on stderr, `failed`), 11 (`broken`), 13 (tab test) |
| §11 tools: process runner — streaming, stdin, tree kill, env scrubbing; the limit | 4, 6 |
| §11 engine: process routes and errors | 7 |
| §11 server integration: terminal streaming and stop; WS Origin refusal | 8, 9 |
| §11 web unit: a terminal's scrollback survives Ideate ↔ Forge | 13 |
| §11 web e2e: a terminal run | 16 |
| §12 item 2: process service and runner, the `project` scope, the xterm terminal with `cd`, scripts, the Processes view, trust levels, the WS Origin check | 2–16 |
| §14 no PTY; shell state does not carry, chaining in one line works | 13 (a chained `cd` goes to the shell), 17 (the guide) |

No spec line is left without a task. The phone layout (§2.1, no terminal at ≤ 640 px) needs no change: `CompactForge` renders no bottom panel.

**2. Placeholder scan.** No "TBD", "TODO", "implement later", "similar to Task N", or step without its code. Two values are filled at run time by command, not by guess: `DATE` (`date +%F`) and the gate counts, which Task 17 pastes from the real output. Every modified file names its anchor lines or quotes the text it replaces.

**3. Names and types across tasks**
- Port: `ProcessSpec`, `ProcessHandlers`, `RunningProcess`, `ProcessRunner { start, scripts }` (Tasks 4–5). Used unchanged by the fake (6), the service (6) and the server (8).
- Service: `createProcessService` and `ProcessService { start, input, stop, list, get, scripts, stopProject, stopAll }` (6). The routes (7), the gateway's PATCH (8) and the server (8) use these names.
- Tools: `createProcessRunner`, `readProjectScripts`, `scrubSecrets`, `SECRET_SHAPED`, `SCRUB_KEEP` (4–5).
- SDK: `startProcess`, `processInput`, `stopProcess`, `listProcesses`, `getProcess`, `projectScripts` (10). The web uses exactly these (12–15).
- Web: `useTerminalStore` (actions `newTab`, `closeTab`, `activate`, `rename`, `setLine`, `setCwd`, `write`, `clearScreen`, `idle`, `attach`, `output`, `exited`, `replaceLive`, `lost`, `reset`) and `LineState`, `busyLine`, `promptFor`, `feed` (12–13). `processKeys` and the hooks (12), `reattach` and `useProcessEvents` (12), `typed`, `startInTab`, `enqueue` (13), `runScript` and `openProcessInTab` (14).
- Mocks: `MockProcesses`, `createProcessHandlers`, `MOCK_MESSAGES`, `installMockSocket` (11–12), `FakeTerminal` and the three fake addons (13).
- The refusal messages are the same text in the engine (6), the mock (11) and the tests (10, 15).

**4. Review Focus pins**

| Line | Pinned by |
|---|---|
| 1. Megabytes, never ending, grandchildren | Task 4 "Stop kills the shell, its child and its grandchild within 2.5 s"; Task 6 "keeps only the last 1,048,576 characters, never half a character"; Task 12 "a tab keeps only the last 1,048,576 characters" |
| 2. Windows quoting | Task 4 "runs a line as the shell would: quotes, &&, \| and a variable" and "runs in a folder whose name has spaces and unicode" |
| 3. Engine stop and reconnect | Task 8 "stopping the engine stops every process it started, grandchildren included"; Task 12 "a re-attach replaces the tab's output with the engine's copy, once" and "a process the engine no longer knows ends the tab's run with a note" |
| 4. Split UTF-8 and ANSI | Task 4 "never splits a character or an ANSI colour across chunks" |
| 5. Secrets | Task 4 "a process never sees a secret-shaped variable, but keeps SSH_AUTH_SOCK, PATH and HOME" and the `scrubSecrets` table in `env.test.ts`; live check 8 in Task 17 |

**Known edge, accepted and named in the code:** a re-attach replaces the tab's copy with the engine's. A batch emitted after the engine took that copy, but arriving before the HTTP answer, is lost from view at the seam. A 50 ms batch is lost on a reconnect; nothing is ever doubled.
