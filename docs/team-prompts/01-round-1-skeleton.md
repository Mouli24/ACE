# Round 1 — Skeleton: engine skeleton (Arhant) + web shell & Canvas (Mouli)

**Previous:** none — start here after `CLAUDE.md` is in place. **Next:** `02-round-2-providers-execution.md` (open only when §9 gate is green and `round-1` is tagged).
**FRS phases covered:** 0 (foundations), 1 (contracts + DB), 2 (engine skeleton: SYS, PRJ, WF), 3 (Canvas: CAN, NODE, CON — data edges only).

---

## 0. Read first (both)

- `CLAUDE.md` — whole file, especially §3 ownership and §5 round process.
- `docs/ACE-FRS.md` §1.3 definitions · §2.4 constraints · §3.1 SYS · §3.2 PRJ · §3.3 WF · §3.4 CAN · §3.5 NODE · §3.6 CON · §5 BR-01..18 · §8.3 fixtures · §8.6 rows TC-SYS, TC-PRJ, TC-WF, TC-CAN, TC-NODE, TC-CON.
- `docs/ARCHITECTURE.md` §3 principles · §7 ports table · §10.1 web app · §11 gateway (Mode A column) · §12.2 graph service · §15.1–15.3 data · §20.1–20.3 API/WS · §21.4 reconnect · §22.1 security · §29 config · §30 code organization · §33.2–33.3 site map and routes · §35 stack.

## 1. Round goal

At the end of Round 1, on a clean clone, `pnpm dev` starts the engine and the web app; the user creates a project, opens a workflow tab, drags Input / Agent / Model / Output / Merge / Transform nodes onto a dark dotted Canvas, configures them in the right-hand panel, connects them with typed arrows (incompatible types and plain cycles refused with a reason), reloads the page and finds everything exactly where it was. No model is called yet — providers and runs are Round 2.

**Demo script (run by both at the gate):** `pnpm dev` → open printed URL → New project "Demo" → New workflow → add Input → Agent → Output, connect → set Agent name/instructions/types → connect Input (text) to Agent (text) OK → try Agent (text) → an image-only port → refused with reason → try closing a cycle → refused → reload → identical graph → export JSON → import into a second workflow → identical.

---

## 2. Shared contract — Round 1 (`packages/contracts`, implemented by Arhant in Step 0)

Everything below is **the** definition. Arhant implements it verbatim as Zod schemas with inferred types; Mouli codes against it. Any change goes through a DECISION NEEDED and a contracts-only PR.

### 2.1 Package names and ports
`@ace/config @ace/contracts @ace/engine @ace/storage-local @ace/providers @ace/guardrails @ace/context @ace/tools @ace/server @ace/sdk @ace/ui @ace/web`.
Engine: `http://127.0.0.1:4747` (`ACE_PORT` overrides). Web dev: `http://localhost:5173`. Data dir: `ACE_DATA_DIR` or `~/.ace`; config file `<dataDir>/ace.config.json`; tests always use a temp dir.

### 2.2 Enums (`src/enums.ts`) — ALL declared now, even the ones first used later
```ts
DataType        = 'text' | 'image' | 'audio' | 'video' | 'code' | 'json' | 'file'
NodeKind        = 'input' | 'agent' | 'model' | 'output' | 'merge' | 'transform' | 'retrieval' | 'guardrail' | 'custom'
EdgeKind        = 'data' | 'loop'
NodeState       = 'IDLE' | 'READY' | 'RUNNING' | 'WAITING' | 'COMPLETED' | 'PAUSED' | 'STOPPED' | 'BLOCKED' | 'FAILED'
RunState        = 'PREFLIGHT' | 'RUNNING' | 'PAUSED' | 'COMPLETE' | 'BLOCKED' | 'HALTED'
FailureReason   = 'RUN_FAILED' | 'CONTRACT_VIOLATION' | 'GUARDRAIL_VIOLATION' | 'BLOCKED'
HaltReason      = 'stopped' | 'budget_exceeded' | 'failure' | 'shutdown' | 'crash'
ProviderState   = 'UNKNOWN' | 'CHECKING' | 'CONNECTED' | 'AUTH_FAILED' | 'UNREACHABLE' | 'RATE_LIMITED'
ProviderType    = 'anthropic' | 'google' | 'openai' | 'openai_compatible' | 'ollama' | 'mock'
ErrorKind       = 'user_cancelled' | 'agent' | 'provider' | 'auth' | 'network' | 'invalid_config' | 'workflow' | 'guardrail'
GuardrailAction = 'pass' | 'warn' | 'redact' | 'ask_user' | 'block'
GuardrailPoint  = 'input' | 'context' | 'tool' | 'output' | 'cost' | 'loop' | 'data'
RoutingPolicy   = 'fixed' | 'fallback' | 'capability' | 'cost' | 'latency'
```
A unit test asserts every literal above (`describe("FR-SYS-006 enum literals")`).

### 2.3 Error shape (`src/errors.ts`) — FR-SYS-006, Arch §20.1/§28
```ts
ApiError = { error: { kind: ErrorKind, code: string, message: string, details?: unknown, retryable: boolean } }
```
Codes used in Round 1: `unauthorized` (401) · `forbidden_origin` (403) · `not_found` (404) · `validation_failed` (400, `details: ValidationIssue[]` or Zod issues) · `stale_version` (409, `details: { currentVersion }`) · `invalid_path` (400, `details: { path }`) · `unsupported_format_version` (400) · `not_implemented` (501) · `internal` (500).
Helper: `aceError(kind, code, message, { details?, retryable? })` returning the shape above.

### 2.4 Graph entities (`src/graph.ts`)
```ts
Id = string (ULID)                     Timestamp = ISO-8601 string
Project  = { id, name: string(1..120), folderPath: string, lastOpenedAt?: Timestamp, createdAt, updatedAt }
Workflow = { id, projectId, name: string(1..120), version: number(int ≥ 0), formatVersion: 1, createdAt, updatedAt }
Port     = { id, name: string, dataType: DataType, multi: boolean }          // multi=true accepts many edges
Position = { x: number, y: number }
Node     = { id, workflowId, kind: NodeKind, name: string(1..80), position: Position,
             inputs: Port[], outputs: Port[], config: NodeConfig }           // config is discriminated by kind
Edge     = { id, workflowId, kind: EdgeKind, from: { nodeId, portId }, to: { nodeId, portId }, loop?: LoopConfig }
LoopConfig = { maxIterations: number(int 1..50), exitCondition: { path: string, equals: string|number|boolean }, onMax: 'continue'|'fail' }
             // declared now; engine refuses kind 'loop' with `not_implemented` until Round 3
```
`NodeConfig` per kind:
```ts
input:     { text?: string, artifactIds: Id[], outputTypes: DataType[] }      // artifactIds used from Round 4
output:    {}
agent:     AgentConfig
model:     { providerId?: Id, modelId?: string, systemPrompt?: string, inputTypes: DataType[], outputTypes: DataType[], execution: ExecutionSettings }
merge:     { mode: 'all' | 'any' }
transform: { op: 'template' | 'extract_json_field' | 'join', template?: string, path?: string, separator?: string }
retrieval: { knowledgeBaseId?: Id, k: number(int 1..20) }                    // Round 5
guardrail: { policyId?: Id }                                                  // later round
custom:    { customNodeId?: Id }                                              // later round

AgentConfig = {
  providerId?: Id, modelId?: string,
  routing: { policy: RoutingPolicy, fallbackModelIds: string[] },            // default { policy: 'fixed', fallbackModelIds: [] }
  instructions: string,
  inputTypes: DataType[], outputTypes: DataType[],
  outputContract?: { jsonSchema?: Record<string, unknown> },
  execution: ExecutionSettings,
  contextPolicy: { budgetTokens: number(int 256..200000) },                   // default 4000
  guardrailPolicyId?: Id,                                                     // Round 3
  tools: { enabled: string[], maxToolCalls: number(int 0..50), allowedDomains: string[] },  // Round 4; default { enabled: [], maxToolCalls: 10, allowedDomains: [] }
  knowledgeBaseIds: Id[],                                                     // Round 5; default []
  memory: { enabled: boolean },                                               // Round 5; default { enabled: false }
  skillIds: Id[]                                                              // reserved; default []
}
ExecutionSettings = { temperature: number(0..2), maxTokens: number(int 1..200000), timeoutMs: number(int 1000..600000), retries: number(int 0..5) }
                  // defaults { temperature: 0.7, maxTokens: 4096, timeoutMs: 120000, retries: 2 }
```
Port derivation (FR-NODE-006): `derivePorts(node)` (pure, in contracts): `input` → one output port per `outputTypes` entry; `output` → one input port per accepted type (`text`, `json`, `image`, `audio`, `video`, `code`, `file`, all `multi:false`); `agent`/`model` → one input port per `inputTypes` (`multi:false`) and one output port per `outputTypes`; `merge` → one input port `in` (`dataType:'json'`? no — `dataType: 'text'`, `multi: true`) plus one `in_json` (`json`, `multi:true`) and one output `out` (`json`); `transform` → input `in` (`text`|`json` per `op`: `template`→`json`, `extract_json_field`→`json`, `join`→`text`, `multi:true` for `join`), output `out` (`text` for template/join, `json` for extract). Port ids are stable: `<nodeId>:in:<name>` / `<nodeId>:out:<name>`.

### 2.5 Connection rule (`src/validation.ts`, pure) — FR-CON-002/005
```ts
isConnectionAllowed(source: Port, target: Port, existingEdgesIntoTarget: number)
  : { ok: true } | { ok: false, code: 'incompatible_types' | 'single_input_occupied', reason: string }
```
Compatible: identical `dataType`; additionally `code`→`text` and `text`→`code` are allowed; nothing else.
```ts
ValidationIssue = { severity: 'error' | 'warning', code: string, message: string, nodeId?: Id, edgeId?: Id }
```
Codes: `unconnected_required_input`, `no_input_node`, `no_output_node`, `incompatible_types`, `cycle`, `single_input_occupied`, `invalid_execution_setting`, `missing_model` (warning in Round 1, error from Round 2), `loop_not_supported` (Round 1 only).

### 2.6 Graph operations (`src/graph-ops.ts`) — FR-WF-004/005, Arch §10.1
```ts
GraphOp =
  | { op: 'add_node',    node: Node }
  | { op: 'update_node', nodeId: Id, patch: { name?, config?: Partial<NodeConfig> } }   // ports re-derived server-side
  | { op: 'move_node',   nodeId: Id, position: Position }
  | { op: 'delete_node', nodeId: Id }                                                    // engine deletes its edges
  | { op: 'add_edge',    edge: Edge }
  | { op: 'update_edge', edgeId: Id, patch: { loop?: LoopConfig } }
  | { op: 'delete_edge', edgeId: Id }
GraphOpsRequest  = { baseVersion: number, ops: GraphOp[] }                               // 1..200 ops, ONE transaction
GraphOpsResponse = { version: number, nodes: Node[], edges: Edge[] }                    // version = baseVersion + 1
```
Stale `baseVersion` → 409 `stale_version`. Any invalid op → 400 `validation_failed`, **nothing applied**, version unchanged.

### 2.7 Settings, export (`src/settings.ts`, `src/export.ts`)
```ts
Settings = { dataDir: string, defaultProviderId?: Id, concurrency: number(int 1..64), theme: 'dark'|'light'|'system',
             lastProjectId?: Id, onboardingCompleted: boolean, allowedOrigins: string[] }
           // defaults: concurrency 20, theme 'dark', onboardingCompleted false, allowedOrigins ['http://localhost:5173','http://127.0.0.1:5173']
WorkflowExport = { formatVersion: 1, exportedAt, name, nodes: Node[], edges: Edge[] }   // provider ids kept, never keys
```

### 2.8 REST endpoints — Round 1 (`/api/v1`, `Authorization: Bearer <token>` on every request)
| Method + path | Body → Response |
|---|---|
| `GET /health` | → `{ status: 'ok', version: string, db: 'ok' }` |
| `GET /settings` · `PATCH /settings` | `Partial<Settings>` → `Settings` |
| `GET /projects` · `POST /projects` | `{ name, folderPath? }` → `Project` (folder created if missing; unwritable → 400 `invalid_path`) |
| `GET /projects/:id` · `PATCH /projects/:id` · `DELETE /projects/:id` | `{ name? }` → `Project` · delete → 204 |
| `POST /projects/:id/open` | → `Project` (sets `lastOpenedAt` and `settings.lastProjectId`) |
| `GET /projects/:id/workflows` · `POST /projects/:id/workflows` | `{ name }` → `Workflow` |
| `GET /workflows/:id` | → `{ workflow: Workflow, nodes: Node[], edges: Edge[] }` |
| `PATCH /workflows/:id` · `DELETE /workflows/:id` | `{ name? }` → `Workflow` · 204 |
| `POST /workflows/:id/duplicate` | → `{ workflow, nodes, edges }` with fresh ids |
| `POST /workflows/:id/graph-ops` | `GraphOpsRequest` → `GraphOpsResponse` (409 / 400 as §2.6) |
| `POST /workflows/:id/validate` | → `{ issues: ValidationIssue[] }` |
| `GET /workflows/:id/export` | → `WorkflowExport` |
| `POST /projects/:id/workflows/import` | `WorkflowExport` → `{ workflow, nodes, edges }` (bad `formatVersion` → 400 `unsupported_format_version`) |

Lists are cursor-paginated: `?cursor=&limit=` → `{ items: T[], nextCursor?: string }` (default limit 50).

### 2.9 WebSocket — `ws://127.0.0.1:4747/ws?token=<token>` (`src/ws.ts`)
Frames are JSON `{ type, payload }`; server→client run/workflow frames also carry `seq`.
Client → server: `subscribe { scope: 'workflow', id }` · `subscribe { scope: 'engine' }` · `unsubscribe { scope, id? }` · `resume { afterSeq: number }`.
Server → client (Round 1): `hello { seq: number }` (current global seq on connect) · `workflow.updated { workflowId, version }`.
Events are persisted in `events` with a **global monotonic `seq`**; `resume { afterSeq }` replays every persisted event with `seq > afterSeq` for the client's subscriptions, in order, then continues live. Wrong/missing token → close code `4401`.

### 2.10 Auth handshake
Engine prints on start: `ACE engine ready · http://127.0.0.1:4747 · open http://localhost:5173/?token=<token>` (token = 32 random bytes, hex, new per start, also written to `<dataDir>/session-token` with mode 600 for the CLI later). Web reads `?token=`, stores it in `sessionStorage['ace.token']`, strips it from the URL, and sends it as `Authorization: Bearer` (REST) and `?token=` (WS).

---

## 3. Step 0 — Arhant's bootstrap + contract PR (before anyone branches)

Arhant, first working day, ≤ half a day, on branch `round-1/contracts`, PR reviewed by Mouli against §2 line by line, merged the same day:

1. Workspace root: `package.json` (root scripts from `CLAUDE.md` §2; `pnpm dev` uses `concurrently` to run `pnpm --filter @ace/server dev` and `pnpm --filter @ace/web dev`), `pnpm-workspace.yaml` (`apps/*`, `packages/*`, `tests/acceptance`), `tsconfig.base.json` (strict, ESM, `noUncheckedIndexedAccess`), `.npmrc` (`node-linker=hoisted`), `.gitattributes` (`* text=auto eol=lf`), `.gitignore` (node_modules, dist, `*.sqlite*`, `data/`, `.env*`, playwright-report, coverage), `.editorconfig`.
2. `packages/config`: shared `tsconfig.json`, `eslint.config.js` (with `no-restricted-imports` encoding CLAUDE.md §3.4 rule 3), `prettier.config.js`.
3. `packages/contracts`: everything in §2 with tests: enum literals, `derivePorts`, `isConnectionAllowed` (TC-CON-002 / TC-CON-006 shapes), `GraphOpsRequest` bounds, `WorkflowExport` round-trip. `src/index.ts` barrel exporting every module listed in §2 **plus** empty placeholder modules for later rounds (`providers.ts`, `models.ts`, `runs.ts`, `envelope.ts`, `events.ts`, `guardrails.ts`, `tools.ts`, `artifacts.ts`, `chat.ts`, `knowledge.ts`, `memory.ts`, `usage.ts`, `templates.ts`) so the barrel never changes again.
4. Empty-but-valid packages for every other Arhant path (`package.json`, `tsconfig.json`, `src/index.ts`) so `pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build` exit 0 on the skeleton. Do **not** create `apps/web`, `packages/ui`, `packages/sdk` — Mouli creates them.
5. `.github/workflows/ci.yml`: on PR → install → lint → typecheck → test → build → test:e2e → test:acceptance (the last two `continue-on-error: false` but skipped with a clear message while the suites are empty). `nightly-providers.yml`: scheduled, runs `pnpm test:providers`, skips cleanly without secrets.
6. `docs/DECISIONS.md` seeded with D1–D17 (recommended answers from Arch §39 / FRS §11; D1–D8 derived as: D1 TypeScript/Node engine + Hono + Vite SPA + Electron later; D2 free dragging + auto-layout; D3 loops only via loop edges; D4 pause = no new dispatch; D5 mid-run edits apply to next run; D6 files as artifact references; D7 custom nodes HTTP + sandboxed script; D8 self-improvement out of scope) and OI-01..06, OI-16 listed open; `docs/defect-log.md` with the FRS §8.5 severity scale and the table header.
7. Tag nothing yet. Tell Mouli the PR is up; she reviews §2 vs code, merges, pulls, and branches.

Mouli in the meantime (no repo dependency): design tokens and component inventory for `packages/ui` on paper, the MSW handler list from §2.8, and the Playwright test list from §7.1.

---

## 4. Arhant — Feature A1: Engine skeleton

**Branch** `round-1/arhant-engine-skeleton` · **Depends on** Step 0 merged
**Owns in this round** `apps/server/**`, `packages/engine/**`, `packages/storage-local/**`, `tests/acceptance/{vitest.config.ts,playwright.config.ts,helpers/**,fixtures/round-1/**}`, root scripts.
**FRs** FR-SYS-001, 002, 003, 004, 005, 006, 007, 010 · FR-PRJ-001, 002, 003, 004 · FR-WF-001, 003, 004, 005, 006, 007, 008 (WF-002 is UI) · FR-CON-002, 003, 005 (server-side enforcement) · FR-NODE-006, 007 (server-side) · FR-EXE-014 (event log + resume, workflow scope) · NFR-REL-02, NFR-SEC-01, NFR-SEC-02
**TCs** TC-SYS-001, 002, 003, 004, 005, 006, 007, 011, 012 · TC-PRJ-001, 002, 003, 004 · TC-WF-001, 003, 004, 005, 006, 007, 008 · TC-CON-002, 003, 005, 006 (API level) · TC-NODE-006 (API level) · TC-NFR-006
**Deferred to Round 2:** FR-SYS-008/009 (need runs), TC-SYS-008..010, TC-EXE-013.

### Prompt for Arhant — paste after the preamble (§6)

```text
FEATURE A1 — Engine skeleton (Round 1, owner Arhant). Read CLAUDE.md §3.1 for the exact paths I own; touch nothing else.
Read: docs/team-prompts/01-round-1-skeleton.md §2 (the contract — already implemented in packages/contracts, import from it, never redefine),
docs/ACE-FRS.md §3.1, §3.2, §3.3, §3.6 (CON-002/003/005), §3.5 (NODE-006/007), §5, §8.6 rows TC-SYS-001..007/011/012, TC-PRJ-*, TC-WF-*, TC-CON-002/003/005/006, TC-NODE-006, TC-NFR-006;
docs/ARCHITECTURE.md §7, §11 (Mode A), §12.2 graph service, §15.1–15.3, §20.1, §21.4, §22.1, §29, §30.

Build, in this order, TDD on a temp SQLite DB per test:

1. packages/engine/src/ports/: interfaces ONLY — Repository, BlobStore, SecretStore, Queue, PubSub, VectorIndex, KeywordIndex, Sandbox, Auth (Arch §7). Repository exposes typed methods per entity (projects, workflows, nodes, edges, events, settings) and `transaction(fn)`. Every method takes a `scope: { workspaceId: string }` parameter; local mode passes the constant 'local' (keeps hosted mode possible without engine changes).
2. packages/storage-local/: better-sqlite3 + Drizzle implementing Repository (tables now: projects, workflows, nodes, edges, events, settings — plus forward-only migration tooling; add the remaining Arch §15.3 tables in later rounds), InProcessQueue, InProcessPubSub, FsBlobStore (content-addressed folder; used from Round 4), KeychainSecretStore (OS keychain; typed error if unavailable; no secret may ever be written to a SQLite table — enforce and test). Writes are atomic: a batch of graph ops is one transaction (TC-NFR-006: kill mid-batch → graph is fully old or fully new). Back up the DB file before applying migrations (NFR-REL-03).
3. packages/engine/src/gateway/: Hono app factory `createEngineApp(deps)`. Bind 127.0.0.1 only (FR-SYS-001). Session token middleware on every route incl. /health (FR-SYS-002 → 401 `unauthorized`). Origin allow-list from settings.allowedOrigins + own origin (FR-SYS-003 → 403 `forbidden_origin`). Zod-validate every body/query with contracts; convert every thrown error to the FR-SYS-006 shape (TC-SYS-007: 400/401/404/409). Request id header `x-request-id`. GET /health per §2.8.
4. packages/engine/src/config/: precedence node → project → user(settings) → engine(ace.config.json + env ACE_PORT/ACE_DATA_DIR) → defaults, Zod-validated at startup; invalid config → refuse to start with a clear message (FR-SYS-010, TC-SYS-011/012).
5. packages/engine/src/logging/: pino JSON, child logger per subsystem, redaction of apiKey/authorization/token/secret/key headers and key-format patterns; daily rotation, 14-day retention (FR-SYS-007, FR-SYS-011 — rotation may be a simple size/date-based file rotator now).
6. packages/engine/src/graph/: graph service — projects (create with folder creation + writable check naming the bad path, list, get, rename, delete, open → lastProjectId) (FR-PRJ-001..004); workflows (create, list, get with nodes+edges, rename, duplicate with fresh ids, delete) (FR-WF-001/003); graph-ops applied in ONE transaction with `baseVersion` check → 409 `stale_version` (FR-WF-004/005); per-op validation using contracts `isConnectionAllowed` + `derivePorts` + execution ranges (FR-CON-002/005, FR-NODE-006/007); plain-edge cycle detection in `graph/cycles.ts` (DFS over data edges; a `kind:'loop'` edge → 501 `not_implemented` this round) (FR-CON-003); delete_node removes its edges; `validate` returning ValidationIssue[] with the codes in §2.5 (FR-WF-006); export without secrets (FR-WF-007) and import with formatVersion check (FR-WF-008).
7. packages/engine/src/events/: append-only event log through Repository with global monotonic seq; EventBus `emit(event)` / `subscribe(filter, fn)` on top of PubSub; WebSocket hub at /ws with token check (close 4401), subscribe/unsubscribe/resume per §2.9; on resume replay from the events table in order then go live. Emit `workflow.updated` after every successful graph-ops batch. Include the ~50 ms batching utility for future token streams (Arch §24) with a unit test, unused yet.
8. apps/server/: `ace-engine` entry — loads config, wires local adapters, generates the session token, starts Hono + WS on 127.0.0.1:4747, prints the URL line from §2.10, writes `<dataDir>/session-token` (mode 600), graceful SIGINT/SIGTERM shutdown (stop accepting, close WS, flush logs; run halting arrives in Round 2). `pnpm --filter @ace/server dev` runs it with tsx watch.
9. tests/acceptance/ harness (I own the config, Mouli writes her spec file later): `helpers/engine.ts` (start engine on a random free port with a temp data dir, returns { url, token, stop }), `vitest.config.ts` (globalSetup uses it, exposes ACE_URL/ACE_TOKEN), `playwright.config.ts` (webServer: engine helper + `pnpm --filter @ace/web preview` with VITE_ACE_URL, baseURL with ?token=), `fixtures/round-1/linear.json` (Input→Agent→Output WorkflowExport). Root script `pnpm test:acceptance` runs both configs.

Tests (name each by TC id): TC-SYS-001 (bind check: listening address is 127.0.0.1 only), 002, 003, 004, 005, 006, 007, 011, 012; TC-PRJ-001..004; TC-WF-001, 003, 004, 005 (two clients, stale baseVersion → 409), 006, 007, 008; TC-CON-002, 003, 005, 006 via graph-ops; TC-NODE-006 (temperature 5 → 400, nothing saved); TC-NFR-006 (throw inside the transaction after half the ops → version unchanged, no partial rows). Plus `describe("FR-EXE-014 resume replays workflow.updated")` and `describe("FR-SYS-007 no secrets in logs")` (log a redacted payload containing sk-ant-… and assert it is masked).

Done when: all listed TCs green; `pnpm typecheck && pnpm lint && pnpm test && pnpm build` green with no env vars; `pnpm dev:engine` prints the URL line and `curl -H "Authorization: Bearer <token>" http://127.0.0.1:4747/api/v1/health` returns db ok while a request from another LAN address is refused; coverage ≥ 80 % on engine, storage-local, contracts. Do NOT build providers, runs, scheduler, prompts, guardrails or any UI — Round 2+.
Finish with the Deliverable report (CLAUDE.md §8 step 6) and paste it into the PR body.
```

---

## 5. Mouli — Feature M1: Web shell + Canvas + SDK v1

**Branch** `round-1/mouli-web-canvas` · **Depends on** Step 0 merged (needs `@ace/contracts`)
**Owns in this round** `apps/web/**`, `packages/ui/**`, `packages/sdk/**`, `README.md`.
**FRs** FR-CAN-001, 002, 003, 004, 005, 006, 007, 010 · FR-NODE-001 (six kinds: input, agent, model, output, merge, transform), 002, 003 (all fields rendered; later-round fields disabled with the round they arrive in), 005 (chip shows "no model" until Round 2), 006, 007, 008 (inline errors), 010 (status ring separate from provider colour), 012 (Output node placeholder), 013 · FR-CON-001, 002, 003, 004, 005, 006 (UI side; tooltip "no data yet") · FR-WF-001, 002, 003, 004, 005 (UI side: tabs, autosave, 409 refetch-and-reapply) · FR-PRJ-001, 002, 004 (UI side) · NFR-PERF-01, 02, 05 · NFR-USE-01, 02
**TCs (Playwright vs MSW + component tests)** TC-CAN-001, 002, 003, 004, 005, 006, 009 · TC-NODE-001, 002, 005, 006 · TC-CON-001, 002, 003, 004, 005, 006 · TC-WF-001, 002, 003, 004, 005 · TC-PRJ-001, 003, 004 · TC-NFR-001 (200-node fixture ≈60 fps, measured)
**Deferred:** TC-CAN-007/008/010 (Round 5 productivity), TC-NODE-003/004/009/010 (Round 2, need providers/runs).

### Prompt for Mouli — paste after the preamble (§6)

```text
FEATURE M1 — Web shell, Canvas and SDK v1 (Round 1, owner Mouli). Read CLAUDE.md §3.2 for the exact paths I own; touch nothing else (never packages/contracts, packages/engine, apps/server).
Read: docs/team-prompts/01-round-1-skeleton.md §2 (the contract — import types from @ace/contracts),
docs/ACE-FRS.md §3.4 CAN, §3.5 NODE, §3.6 CON, §3.3 WF, §3.2 PRJ, §4 NFR-PERF-01/02/05 and NFR-USE-01/02, §8.6 rows TC-CAN, TC-NODE, TC-CON, TC-WF, TC-PRJ;
docs/ARCHITECTURE.md §10.1 (modules, state, design system), §20.1, §20.3, §21.4, §33.2–33.3 (site map, routes), §24 (Canvas performance).

Build, TDD, in this order. The engine is NOT available while I build: everything runs against MSW mocks (VITE_ACE_MOCK=1) that implement §2.8/§2.9 in memory, and switches to the real engine when VITE_ACE_MOCK is unset.

1. packages/ui: design tokens (Tailwind preset) — dark dotted-grid canvas background, provider accent colours (anthropic, google, openai, openai_compatible, ollama, mock), one status-ring colour per NodeState, serif font for human text, monospace for machine text, WCAG AA contrast checked; shadcn/ui base components re-exported; `NodeCardProps` and `PortHandleProps` types.
2. packages/sdk: `createAceClient({ baseUrl, token })` with one typed method per §2.8 endpoint (bodies/responses validated with @ace/contracts Zod schemas), `AceApiError` wrapping the FR-SYS-006 shape; `createAceSocket({ url, token })` implementing §2.9: subscribe/unsubscribe, `hello` handling, exponential-backoff reconnect that automatically sends `resume { afterSeq: lastSeq }`, typed `on(type, handler)`. Unit tests with a fake WebSocket: reconnect resumes from the last seq; no duplicate or missing frames.
3. apps/web shell: Vite + React + TypeScript + Tailwind + shadcn/ui; token handshake per §2.10; routes `/` → `/projects`, `/projects`, `/projects/:projectId`, `/projects/:projectId/workflows/:workflowId`, `/settings` (theme only for now); TanStack Query for all engine data, Zustand for selection/panels/viewport; a single AceSocket instance patching the Query cache on `workflow.updated` (refetch that workflow when version differs). Layout per Arch §33.1 step 5: top bar (project name, workflow tabs, placeholders for provider status and run controls), left palette, centre Canvas, right config panel, bottom panel with a Validation tab (Events/Errors/Timeline tabs render "available in Round 3/4"). react-resizable-panels for the three panes.
4. Projects screens: list, create (name + optional folder path; server error `invalid_path` shown inline naming the path), rename, delete with confirmation; reopen last project on launch via settings.lastProjectId (FR-PRJ-004).
5. Workflows: create, tabs (switching shows the correct graph, FR-WF-002), rename, duplicate, delete; every edit autosaves through `POST /workflows/:id/graph-ops` with optimistic UI, ops batched (≤ 100 ms debounce) with `baseVersion`; on 409 refetch, reapply pending ops on top, retry once, then surface a toast (FR-WF-004/005).
6. Canvas (React Flow): dotted dark grid (FR-CAN-001); add nodes by click or drag from the palette at the drop point (FR-CAN-002); select single / Shift / Ctrl / box (FR-CAN-003); drag to move, positions persisted (FR-CAN-004); delete selected nodes and their edges (FR-CAN-005); duplicate with copied config, new ids, offset (FR-CAN-006); pan/zoom mouse + trackpad, fit-to-view (F), minimap (FR-CAN-007); a loading state until nodes AND edges are loaded — never half-drawn (FR-CAN-010). Memoised node components, viewport-only rendering; ship a `?fixture=200` dev route that loads a generated 200-node/400-edge graph and a Playwright test that measures frame time while panning (NFR-PERF-01).
7. Node cards: kinds input, agent, model, output, merge, transform (FR-NODE-001); name, kind icon, provider accent border (constant), separate status ring (IDLE in this round), model chip ("no model" until Round 2) (FR-NODE-005/010); typed port handles derived with contracts `derivePorts` (FR-NODE-006); Output node shows "final result appears here after a run" (FR-NODE-012).
8. Config panel (right pane) opened on selection (FR-NODE-002) with every AgentConfig field from §2.4: name, provider + model pickers (empty lists with "add a provider in Round 2" until then), routing policy (fixed/fallback), instructions, input/output types (multi-select of DataType), output contract JSON schema editor (Monaco), execution settings with range validation and inline errors that block save (FR-NODE-007/008), context budget; tools/skills/memory/guardrail policy/knowledge bases rendered disabled with "available in Round 4/6+/5/3/5". Model node, Merge node (mode all/any), Transform node (op + fields, FR-NODE-013) and Input node (text + output types) panels too.
9. Connections: drag output→input creates an edge through graph-ops (FR-CON-001); before creating, run contracts `isConnectionAllowed` and show the reason on refusal (FR-CON-002/005); a plain edge that closes a cycle is refused client-side (DFS on current edges) AND the server 400 is surfaced with its message (FR-CON-003); delete edge by key or context menu (FR-CON-004); edge label shows its dataType; hover tooltip "no data yet" (FR-CON-006).
10. MSW mocks in apps/web/src/mocks: in-memory implementation of every §2.8 endpoint incl. 409 on stale version and 400 on invalid ops, plus a FakeSocket emitting `hello` and `workflow.updated`. Playwright (apps/web/e2e) runs against the mocks.
11. README.md: clone → pnpm install → pnpm dev → open URL; note that Round 1 has no model calls.

Tests (name by TC id): component tests for the config panel (TC-NODE-001/002/006) and node cards (TC-NODE-005); Playwright: TC-CAN-001, 002, 003, 004, 005, 006, 009 (throttle network, assert no half-drawn state), TC-CON-001..006, TC-WF-001..005 (005: two pages, older baseVersion → the page shows refreshed state), TC-PRJ-001, 003 (unwritable path error from the mock), 004; TC-NFR-001 measurement. Keyboard-only path: add, select, connect, delete (NFR-USE-02).

Done when: all listed tests green; `pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e` green with no env vars; the demo script in §1 works against the mocks; coverage ≥ 60 % on apps/web, packages/ui, packages/sdk. Do NOT build providers UI, run UI, chat, undo/redo, auto-layout, context menus or shortcuts beyond Delete/F — Rounds 2–5.
Finish with the Deliverable report (CLAUDE.md §8 step 6) and paste it into the PR body.
```

---

## 6. Session preamble (both — paste first, then your feature prompt)

```text
Read CLAUDE.md and docs/DECISIONS.md fully. We are building ACE as a two-person team; I am <Arhant|Mouli>. The only sources of truth are docs/ACE-PRD.md, docs/ACE-FRS.md, docs/ARCHITECTURE.md; read only the sections the feature prompt names, by offset/limit. Rules for this session: (1) plan mode first — present an FR/TC coverage table (FR id · TC ids · implementation file · test file) and wait for my approval; (2) work ONLY inside the paths CLAUDE.md §3 assigns to me; (3) TDD, tests named by TC id, mock provider only, `pnpm test` must pass with zero env vars; (4) never build anything from a later round; (5) if the docs conflict or are silent, stop and post a DECISION NEEDED block (CLAUDE.md §7), never guess; (6) exact enum strings from packages/contracts, never literals; (7) small Conventional Commits on my branch, never to main, never force-push; (8) finish with the Deliverable report. My feature prompt follows.
```

---

## 7. Merge procedure — Round 1

1. Arhant's A1 PR and Mouli's M1 PR are both opened against `main`. Each **reviews the other's** PR per `CLAUDE.md` §6.1 within one working day.
2. Merge order: whichever is approved first merges first ("Rebase and merge"). The second person rebases (`git fetch origin && git rebase origin/main`), re-runs `pnpm typecheck && pnpm lint && pnpm test`, pushes with `--force-with-lease`, merges.
3. Right after both are on `main`: both pull, run `pnpm install && pnpm dev`, and walk the §1 demo script together against the **real engine**. Anything broken at the seam (UI ↔ API) is a defect against the side whose behaviour deviates from §2.
4. Then cross-testing (§8). Nobody starts Round 2.

---

## 8. Cross-testing — Round 1

Both files run with `pnpm test:acceptance` (real engine on a temp DB + real web preview). They stay in CI permanently.

### 8.1 Arhant tests Mouli's feature (M1)
**File:** `tests/acceptance/round-1/arhant-tests-mouli.e2e.ts` (Playwright; Arhant writes it; fresh Claude session using the verification prompt in §8.3).
**Must cover:**

| TC / check | Scenario against the real engine |
|---|---|
| TC-CAN-003 | Move a node, reload the page → same position from the server |
| TC-WF-004 | Add a node, reload → still present (autosave went through graph-ops) |
| TC-WF-005 | Two browser contexts edit the same workflow; the stale one gets 409 and ends up showing the latest graph, no lost node |
| TC-CON-002 | Connect text output → image-only input → refused, reason visible |
| TC-CON-003 | A→B then B→A as a plain edge → refused, reason visible |
| TC-CON-006 | Second edge into a `multi:false` port → refused |
| TC-NODE-002 | Fill every Agent config field, reload → every value persisted (compare with `GET /workflows/:id`) |
| TC-NODE-006 | Temperature 5 → inline error, nothing sent to the engine (assert version unchanged) |
| TC-CAN-009 | Throttle to Slow 3G → loading state, then the whole graph at once |
| TC-CAN-004/005 | Delete a connected node → no dangling edges on the server; duplicate → independent copy |
| TC-PRJ-004 | Open project B, close tab, open app → project B |
| FR-WF-007/008 | Export from the UI → import into another workflow → identical node/edge count and configs |
| NFR-USE-02 | Keyboard-only: add a node, connect, delete |

**Manual pass (15 min, recorded in REPORT.md):** ten minutes of abuse — 200-node fixture pan/zoom, rapid drag while offline (kill the engine mid-drag, restart, verify recovery), paste 3,000 characters into instructions, resize panes to minimum, browser zoom 50 % and 200 %.

### 8.2 Mouli tests Arhant's feature (A1)
**File:** `tests/acceptance/round-1/mouli-tests-arhant.test.ts` (Vitest, calls the real engine through `@ace/sdk`; Mouli writes it).
**Must cover:**

| TC / check | Scenario |
|---|---|
| TC-SYS-002 | No token → 401 in the FR-SYS-006 shape; wrong token → 401 |
| TC-SYS-003 | `Origin: https://evil.example` → 403 `forbidden_origin` |
| TC-SYS-004/005 | `GET /health` → `{ status:'ok', version, db:'ok' }` |
| TC-SYS-007 | Trigger 400 (bad body), 401, 404 (unknown workflow), 409 (stale version) → all match `ApiError` |
| TC-WF-005 | Two clients, second sends stale `baseVersion` → 409 with `details.currentVersion` |
| TC-WF-006 | Agent with unconnected required input + no Output node → issues with severity, code, message, nodeId |
| TC-WF-007 | Export contains no `apiKey`/`token`/`secret` keys anywhere (deep scan) and validates against `WorkflowExport` |
| TC-WF-008 | Import with `formatVersion: 99` → 400 `unsupported_format_version`, no workflow created |
| TC-CON-003 | graph-ops adding a plain edge that closes a cycle → 400, version unchanged |
| TC-CON-005/006 | Fan-out to three inputs OK; second edge into single-input port → 400 |
| TC-NODE-006 | `execution.temperature: 5` via graph-ops → 400, nothing saved |
| TC-NFR-006 | Batch of 20 ops where op 15 is invalid → 400, `GET /workflows/:id` shows none of the 20 applied, version unchanged |
| FR-EXE-014 | Subscribe, disconnect, make 10 edits, reconnect with `resume { afterSeq }` → exactly 10 `workflow.updated` frames in order |
| FR-PRJ-003 | Create project with a read-only folder → 400 `invalid_path` naming the path |
| FR-SYS-007 | After the above, grep the engine log folder for the token → not found |

**Manual pass (15 min, recorded in REPORT.md):** clean clone → `pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build` (no env vars); start the engine, `curl` from another device on the LAN → refused; kill `-9` the engine during a burst of 200 graph-ops → restart → DB opens, graph consistent.

### 8.3 Verification session prompt (both use it)
```text
You are verifying a feature the OTHER developer built and merged; you did not write it and you will not fix it. Feature under verification: <A1 | M1> (docs/team-prompts/01-round-1-skeleton.md §4 or §5). Read its FR and TC lists and the FRS acceptance criteria as written — judge against the FRS text, not against the tests that shipped. Then: (1) write the cross-test file named in §8 with every listed scenario, run `pnpm test:acceptance`, paste the real output; (2) for each shipped TC test, check it exists, is named by TC id and would fail if the behaviour broke — report any that would not; (3) list files the feature changed outside its owner's paths; (4) look for silent narrowing (weaker than the acceptance criteria, TODO, skipped tests, happy-path only); (5) grep for enum drift and dependency-rule violations (CLAUDE.md §6.1 step 4, §3.4 rule 3). Output a VERIFICATION REPORT: verdict VERIFIED / NOT VERIFIED; FR-by-FR table (met? evidence); TC-by-TC table; findings as rows ready for docs/defect-log.md (severity per FRS §8.5, FR/TC violated, repro steps). Do not modify product code, tests you did not write, or any doc.
```

### 8.4 `tests/acceptance/round-1/REPORT.md` template (created by whoever merges second)
```markdown
# Round 1 verification report
## Arhant → Mouli (M1)
Verdict: VERIFIED | NOT VERIFIED · Date · Commit tested
Automated: <paste pnpm test:acceptance summary for arhant-tests-mouli.e2e.ts>
Manual pass: <what was tried, what happened>
Findings: <defect-log ids or "none">
## Mouli → Arhant (A1)
Verdict: … (same structure)
```

---

## 9. Round exit gate (both tick every line before tagging)

- [ ] C1 merged and matches §2 line by line; A1 and M1 merged; `main` green in CI (`ci.yml`).
- [ ] `pnpm test:acceptance` green on `main` with both Round 1 files present.
- [ ] REPORT.md has both sections; every finding is in `docs/defect-log.md`; no open critical/high.
- [ ] Demo script (§1) walked by both against the real engine.
- [ ] Coverage: engine-side ≥ 80 %, web-side ≥ 60 %.
- [ ] `docs/DECISIONS.md` has every decision made this round (D18+).
- [ ] `CLAUDE.md` §9: C1, A1, M1 rows updated to `VERIFIED` with SHA, date, verifier; §9.1 Round 1 row filled.
- [ ] `git tag round-1 && git push origin round-1`.

---

## 10. Hand-off to Round 2

What Round 2 assumes exists: the contract barrel with placeholder modules (Step 0.3); `Repository` with `scope`; `EventBus` + WS hub with `resume`; graph-ops + validate; the SDK client and socket; the Canvas with node cards, ports and config panel whose provider/model pickers are empty. Round 2 adds providers, the model catalog, the router and the run engine on the engine side, and the providers screen + live run UI on the web side. Open `02-round-2-providers-execution.md`.
