# Agentic Nodes Phases 2–4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A node with workspace access works like Claude Code inside the project: it reads, creates and edits files, runs commands (asking first unless always-allowed), sees the results, keeps going until done, and Forge and the canvas show it happening live.

**Architecture:** Phases 0–1 are on main (PR #51: `packages/tools/src/agent/*`, one agent session per run; PG-5.1 per-node checkpoints; PG-5.3 agent process rows). This plan adds the per-node access level, the agentic tool loop with turn history and provider-opaque replay, command approvals with Always allow, the envelope `workspace` block, restart/revert rules, then the UI, then CLI nodes. New engine logic lives in `packages/engine/src/runs/agentic/`; `executor.ts` only branches into it.

**Tech Stack:** TypeScript, Zod (contracts), Hono (engine routes), AI SDK 7.0.109 (`ai`, `@ai-sdk/*`), better-sqlite3 (storage-local), React + TanStack Query + Zustand (web), Vitest, Playwright.

**Spec:** `docs/team-prompts/agentic-nodes-prompt.md` (Phases 2–4), `docs/team-prompts/agentic-nodes-inventory.md`, decisions D340–D349, D361, D365 in `docs/DECISIONS.md`.

## Global Constraints

- Access levels are exactly `off | read_only | edit_files | edit_commands` — **no Full auto** (D342). Existing nodes (no `workspace` field) behave exactly as today. New nodes default to `edit_files`.
- Every `run_command` asks unless `classifyCommand(command, allowlist).autoAllowed` (D342/D348); a denylist match always asks and never offers Always allow.
- Keep existing tool and event names and argument shapes (`oldString`, `newString`, `tool.call`, `files.changed`, `process.*`, `node.approval_*`); new facts extend payloads (D344). New events only for facts that have none.
- Checkpoints stay in D300's private store; nothing commits to the person's `.git` (D341). Where the prompt says commit sha, use the checkpoint id.
- The run snapshot is written once; facts produced later go to append-only rows/events or to `node_runs` (D345, BR-04).
- Commands are unconfined; the UI says "Commands run on this computer with your permissions. They are not sandboxed." (D346).
- BR-02 holds between nodes (envelopes only). Turn history lives only inside one node step.
- Every new route body and event payload has a Zod schema in `packages/contracts`.
- No demo data in the UI. Windows first. Prettier: `--config packages/config/prettier.config.js`.
- Decision rows start at **D375**, defects at **D-104** (D374 is on Mouli's open `fix/completed-run-halts`). Row format `| D<n> | title | decision | affects | date | who |`; who = Arhant.
- Commit message tag: `[agentic-nodes]` plus the FR/D ids touched; end with the Co-Authored-By line.

## Review Focus

1. **A node on a model with no tool support** (discovered model, `supportsTools: false`) set to Read only or above → pre-flight refuses with `model_cannot_use_tools` and the selector says why; never a silent text-only run. (Task 6, Task 11)
2. **Compound and risky commands under an allowlist:** `npm test && git push --force` with `npm test` and `git push` allowed → asks (denylist), offers no Always allow; `pnpm install; pnpm test` with only `pnpm install` allowed → asks. (Task 3)
3. **Stop while a command waits for approval or a background `npm run dev` runs** → the approval resolves as deny, the process tree is gone, the node is STOPPED and no tool call is left without a result. (Task 7, Task 9)
4. **The file changes under a node between its read and its edit** (writing steps of one run take turns, D365, so the collision comes from a Forge save or a chat turn) → the stale edit comes back as a tool error the model recovers from by re-reading, not a node failure; each step's checkpoint holds only its node's files. (Task 6 test, Gate 2a)
5. **Existing workflows** (nodes saved before this branch, including ones with `write_file`/`run_command` in `tools.enabled`) → identical behaviour, prompts and approvals as on main. (Task 1, Task 6)

---

## Part A — Phase 2 (engine)

### Task 1: Contracts — per-node workspace access

**Files:**
- Modify: `packages/contracts/src/graph.ts` (AgentConfigSchema ~:161–197, `defaultAgentTools` :155)
- Create: `packages/contracts/src/agent.ts`; export from `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/validation.ts` (add a `AGENTIC_VALIDATION_ISSUE_CODES` list after `ROUND_5_…` and include it wherever the round lists are unioned)
- Modify: `apps/web/src/nodes/factory.ts:56-75` (new agent nodes get `workspace: newAgentWorkspace()`)
- Test: `packages/contracts/src/__tests__/agent.test.ts` (match the package's test folder convention), pinned-list tests that enumerate validation codes, `apps/web/src/nodes/factory.test.ts`

**Interfaces — Produces:**
- `WORKSPACE_ACCESS = ['off','read_only','edit_files','edit_commands'] as const`; `type WorkspaceAccess`
- `DEFAULT_MAX_TURNS = 50`, `MAX_TURNS_LIMIT = 200`, `TOKEN_BUDGET_MIN = 1_000`, `TOKEN_BUDGET_MAX = 10_000_000`, `ALLOWED_COMMANDS_MAX = 100`
- `AgentWorkspaceSchema = z.strictObject({ access, maxTurns: int 1..200, tokenBudget?: int 1_000..10_000_000, allowedCommands: string(1..200)[] max 100 })`; `type AgentWorkspace`
- `AgentConfigSchema.workspace: AgentWorkspaceSchema.optional()` — absent means Off
- `newAgentWorkspace(): AgentWorkspace` → `{ access: 'edit_files', maxTurns: 50, allowedCommands: [] }`
- `agentWorkspaceOf(config: AgentConfig): AgentWorkspace` → `config.workspace ?? { access: 'off', maxTurns: 50, allowedCommands: [] }`
- in `agent.ts`: `WORKSPACE_TOOL_NAMES = ['list_files','read_file','search','git_status','git_diff','write_file','edit_file','run_command','command_output','kill_command'] as const`; `TOOLS_BY_ACCESS: Readonly<Record<WorkspaceAccess, readonly string[]>>` — off `[]`; read_only `list_files, read_file, search, git_status, git_diff`; edit_files adds `write_file, edit_file`; edit_commands adds `run_command, command_output, kill_command`
- `agentToolNames(config: AgentConfig): string[]` — Off: `config.tools.enabled` unchanged; otherwise `TOOLS_BY_ACCESS[access]` followed by the `tools.enabled` names that are not in `WORKSPACE_TOOL_NAMES`, deduplicated, order kept
- `isAgentic(config: AgentConfig): boolean` → `agentWorkspaceOf(config).access !== 'off'`
- in `agent.ts`: `WorkspaceSummarySchema = z.strictObject({ checkpointId: IdSchema.optional(), filesChanged: z.array(z.strictObject({ path: string, added: int ≥0, removed: int ≥0 })).max(500), commands: z.array(z.strictObject({ command: string max 2_000, exitCode: int | null, durationMs: int ≥0 })).max(200) })`; `type WorkspaceSummary` (Tasks 6 and 7 use it)
- validation codes `model_cannot_use_tools`, `project_folder_missing`

- [ ] **Step 1: Write failing tests** — `AgentConfigSchema.parse` of a config without `workspace` succeeds and `agentWorkspaceOf` returns access `off`; `maxTurns: 0` and `201` fail; `allowedCommands` of 101 entries fails; `agentToolNames` for `{access:'read_only'}` with `enabled: ['web_search','write_file']` equals `['list_files','read_file','search','git_status','git_diff','web_search']`; for Off with `enabled: ['write_file','run_command']` equals that list unchanged; new node from `factory.ts` has `workspace.access === 'edit_files'`; the pinned validation-code list includes the two new codes.
- [ ] **Step 2: Run** `pnpm --filter @ace/contracts test` and `pnpm --filter @ace/web test -- factory` → FAIL (exports missing).
- [ ] **Step 3: Implement** the schema, constants and helpers above; update every pinned list the new codes break (grep the test folders for `ROUND_5_VALIDATION_ISSUE_CODES`).
- [ ] **Step 4: Run** `pnpm --filter @ace/contracts typecheck test` and the web factory test → PASS. Run `pnpm -w typecheck` to catch exhaustive switches over AgentConfig keys.
- [ ] **Step 5: Commit** `feat(contracts): per-node workspace access, max turns, token budget and allowed commands [agentic-nodes] [D375]`

### Task 2: Mock provider — scripted agent tool chains

**Files:**
- Modify: `packages/providers/src/adapters/mock.ts` (mock-script parser `scriptOf`/`scriptTurn` :484–527, model switch :670, model list)
- Test: `packages/providers/src/adapters/__tests__/mock-agent.test.ts` (or the folder the mock tests use)

**Interfaces — Produces:** model id **`mock-agent`** (`supportsTools: true`, `supportsJson: false`, `contextWindow: 200_000`). Script syntax = mock-script's `[[turn N]]` / `[[turn *]]` sections read from the prompt, plus a line form `[[tool <name> <json-object>]]` that emits a `tool_call` chunk `{ callId: 'mock-<turn>-<index>', name, args }`. Other lines in a section are text. The turn number is `(req.turns?.length ?? groupedTurnsOf(req.toolResults)) + 1`, where a request with neither is turn 1 and `toolResults` groups by the `mock-<turn>-` callId prefix. Each turn emits `usage { tokensIn: 100 * turn, tokensOut: 20 }` and `finish`. A section with no `[[tool …]]` line ends the loop. Malformed JSON in a tool line → the adapter throws `invalid_config` naming the line.

- [ ] **Step 1: Failing tests** — a prompt with `[[turn 1]]\n[[tool write_file {"path":"a.txt","content":"hi"}]]\n[[turn 2]]\n[[tool run_command {"command":"node --version"}]]\n[[turn 3]]\nDone.` yields: turn 1 one tool_call `write_file` with those args and callId `mock-1-0`; turn 2 (given one result) `run_command`; turn 3 text `Done.` and no tool call; two tool lines in one section give two calls `mock-1-0`, `mock-1-1`; bad JSON throws `invalid_config`.
- [ ] **Step 2: Run** `pnpm --filter @ace/providers test -- mock-agent` → FAIL.
- [ ] **Step 3: Implement** in `mock.ts`, reusing the mock-script section parser.
- [ ] **Step 4: Run** → PASS; full `pnpm --filter @ace/providers test` stays green.
- [ ] **Step 5: Commit** `feat(providers): mock-agent scripts multi-turn tool chains for tests [agentic-nodes] [D315]`

### Task 3: Turn history and provider-opaque replay

**Files:**
- Modify: `packages/engine/src/ports/model-provider.ts` (GenerateRequest :70–107, StreamChunk :133–167)
- Modify: `packages/providers/src/adapters/ai-sdk.ts` (`continuationMessages` :305–334, `generate` :351–428)
- Modify: `packages/providers/src/adapters/mock.ts` (accept `turns`; Task 2 already counts them)
- Test: `packages/providers/src/adapters/__tests__/ai-sdk-turns.test.ts` using `MockLanguageModelV3` (or the mock model class `ai/test` exports in 7.0.109)

**Interfaces — Produces:**
- `interface AgentTurn { text: string; toolCalls: { callId: string; name: string; args: unknown }[]; results: ToolResult[]; opaque?: { providerType: ProviderType; payload: unknown } }`
- `GenerateRequest.turns?: AgentTurn[]` — when present it supersedes `toolResults`; `toolResults` keeps working unchanged for chat and non-agentic nodes
- `StreamChunk` gains `{ type: 'opaque'; providerType: ProviderType; payload: unknown }`, emitted once at the end of a turn by adapters that can replay it
- The comment at `model-provider.ts:56-59` is amended: the message list exists only inside one node's own tool loop; BR-02 governs what crosses nodes

**Behaviour:** `ai-sdk.ts` emits `opaque` with `payload = (await result.response).messages.filter(m => m.role === 'assistant')` (AI SDK copies `providerMetadata` into `providerOptions` on text, reasoning and tool-call parts, which carries Anthropic thinking signatures and Gemini `thoughtSignature`). `messagesFor(req)`: user prompt, then per turn: the stored assistant messages verbatim when `opaque.providerType === adapter.type`, otherwise one assistant message holding the turn's text and **all** its tool-call parts; then **one** `tool` message with all of that turn's results. The no-tools final turn keeps today's text-replay rule (Anthropic rejects tool blocks without tools).

- [ ] **Step 1: Failing tests** — (a) a 2-turn request whose turn 1 has two tool calls produces exactly one assistant message with two tool-call parts and one tool message with two results; (b) a turn with `opaque` from the same provider type is replayed verbatim, including a `reasoning` part with `providerOptions.anthropic.signature`; (c) opaque from another provider type is ignored and rebuilt; (d) turn-1 text appears in the replayed assistant message; (e) `generate` yields an `opaque` chunk after the mock model's response; (f) `toolResults`-only requests produce today's messages (snapshot the existing behaviour first).
- [ ] **Step 2: Run** `pnpm --filter @ace/providers test -- ai-sdk-turns` → FAIL.
- [ ] **Step 3: Implement** the port types and `messagesFor`; keep `continuationMessages` for the `toolResults` path.
- [ ] **Step 4: Run** the providers suite and `pnpm --filter @ace/engine typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(providers,engine): turn history in a neutral format; thinking and thought signatures round-trip in tool loops [agentic-nodes] [D377]`

### Task 4: Person-set model capabilities

**Files:**
- Modify: `packages/storage-local/src/schema.ts` + new migration `20261017T120000_agentic_nodes` in the folder and naming the existing migrations use (Task 4 creates it; Tasks 6 and 7 append to it)
- Modify: the models repository and catalog merge (`packages/engine/src/providers/index.ts` ~:584, `packages/providers/src/catalog/index.ts:57-90`)
- Modify: `packages/engine/src/gateway/index.ts` (next to `refresh-models` :709) or the providers routes module if one exists; `packages/sdk/src/client.ts`
- Modify: `packages/providers/src/adapters/ollama.ts:121-151` (read `model_info["<arch>.context_length"]` from `/api/show` into `contextWindow`)
- Modify: `apps/web/src/providers/ModelsTab.tsx:279` (a "Tools" switch per model row)
- Test: storage repository test, gateway route test, ollama adapter test, ModelsTab test

**Interfaces — Produces:** `PATCH /providers/:id/models/:modelId` body `ModelCapabilitiesPatchSchema = z.strictObject({ supportsTools: z.boolean().optional(), contextWindow: z.number().int().min(1024).max(10_000_000).optional() })` → 200 with the updated `Model`; 404 unknown model. Stored as `supports_tools_override` / `context_window_override` (nullable) columns that every catalog read applies and `refresh-models` never overwrites. `Model` gains `capabilitiesSetByPerson?: true`. SDK `api().patchModelCapabilities(providerId, modelId, patch)`.

- [ ] **Step 1: Failing tests** — PATCH sets `supportsTools: true` on a discovered model; a following refresh keeps it true; GET `/models` shows it with `capabilitiesSetByPerson`; Ollama `/api/show` fixture with `llama.context_length: 131072` gives `contextWindow 131072`; ModelsTab switch calls the SDK with `{ supportsTools: true }`.
- [ ] **Step 2: Run** the four tests → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** storage, engine, providers, web suites for touched files → PASS.
- [ ] **Step 5: Commit** `feat(storage,engine,web): a person can mark a model as tool-capable; it survives refresh; Ollama context windows [agentic-nodes] [D380]`

### Task 5: Command gate and approvals with Always allow

**Files:**
- Create: `packages/engine/src/runs/agentic/commands.ts`
- Modify: `packages/contracts/src/guardrails.ts` (ApprovalRequestSchema :313–335, decision :337–353)
- Modify: `packages/engine/src/guardrails/evaluator.ts` (`runDestructive` :782–833, tool bag), `packages/engine/src/runs/tool-loop.ts` (ToolGuardStep input)
- Modify: `packages/engine/src/approvals/index.ts` (`decide` :261), `packages/engine/src/approvals/routes.ts:59-79`
- Modify: `apps/server/src/server.ts` (onDecided :565, approval wiring), `packages/sdk/src/client.ts:665-676`
- Test: `packages/engine/src/runs/agentic/__tests__/commands.test.ts`, evaluator test, approvals routes test

**Interfaces:**
- Consumes: `classifyCommand(command, allowlist): Classification` from `@ace/tools` (`autoAllowed`, `alwaysAllowPrefix?`, `denied[]`)
- Produces:
  - `commandGate(command: string, allowlist: readonly string[]): { kind: 'allow' } | { kind: 'ask'; allowPrefix?: string; denylisted: boolean }`
  - `interface RunAllowlist { for(nodeId: Id): readonly string[]; add(nodeId: Id, prefix: string): void }` and `createRunAllowlist(snapshotNodes: Node[]): RunAllowlist` (seeded from each node's `workspace.allowedCommands`)
  - tool bag field `command?: { text: string; gate: ReturnType<typeof commandGate> }` passed to `beforeTool` for `run_command` on an agentic node
  - `ApprovalRequestSchema.command?: { text: string (max 8_000); allowPrefix?: string; denylisted: boolean }`
  - `ApprovalDecisionRequestSchema = z.strictObject({ note?, always?: z.literal(true) })`; decision record gains `always?: true`, `prefix?: string`
  - approval service `decide(nodeRunId, decision, { note?, always? })`; dependency `onAlways(runId: Id, nodeId: Id, prefix: string): Promise<void>`
- Server `onAlways`: `runAllowlist.add(nodeId, prefix)` for the live run, and the saved workflow's node gets the prefix in `config.workspace.allowedCommands` through the graph service's normal node update (version bump, workflow event), never the run snapshot.

**Behaviour:** gate `allow` → `destructive_action` passes with no card and no verdict row beyond `pass`; `ask` → the existing card, with `request.command` set. `POST /node-runs/:id/approve` with `always: true` when the pending request has no `allowPrefix` → 400 `validation_failed` "This command can't be always-allowed." A non-agentic node's approvals are unchanged.

- [ ] **Step 1: Failing tests** — `commandGate('pnpm test', ['pnpm test'])` → allow; `commandGate('pnpm install && pnpm test', ['pnpm install'])` → ask with no prefix; `commandGate('git push --force', ['git push'])` → ask, `denylisted: true`, no prefix; `commandGate('npm run build', [])` → ask, `allowPrefix: 'npm run build'`; `commandGate('echo $(whoami)', [])` → ask, no prefix. Route: approve with `always` adds the prefix, the next identical command in the same run runs with no card, and the workflow's node now lists it; approve with `always` on a no-prefix request → 400.
- [ ] **Step 2: Run** `pnpm --filter @ace/engine test -- commands approvals evaluator` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** engine suite + `pnpm --filter @ace/contracts test` → PASS.
- [ ] **Step 5: Commit** `feat(engine,contracts): command approvals use the node's allowlist; Always allow saves the prefix on the node [agentic-nodes] [FR-GRD-006] [D376]`

### Task 6: The agentic loop

**Files:**
- Create: `packages/engine/src/runs/agentic/system-prompt.ts`, `elide.ts`, `limits.ts`, `index.ts`
- Modify: `packages/engine/src/runs/executor.ts` (tool set :669–686, loop :888–937, `generateTurn` :985–1087, `runToolCall` :1095–1199)
- Modify: `packages/engine/src/runs/preflight.ts` (the two codes)
- Modify: `packages/contracts/src/events.ts` (persisted run event `node.turn`)
- Modify: `packages/contracts/src/guardrails.ts:214` and `packages/storage-local/src/default-policy.ts` + the migration from Task 4 (`max_tool_calls` 25 → 200, only where the seeded default policy still holds 25)
- Test: `packages/engine/src/runs/agentic/__tests__/*.test.ts`, `packages/engine/src/runs/__tests__/executor-agentic.test.ts`

**Interfaces:**
- Consumes: Task 1 (`agentWorkspaceOf`, `agentToolNames`, `isAgentic`), Task 2 (`mock-agent`), Task 3 (`AgentTurn`, `turns`, `opaque`), Task 5 (`commandGate`, `RunAllowlist`)
- Produces:
  - `agentSystemPrompt(input: { instructions: string; workspaceRoot: string; os: NodeJS.Platform; shell: string; access: WorkspaceAccess; upstream?: WorkspaceSummary[] }): string`
  - `ELIDED_OUTPUT = '[output elided — re-run if needed]'`; `elideTurns(turns: AgentTurn[], budget: { contextWindow: number; fixedChars: number }): AgentTurn[]`
  - `checkLimits(state: { turns: number; tokensIn: number; tokensOut: number }, ws: AgentWorkspace): NodeError | undefined` — codes `agent/max_turns`, `agent/token_budget`
  - event `node.turn` payload `{ runId, nodeRunId, nodeId, turn: int ≥1, tokensIn, tokensOut, toolCalls: int ≥0 }` (persisted, append-only)

**Behaviour (agentic nodes only; Off keeps every line of today's path):**
- Offered tools = `agentToolNames(config)` found in the registry. The node's `tools.maxToolCalls` is not used; the policy's `max_tool_calls` still applies with today's one-more-turn-without-tools rule.
- The system prompt = node instructions + `agentSystemPrompt` rules: paths relative to the workspace; OS and shell; read before edit; prefer `edit_file` to rewriting; non-interactive flags (`-y`, `--yes`, `CI=1`); servers with `background: true` and check them with `command_output`; stay inside this node's task and contract, leave downstream nodes' work alone; the upstream `workspace` blocks.
- History is `AgentTurn[]` (text, calls, results, opaque); each turn passes `elideTurns` first. Elision: estimate tokens as chars/4 over `fixedChars` + turns; above 70 % of `contextWindow` replace bodies of the oldest `read_file`, `run_command` and `command_output` results with `ELIDED_OUTPUT` until at or below 50 %; calls and result envelopes stay.
- Before each model call `checkLimits`; at the limit the node fails with message "Stopped after {n} turns, this node's Max turns. Raise it in the node's settings." / "Stopped at {n} tokens, this node's token budget."
- After each turn emit `node.turn`.
- Approval denied (`reject` after `ask_user`) on an agentic node: not a failure — the tool result is `{ denied: true, error: 'The person denied this command.' }` plus their note, the ToolCall row is `rejected`, the node goes back to RUNNING (server `onDecided` sets RUNNING for a request with `command`), the loop continues. A policy `block` still fails the node.
- Stop mid-batch: the loop ends; no further model call is made, so no tool call is ever sent unanswered; remaining calls get ToolCall rows with the status a failed call uses today and summary `cancelled`.
- Pre-flight: an agentic node whose catalog row has `supportsTools === false` → `model_cannot_use_tools` "{model} can't use tools. Pick another model, or turn tools on for it in Providers."; an agentic node in a project with no `folderPath` → `project_folder_missing` "Give the project a folder to let {node} work in it."

- [ ] **Step 1: Failing unit tests** — `elideTurns` leaves turns under 70 % untouched; above it, elides oldest-first down to ≤ 50 % and never changes callIds or tool-call parts; `checkLimits` at `turns === maxTurns` returns `agent/max_turns`; tokens over budget returns `agent/token_budget`; `agentSystemPrompt` contains the workspace root, the shell, and "background: true".
- [ ] **Step 2: Failing executor tests (mock-agent, temp project folder, approvals auto-approved by a test approver)** — script write_file → run_command `node -e "require('fs').readFileSync('a.txt')"` → text: node COMPLETED, `a.txt` exists, two ToolCall rows, three `node.turn` events, request 2 carried `turns` with turn 1's call and result; `maxTurns: 2` with a three-turn script → FAILED `agent/max_turns`; a rejected command → model's next turn sees `denied: true` and the node COMPLETES; an Off node with `run_command` in `tools.enabled` still gets the flat `toolResults` request and `tools.maxToolCalls` limit; pre-flight codes for a `supportsTools:false` model and a folderless project; the file is rewritten through the workspace service's save between the node's `read_file` and `edit_file` → the edit returns a tool error, the script's next turn re-reads and edits, and the node completes.
- [ ] **Step 3: Run** `pnpm --filter @ace/engine test -- agentic` → FAIL.
- [ ] **Step 4: Implement** the module and the executor branch; the default-policy bump and its migration.
- [ ] **Step 5: Run** the full engine suite → PASS (existing tool-loop tests unchanged).
- [ ] **Step 6: Commit** `feat(engine): the agentic loop — access-level tools, turn history, elision, max turns and token budget, denied commands fed back [agentic-nodes] [FR-TOOL-003] [D375] [D377]`

### Task 7: Workspace summary, envelope block, changed paths

**Files:**
- Modify: `packages/contracts/src/tools.ts:165-176` (ToolCall), `packages/contracts/src/envelope.ts:210-228`, `packages/contracts/src/runs.ts:253` (NodeRun)
- Modify: `packages/storage-local/src/schema.ts` + the Task 4 migration (`node_runs.workspace_json`, `tool_calls.changed_paths_json`)
- Modify: `packages/engine/src/runs/executor.ts` (logToolCall :1225–1253), `packages/engine/src/runs/index.ts` (`recordedStep` :2301, `envelopeBetween` :474–560, `beginStepCheckpoint` :3153), `packages/engine/src/envelopes/index.ts:184-216`, `packages/engine/src/prompts/index.ts` (render the block)
- Modify: `packages/engine/src/chat/service.ts:1583-1600` (`recordRunTurn` carries `activity` and `checkpointId`)
- Test: contracts envelope test (Off envelope unchanged), engine runs test, prompts test, chat recordRunTurn test

**Interfaces — Produces:**
- `ToolCall.changedPaths?: string[]` (project-relative, `/` separators, max 200) — write tools: their `path`; `run_command`: its result's `changedPaths`
- Consumes `WorkspaceSummarySchema` from Task 1
- `EnvelopeSchema.workspace?: WorkspaceSummary`; `NodeRun.workspace?: WorkspaceSummary`
- `summarizeStep(input: { toolCalls: ToolCall[]; checkpoint?: Checkpoint }): WorkspaceSummary` in `runs/agentic/summary.ts` — files from the step checkpoint's files (`additions`/`deletions`) when it finished, else the union of `changedPaths` with 0/0; commands from `run_command` rows
- the downstream prompt renders `## Upstream workspace` (files with +/−, commands with exit codes); Off upstream → no section, byte-identical prompt
- chat run turns gain `activity` (`activityItemFor`, `packages/engine/src/chat/activity.ts`) and `checkpointId`, so the chat's "What it did" and Changes card show for runs

- [ ] **Step 1: Failing tests** — an Off chain's envelope and downstream prompt equal today's (snapshot); an agentic A → B chain: A's NodeRun `workspace` lists `a.txt` (+1/−0) and the command with exit 0; B's envelope carries it and B's prompt shows `## Upstream workspace`; `run_command`'s ToolCall row has `changedPaths`; the chat run turn has `activity` with a `command` item and the step's `checkpointId`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** contracts, storage, engine suites → PASS.
- [ ] **Step 5: Commit** `feat(engine,contracts): a node's step hands on its files and commands in the envelope's workspace block [agentic-nodes] [D378]`

### Task 8: Restart, revert, Stop

**Files:**
- Modify: `packages/engine/src/runs/lifecycle.ts:100-194`, `packages/contracts/src/enums.ts:61-71` (if codes are enumerated there)
- Modify: `packages/engine/src/checkpoints/service.ts:454-465` (`act`), `packages/engine/src/checkpoints/routes.ts`
- Modify: `apps/server/src/server.ts` (agent session end on `run.completed` :1008 — confirm it also ends on stop/halt; it must kill foreground and background commands)
- Test: lifecycle test, checkpoints service test, server agent-session test

**Behaviour:**
- `recoverAfterCrash`: a node run of an agentic node (from `run.snapshot`) left RUNNING → `BLOCKED`, error `{ kind: 'run', code: 'engine_restarted', retryable: true, message: 'The engine restarted mid-step. Background commands from this run were stopped.' }`; left WAITING → `BLOCKED`, code `approval_lost`, message 'The approval was lost when the engine restarted. Background commands from this run were stopped.'. Non-agentic nodes keep today's STOPPED. The Domain `stayOpen` branch also calls `cancelPending` (today it skips it).
- `act(revert)` on a `kind: 'run'` checkpoint whose run is PREFLIGHT, RUNNING or PAUSED → 409 `run_active` "Stop the run or let it finish before reverting its steps." Keep is still allowed.
- Run Stop and halt end the run's agent session immediately, killing its foreground command tree and every background process; pending approvals resolve as reject (existing `cancelPending`).

- [ ] **Step 1: Failing tests** for each bullet (a crash fixture with one RUNNING and one WAITING agentic node run; a revert during RUNNING → 409 and after COMPLETE → 200; Stop during a background `node -e "setInterval(()=>{},1000)"` leaves no live pid).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** engine + server suites → PASS.
- [ ] **Step 5: Commit** `feat(engine): restart leaves agentic steps BLOCKED with the reason; no revert while the run is active; Stop kills the run's commands [agentic-nodes] [D379]`

### Task 9: Decisions and Gate 2

**Files:**
- Modify: `docs/DECISIONS.md` (rows D375–D383), `CLAUDE.md` §9 (AN2 row), `docs/ARCHITECTURE.md` §19 only if a state changed (it should not: WAITING reused, D343)
- Create: `tests/acceptance/agentic/gate-2a.test.ts` (or the engine integration folder the acceptance config includes)

**Decision rows (one line each in the table's style):**
- D375 Access levels' tool sets (git_status/git_diff join Read only), Max turns 1–200 default 50, optional token budget; an agentic node ignores `tools.maxToolCalls`; the seeded default policy's `max_tool_calls` goes 25 → 200.
- D376 Command approvals: allowlist gate; Always allow saves the prefix on the workflow's node and the live run, never the snapshot; a denied command is a tool result, not a failure, for agentic nodes.
- D377 Turn history inside one node step (BR-02 is about crossing nodes) with AI SDK response messages replayed as `provider_opaque`; elision 70 % → 50 %, no summariser.
- D378 Envelope and NodeRun `workspace` block, `checkpointId` instead of a commit sha (D341).
- D379 Restart → BLOCKED `engine_restarted` / `approval_lost`; revert refused while the run is active; Stop kills the run's commands.
- D380 Person-set model capabilities override discovery and survive refresh.
- D381–D383 reserved for Part B/C (`tool.started`, terminal kill, CLI access).

**Gate 2a (CI, mock-agent):** Node A script: write `sum.js` (`module.exports = (a,b)=>a+b`) and `sum.test.js` (`node:test`), run `node --test`; Node B script: `read_file sum.js`, `edit_file` adding `subtract`, write `subtract.test.js`, run `node --test`. Pass if both COMPLETE, final command exit 0, files exist, two per-node checkpoints each holding only that node's files, A's envelope lists its files and command, B's `edit_file` passed read-before-edit (a ledger hit, no `stale_read` error), `node.turn` events for every turn.

**Gate 2b (real provider, manual):** the same chain with the owner's configured tool-capable API model (one run, approvals clicked or auto-allowed). Record model, cost and pass/fail per criterion in the AN2 row. Skip with the reason if no tool-capable provider is configured.

- [ ] **Step 1:** write the gate-2a test → **Step 2:** run, expect PASS on the finished Part A (fix in the owning task's code if not) → **Step 3:** decisions + §9 row → **Step 4:** full gates: `pnpm -w typecheck`, `pnpm -w lint`, every package's tests → **Step 5:** commit `test,docs: Gate 2a chain; decisions D375–D380 [agentic-nodes]`.

---

## Part B — Phase 3 (Forge and canvas UI)

Design tokens only (`packages/ui/src/tokens.ts`, `theme.css`, `agentColor(i)` in `apps/web/src/theme/constants.ts:209`); node colour = its agent colour; live = `livePulse`.

### Task 10: Live tool events

**Files:** `packages/contracts/src/events.ts` (transient run-scope `tool.started`), `packages/engine/src/runs/executor.ts` (emit before `registered.run`), `apps/web/src/runs/run-store.ts:338-357` (`useNodeOverlay` gains `activeTool?: { name, target, startedAt }`, cleared by the matching `tool.call`), tests.

**Produces:** `tool.started { runId, nodeRunId, nodeId, callId, name, target?: string (path or command, max 200) }`; `nodeActivityLabel(tool: {name,target}) : string` in `apps/web/src/runs/activity-label.ts` → `Reading src/a.js` (read_file, list_files, search, git_*), `Editing a.js` (write_file, edit_file), `Running npm test` (run_command), `Checking npm run dev` (command_output), `Stopping a command` (kill_command); WAITING → `Waiting for approval`.

- [ ] Failing tests (engine emits `tool.started` before `tool.call` with the same callId; store sets and clears `activeTool`; label table) → implement → pass → commit `feat(engine,web): tool.started shows what a node is doing right now [agentic-nodes] [D381]`

### Task 11: Node settings — Workspace access

**Files:** create `apps/web/src/config-panel/WorkspaceAccessField.tsx`; modify `config-panel/panels.tsx:176-302`, `SkillsField.tsx`, `AgentToolsSection.tsx`; tests.

**Behaviour:** four options with these exact lines — Off "Answers in chat only. Doesn't touch the project." · Read only "Reads and searches the project's files." · Edit files "Reads, creates and edits files in the project." · Edit + commands "Also runs terminal commands. Each one asks first unless you've always-allowed it." For Edit + commands show "Commands run on this computer with your permissions. They are not sandboxed." Fields: Max turns (1–200), Token budget (optional, empty = none), Allowed commands (chips with remove; no free-text add — prefixes come from Always allow). Disabled with "This model can't use tools." + link to Providers when the chosen model's `supportsTools === false`; disabled with "Give the project a folder first." when `folderPath` is empty. When access ≠ Off: the Files and Shell skill switches and the workspace tools' checkboxes are hidden, and Max tool calls is hidden.

- [ ] Failing component tests for each line above → implement → pass → commit `feat(web): Workspace access in node settings [agentic-nodes] [D342] [D375]`

### Task 12: Command approval cards

**Files:** `packages/ui/src/components/approval-card.tsx`, `apps/web/src/runs/approvals/ApprovalStack.tsx:93-131`, `apps/web/src/runs/hooks.ts:294-297`, `apps/web/src/forge/terminal/` (pinned stack at the panel top), `apps/web/src/chat/` Team aside run approvals; tests.

**Behaviour:** with `request.command`: node chip (colour + name), the full command in mono, wrapped, never truncated; buttons **Allow · Always allow `<prefix>` · Deny** (Always hidden without `allowPrefix`); denylisted adds "This matches the risky-command list." Allow → approve; Always → approve `{ always: true }`; Deny → reject. Keyboard A / R kept; Always has no shortcut. Cards without `command` render as today.

- [ ] Failing tests → implement → pass → commit `feat(ui,web): command approval cards with Always allow, in the Terminal panel and the Team chat [agentic-nodes] [D376]`

### Task 13: Canvas card, chat and Result card

**Files:** `apps/web/src/nodes/NodeCard.tsx` (:280-358, note :545-551), `NodeCardButtons.tsx:87-115`, `apps/web/src/chat/ChatConversation.tsx:251-261` + `ChatAside.tsx:185-188`, `apps/web/src/domain/RunResult.tsx:181-282`, `apps/web/src/forge/attribution.ts:18-144`, Forge path bar; tests.

**Behaviour:**
- Card: under the status chip, `nodeActivityLabel` while RUNNING/WAITING (mono target, ellipsis); the "running — answer in Chat" note becomes that label for agentic nodes.
- Explorer: the live agent badge (`FileTree.tsx:521-527`) sits on the file an `activeTool` write targets, from its `tool.started` to its `tool.call`, instead of on every file the node touched while it is RUNNING.
- Agentic nodes: **Open in Forge** in the card menu and in place of the chat's "Send to Forge →" chip; it opens Forge with the files of the node's last step (`NodeRun.workspace.filesChanged`, falling back to `changedPaths`), using RunResult's existing open-files mechanism. Off nodes keep Send to Forge.
- `attribution.ts`: a `run_command` `tool.call` with `changedPaths` attributes those files to the node, whole-file, `viaCommand: true`; the path bar shows "{Node} changed this file via a command · {relative time}" (ranges keep "{Node} edited lines a–b · {relative time}").
- RunResult "Files written" includes command-made files.

- [ ] Failing tests per bullet → implement → pass → commit `feat(web): live node activity on cards, Open in Forge, command-made files attributed [agentic-nodes] [D334] [D378]`

### Task 14: Terminal rows, Kill, Revert step

**Files:** `packages/contracts/src/workspace.ts:425-443` (`ProcessAgentSchema.background: boolean`), `packages/engine/src/processes/service.ts:507-518` (stop allowed for background agent processes via the run's agent session), `apps/server/src/server.ts` (route the stop to the session), `apps/web/src/forge/terminal/ProcessesList.tsx:86-129`, `apps/web/src/nodes/NodeCardButtons.tsx`, chat `ChangesCard.tsx`; tests.

**Behaviour:** agent rows show the node's colour chip and name (from `agentMap`), the command in mono, status, duration; a node filter (All + each node with rows); **Kill** on running background agent rows (foreground ones say "Stop the run to stop this command."). Card menu **Revert step** on an agentic node with a finished step checkpoint → the existing RevertAllDialog → `checkpointAction(revert)`; disabled with "Can't revert while the run is running." while the run is active (engine 409 is the backstop).

- [ ] Failing tests → implement → pass → commit `feat(engine,web): agent command rows by node, Kill for background commands, Revert step [agentic-nodes] [D382]`

### Task 15: Gate 3 (manual, Windows, browser)

Run the Gate 2 chain from the canvas with `mock-agent` and, if configured, the owner's real tool-capable model; click approvals by hand (Playwright Chromium per `ace-tooling` notes). Check prompt items 1–10 one by one with screenshots: live files, live badge, gutter, path bar, terminal rows, approval cards, settings, card sub-status + Open in Forge, Stop, Revert step. Record pass/fail in the AN2 row; fix failures in the owning task. Commit screenshots under `docs/team-prompts/agentic-nodes/`.

---

## Part C — Phase 4 (CLI-backed nodes)

### Task 16: CLI access per node

**Files:** `packages/engine/src/ports/model-provider.ts` (`GenerateRequest.cliAccess?: { access: WorkspaceAccess; allowedCommands: string[] }`), `packages/providers/src/adapters/cli/{adapter,claude-code,codex,gemini}.ts`, `packages/engine/src/runs/executor.ts` (pass it for agentic CLI nodes), `apps/web/src/config-panel/WorkspaceAccessField.tsx` (per-CLI availability), tests.

**First step: read `claude --help`, `codex exec --help`, `gemini --help` on this machine and record the exact flags in the task's commit body.** Mapping to implement only where a real equivalent exists:
- Claude Code: Read only `--permission-mode dontAsk --tools Read,Grep,Glob`; Edit files `--permission-mode acceptEdits --tools Read,Edit,Write,Grep,Glob`; Edit + commands adds `Bash` to `--tools` and one `--allowedTools "Bash(<prefix>:*)"` per allowed prefix under `dontAsk`, so a command outside the list is refused by the CLI, not asked (headless can't ask) — the selector says "Runs only the commands you've always-allowed; others are refused."
- Codex: Read only `--sandbox read-only`; Edit files and Edit + commands both `--sandbox workspace-write` (Codex runs commands in its sandbox under both) — Edit files is shown as "Codex also runs commands inside its sandbox."
- Gemini CLI: from its `--help`; a level with no equivalent is disabled with the reason.
- Access Off on a CLI node keeps the provider's `cliPermission` exactly as today.
- The CLI session is listed as one agent process row (PG-5.3 path) whose output is the CLI's activity summaries; attribution comes from the step checkpoint (whole-file, "via {CLI}").

- [ ] Failing tests (args per CLI per level; Off unchanged; one process row per CLI step) → implement → pass → commit `feat(providers,engine,web): CLI nodes take their access level per node [agentic-nodes] [D383]`

### Task 17: Gate 4 and wrap-up

Gate 4: the chain with Node A on Claude Code (haiku) and Node B on `mock-agent` or the owner's API model. D383 row (CLI file tools bypass ACE's path guard and hash rule; API nodes in parallel still see the CLI's changes through their hash checks). Update the AN2 row, write the final report (files per phase, test results, each Gate, decisions, C1–C6 as already resolved by D340–D345, anything skipped with the reason).

---

## Execution waves

| Wave | Tracks (parallel, one worktree each) |
|---|---|
| 1 | T1 contracts · T2 mock-agent · T3 turn history · T4 capabilities |
| 2 | T5 → T6 (one track: both touch the executor and approvals) · T8 restart/revert/Stop |
| 3 | T7 summary/envelope → T9 Gate 2 |
| 4 | T10 → T13 (live events, card, chat) · T11 settings · T12 approval cards · T14 terminal/revert |
| 5 | T15 Gate 3 · T16 → T17 |

Integrate each wave onto `feat/agentic-nodes-p2` before the next starts; full gates (`pnpm -w typecheck`, `pnpm -w lint`, all package tests) after each wave.
