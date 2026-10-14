# ACE — Agentic Nodes: every node works directly in Forge

> Build prompt for Claude Code. Save as `docs/team-prompts/agentic-nodes-prompt.md` and run it from the repo root on a new branch `feat/agentic-nodes`.

## Goal

Today a node can only return text, and a human clicks **Send to Forge** to get it into the workspace. After this work, a node with workspace access behaves like a coding agent: it reads files, creates and edits files, and runs terminal commands **directly in the Forge workspace**, and Forge shows it happening live.

How it works — the same loop every coding agent uses:

1. The engine sends the model the task plus a set of tool definitions.
2. The model replies with tool calls (`read_file`, `edit_file`, `run_command`, …).
3. The engine runs them inside the Forge workspace, streams events to the UI, and sends the results back to the model.
4. Repeat until the model answers with no tool calls, or a limit / cancel stops it.

The model never touches the machine. The engine does, through one tool layer that ACE owns. That tool layer is where permissions, path confinement, edit attribution and the terminal log live.

## Ground rules

- **Read before you build.** No file names, functions, routes or tables in this prompt are assumed. Phase 0 finds the real ones. Where this prompt says "the node runner" or "the SSE channel", use whatever Phase 0 found.
- Follow the repo's conventions: DECISIONS file with DECIDE blocks, Part/Milestone/Gate sequencing, existing ESLint rules, and the frontend ↔ engine boundary (HTTP/SSE only — React never calls Node APIs directly).
- Every new route body and every new event payload gets a Zod schema, the same way existing envelopes and IPC are validated.
- **No demo or fake data in the UI.** Every UI element below shows real engine state, or it is not built. (Tests may use the existing mock adapter — see Gate 2.)
- Windows is the primary dev platform (Node 24, pnpm). Everything must work there first without breaking macOS/Linux.
- Spec gaps are never filled silently. On anything in **Stop conditions** or **Conflicts with locked spec**, stop and ask. Don't improvise.

---

## Conflicts with locked spec — flag, don't resolve quietly

This feature touches several locked decisions. Phase 0 must confirm each one against the real spec/HLD, and each gets a DECIDE block before Phase 2 code is written. The defaults below are proposals, not decisions.

| # | Locked decision | What this feature does to it | Proposed default |
|---|---|---|---|
| C1 | Monaco editor is **read-only during runs** | Live file reloads and a "Keep mine" bar assume the user may edit mid-run | Keep the lock. The editor stays read-only during runs; the dirty-buffer bar only applies to buffers that had unsaved edits **before** the run started. |
| C2 | Envelope = reads + **bounded context** + output contract | A node with Read access can read the whole workspace, not just what the envelope hands it | Allowed, but recorded: the envelope still defines the task and contract; workspace reads are logged per step so Bench can see what each node actually consumed. |
| C3 | Core thesis: explicit outer loop beats a single agent's inner loop; avoid a "single-agent baseline in a costume" | Every node now runs its own inner loop (up to Max turns) | Nodes stay role-scoped (system prompt forbids work outside the node's contract). ACE Bench must record access level + Max turns per node, and the single-agent baseline arm must get the **same tool layer**, or the comparison is unfair. |
| C4 | **Immutable run records written at dispatch time** | Approvals, attribution, commands and commit shas appear after dispatch | Access level, Max turns, token budget, tool list and shell go into the dispatch record. Everything produced later goes into **append-only** tables keyed by run/step. Never update the dispatch record. |
| C5 | XState v5 machines **transcribed from the lifecycle document** | Approvals add a waiting state | `awaiting_approval` is a real XState state (not a boolean flag), and the lifecycle document is updated in the same PR. |
| C6 | Git-backed workspace with **stage commits** | This prompt adds per-node checkpoint commits | Extend the existing stage-commit convention; don't add a second one. |

---

## Phase 0 — Inventory (no behaviour changes)

Write `docs/team-prompts/agentic-nodes-inventory.md` answering all of these with real file and function names:

1. **Node execution path** — from Run on the canvas / Brain dispatch → where the model is called → where the output goes.
2. **Providers** — every provider type in the registry: HTTP API (which wire format: Anthropic Messages, OpenAI-compatible chat completions, OpenAI Responses, Gemini, other), CLI child process (`claude`, `codex`, `gemini`), or the mock adapter. For each: does the adapter support tool/function calling? Streaming? Does the registry record a context-window size and a tool-calling capability flag?
3. **Send to Forge** — where the button lives and what it does end to end.
4. **Forge workspace** — how the root folder is chosen; the file API (list/read/write/save); how the explorer and open Monaco buffers learn about changes on disk (watcher, polling, nothing); how git is used (simple-git calls, the stage-commit convention, commit hooks or signing config present in the repo).
5. **Engine → UI events** — the SSE channel(s), event naming, how the client subscribes.
6. **State** — the XState node machine and run machine (incl. `RUN_FAILED`, `CONTRACT_VIOLATION`, `BLOCKED`, `COMPLETE`, `HALTED`), where the lifecycle document lives, and where state is persisted (SQLite tables). Which tables are written once at dispatch.
7. **Handoff envelope** — Zod schema and where it's validated.
8. **Engine auth** — the token middleware. Every new route must use it.
9. **Process spawning today** — the JS sandbox, any CLI spawning, how children are killed on shutdown.
10. **DECISIONS** — file location, next free D-number, and what the sandbox-confinement entry (D-083) says.
11. **UI tokens** — where the redesign spec / design tokens live (`ACE-UI-redesign-prompt.md` or the implemented theme). Phase 3 must use them.
12. **ACE Bench** — how runs are versioned, and how arms are configured (needed for C2/C3).
13. **Locked-spec conflicts** — confirm or correct each row of the Conflicts table above against the actual spec.

**Gate 0:** the inventory file answers all 13. Continue to Phase 1 unless a stop condition hits.

---

## Phase 1 — Workspace Tools (engine)

One engine module (name it to fit the repo, e.g. `workspace-tools`) used by every agentic node. It knows nothing about models: it takes a tool call plus a node context and returns a result.

**Node context:** `{ runId, nodeId, nodeName, nodeColor, workspaceRoot, access, signal }` — `access` comes from node settings (Phase 2), `signal` is an `AbortSignal` for Stop/cancel.

### Tools

Use these exact names and argument shapes so every provider adapter shares them. Keep the tool descriptions the model sees short, and include the rules in the right column.

| Tool | Args | Behaviour and rules |
|---|---|---|
| `list_files` | `path?`, `pattern?` (glob), `max?` | Respects `.gitignore`; always skips `.git/` and `node_modules/`. Sorted, capped (default 500) with an "N more" note. |
| `read_file` | `path`, `offset?`, `limit?` | Numbered lines, default 2000 lines, lines over 2000 chars truncated. Records `{path, contentHash}` as read by this node. Binary files → a short notice, not bytes. |
| `search` | `pattern` (regex), `path?`, `glob?`, `max?` | Content search, gitignore-aware, returns `path:line: text`, capped. Use an existing dependency if the repo has one; otherwise implement in Node. |
| `write_file` | `path`, `content` | Creates the file and parent folders. If the file already exists, this node must have read it and its hash must be unchanged — otherwise return an error telling the model to read it again. |
| `edit_file` | `path`, `old_string`, `new_string`, `replace_all?` | Exact string replacement. Same read-before-edit + unchanged-hash rule. `old_string` must match exactly once unless `replace_all`; 0 or 2+ matches → error saying which. Preserve the file's line endings (CRLF stays CRLF). |
| `run_command` | `command`, `timeout_ms?` (default 120000, max 600000), `background?` | See Command runner. Returns exit code, duration and capped output. With `background: true`, returns a `processId` immediately. |
| `command_output` | `processId` | New output since the last call, plus running/exited status. |
| `kill_command` | `processId` | Kills the process tree. |

After a successful `write_file` / `edit_file`, update the node's recorded hash for that file so it can keep editing its own changes without re-reading. If a command changes a file the node has read (formatter, `pnpm install` touching `package.json`), the hash no longer matches and the node must re-read — that is intended. Tools a node's access level doesn't allow are **not sent to the model at all**.

### Path guard — the hard boundary for file tools

- Resolve every path against `workspaceRoot`, then `fs.realpath.native` it (for a new file: realpath of the nearest existing parent). Reject anything outside `workspaceRoot`. This catches `..`, absolute paths, and symlink/junction escapes.
- Reject writes and edits inside `.git/`.
- Windows: compare paths case-insensitively; reject UNC paths, `\\?\` / `\\.\` prefixes, alternate data streams (a `:` after the drive letter), and reserved device names (`CON`, `NUL`, `PRN`, `AUX`, `COM1`…, `LPT1`…, with or without an extension).
- Violations go back to the model as tool errors, not exceptions that kill the step.

### Concurrency between nodes

Nodes share one workspace (One workspace one truth). No per-node worktrees.

- A per-path write mutex so two writes to the same file never interleave.
- The read-before-edit hash rule is the real protection: if node A changes a file node B read earlier, B's next edit fails with "changed since you read it" and B re-reads. Never silently overwrite.

### Change detection and attribution

Tool writes are not the only way files change — commands (`npm init`, codegen, formatters, background dev servers) change files too. Both must reach the UI.

- **Tool writes:** every successful write/edit emits `fs.changed { runId, nodeId, nodeName, nodeColor, path, source: "tool", ranges: [{startLine, endLine}], at }`, where `ranges` are the new lines in the file after the change.
- **Command writes:** snapshot `git status --porcelain` (plus mtimes for ignored paths the explorer shows) before and after each foreground command, and run a workspace watcher while background processes are alive. Emit `fs.changed { …, source: "command", cmdId, ranges: [] }` for each changed path. No line ranges — don't guess.
- **Persisted attribution:** live ranges are for the current step only; they go stale as soon as anyone edits the file again. After a reload, gutter attribution comes from `git blame` on the node commits (author = node name, Phase 2). Keep the event log in an append-only SQLite table for the timeline and the path bar.

### Command runner

- **Shell.**
  - Windows: prefer Git Bash. Find the Git install from the `git` executable on PATH and use its `bin\bash.exe` launcher. Never use `C:\Windows\System32\bash.exe` (that's the WSL launcher). Fallback: `powershell.exe -NoProfile -NonInteractive -Command`.
  - macOS/Linux: `/bin/bash`, fallback `/bin/sh`.
  - Override via an env var (e.g. `ACE_AGENT_SHELL`).
  - Use non-login `-c`. Test that `pwd` is the workspace and that `ls`, `grep`, `node`, `pnpm`, `git` all resolve.
  - The chosen shell and OS go into the node's system prompt so the model writes matching syntax.
- **cwd** = `workspaceRoot`, every time.
- **Spawn options:** `windowsHide: true` on Windows so no console windows flash up.
- **Env:** start from an allowlist, not the engine's env. Windows starting point: `PATH`, `PATHEXT`, `SystemRoot`, `SystemDrive`, `windir`, `ComSpec`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, `ProgramData`, `ProgramFiles`, `ProgramFiles(x86)`, `TEMP`, `TMP`, `OS`, `PROCESSOR_ARCHITECTURE`, `NUMBER_OF_PROCESSORS`, `USERNAME`, `COMPUTERNAME`; POSIX: `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `TMPDIR`. **On Windows match allowlist keys case-insensitively** — the real key is often `Path`, and an exact-case lookup silently drops it. Verify node/pnpm/git work with the result and record the final list in DECISIONS. **Never** pass provider API keys, the engine auth token, or any ACE secret. Add `CI=1` and `GIT_TERMINAL_PROMPT=0`.
- **stdin** is `'ignore'`, so interactive prompts fail fast instead of hanging.
- **Timeout / Stop / run cancel / engine shutdown** kill the whole process tree — Windows: `taskkill /pid <pid> /T /F`; POSIX: spawn detached and kill the process group. Test on Windows that a grandchild (e.g. a dev server started via `pnpm dev`) actually dies.
- **Output:** stream stdout/stderr chunks as events. What goes back to the model is capped (~30 000 chars: keep head and tail, mark the cut).
- **Background processes** are tracked per run and killed when the run ends, the run is cancelled, or the engine shuts down. (Run, not step — node B may need the server node A started.)
- **Events:** `cmd.started { cmdId, runId, nodeId, command, background }`, `cmd.output { cmdId, stream, chunk }`, `cmd.exited { cmdId, exitCode, signal, durationMs, timedOut }`.

### Command classification (approvals, allowlist, denylist)

A prefix check on the raw string is not enough: `pnpm install && rm -rf ~` starts with `pnpm install`.

- Split the command into segments on `&&`, `||`, `;`, `|`, `&` and newlines. Every segment must pass the denylist and (for auto-allow) the node's allowlist.
- If the command contains command substitution (`$(…)`, backticks), `eval`, `bash -c` / `sh -c` / `powershell -Command`, or anything the splitter can't parse confidently, it can't be auto-allowed by prefix: it needs approval (except in Full auto, where only the denylist applies).
- **Denylist:** a short pattern list (disk formatting, `rm -rf` on `/` or `~`, `git push --force`, registry edits, shutdown/reboot), checked on every segment, that always needs approval, even in Full auto. Document it as a speed bump, **not** a security boundary.

### Security, stated honestly (goes in DECISIONS)

File tools are confined to the workspace. **Commands are not.** A command runs as the user, starting in the workspace folder, and can reach anything the user can. The mitigations in this prompt are approvals, env scrubbing, timeouts and tree-kill. Real confinement is D-083 and is out of scope here. The UI must say this plainly (Phase 3).

### Phase 1 tests

Path escape via `..`, absolute path, symlink, and Windows junction · UNC path, ADS (`file.txt:hidden`), `NUL` / `con.txt` · write into `.git/` · edit with 0 and 2 matches · edit after another node changed the file · edit after a command changed a file the node had read · CRLF preserved · own-write then edit without re-read · command that creates a file emits `fs.changed` with `source: "command"` · command timeout kills a grandchild on Windows · child env contains no API keys or engine token, and does contain PATH on Windows · output cap · background process killed at run end · Git Bash `pwd` equals workspace · `pnpm install && rm -rf ~` is not auto-allowed by a `pnpm install` allowlist entry and hits the denylist.

**Gate 1:** all Phase 1 tests pass on Windows.

---

## Phase 2 — Agent loop, approvals, checkpoints (engine)

### Workspace access (per node, saved with node settings)

| Level | Tools sent to the model | Needs approval |
|---|---|---|
| **Off** | none — today's text-only behaviour, Send to Forge kept | — |
| **Read only** | `list_files`, `read_file`, `search` | nothing |
| **Edit files** | + `write_file`, `edit_file` | nothing |
| **Edit + commands** (default for new nodes) | + `run_command`, `command_output`, `kill_command` | each `run_command` not covered by the node's allowlist |
| **Full auto** | same | nothing, except denylist matches |

Existing nodes migrate to **Off** so nothing changes under the user; new nodes default to **Edit + commands**. Each node also gets **Max turns** (default 50) and an optional **token budget** (input + output tokens per step). Access level, Max turns, budget and the tool list are written into the dispatch record (C4).

### The loop

For a node step whose access isn't Off:

1. **System prompt:** the node's role/instructions from settings; the workspace (paths relative to it); OS and shell; tool rules (read before edit, prefer `edit_file` over rewriting whole files, use non-interactive flags, start servers with `background: true`, stay inside this node's task and contract — don't do downstream nodes' work); the upstream handoff envelope including its `workspace` block.
2. Call the model with the tools allowed by the access level.
3. For each tool call in the reply, in order and one at a time: approval check → run via Workspace Tools → collect the result.
4. Send results back in the provider's format. **Every tool call gets exactly one result before the next model call** — if Stop or cancel lands mid-batch, the remaining calls get an error result ("cancelled"), never nothing.
5. **Stop when:** no tool calls (done) · max turns or token budget reached (fail with a clear reason) · Stop/cancel · provider error (existing failure path). A denied approval is **not** a failure: send "user denied this command" back as the tool result and let the model adjust.

Record token usage per turn on the step (append-only) so the cost model gets real numbers.

**Neutral internal format:** `{ role, content: [ text | tool_call {id, name, args} | tool_result {id, ok, output} | provider_opaque {provider, payload} ] }`. `provider_opaque` carries blocks the provider requires to be sent back unchanged in a tool loop (thinking blocks and their signatures, reasoning items, thought signatures) — drop them and multi-turn tool use breaks. Write one adapter per wire format **that already exists in the registry**, mapping to and from it. Don't add providers.

Tool-calling support comes from a capability flag in the registry. If the registry has none, add one (DECIDE) rather than guessing per model name. If a provider/model can't do tool calling, its node's access selector is disabled with "This model can't use tools" — no fake fallback. The mock adapter gets scripted tool-call support for tests.

**Streaming:** assistant text goes out on the existing node-output events; tool activity as `node.tool_call { runId, nodeId, callId, name, args }` and `node.tool_result { callId, ok, summary }`.

**Context:** tool results are already capped. If the conversation passes ~70% of the model's context window (from the registry), replace the bodies of the oldest `read_file` and command outputs with `[output elided — re-run if needed]`. Keep every tool_call/tool_result pair intact; only bodies change. Elide in one batch down to ~50% rather than one message per turn, so prompt caching isn't invalidated every turn. No summariser model.

### Approvals

- When a call needs approval: insert `{ id, runId, nodeId, tool, args, status: "pending" }` (append-only; resolution is a new row or a status column on this table, never the dispatch record), emit `approval.requested`, and move the node into `awaiting_approval` (C5).
- `POST /approvals/:id` (fit the repo's route style) with `{ decision: "allow" | "deny" | "always" }`, behind the existing auth, Zod-validated. Reject if the approval isn't pending or its run isn't active. `always` adds the command prefix (first word + subcommand, e.g. `pnpm install`, `npm test`) to this node's allowlist — subject to the segment rules in Command classification.
- Emit `approval.resolved`. Cancelling the run resolves pending approvals as deny.
- **Engine restart mid-step** (with or without a pending approval): the node goes to `BLOCKED` with the reason ("approval lost on restart" or "engine restarted mid-step"). Background processes from that run are gone; say so in the reason.

### Git checkpoints (Version every run)

- Extend the existing stage-commit convention (C6) instead of adding a second one.
- **Run start, not every node:** if the workspace has uncommitted changes when a run starts, commit them once as `ace: checkpoint before run <runId>`. (Per-node "before" checkpoints would capture other nodes' half-finished work when nodes run in parallel.)
- **After each step:** stage **only the paths this node changed** — its tool writes plus command-detected changes during its step window — and commit `ace(<nodeName>): <one-line task summary>`, author name = node name, email `node-<nodeId>@ace.local`. Never `git add -A` while another node is running. Store the sha in the step's append-only record.
- If a command-detected change happened while two nodes were active, include it in the commit and list both node ids in a commit trailer — don't guess attribution.
- Commit with `-c commit.gpgsign=false` and decide on hooks (DECIDE): a repo with husky/pre-commit or GPG signing will otherwise fail or hang a headless commit. Proposed default: `--no-verify` for ACE commits, stated in DECISIONS.
- One workspace-level git mutex so concurrent nodes never fight over the index.
- `POST /runs/:runId/nodes/:nodeId/revert` (fit the repo's route style) → `git revert <sha>`. Refuse while the run is active. On conflict, report it; never force.

### Handoff envelope

Add `workspace: { commit, filesChanged: [{ path, added, removed }], commands: [{ command, exitCode, durationMs }] }` to the node's output envelope. Schema change → DECIDE block and Zod validation update. Off nodes must keep passing existing contract checks unchanged.

### Gate 2 — engine only, scripted

Two parts:

**2a — deterministic (runs in CI):** the mock adapter scripts the tool calls for the chain below. Same pass criteria. This catches loop, envelope and git regressions without API spend or flakiness.

**2b — real provider:** the same chain with a real provider from the registry (approvals auto-allowed by the test), on a temp git workspace:

- **Node A:** "Create a tiny Node project with a `sum(a, b)` function and a test using `node --test`, then run the test."
- **Node B:** "Read the project, add `subtract(a, b)` with a test, run all tests."

Pass if: both steps finish, the final test run exits 0, the files exist, there are 2 node commits with the right authors, each commit contains only that node's files, A's envelope lists its files and command, B's edit to A's file went through read-before-edit, and token usage is recorded per turn.

---

## Phase 3 — Forge and canvas UI

Use the design tokens from the redesign spec. No colours outside it; the node colour is the node's existing accent.

1. **Live files.** On `fs.changed` (both sources), the explorer refreshes and new files appear. A clean open buffer reloads from disk. The editor stays read-only during runs (C1); a buffer that had unsaved edits from before the run is never overwritten — show a one-line bar: "{Node} changed this file on disk · Reload · Keep mine".
2. **Live-agent badge** on the explorer row while a node is mid-write (from its `node.tool_call` to the matching result) — the spec's node-colour badge with `livePulse`.
3. **Gutter bars** — Monaco decorations in the node's colour: live ranges for the current step, `git blame` on node commits after that. Command-made changes show as whole-file, labelled that way.
4. **Path bar** — "{Node} edited lines a–b · {relative time}" for the latest attribution on the open file ("{Node} changed this file via a command" when there are no ranges).
5. **Terminal panel** — bottom panel in Forge (toggle, resizable, remembers its height). One row per command: node chip, command (mono), status (running / exit code / timed out), duration; expands to live output (ANSI stripped, or xterm.js only if it's already a dependency). Keep the last ~1 MB per command in the UI and mark the cut. Background processes get a Kill button. Filter by node. This is a read-only log of agent commands, not an interactive shell.
6. **Approval cards** — in the Team chat aside and pinned at the top of the Terminal panel: node chip, the full command in mono (never truncated), and **Allow · Always allow `<prefix>` · Deny**. Hide "Always allow" when the command can't be auto-allowed by prefix (compound with substitution, etc.).
7. **Node settings** — "Workspace access" selector with the five levels and a one-line description each, plus Max turns and token budget. For Edit + commands and Full auto, show: "Commands run on this computer with your permissions." Full auto adds: "No approval prompts."
8. **Canvas node card** — live sub-status from real events (Reading `file` / Editing `file` / Running `cmd` / Waiting for approval). For nodes with access above Off, **Send to Forge is removed** and replaced by **Open in Forge**, which opens the files that node changed in its last step. Off nodes keep Send to Forge.
9. **Stop** on a running node aborts the model call and kills its commands.
10. **Revert step** on a finished node (node card menu and Team chat) → the revert route. Disabled while the run is active.

**Gate 3** — manual run on Windows (desktop shell if it's built, otherwise the browser): the Gate 2 chain from the canvas, approvals clicked by hand. Check items 1–10 against what you actually see and list pass/fail for each.

---

## Phase 4 — CLI-backed nodes (only if Phase 0 found any, and their quota/terms check is done)

A provider that runs `claude`, `codex` or `gemini` as a child process is already a coding agent with its own tools. For those nodes:

- Run the CLI in its non-interactive agent mode with `cwd = workspaceRoot`. Take the exact flags from `<cli> --help` on this machine — not from memory or the internet. Prefer a streaming JSON output mode if the installed version has one.
- Map access levels to the CLI's own permission flags where a real equivalent exists. Where none exists, disable that level in the selector and say why. Headless runs can't answer the CLI's interactive prompts, so "Edit + commands" may not be available — don't fake it.
- The CLI's own file tools bypass ACE's path guard and hash rule. Say so in DECISIONS. API nodes running in parallel are still protected (their hash check sees the CLI's changes); the CLI node is not.
- Stream the CLI's output into the Terminal panel as one row. Parse per-tool events only if the installed version's JSON format is clear; otherwise attribution comes from `git diff` at step end (whole-file, labelled that way).
- Same checkpoints, envelope block, Stop and tree-kill as Phase 2.
- The CLI uses whatever account it's signed into on this machine. Add a DECISIONS note that the provider's terms for using its CLI this way must be checked before ACE ships to other users.

**Gate 4:** the Gate 2 chain with Node A on a CLI provider and Node B on an API provider.

---

## DECISIONS to add (DECIDE blocks)

1. ACE-owned agent loop and tool layer for API nodes, rather than routing every node through a CLI agent — one place for permissions, confinement, attribution and the terminal log; provider stays a variable.
2. Shared Forge workspace with read-before-edit hashes and per-file mutex, rather than per-node git worktrees (deferred).
3. Commands unconfined until D-083 — explicit risk acceptance, mitigations listed.
4. Windows shell: Git Bash, fallback PowerShell, env-var override; final env allowlist (case-insensitive on Windows).
5. Existing nodes migrate to Off; new nodes default to Edit + commands.
6. Envelope gains a `workspace` block.
7. `awaiting_approval` as an XState state; lifecycle document updated.
8. Compound-command handling for approvals, allowlist and denylist.
9. Commit scope (only the node's paths), run-start checkpoint, and hooks/signing policy for ACE commits.
10. Attribution source: live ranges during a step, `git blame` after.
11. Tool-calling capability flag and `provider_opaque` round-tripping in the neutral format.
12. Resolutions for C1–C6 (editor lock, bounded context, Bench tool parity, append-only post-dispatch records, XState, stage commits).

## Out of scope

Sandbox confinement (D-083) · an interactive user terminal / PTY · per-node worktrees · giving Brain tools · MCP servers for nodes · new providers · packaging or signing changes.

## Stop conditions — stop and ask

- No single Forge workspace root, or it isn't a git repo and Forge doesn't already manage git (don't `git init` a user's folder on your own).
- A provider adapter would need a new SDK or a rewrite to support tool calling.
- The envelope block or the approval state breaks ACE Bench run versioning or existing contract checks beyond a small schema bump.
- Any C1–C6 default turns out to contradict the spec in a way that changes product behaviour.
- Process-tree kill on Windows can't be made reliable (grandchildren survive).
- The repo's commit hooks or signing setup can't be handled headlessly without disabling something the team relies on.
- Anything would need the frontend to call Node APIs directly.

## When done

Report: files changed per phase, test results, each Gate with pass/fail, DECISIONS added, C1–C6 resolutions, and anything skipped with the reason.
