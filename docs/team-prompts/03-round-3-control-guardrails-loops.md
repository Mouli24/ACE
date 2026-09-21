# Round 3 — Control, Errors, Guardrails, Parallel & Loops: engine (Arhant) + control/safety UI (Mouli)

**Previous:** `02-round-2-providers-execution.md` — tagged `round-2`, A2 and M2 `VERIFIED`. **Next:** `04-round-4-multimodal-chat-tools.md`.
**FRS phases covered:** 6 (CTL, ERR, GRD input/output/cost/loop/approvals), 7 (PAR + FR-CON-007 loop edges), FR-EXE-013.

---

## 0. Read first (both)
- `docs/ACE-FRS.md` §3.10 CTL · §3.11 ERR · §3.24 GRD (001–003, 007–015, 018; 004 is Round 5, 005/006 Round 4, 016/017 backlog) · §3.12 PAR · §3.6 CON-007 · §3.9 EXE-013 · §5 BR-03/05/12/14/15 · §8.6 rows TC-CTL, TC-ERR, TC-GRD-001..004, 008..019, TC-PAR, TC-CON-007, TC-EXE-012, TC-NFR-013.
- `docs/ARCHITECTURE.md` §12.3 (loop edge handling, failure/retry/WAITING branches) · §13.1–13.4 guardrails · §19.1–19.2 (PAUSED, WAITING, STOPPED, FAILED transitions) · §21.2 approval flow · §28 error kinds · ADR-011, ADR-012, ADR-013 · D9, D10.
- `docs/ACE-PRD.md` US-011, 012, 013, 014, 015, 017, 018, 019.

## 1. Round goal
The operator can pause, resume, stop and restart a run, retry a failed node (or everything after it), re-run one node, and start from a chosen node. Errors are classified and shown with a Retry button; network/rate-limit errors retry automatically with backoff, auth errors do not; downstream nodes of a failure show BLOCKED, stopped nodes are not failures. Guardrail policies exist (project default per D10, agent override), check inputs and outputs, enforce budgets and loop limits, and can pass / warn / redact / ask the user / block — a block is `GUARDRAIL_VIOLATION`, an ask puts the node in WAITING with an approval card that also works at phone width. Independent branches run concurrently into a Merge node; Review→Fix loops run through loop edges with a max, an exit condition and per-iteration records.

**Demo script (gate):** Review→Fix fixture (Writer `mock-text` → Reviewer `mock-reject-twice` with review contract → loop edge back to Writer, max 3, exit `verdict == "approved"`) → Start → three iterations visible, loop ends on approval → parallel fixture (Input → 2 agents → Merge(all) → Writer) → both branches overlap, merge output ordered → set Writer to `mock-slow` → Start → Pause (Reviewer never starts) → Resume → Stop mid-stream (stream closes ≤ 2 s, run HALTED `stopped`) → Restart → new run → set Reviewer to `mock-429-then-ok` → completes on attempt 3 automatically → set to `mock-401` → fails once, Retry button → policy with output PII `ask_user` + Writer instructed to output an email → node WAITING → approval card → Reject → GUARDRAIL_VIOLATION → run cap $0.01 with `mock-slow` → HALTED `budget_exceeded`.

---

## 2. Shared contract — Round 3 (Arhant, Step 0)

### 2.1 Controls and retries (`src/runs.ts` additions)
```ts
StartRunRequest.startFromNodeId?: Id      // now honoured: upstream node runs of the latest run are reused, not re-called (FR-EXE-013)
RetryRequest   = { withDownstream: boolean }                                    // POST /node-runs/:id/retry
RerunRequest   = {}                                                             // POST /runs/:id/nodes/:nodeId/rerun → executes only that node with latest upstream outputs
NodeRun additions: guardrailPolicy?: { id: Id, version: number }, verdicts: Verdict[], approvals: ApprovalDecision[]
Run additions:     pausedAt?: Timestamp, restartedFromRunId?: Id
```
Retry policy (FR-ERR-005, Arch §28): `network` and `provider` (incl. 429) → automatic retry with exponential backoff `500 ms · 2^attempt` capped at 8 s, up to `execution.retries`; `auth`, `invalid_config`, `workflow`, `guardrail`, `user_cancelled` → never; `agent` → one automatic "contract repair" retry appending the validation reason to the prompt, then `CONTRACT_VIOLATION`. Each automatic retry is a new node run with `attempt + 1`.

### 2.2 Guardrails (`src/guardrails.ts`)
```ts
GuardrailCheckType = 'size_limit' | 'pii' | 'prompt_injection' | 'blocked_topics'                       // input
                   | 'contract' | 'moderation' | 'secret_leak' | 'required_citations'                    // output (pii also valid at output)
                   | 'max_tokens_per_node' | 'max_cost_per_run' | 'daily_budget'                         // cost
                   | 'max_iterations' | 'max_tool_calls' | 'repeated_output'                             // loop
                   | 'untrusted_tagging'                                                                 // context (Round 5)
                   | 'tool_allowed' | 'path_confinement' | 'domain_allowlist' | 'destructive_action'     // tool (Round 4)
GuardrailCheck  = { id: Id, point: GuardrailPoint, type: GuardrailCheckType, action: GuardrailAction, enabled: boolean,
                    params: Record<string, unknown> }   // e.g. size_limit { maxChars }, blocked_topics { patterns: string[] }, max_cost_per_run { usd }, repeated_output { times: 3 }
GuardrailPolicy = { id, projectId, name: string(1..80), version: number(int ≥ 1), isProjectDefault: boolean, checks: GuardrailCheck[], createdAt, updatedAt }
Verdict = { id: Id, nodeRunId: Id, point: GuardrailPoint, checkType: GuardrailCheckType, action: GuardrailAction,
            passed: boolean, reason: string, redactedTypes?: string[] /* e.g. ['email'] — never the value */, at: Timestamp }
ApprovalRequest  = { id: Id, runId, nodeRunId, nodeId, nodeName, point: GuardrailPoint, checkType, reason: string, preview: string(≤ 500), requestedAt }
ApprovalDecision = { requestId: Id, decision: 'approve' | 'reject', note?: string, decidedAt: Timestamp }
PolicyTestRequest = { text: string, point: 'input' | 'output' }  →  PolicyTestResponse = { verdicts: Omit<Verdict,'id'|'nodeRunId'>[] }
```
Data guardrails (`data` point) have **no policy representation** — always on (BR-15): secret redaction of stored prompts/outputs/logs, file confinement (Round 4).
Default policy created with every project (D10, FR-GRD-018) — name "Default", version 1: input `pii warn`, `prompt_injection warn`, `size_limit warn { maxChars: 200000 }`; output `secret_leak block`, `moderation warn`, `contract block`; cost `max_cost_per_run warn` (param from project), `daily_budget block`; loop `max_iterations block { max: 50 }`, `max_tool_calls block { max: 25 }`, `repeated_output block { times: 3 }`; tool `destructive_action ask_user`, `tool_allowed block`, `path_confinement block`, `domain_allowlist block` (tool checks are evaluated from Round 4).

### 2.3 Budgets
`Settings.dailyBudgetUsd?: number` · `Project.maxCostPerRunUsd?: number` (PATCH /projects/:id) · per-node token cap = `AgentConfig.execution.maxTokens` (already). Cost point: before dispatching a node, projected cost (`totals.costUsd + maxTokens × price`) > cap → HALTED `budget_exceeded`; after each node, actual `totals.costUsd` > cap → HALTED `budget_exceeded`; daily budget exceeded → pre-flight issue `daily_budget_exceeded` (BLOCKED) or mid-run HALTED.

### 2.4 Parallel and loops
`merge` config `{ mode: 'all' | 'any' }` — output is `json`: `{ inputs: [{ port, nodeId, parts }] }` ordered by input port order; in `any` mode the remaining branches still complete and are recorded but do not feed the merge.
`LoopConfig` (declared in Round 1) now accepted; validation: loop edge must have `loop`, `maxIterations` 1..50 (0/51 → 400 `validation_failed`), `exitCondition.path` must be a dotted path into the source node's `json` output; a loop edge's target must be upstream of its source.
`ReviewContract` (FR-PAR-007) = `{ score: number(0..10), verdict: 'approved' | 'changes_requested', issues: string[] }` — exported JSON schema `REVIEW_CONTRACT_SCHEMA` for use as an agent `outputContract`.
Loop stop reasons (recorded on the last iteration's node run `loopStop?: 'exit_condition' | 'max_iterations' | 'repeated_output'`).

### 2.5 REST endpoints — Round 3 additions
| Method + path | → |
|---|---|
| `POST /runs/:id/pause` · `/resume` · `/stop` · `/restart` | → `Run` (restart returns the **new** run with `restartedFromRunId`); invalid for the current state → 409 `invalid_run_state` |
| `POST /node-runs/:id/retry` | `RetryRequest` → `NodeRun` (new attempt) |
| `POST /runs/:id/nodes/:nodeId/rerun` | → `NodeRun` |
| `POST /node-runs/:id/approve` · `/reject` | `{ note? }` → `NodeRun` |
| `GET /runs/:id/approvals` | → `ApprovalRequest[]` (pending) |
| `GET /guardrail-policies?projectId` · `POST /guardrail-policies` | → `GuardrailPolicy` |
| `GET /guardrail-policies/:id` · `PATCH /guardrail-policies/:id` (creates version+1) · `DELETE` (409 `policy_in_use` unless `confirm=true`) | |
| `POST /guardrail-policies/:id/test` | `PolicyTestRequest` → `PolicyTestResponse` |
| `POST /guardrail-policies/:id/set-default` | → `GuardrailPolicy` |

### 2.6 Events — Round 3 additions (all persisted with seq)
`run.paused { runId }` · `run.resumed { runId }` · `node.approval_required { runId, request: ApprovalRequest }` · `node.approval_decided { runId, nodeRunId, decision: ApprovalDecision }` · `guardrail.verdict { runId, nodeRunId, verdict: Verdict }` · `loop.iteration { runId, edgeId, targetNodeId, iteration, stop?: LoopStopReason }` · `run.completed.haltReason` now also `'stopped' | 'budget_exceeded'`.

---

## 3. Step 0 — Arhant's contract PR (`round-3/contracts`)
Fill `guardrails.ts`; extend `runs.ts`, `events.ts`, `graph.ts` (merge/loop validation helpers `validateLoopConfig`, `REVIEW_CONTRACT_SCHEMA`) per §2. Tests: a `Verdict` cannot carry a `value` field (FR-GRD-014 — schema is `strict`); `LoopConfig` rejects 0 and 51; every new event type parses. Mouli reviews and merges same day; she updates MSW/FakeSocket scenarios (paused, waiting-approval, budget-halt, loop-3-iterations, merge-any).

---

## 4. Arhant — Feature A3: Controls, errors, guardrail engine, parallel & loops

**Branch** `round-3/arhant-control-guardrails-loops` · **Depends on** C3 merged
**Owns** `packages/engine/src/{runs/control,errors,retry,guardrails,scheduler,budgets,approvals}/**`, `packages/guardrails/**`, `packages/storage-local` (tables guardrail_policies, guardrail_verdicts, approvals; default-policy migration), `tests/acceptance/fixtures/round-3/**`.
**FRs** FR-CTL-001..006 (006 = the engine exposes `allowedActions` on `Run` so the UI cannot guess — add `allowedActions: ('pause'|'resume'|'stop'|'restart')[]` to `Run` in C3) · FR-EXE-013 · FR-ERR-001, 003, 004, 005, 006, 007, 008 · FR-GRD-001, 002, 003, 007, 008, 009, 010, 011, 012, 013, 014, 015, 018 · FR-PAR-001..007 · FR-CON-003 (loop edges now the legal cycle), 007 · NFR-SAFE-01
**TCs** TC-CTL-001..005 · TC-EXE-012 · TC-ERR-001, 003, 004, 005, 006, 007, 008, 009 · TC-GRD-001, 002, 003, 004, 008 (ask_user on an output PII check; the destructive-tool variant is re-run in Round 4), 009, 010, 011, 012, 013, 014 (limit exists; enforced end-to-end in Round 4), 015, 016, 017, 018, 019 · TC-PAR-001..008 · TC-CON-007 · TC-NFR-013

### Prompt for Arhant — paste after the preamble (Round 1 file §6)
```text
FEATURE A3 — Run controls, error model, guardrail engine, parallel branches and loop edges (Round 3, owner Arhant). Paths: CLAUDE.md §3.1 only.
Read: docs/team-prompts/03-round-3-control-guardrails-loops.md §2 (contract, in packages/contracts);
docs/ACE-FRS.md §3.10, §3.11, §3.24 (001–003, 007–015, 018), §3.12, §3.6 (CON-007), §3.9 (EXE-013), §4 NFR-SAFE-01, §5, §8.6 rows listed in §4 "TCs";
docs/ARCHITECTURE.md §12.3, §13.1–13.4, §19.1–19.2, §21.2, §28; ADR-011/012/013; docs/DECISIONS.md D9, D10.

Build, TDD on the mock provider:

1. Controls (packages/engine/src/runs/control): pause = scheduler stops dispatching, RUNNING nodes finish, READY→PAUSED, run PAUSED (FR-CTL-001); resume = PAUSED→READY, dispatch continues (FR-CTL-002); stop = abort every in-flight generate() via AbortSignal, RUNNING→STOPPED, READY/PAUSED→STOPPED, run HALTED `stopped`, provider streams closed within 2 s — measure (FR-CTL-003); restart = new run with the same snapshot and inputs, `restartedFromRunId` (FR-CTL-004); rerun node = execute only that node with the latest upstream outputs, new node run (FR-CTL-005); startFromNodeId = reuse the latest run's upstream node runs, do not re-call them (FR-EXE-013); `allowedActions` derived from run state (FR-CTL-006). Invalid action → 409 `invalid_run_state`.
2. Error model (packages/engine/src/errors): classify every failure into the eight ErrorKinds (Arch §28) with one test per kind driven by mock models (`mock-401` auth, `mock-503` provider, `mock-timeout` network, `mock-refuse` agent, stop → user_cancelled, missing model → invalid_config, upstream failed → workflow, block → guardrail) (FR-ERR-001). Manual retry = new node run attempt+1 with identical inputs (FR-ERR-003); retry with downstream re-executes everything reachable after it (FR-ERR-004); automatic retry policy per §2.1 (FR-ERR-005: `mock-429-then-ok` completes on attempt 3; `mock-401` exactly one attempt); downstream of a failure BLOCKED, never FAILED (FR-ERR-006); STOPPED excluded from failure counts (FR-ERR-007); fix config then rerun succeeds (FR-ERR-008).
3. packages/guardrails: pure check implementations — size_limit; pii (email, phone, IBAN/credit-card-like, national-id-like regex packs, returns types only); prompt_injection rule pack (patterns like "ignore previous instructions", "disregard the system prompt", "you are now", "print your system prompt", zero-width/hidden-marker sequences); blocked_topics (user patterns); moderation rule pack (category word lists → warn); secret_leak key-format patterns (sk-, sk-ant-, AIza, ghp_, AKIA, -----BEGIN PRIVATE KEY-----, generic 32+ hex/base64 tokens with a key-like prefix); required_citations (output must contain `[source:` markers or a `sources` array); contract (delegates to validateAgainstContract). Every check returns `{ passed, reason, redactedTypes?, sanitized? }` and the engine applies the configured action. Rule packs must add < 300 ms per node measured over 100 nodes (NFR-SAFE-01, TC-NFR-013).
4. packages/engine/src/guardrails: policy service (CRUD, PATCH creates version+1, set-default, delete guard, test endpoint) (FR-GRD-001); resolution project default → agent override, policy id+version recorded on the node run (FR-GRD-002); evaluation at points input (Input node content and every envelope's reads before assembly), output (after generation, before contract validation — order: secret_leak → pii → moderation → required_citations → contract), cost (§2.3), loop (§2.4); actions: pass → continue; warn → continue + `guardrail.verdict`; redact → replace the span with `[<type> redacted]`, verdict records the type only, sanitized text flows on (FR-GRD-014); ask_user → node WAITING, `node.approval_required` with an ApprovalRequest (preview ≤ 500 chars), release the provider concurrency slot, approve → continue from where it paused, reject → FAILED `GUARDRAIL_VIOLATION`, decision stored + `node.approval_decided` (FR-GRD-013); block → FAILED `GUARDRAIL_VIOLATION`, distinct from CONTRACT_VIOLATION (FR-GRD-012, D9). Every verdict stored on the node run and emitted (FR-GRD-015). Data guardrails always on and with no off switch anywhere in the API (FR-GRD-010; test that no policy field can disable secret redaction). Migration: every existing and new project gets the §2.2 default policy (FR-GRD-018).
5. Budgets (packages/engine/src/budgets): per §2.3; exceeding → HALTED `budget_exceeded` with the reason on the run (FR-GRD-008). Daily usage aggregate from node_runs.
6. Parallel + merge (scheduler): independent branches dispatch concurrently (already) — prove two 2-second `mock-slow` branches finish in ≈2 s (FR-PAR-001); merge node executes with `all` (waits for every connected input) or `any` (first arrival; later arrivals recorded, not fed), output ordered by input port (FR-PAR-002); remove `not_supported_yet` for merge.
7. Loop edges: accept `kind:'loop'` in graph-ops with §2.4 validation (FR-CON-007; 0/51 refused); scheduler: on source completion, evaluate exitCondition on the source's json output (dotted path equals value) → if unmet and iteration < min(maxIterations, policy max_iterations) → deliver envelope to the target with iteration+1 (new node runs for the whole loop body, each recorded, `loop.iteration` event) else stop with the reason; onMax `continue` passes the last output downstream, `fail` → FAILED `RUN_FAILED` with a clear message (FR-PAR-003..006); repeated_output (hash of output identical `times` in a row on the same node) stops the loop with reason `repeated_output` and applies the onMax behaviour (FR-GRD-009); REVIEW_CONTRACT_SCHEMA usable as outputContract, missing verdict → CONTRACT_VIOLATION (FR-PAR-007). max_tool_calls is enforced by the tool loop in Round 4 — implement the counter check now with a unit test.
8. Fixtures tests/acceptance/fixtures/round-3/: `review-fix.json` (Writer mock-text → Reviewer mock-reject-twice with REVIEW_CONTRACT_SCHEMA → loop edge back, max 3, exit verdict==approved, onMax continue), `review-never.json` (same graph but the Reviewer uses a new mock model `mock-reject-always`, which always returns `{ score: 4, verdict: "changes_requested", issues: ["needs work"] }` — add it to the mock provider in this round, extend the Round 2 §2.6 table and record the addition in DECISIONS.md), `parallel-merge-all.json`, `parallel-merge-any.json`, `retry-429.json`, `auth-401.json`, `pii-ask.json` (policy with output pii ask_user; Writer instructed to include an email), `leak.json` (mock-leak + default policy), `budget-cap.json` (mock-slow, project cap 0.01).

Tests by TC id: TC-CTL-001..005 (003 with the measured stop latency), TC-EXE-012, TC-ERR-001 (eight cases), 003..009, TC-GRD-001..004, 008 (approve on pii-ask → continues, decision logged with time), 009 (reject → GUARDRAIL_VIOLATION), 010 (leak blocked/redacted per policy), 011, 012, 013 (mock-repeat in a loop → stops at 3), 014 (unit-level counter), 015, 016 (all five actions on fixture inputs), 017, 018, 019, TC-PAR-001..008, TC-CON-007, TC-NFR-013 (print the ms/node figure).

Done when: all green; `pnpm typecheck && pnpm lint && pnpm test && pnpm build` green with zero env vars; coverage ≥ 80 % on engine + guardrails; §1 demo script works through the API; Stop latency and guardrail overhead numbers in the report. Do NOT build tool guardrails, the Guardrail node, context guardrails, artifacts, chat or UI — Rounds 4–5 / backlog.
Deliverable report per CLAUDE.md §8 step 6.
```

---

## 5. Mouli — Feature M3: Controls, errors, approvals, policies, loops & merge UI

**Branch** `round-3/mouli-control-guardrails-ui` · **Depends on** C3 merged
**Owns** `apps/web/src/{runs/controls,errors,approvals,guardrails,edges/loop,nodes/merge,inspector (verdicts, iterations),bottom-panel (Events, Errors),settings (budgets)}/**`, `packages/sdk` (Round 3 endpoints/events), `packages/ui` (approval card, verdict badge, loop edge style).
**FRs** FR-CTL-006 (buttons from `allowedActions`) · FR-ERR-002, 006 (BLOCKED visual), 007 (STOPPED visual ≠ FAILED) · FR-GRD-001 (policy screens), 002 (agent override picker), 011 (action selector per check), 013 (approval card), 014 (redaction shown as type), 015 (verdict list), 018 (default policy visible) · FR-CON-007 (loop edge UI) · FR-PAR-002 (merge mode + slots), 005 (iteration selector) · FR-GRD-008 (budget fields + HALTED reason display) · FR-MOB-002 (approval card usable at 380 px — full responsive views are Round 5) · NFR-USE-03 (every error says what happened and what to do next)
**TCs (Playwright vs scenarios + component)** TC-CTL-006 · TC-ERR-002, 007 (BLOCKED shown), 008 (cancel ≠ failure) · TC-GRD-001 (policy lifecycle UI), 002 (override), 008/009 (approval card approve/reject), 016 (all five actions configurable), 018 (redaction type only), 019 (verdict list) · TC-PAR-006 (iteration selector) · TC-CON-007 (0 and 51 refused inline) · TC-MOB-002

### Prompt for Mouli — paste after the preamble (Round 1 file §6)
```text
FEATURE M3 — Run controls, error cards, approvals, guardrail policy screens, loop/merge UI (Round 3, owner Mouli). Paths: CLAUDE.md §3.2 only.
Read: docs/team-prompts/03-round-3-control-guardrails-loops.md §2 (contract; import from @ace/contracts);
docs/ACE-FRS.md §3.10 (CTL-006), §3.11 (ERR-002/006/007), §3.24 (GRD-001/002/008/011/013/014/015/018), §3.12 (PAR-002/005), §3.6 (CON-007), §3.29 (MOB-002), §4 NFR-USE-03, §8.6 rows listed in §5 "TCs";
docs/ARCHITECTURE.md §10.1, §13.3–13.4, §19.1–19.2, §21.2, §33.2 (Guardrail policies screen, Approvals).

Build against MSW + FakeSocket scenarios (paused, stopped, waiting-approval, budget-halt, loop-3-iterations, merge-any, retry-429, blocked-downstream); switch to the real engine after A3 merges.

1. packages/sdk: methods for every §2.5 endpoint; socket handlers for §2.6 events; RunView gains pausedAt, pending approvals, verdicts per node run, iterations per node, allowedActions.
2. Run controls toolbar (top bar slot from Round 2): Pause / Resume / Stop / Restart enabled strictly from `run.allowedActions` (FR-CTL-006, TC-CTL-006); Stop asks for confirmation; Restart opens the new run. Node context menu + inspector buttons: Retry, Retry with downstream, Re-run this node, Start from this node (calls `POST /workflows/:id/runs` with startFromNodeId).
3. Error cards (bottom "Errors" tab and on the failed node): failed node, kind, message, provider, state, Retry button, plus a "what to do next" line per kind — auth → "update the provider key in Providers", provider → "retry or add a fallback model", invalid_config → "open the node settings", guardrail → "see verdicts / adjust the policy", network → "check the endpoint" (FR-ERR-002, NFR-USE-03). BLOCKED nodes render greyed with a lock icon and "blocked by <node>" (FR-ERR-006); STOPPED nodes render neutral, never red, and the run summary counts them separately from failures (FR-ERR-007, TC-ERR-008). HALTED runs show the haltReason in plain words ("stopped by you", "budget exceeded: $0.012 > $0.01 cap", "a node failed", "engine shut down", "engine crashed").
4. Approval card: on `node.approval_required` show a card anchored to the node on the Canvas AND in the run view: node name, point, check type, reason, preview, Approve / Reject buttons, optional note, keyboard shortcuts (A / R), decision result shown after the response; the node's status ring shows WAITING; the card layout works at 380 px width (FR-GRD-013, FR-MOB-002, TC-GRD-008/009, TC-MOB-002). A pending-approvals badge in the top bar lists all pending cards across runs (`GET /runs/:id/approvals`).
5. Guardrail policies screen (`/guardrails`): list per project with version and "default" badge; editor with checks grouped by point (input, output, cost, loop, tool, context) — type, action (pass/warn/redact/ask user/block — label "ask user" for `ask_user`), enabled, params form per type; Save creates a new version and shows it; Test panel: paste text, choose input/output, run `POST .../test`, show verdicts (FR-GRD-001, 011, TC-GRD-001, 016); Set as project default (FR-GRD-018 default visible on new projects); Delete with in-use confirmation. Config panel: guardrail policy override picker on Agent nodes (project default / specific policy) (FR-GRD-002, TC-GRD-002).
6. Inspector: Verdicts tab per node run — check, point, action, passed, reason, and for redactions the types removed only, never a value (FR-GRD-014/015, TC-GRD-018/019); approval decisions with timestamps; policy id+version used.
7. Bottom "Events" tab: chronological run events (state changes, verdicts, approvals, loop iterations, halts) from the socket buffer, filter by node (this is the event view; the chat Timeline is Round 4).
8. Loop edges: context menu "Make loop edge" on an edge whose target is upstream of its source; distinct style (dashed, arrow-back glyph, iteration badge during runs); editor for maxIterations (1–50, inline refusal of 0 and 51), exitCondition path + value, onMax (FR-CON-007, TC-CON-007). Inspector: iteration selector listing each iteration's node run and output (FR-PAR-005, TC-PAR-006). Config panel "Use standard review contract" button that fills the Agent outputContract with REVIEW_CONTRACT_SCHEMA.
9. Merge node: mode selector all/any; input port slots labelled with the feeding node name during runs (FR-PAR-002).
10. Budgets: Settings → daily budget (USD); project settings → max cost per run; execution settings already has max tokens per node (FR-GRD-008 UI).

Tests by TC id: TC-CTL-006, TC-ERR-002/007/008, TC-GRD-001/002/008/009/016/018/019, TC-PAR-006, TC-CON-007, TC-MOB-002 (viewport 380 px). Keyboard-only approval.
Done when: all green; `pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e` green with zero env vars; coverage ≥ 60 % web-side; §1 demo script works against scenarios. Do NOT build the chat timeline, tool UI, uploads, knowledge, undo/redo — Rounds 4–5.
Deliverable report per CLAUDE.md §8 step 6.
```

---

## 6. Merge procedure — Round 3
As Round 1 §7. After both merge, walk the §1 demo script together against the real engine.

## 7. Cross-testing — Round 3

### 7.1 Arhant tests Mouli's feature (M3)
**File:** `tests/acceptance/round-3/arhant-tests-mouli.e2e.ts` (Playwright, real engine, mock provider, Round 3 fixtures imported through the UI).

| TC / check | Scenario |
|---|---|
| TC-CTL-006 | In every run state only the allowed buttons are enabled (compare with `run.allowedActions`) |
| TC-CTL-001..004 via UI | Pause during `mock-slow` → next node never starts; Resume → completes; Stop → run HALTED "stopped by you"; Restart → new run id shown |
| TC-ERR-002 | `auth-401.json` → error card shows node, kind auth, message, provider, state, Retry, and the "update the provider key" hint |
| TC-ERR-007/008 | Downstream nodes show BLOCKED (not failed); stopped nodes not counted as failures in the run summary |
| TC-GRD-008/009 | `pii-ask.json` → WAITING ring + approval card → Approve → continues; new run → Reject → GUARDRAIL_VIOLATION shown distinctly from CONTRACT_VIOLATION |
| TC-GRD-001/016 | Create a policy with all five actions, save → version 2 shown; Test panel with "ignore previous instructions" → verdict listed |
| TC-GRD-002 | Project default warns on PII; agent override blocks → run blocks; inspector shows the override id/version |
| TC-GRD-018/019 | Redact action → inspector shows "email redacted", the email itself never appears in the DOM |
| TC-CON-007 | Loop edge editor refuses 0 and 51 inline; 3 accepted and persisted |
| TC-PAR-006 | `review-fix.json` → iteration selector lists 3 iterations with distinct outputs |
| TC-MOB-002 | Viewport 380 px: approval card usable, Approve continues the node |
| Budget | `budget-cap.json` → HALTED "budget exceeded: $x > $0.01 cap" |

**Manual pass:** approve from a second tab while the first shows the card; pause/resume 20× fast; reload while WAITING; policy editor with 30 checks; screen-reader labels on the approval buttons.

### 7.2 Mouli tests Arhant's feature (A3)
**File:** `tests/acceptance/round-3/mouli-tests-arhant.test.ts` (Vitest through `@ace/sdk`).

| TC / check | Scenario |
|---|---|
| TC-CTL-001/002 | Pause while A runs → A COMPLETED, B never READY→RUNNING; Resume → B runs, COMPLETE |
| TC-CTL-003 | Stop during `mock-slow` → last `node.token` ≤ 2 s after the stop call; nodes STOPPED; run HALTED `stopped` |
| TC-CTL-004/005 | Restart → new id, same snapshot version + inputs; rerun node B → exactly one new node run, A's call count unchanged |
| TC-EXE-012 | startFromNodeId B → A not re-called (`mockProvider.calls()`), B and C executed |
| TC-ERR-001 | Eight fixtures → eight kinds |
| TC-ERR-005/006 (auto retry) | `retry-429.json` → attempts 1,2 fail, 3 COMPLETED; `auth-401.json` → one attempt only |
| TC-ERR-003/004/009 | Manual retry → attempt 2 same inputs; retry with downstream re-runs C; fix model then rerun → COMPLETED |
| TC-ERR-007 | Downstream of a failure BLOCKED with error kind `workflow` |
| TC-GRD-003/004 | Input "ignore previous instructions…" → verdict prompt_injection warn; phone+email input → pii detected with types |
| TC-GRD-010/011/017 | `leak.json` → output secret_leak block → GUARDRAIL_VIOLATION (not CONTRACT_VIOLATION); citations policy with none → check fails with reason |
| TC-GRD-012 | `budget-cap.json` → HALTED `budget_exceeded`, no further node dispatched |
| TC-GRD-013 | `mock-repeat` in a max-10 loop → stops after 3 identical outputs, `loopStop: 'repeated_output'` |
| TC-GRD-015 | No API path disables data guardrails: a policy patch with `secret_leak enabled:false` at `data` point → 400 |
| TC-GRD-008/009 | Approve → node continues and `approvals[0].decidedAt` set; reject → GUARDRAIL_VIOLATION |
| TC-PAR-001..005/007/008 | Two `mock-slow` branches ≈ 2 s total; merge all/any; review-fix exits at iteration 3; review-never → exactly max iterations; onMax fail → RUN_FAILED with message; reviewer without verdict → CONTRACT_VIOLATION |
| TC-CON-007 | graph-ops loop edge with maxIterations 0 → 400; 51 → 400 |
| TC-NFR-013 | 100 nodes with the default policy → average guardrail overhead < 300 ms/node (read from node run timings) |

**Manual pass:** clean clone `pnpm test`; SIGTERM while WAITING → run HALTED `shutdown`, restart → approval endpoint returns 409; 50 pause/resume calls in parallel → consistent state.

### 7.3 Verification prompt and REPORT
Round 1 §8.3 with `<A3 | M3>` and this file's §4/§5; REPORT template Round 1 §8.4 → `tests/acceptance/round-3/REPORT.md`.

## 8. Round exit gate
- [ ] C3, A3, M3 merged; CI green; `pnpm test:acceptance` green for rounds 1–3.
- [ ] REPORT.md complete; no open critical/high; Stop latency, TC-NFR-013 figure recorded.
- [ ] §1 demo script walked by both.
- [ ] `docs/DECISIONS.md` updated (expect OI-08/D10 confirmation, `mock-reject-always` addition, retry backoff constants).
- [ ] `CLAUDE.md` §9 rows C3/A3/M3 → VERIFIED; §9.1 Round 3 filled; `git tag round-3`.

## 9. Hand-off to Round 4
Round 4 assumes: guardrail engine with `ask_user`/approvals and the tool-point check types declared but not yet evaluated; `max_tool_calls` counter; error kinds complete; envelopes accept `Part` file variants (declared in Round 2); the inspector has Verdicts and iteration tabs; the approval card exists. Open `04-round-4-multimodal-chat-tools.md`.
