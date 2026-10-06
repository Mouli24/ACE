# X1 — Model gateway, CLI providers, file/terminal/git tools — design

Date: 2026-10-06 · Owner: Arhant (one developer, D94) · Status: DRAFT for review
Branch: `x1/model-gateway` — one PR, contracts commits first (CLAUDE.md §3.4 rule 2)
Worktree: `D:\ACE offcl\wt\x1` (the main checkout stays on `main` — the launcher runs it)

## 1. Goal

ACE runs agent nodes on Claude, Codex, Gemini, Ollama and the existing API providers through one
model gateway, with no provider-specific code in the agent runtime. Locally installed coding-agent
CLIs (Claude Code, Codex CLI, Gemini CLI) are found by a scan in **Add provider** and used through
their own logins — no API key in ACE. API and local models can call new project-folder tools (files,
terminal, git) through ACE's existing tool loop.

Success, demonstrated for real on this machine (Claude Code 2.1.282, logged in):
Add provider → scan lists Claude Code → Add → Test = CONNECTED → an agent node on
`Claude Code · Sonnet` edits a file in a project, runs the project's tests, and its commands and
file edits appear in the inspector's Tool calls tab while its text streams onto the Canvas.

## 2. Decisions (to append to `docs/DECISIONS.md` as D260–D266)

| # | Decision |
|---|---|
| D260 | X1 starts before `round-4`/`round-5` are tagged, on the owner's instruction (as D236/D237). It pulls forward FR-PRV-008 (rounds 6+), FR-TOOL-008 (round 7) and part of FR-GIT. Tracked as feature X1 with its own §9 row; it does not renumber rounds. |
| D261 | CLI providers are **agent routes**: the CLI owns its agent loop and its own file/terminal tools in the project folder; ACE delegates a whole node turn and records the CLI's activity. ACE's tool loop is not used for them. API/local providers are **model routes**: ACE owns the loop. |
| D262 | CLI permissions are a **preset per provider** — `read_only` / `edit_files` (default) / `full_auto` — mapped to each CLI's own flags (§6). No mid-run approval for CLI actions. |
| D263 | Usage for a CLI call is **what the CLI reports**: tokens from all three; `costUsd` only where the CLI gives one (Claude Code `total_cost_usd`), else 0. Budgets therefore can halt Claude Code runs but never Codex/Gemini runs. |
| D264 | ACE never reads a CLI's stored credentials; it runs the unmodified binary, which uses its own login. Readiness comes from the CLI's own status command where one exists. |
| D265 | Provider status keeps the six locked `ProviderState` names (CLAUDE.md §7). The brief's statuses map: not_installed → `UNREACHABLE` + install message · not_authenticated → `AUTH_FAILED` · connecting → `CHECKING` · ready → `CONNECTED` · error → `UNREACHABLE`/`UNKNOWN`. Installed/version/login detail lives in the new scan response. |
| D266 | Seven new built-in tools (FR-TOOL-008): `list_files`, `read_file`, `write_file`, `edit_file`, `git_status`, `git_diff` (non-destructive, confined to the project folder) and `run_command` (**destructive** → an approval card on every call under the default policy, because it is an unsandboxed shell on Windows — the D-083 risk). |

## 3. Architecture in ACE's own code

```
Canvas / Inspector / Providers UI (apps/web)          ← WS: node.token, tool.call, provider.status
        │ REST /api/v1
Gateway HTTP (engine/src/gateway)          scan: GET /providers/detect/clis
        │
Agent runtime: run service → scheduler → node executor (engine/src/runs)
        │   owns: envelopes, context, prompt, guardrails, approvals, budgets, ACE tool loop
        ▼
MODEL GATEWAY  (NEW engine/src/models/gateway.ts)
        │   route (router) · adapter lookup · per-provider gate · catalog/pricing · error stamping
        ▼
ProviderAdapter port (engine/src/ports/model-provider.ts) — the one provider interface
        │
   ┌────┴──────────────┬───────────────────────┬─────────────────────┐
API adapters        local                   CLI adapters (NEW)        mock
anthropic/openai/   ollama,                 claude_code / codex_cli /
google (AI SDK)     openai_compatible       gemini_cli → child process in the project folder
   │ tool_call ↔ ACE tool loop               │ text + activity (commands, file edits) + usage
   ▼                                          ▼
ACE tools (packages/tools): existing six + NEW list/read/write/edit/git_status/git_diff/run_command
```

The executor keeps the agent loop (brief §10). Nothing above the gateway names a provider type.

### 3.1 Your brief → ACE mapping

| Brief | ACE (after X1) |
|---|---|
| `AIProvider` | `ProviderAdapter` (unchanged shape). `authenticate` = the key in the keychain (API) or the CLI's own login (CLI). `getStatus` = `check()`. `execute` = `generate(req, signal)`. `disconnect` = provider delete (no persistent connection exists: one process per call). |
| `ModelInfo` + `executionRoute` | Catalog `Model` rows; the route is derived from the provider type: `api` / `local` / `cli` (`routeOf(type)` in contracts). |
| Model Gateway | `ModelGateway` (§4.1). |
| `ModelEvent` | `StreamChunk` + one new member `activity` (§4.2). |
| `ModelError` | `NodeError {kind, code, message, retryable, providerId}`; `authenticationRequired` ≙ kind `auth`, `rateLimited` ≙ code `http_429`/`rate_limited`. |
| `ModelRequest.messages` | Not added: BR-02/ADR-008 keep a single assembled prompt. Adapters build vendor messages internally (incl. tool-call continuations, §4.4). |
| Agent → provider/model/prompt/tools/permissions | Already `AgentConfig` (`providerId`, `modelId`, `routing`, `instructions`, `tools`, `guardrailPolicyId`); CLI permission is per provider (D262). |

## 4. Engine

### 4.1 `ModelGateway` (new `packages/engine/src/models/gateway.ts`)

Consolidates what `apps/server/src/server.ts` wires today as separate closures (`adapterFor`,
`runGated`, `router`, `catalogCache`, `pricingFor`, `refreshCatalogCache`):

```ts
interface ModelGateway {
  adapterFor(providerId: Id): Promise<ProviderAdapter>;      // normalised (below)
  runGated<T>(providerId: Id, fn: () => Promise<T>): Promise<T>;
  router: ModelRouter;                                         // reads the gateway's catalog
  catalog(): readonly Model[];
  refreshCatalog(): Promise<void>;
  pricingFor(providerId: Id, modelId: string): ModelPricing | undefined;
}
createModelGateway({ providers, models, scope, createRouter }): Promise<ModelGateway>
```

- `adapterFor` wraps the factory's adapter so every `generate` failure leaves as a `ProviderCallError`
  whose `NodeError` carries `providerId` (today each adapter does it, or not — the mock does not).
- Executor, chat service, summariser and knowledge embedder keep their existing dependency names
  (`adapterFor`, `runGated`, `router`, `modelsFor`, `pricingFor`); `server.ts` passes the gateway's
  members. **No executor/chat/summariser signature change**, so their test harnesses stay as they are.

### 4.2 Port changes (`packages/engine/src/ports/model-provider.ts`)

- `GenerateRequest.workingDir?: string` — the project folder. Executor: `deps.projectFolderFor(runId)`
  (new, optional; server resolves run → workflow → project `folderPath`, cached per run). Chat and
  summariser: none (a CLI then runs read-only in a temp folder — direct chat has no Stop).
- `ToolResult.args?: unknown` — the call's arguments, so an API adapter can replay the assistant's
  tool call before its result (§4.4). Executor fills it.
- `StreamChunk` gains:
  `{ type: 'activity'; tool: string; args: unknown; status: 'ok' | 'error'; summary: string; durationMs: number }`
  — something the provider did itself (a CLI's command, file edit, read). Emitted once, on completion.
- `{ type: 'usage' }` gains optional `costUsd?: number` (D263).

### 4.3 Executor (`packages/engine/src/runs/executor.ts`) — three small additions

1. Pass `workingDir` in the request.
2. `case 'activity'`: `logToolCall({ callId: nextId(), name: 'cli_' + snake(tool), args }, { status, resultSummary: summary, durationMs, verdicts: [], at })` → a ToolCall row and a `tool.call` event (inspector Tool calls tab and Events tab render it unchanged). No guardrail step: the CLI already did it (D261).
3. Sum `usage.costUsd`; when any was reported, it replaces `usageFor`'s price-table cost.

### 4.4 API adapters get real tool calling (`packages/providers/src/adapters/ai-sdk.ts`)

Today `streamText` is called without tools, so only the mock can enter the tool loop. Change:
- `req.tools` → AI SDK tools **without `execute`** (`jsonSchema(def.inputSchema)`), so the SDK
  surfaces the call and ACE's loop runs it.
- `tool-call` stream parts → `{ type: 'tool_call', callId, name, args }`; finish `tool-calls` → `tool_calls`.
- Continuation: with `req.toolResults`, send `messages` = user prompt, then per result an assistant
  `tool-call` part (`callId`, `name`, `args`) and a `tool` `tool-result` part. Single-prompt calls are unchanged.
- Applies to anthropic, openai, google, openai_compatible, ollama (all share `createAiSdkAdapter`).
- Manifest `supportsTools` is already true for the cloud models; discovered models default false.

## 5. CLI providers (`packages/providers/src/adapters/cli/`, new)

| File | Responsibility |
|---|---|
| `resolve.ts` | Find the binary on PATH (+PATHEXT on Windows). For an npm `.cmd` shim, read it and spawn the real target (`.exe`, or `node <script.js>` via `process.execPath`) **without a shell** (Node DEP0190). |
| `runner.ts` | `runCli({ bin, args, cwd, env, stdin, signal })` → async iterable of stdout lines. Writes the prompt to stdin and closes it. Abort/timeout → kill the process tree (`taskkill /pid /T /F` on Windows, process-group `SIGKILL` on POSIX; same pattern as `packages/tools/src/sandbox/runner.ts:40-53`, duplicated because providers may not import tools — §3.4 rule 3). Keeps the last 8 KB of stderr for error messages. Exit code surfaced at the end. |
| `detect.ts` | Per CLI: installed? version, path, login status (Claude `claude auth status` exit code + JSON; Codex `codex login status` exit code + stderr text, plus `CODEX_API_KEY`; Gemini: `GEMINI_API_KEY`/`GOOGLE_API_KEY`/Vertex env or `~/.gemini/settings.json` `security.auth.selectedType` → `unknown` with detail). 60 s cache; the scan endpoint forces a refresh. |
| `claude-code.ts`, `codex.ts`, `gemini.ts` | Flags, JSONL parsing into `StreamChunk`s, `check()`, `listModels()`. |

### 5.1 Invocation (cwd = `workingDir`, or a fresh temp dir forced to `read_only` when absent)

| | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|
| Base | `-p --output-format stream-json --verbose --include-partial-messages --setting-sources "" --strict-mcp-config --permission-prompts none` (verified 2026-10-06: `""` keeps the user's hooks/plugins — e.g. a SessionStart hook injecting instructions — out of agent runs; login still works) | `exec --json --skip-git-repo-check --color never -` | `-o stream-json --skip-trust`; env `GEMINI_CLI_NO_RELAUNCH=true` |
| Prompt | stdin; ACE `system` via `--append-system-prompt` | stdin; `system` prepended | stdin; `system` prepended |
| Model | `--model <alias>` unless `default` | `-m <id>` unless `default` | `-m <alias>` unless `default` |
| `read_only` | `--permission-mode dontAsk --tools Read,Grep,Glob` | `--sandbox read-only` | `--approval-mode plan` |
| `edit_files` | `--permission-mode acceptEdits --tools Read,Edit,Write,Grep,Glob` (no shell) | `--sandbox workspace-write` | `--approval-mode auto_edit` (shell denied headless) |
| `full_auto` | `--permission-mode bypassPermissions` | `--dangerously-bypass-approvals-and-sandbox` | `--approval-mode yolo` |
| Text | `stream_event` `text_delta` (live) | `item.completed` `agent_message` (whole) | `message` assistant `delta:true` (live) |
| Activity | `assistant.tool_use` paired with `user.tool_result` | `command_execution`, `file_change`, `mcp_tool_call` items | `tool_use` paired with `tool_result` |
| Usage | `result.usage` (+cache tokens into tokensIn), `total_cost_usd` | `turn.completed.usage` | `result.stats` |
| Failure | `result.is_error` / `subtype` | `turn.failed`, `error`, exit 1 | `error` severity error, exit 41 auth / 53 turns / 55 trust |
| Models | `default, opus, sonnet, haiku` | `codex debug models` ids, else `default` | `default, pro, flash, flash-lite` |
| Install hint | `npm i -g @anthropic-ai/claude-code` | `npm i -g @openai/codex` | `npm i -g @google/gemini-cli` |
| Login hint | `claude auth login` | `codex login` | run `gemini` once and sign in |

Output text = every assistant message in order, separated by a blank line. ACE tools offered to a CLI
model are ignored (the CLI uses its own); catalog rows say `supportsTools: false`. Models are
text-in/text-out, context window 200 000, price `unpriced` (D263 supplies cost).

**Verified against the real Claude Code 2.1.282 on 2026-10-06** (probe fixtures in the plan):
stdin-only prompt works; `--tools ""` / `--tools Read` and `--permission-prompts none` are accepted;
text arrives as `stream_event` → `content_block_delta` / `text_delta` with `parent_tool_use_id: null`
(sub-agent text has a non-null parent and is skipped); `assistant` events carry one content block each
(`thinking`, `text`, or `tool_use {id,name,input}`); `user` events carry `tool_result {tool_use_id,
content, is_error?}`; `result` carries `total_cost_usd`, `usage.{input_tokens,
cache_read_input_tokens, cache_creation_input_tokens, output_tokens}`, `is_error`, `subtype`,
`api_error_status`; a `rate_limit_event` reports plan utilisation (`rate_limit_info.status`).
Direct chat passes no `workingDir`, so a CLI in chat runs read-only in a temp folder (chat has no Stop). Codex and Gemini shapes come from their docs/source and are tested against fake
CLIs only until installed.

### 5.2 Status and errors

- `check()`: not installed → `UNREACHABLE` "Codex CLI is not installed — npm i -g @openai/codex";
  logged out → `AUTH_FAILED` "Run `codex login` in a terminal"; logged in / configured → `CONNECTED`
  with the login detail. Gemini "configured but unverified" → `CONNECTED` "Google login configured;
  confirmed on first run". Cheap (version + status command, cached), so the 60 s periodic check is fine.
- Run-time mapping: spawn ENOENT → `provider/cli_not_found` (not retryable, provider `UNREACHABLE`);
  auth failure (Claude auth error result, Codex "Not logged in", Gemini exit 41) → `auth` (existing
  `markAuthFailed` sets `AUTH_FAILED`); plan/quota limit → `provider/rate_limited`; crash/non-zero exit
  → `provider/cli_exit_<code>` with the stderr tail; abort → `abortedCallError` (timeout = `network`,
  stop = `user_cancelled`).
- **Retry rule:** any CLI failure after at least one `activity` is `retryable: false` — the CLI may
  have changed files, so re-running it is not idempotent. Before any activity, rate limits and timeouts
  stay retryable as today.
- Concurrency for CLI providers starts at **1** (two agents editing one folder collide): the Add
  dialog sends `DEFAULT_CLI_CONCURRENCY`; the request schema's own default (20) is left unchanged so
  existing clients behave as before. The user may raise it.

## 6. Contract (`packages/contracts`, PR `x1/contracts`)

- `enums.ts`: `PROVIDER_TYPES` += `claude_code`, `codex_cli`, `gemini_cli`.
- `providers.ts`: `CLI_PROVIDER_TYPES`, `isCliProviderType()`, `PROVIDER_ROUTES` + `routeOf(type)`
  (`api|local|cli|mock`); `CLI_PERMISSIONS = ['read_only','edit_files','full_auto']`,
  `DEFAULT_CLI_PERMISSION = 'edit_files'`, `DEFAULT_CLI_CONCURRENCY = 1`; `Provider.cliPermission?`;
  create/update requests take `cliPermission?` and a CLI type refuses `apiKey`/`baseUrl` (and a non-CLI
  type refuses `cliPermission`); `CliDetectionSchema = { type, installed, version?, path?, login:
  'logged_in'|'logged_out'|'unknown', loginDetail?, installHint, loginHint }`;
  `CliDetectResponseSchema = { items: CliDetection[] }` for `GET /providers/detect/clis`.
- `tools.ts`: `BUILTIN_TOOL_NAMES` += the seven tools of D266; the "not in this round" comment goes.
- `api.ts`: the new route, if routes are listed there.
- No new WS frame: CLI activity rides the existing `tool.call` event.

Storage: `providers.cli_permission` (nullable text), migration `20261006T120000_x1_cli_providers`.

## 7. Tools (`packages/tools/src/builtins/`, new files)

`ToolContext` and the executor's `ToolRunContext` gain `projectDir` (the project folder; empty when a
run has none — the project tools then refuse). Path confinement generalises `sandbox/paths.ts`
`resolveInsideSandbox` to `resolveInside(root, path)` (lexical check + realpath symlink check);
TC-TOOL-009: a write to the parent folder is refused.

| Tool | Args | Behaviour |
|---|---|---|
| `list_files` | `path?`, `recursive?`, `maxEntries≤2000` | Skips `.git`, `node_modules`, `.ace`. |
| `read_file` | `path`, `offset?`, `limit?` (lines) | UTF-8, ≤ 256 KB returned, binary refused. |
| `write_file` | `path`, `content` | Creates parents; refuses `.git/**` and `.ace/**`. |
| `edit_file` | `path`, `oldString`, `newString`, `replaceAll?` | `oldString` must match exactly once unless `replaceAll`. |
| `git_status` | — | `git status --porcelain=v1 -b` in the project. |
| `git_diff` | `staged?`, `path?` | `git diff [--cached] [-- path]`, ≤ 256 KB. |
| `run_command` | `command`, `cwd?` (inside project), `timeoutMs≤600000` (default 120000) | `cmd.exe /d /s /c` on Windows, `/bin/sh -c` on POSIX; user's env; stdout/stderr tails ≤ 64 KB each; exit code; **honours `ctx.signal`** and kills the tree; `destructive: true`. |

Git runs `git` with an argument array, no shell, `GIT_TERMINAL_PROMPT=0`.

## 8. Web (`apps/web`, `packages/ui`, `packages/sdk`)

- `@ace/ui` tokens: accents for the three types in `PROVIDER_ACCENT`, `LIGHT_PROVIDER_ACCENT`,
  `ThemeColors.provider`, and `--color-provider-*` in both themes of `theme.css` (the token tests
  enforce key parity and ≥ 3:1 contrast).
- `@ace/sdk`: `detectClis()`; `cliPermission` on create/update bodies.
- `provider-meta.ts`: labels "Claude Code", "Codex CLI", "Gemini CLI"; CLI types need neither key nor URL.
- **Add provider dialog**: a "Found in your terminal" section on open (auto-scan + Scan again): per
  CLI — installed + logged in → **Add**; installed + logged out → login command (copy); missing →
  install command (copy). **Add** sets type/name, concurrency 1, and shows **Permission**
  (Read-only / Edit project files / Full auto, with "Full auto lets the CLI run any command on your
  machine" warning). The existing manual form stays below for API providers.
- Provider row: CLI providers show the permission level where API providers show "key set".
- Edit dialog: permission level for CLI providers.
- MSW: `GET /providers/detect/clis`, `cliPermission` in the mock db, empty catalogs for CLI types.
- Inspector/Events: no change — CLI activity arrives as ordinary ToolCalls named `cli_*`.

## 9. Testing (zero env vars for `pnpm test`, CLAUDE.md §7)

| Area | Tests |
|---|---|
| contracts | enum + refinements (CLI type with apiKey refused, etc.), detection schema |
| gateway | adapter normalisation stamps `providerId`; catalog/pricing; gate passthrough |
| executor | `activity` → ToolCall + `tool.call`; reported `costUsd` replaces price-table cost; `workingDir` passed |
| ai-sdk | tools passed; `tool-call` → `tool_call`; continuation messages; with the AI SDK's mock model |
| cli runner | fake Node CLI scripts: stdin delivered, JSONL parsed incrementally, abort kills the tree within 2 s (incl. a grandchild), timeout, stderr tail, exit codes, `.cmd` shim resolution |
| cli adapters | flags per preset/model/system; recorded JSONL fixtures → chunks (Claude fixtures recorded from the real CLI); activity pairing; usage/cost; error mapping; retry rule after activity |
| detection | fake binaries on a temp PATH: installed / missing / logged out / version parse |
| tools | each tool; TC-TOOL-009 confinement; `.git` write refused; `run_command` timeout/abort/output cap; git on a temp repo (skipped if `git` missing) |
| web | scan section states; add-from-scan; permission field; `it.each(PROVIDER_TYPES)` still passes |
| `@provider` (nightly, real) | Claude Code: check + one `read_only` call |

**Real end-to-end (manual, recorded in the report):** demo project with a failing test →
agent node on `Claude Code · Sonnet`, `full_auto` → adds the function, runs the tests, git diff;
verify Canvas streaming, ToolCalls, usage/cost, Stop mid-run kills `claude`. Repeat the tool-loop
path with an API provider whose stored key answers (OpenAI "v1" / Google "v1 test", if reachable)
using the new file + `run_command` tools.

Gates before claiming done: `pnpm typecheck && pnpm lint && pnpm test`, coverage ≥ 80 % engine-side,
≥ 60 % web; real outputs pasted.

## 10. Phases

1. **Contracts PR** (`x1/contracts`) — §6, tests, D260–D266 rows.
2. **Gateway** — §4.1, server wiring switched; all existing tests green, no behaviour change.
3. **Claude Code end to end** — verify CLI facts (§5.1), runner, resolve, detect, Claude adapter,
   factory, migration, executor additions (§4.3), scan endpoint, web scan UI. Real run.
4. **Tool calling** — §4.4 + §7. Mock-driven tests, then a real API run if a stored key answers.
5. **Codex + Gemini adapters** — fake-CLI tests; exact install/login steps reported.
6. **Verification** — full gates, real coding task, Feature Log row X1, report.

## 11. Out of scope / known limits

- Logging in to a CLI from inside ACE (both CLIs' login flows are interactive) — ACE shows the command.
- Offering ACE's own tools to a CLI agent (possible later via MCP).
- A verifier component: verification is a workflow pattern (a reviewer agent with `git_diff` +
  `run_command`, or the CLI running tests itself). *Inference from Build with ACE's "Changes" review.*
- A files/diff/terminal UI panel (round 7's web work); results are visible through ToolCalls and output.
- Streaming `thinking`; stopping a direct chat; Ollama verification (not installed here).
- Codex/Gemini Windows sandbox caveats: Codex `workspace-write` needs its one-time Windows sandbox
  setup; Gemini has no native shell sandbox — `edit_files` relies on headless denial of shell.
