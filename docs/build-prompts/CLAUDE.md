# CLAUDE.md — ACE monorepo standing instructions

Loaded in every Claude Code session. Read it fully before touching anything. When this file and the docs disagree, the docs win; report the conflict as a DECISION NEEDED (§8).

## 1. What ACE is and where the truth lives

ACE is a multimodal AI agent orchestration platform: a visual Canvas where users connect agent nodes into workflows and run them across cloud, local and custom models side by side.
Every handoff between nodes is an envelope (reads + bounded context + output contract), never raw chat history; every run executes from an immutable snapshot with an append-only event log.
Guardrails at seven points, budgets, human approvals and typed output contracts make runs safe, inspectable and reproducible; ACE Bench compares configurations with frozen tasks and blind judging.
v1 is local and single-user: a React/Vite SPA talking to a local Node.js/Hono engine over REST `/api/v1` and WebSocket `/ws`, then the same SPA packaged as an Electron desktop app.
Hosted multi-tenant mode is post-v1 and reuses the same engine by swapping adapters (Arch §7, ADR-016).

Specs — the ONLY sources of truth:
- `docs/ACE-PRD.md` — feature priorities (Must/Should/Could/Later), user stories US-001..040 with acceptance criteria, product states, product principles.
- `docs/ACE-FRS.md` — §1.3 definitions · §3 FR-* per module (each module header states its phase) · §4 NFR-* · §5 BR-01..18 · §6 external interfaces · §7 UC-01..20 · §8 testing (§8.2 levels, §8.3 fixtures, §8.4 exit criteria, §8.6 TC-*, §8.7 UAT) · §9 traceability · §10 phase list · §11 OI-*.
- `docs/ARCHITECTURE.md` — §3 P1-P10 · §4 quality attributes · §7 deployment modes + port/adapter table · §10 client · §11 gateway · §12 orchestration (§12.3 scheduler, §12.4 Envelope, §12.5 prompts, §12.6 RAG, §12.7 tool loop, §12.8 memory) · §13 guardrails · §14 model serving · §15 data · §16 tools · §19 state machines · §20 API · §22 security · §28 error kinds · §29 config · §30 code organization · §31 testing · §32 versioning · §35 stack · §36 ADRs · §39 open decisions.
- `docs/DECISIONS.md` — D1..D17 plus every decision made during the build.
- `docs/build-prompts/` — one prompt per phase; the current phase's prompt is the work order for the session.

Rules:
- The docs are the source of truth. Never invent a requirement, endpoint, table, column, state, message name or behaviour. If the docs do not say it, it is a decision (§8), not a guess.
- Look things up every time; do not work from memory of the docs. Before touching a module, read its FR table (FRS §3), its TC table (FRS §8.6) and the Arch sections listed in FRS §9 for that module.
- Cite IDs everywhere: FR-xxx, TC-xxx, NFR-xxx, BR-xx, UC-xx, ADR-xxx, D-n and Arch §n in plans, commit messages, test names, PR bodies and reports.
- The "Build Blueprint" and the 47-section product spec are cited by the docs but are NOT in the repo. Anything only they specify (full column list, D1-D8 detail, full endpoint list) must be derived from the three docs or raised as DECISION NEEDED.

## 2. Non-negotiable rules

### 2.1 Principles (Arch §3)
- P1 Canvas first: make every major action reachable from the Canvas (NFR-USE-01).
- P2 Engine owns truth: the UI is a projection of engine state and events; the client never holds state the engine does not.
- P3 Envelopes, not history: pass bounded, validated envelopes on every edge; never raw conversation history.
- P4 Contracts everywhere: one Zod schema set in `packages/contracts` serves API, WebSocket, envelopes and DB validation.
- P5 Distinct states: never merge CONTRACT_VIOLATION, RUN_FAILED, BLOCKED, GUARDRAIL_VIOLATION; COMPLETE is not HALTED.
- P6 Immutable runs: snapshot at dispatch; events are append-only; never update or delete an event or a snapshot.
- P7 Ports and adapters: the engine depends on interfaces only; storage, queue, pub/sub, blobs, secrets, sandbox, auth, providers and tools are adapters.
- P8 Visible architecture: retrieval and guardrails can be real nodes on the Canvas.
- P9 Safe by default: guardrails, budgets and permissions are on unless the user relaxes them.
- P10 Governed measurement: frozen bench tasks, blind judging, pre-registered rules.

### 2.2 Business rules (FRS §5) — enforce in code and prove in tests
- BR-01 The engine holds the source of truth; the UI never does.
- BR-02 Nodes exchange envelopes only; never pass raw conversation history.
- BR-03 CONTRACT_VIOLATION, RUN_FAILED and BLOCKED are different failures; COMPLETE and HALTED are different endings.
- BR-04 Never change a run's snapshot after the run starts.
- BR-05 Cycles exist only as loop edges with a maximum iteration count (1-50, FR-CON-007).
- BR-06 Never edit frozen bench tasks or pre-registered rules.
- BR-07 Secrets never appear in the database, logs or exports.
- BR-08 Never call a provider that failed its pre-flight check.
- BR-09 Block user edits to project files while a run is active.
- BR-10 Config edits during a run apply only to later runs; the active run uses its snapshot.
- BR-11 Never run a custom script without the user approving its declared permissions.
- BR-12 Report guardrail blocks as GUARDRAIL_VIOLATION; never merge it with other failure reasons (D9).
- BR-13 Always treat retrieved documents, tool results and upstream outputs as untrusted.
- BR-14 Never run a destructive tool action without user approval.
- BR-15 Data guardrails (secret redaction, file confinement) cannot be disabled; do not build an off switch.
- BR-16 Always record the model actually used; bench runs use fixed routing.
- BR-17 Frozen bench tasks never enter training data.
- BR-18 Hosted tenants never see each other's data.

### 2.3 ADRs (Arch §36)
- Locked: ADR-008 envelopes with bounded context · ADR-009 immutable run snapshots + append-only events.
- Accepted (binding): ADR-001 web UI + local engine first, Electron later · ADR-002 custom orchestration engine, no LangGraph/LlamaIndex · ADR-003 Vite SPA for the app, Next.js only for the public site · ADR-004 Hono gateway, no FastAPI · ADR-005 SQLite local / Postgres hosted via Drizzle · ADR-006 in-process queue local, BullMQ hosted, Kafka deferred · ADR-007 sqlite-vec / pgvector before Qdrant · ADR-016 ports-and-adapters engine.
- Proposed, adopted via decisions: ADR-010 free dragging + auto-layout · ADR-011 loops only via loop edges · ADR-012 GUARDRAIL_VIOLATION (D9) · ADR-013 guardrail policies + optional Guardrail node · ADR-014 router v1 = Fixed + Fallback (D12) · ADR-015 training post-v1 as a Python service.
- Implement ADRs as written. Changing one requires a DECISION NEEDED block and a new D-number.

### 2.4 Exact names — never paraphrase, never re-case
- Node states: IDLE, READY, RUNNING, WAITING, COMPLETED, PAUSED, STOPPED, BLOCKED, FAILED.
- Run states: PREFLIGHT, RUNNING, PAUSED, COMPLETE, BLOCKED, HALTED.
- Failure reasons: RUN_FAILED, CONTRACT_VIOLATION, GUARDRAIL_VIOLATION, BLOCKED.
- Provider states: UNKNOWN, CHECKING, CONNECTED, AUTH_FAILED, UNREACHABLE, RATE_LIMITED.
- Error kinds: user_cancelled, agent, provider, auth, network, invalid_config, workflow, guardrail.
- Guardrail actions: pass, warn, redact, ask user, block. Guardrail points: input, context, tool, output, cost, loop, data.
- Routing policies: fixed, fallback, capability, cost, latency.
- HALTED reasons named in the docs: `shutdown` (FR-SYS-008), `budget_exceeded` (FR-GRD-008), `plan_limit` (hosted, FR-HOST-009).
- Define each enum once in `packages/contracts` and import it everywhere. The UI maps enum value → display label; nothing maps labels back.

### 2.5 Structural rules
- Error format (FR-SYS-006, Arch §20.1, §28): every non-2xx response and every engine error is `{ error: { kind, code, message, details?, retryable } }`; node errors also carry provider info and the node run ID.
- Envelope-only handoffs (Arch §12.4): files travel as artifact references, never inline bytes (FR-MM-004); envelope context never exceeds the node's token budget (FR-EXE-007).
- Immutable snapshots + append-only events: the run snapshot is written once at start (FR-EXE-002); `events` carries a monotonic per-run `seq`; reconnecting clients send `resume { afterSeq }` and receive every missed event in order (FR-EXE-014, Arch §21.4).
- Engine owns truth: `apps/web` renders from TanStack Query data patched by WebSocket events; graph edits are optimistic, batched, versioned, and reconciled on 409 (Arch §10.1, FR-WF-005).
- Ports and adapters (Arch §7, §30): `packages/engine` imports `packages/contracts` and its own port interfaces only; `storage-local`, `storage-cloud`, `providers`, `tools` implement ports; adapters are wired in the app entry (`apps/server`, `apps/desktop`), never inside the engine.
- Security (FR-SYS-001..003, FR-PRV-002, FR-GIT-008, NFR-SEC-01..05, Arch §22): bind 127.0.0.1 only; random session token required on every REST request and WS connection (missing or wrong → 401, WS closed); Origin allow-list (foreign origin → 403); secrets only in the OS keychain / Electron safeStorage through `SecretStore`; the API returns only "key set: yes/no", never a key; no secret in DB, logs, exports, fixtures or displayed prompts; file access confined to the project folder (`../` refused); sandboxes enforce time, memory and folder limits; upload size and type checks on every file.
- Untrusted by default (BR-13, FR-GRD-004, FR-PRM-002, FR-TOOL-010, NFR-SEC-04): retrieved chunks, tool results and upstream outputs go inside clearly delimited, labelled untrusted blocks with `trust: 'untrusted'`; hidden instructions are stripped; instructions found in them are never executed.
- Safe by default (P9, D10, FR-GRD-018): a new project gets the default policy — warn on content issues, block secret leaks and tool abuse; data guardrails are always on.
- Config precedence (FR-SYS-010, Arch §29): node → project → user → engine → defaults; validate all layers with Zod at startup; an invalid config file makes the engine refuse to start with a clear message.

## 3. Tech stack (locked — Arch §35, local column)

| Layer | Use |
|---|---|
| Client | React, Vite, React Flow, Tailwind, shadcn/ui, Zustand, TanStack Query, Monaco, react-resizable-panels, cmdk, Electron (desktop) |
| Gateway | Hono middleware: token auth, origin check, Zod validation, request ID |
| Orchestration | TypeScript engine, XState v5 for state machines, Zod, Vercel AI SDK for provider calls where possible |
| Guardrails | Zod (contracts), rule packs (regex / key-format patterns), Llama Guard via Ollama as optional classifier |
| Models | Anthropic, Google, OpenAI, OpenAI-compatible (Ollama, LM Studio, custom endpoint), CLIs (Could), mock |
| Data | SQLite + Drizzle, sqlite-vec, FTS5, local artifact folder, OS keychain → safeStorage, simple-git |
| Tools | unpdf, mammoth, sharp, simple-git, child-process sandbox (Docker when available), SearXNG, MCP client |
| Infra / Ops | pnpm workspaces, Node.js LTS, ESM, GitHub Actions, electron-builder, electron-updater, pino, Sentry (opt-in, off by default) |
| Testing | Vitest, Testing Library, Playwright |

DO NOT USE:
- Next.js for the app. `apps/web` is a Vite SPA (ADR-003); Next.js exists only in `apps/site`.
- Python in product code. Only `services/training` (post-v1) may be Python (FRS §2.4).
- LangGraph, LlamaIndex, LangChain or any agent framework as the execution model (ADR-002).
- Kafka, Celery, RabbitMQ (ADR-006). Local = in-process queue; hosted = BullMQ.
- Qdrant, Pinecone, Weaviate, Chroma in v1 (ADR-007). Local vectors = sqlite-vec.
- Any ORM or query builder other than Drizzle (ADR-005): no Prisma, TypeORM, Knex, Sequelize, MikroORM.
- Any state library in `apps/web` other than Zustand + TanStack Query: no Redux, MobX, Jotai, Recoil, XState-in-UI stores.
- Browser APIs (`window`, `document`, `localStorage`, DOM, `fetch` assumptions about a browser) anywhere under `packages/engine`.
- Node APIs (`fs`, `path`, `child_process`, `process.env`, `node:*`) anywhere under `apps/web`.
- Express, Fastify, NestJS, Koa or FastAPI for the gateway (ADR-004). Hono only.
- `any`, `@ts-ignore`, `console.*` in engine code, committed `.env`, real keys in fixtures.

## 4. Monorepo layout (Arch §30)

```
ace/
├─ apps/
│  ├─ web/              React SPA
│  ├─ desktop/          Electron shell
│  ├─ site/             Next.js public site (hosted)
│  ├─ cli/              ace CLI
│  └─ server/           Hosted gateway + API entry
├─ packages/
│  ├─ contracts/        Zod schemas, OpenAPI generation
│  ├─ engine/           orchestration core (ports & adapters)
│  ├─ providers/        model adapters + router + catalog
│  ├─ guardrails/       policies, rule packs, classifiers
│  ├─ context/          parsing, chunking, embeddings, retrieval
│  ├─ tools/            tool registry, sandbox, search, MCP client
│  ├─ storage-local/    SQLite, sqlite-vec, FTS5, keychain, fs blobs
│  ├─ storage-cloud/    Postgres, pgvector, Redis, S3, secret manager
│  ├─ sdk/              TypeScript SDK
│  ├─ ui/               shared components + design tokens
│  └─ config/           tsconfig, eslint, prettier
├─ services/
│  └─ training/         Python fine-tuning service (post-v1)
├─ bench/               frozen tasks and rubrics
├─ infra/               Dockerfiles, Terraform, k8s manifests
└─ docs/                ARCHITECTURE.md, FRS, DECISIONS.md, API reference
```

Dependency rules (Arch §30, verbatim): `engine` depends on `contracts` and interfaces only · `storage-*` implement engine ports · `web` never imports Node modules · `engine` never imports browser APIs.
Derived: `contracts` imports nothing from the workspace · `providers`, `guardrails`, `context`, `tools` import `contracts` and engine port types only · `sdk` and `ui` import `contracts` only · apps import packages, packages never import apps · the local engine entry in v1 lives in `apps/server` (local mode) and is started by `apps/desktop` in Phase 16. Enforce with eslint `no-restricted-imports` and per-package `exports` maps.

Canonical root scripts (all phases, no others as CI entry points): `pnpm dev` · `pnpm build` · `pnpm typecheck` · `pnpm lint` · `pnpm test` (unit + integration + component) · `pnpm test:e2e` (Playwright) · `pnpm test:providers` (nightly, tagged, real keys).

Where tests live: unit tests colocated as `src/**/*.test.ts(x)`; integration tests in `packages/<pkg>/test/`; Playwright E2E in `apps/web/e2e/` (desktop parity suite reuses them from `apps/desktop/e2e/`); provider contract tests in `packages/providers/test/contract/` tagged `@provider`; shared fixtures (FRS §8.3) in `packages/contracts/fixtures/` (workflows, files) and `packages/guardrails/test/corpora/` (guardrail corpora); frozen bench tasks in `bench/`. The Phase 0 prompt may refine this; if it does, the prompt wins and DECISIONS.md records it.

## 5. Contracts first (P4, NFR-MAIN-01, Arch §20, §32)

- `packages/contracts` holds every Zod schema: entities for the tables in Arch §15.3, API request/response bodies, WebSocket messages, Envelope and Part, guardrail policies and verdicts, tool definitions (Arch §16), custom node manifests, workflow file format with `formatVersion`. No other package defines a shape; derive types with `z.infer`.
- Drizzle tables in `storage-*` mirror the contracts; validate input with contract schemas, never with ad-hoc checks.
- Generate the OpenAPI document (FR-CLI-007, TC-CLI-005) and the TypeScript SDK in `packages/sdk` (FR-CLI-006) from the contracts. Never hand-write either; a diff between routes and OpenAPI is a failing test.
- API conventions (Arch §20.1): base `/api/v1`; JSON; Zod-validated at the gateway; error body `{ error: { kind, code, message, details?, retryable } }`; `If-Match: <version>` on graph writes → 409 on conflict (FR-WF-005); cursor pagination `?cursor=&limit=`; bearer session token on every request; `GET /health` → 200 with `version` and `db: ok` (FR-SYS-004); hosted adds `Idempotency-Key` on run creation. Use the endpoint groups and paths in Arch §20.2; do not add routes without a decision.
- WebSocket `/ws` (Arch §20.3): client → server `subscribe`, `unsubscribe`, `resume { afterSeq }`; server → client `workflow.updated`, `run.started`, `run.paused`, `run.resumed`, `run.completed`, `node.state`, `node.token`, `node.output`, `node.error`, `node.approval_required`, `edge.transfer`, `loop.iteration`, `tool.call`, `guardrail.verdict`, `message.created`, `provider.status`, `kb.ingest`, `usage.updated`. Run-scoped messages carry the event `seq`; tokens are batched ~50 ms before send (Arch §24).
- Versioning (Arch §32, NFR-VER-01): `/api/v1` is additive only, breaking → `/api/v2` with overlap; contracts use semver; Drizzle migrations are forward-only and back up the DB before applying (NFR-REL-03); the workflow importer upgrades older `formatVersion`s (FR-WF-008, TC-NFR-016); prompts, skills and guardrail policies are versioned records and every node run stores the versions used (FR-PRM-004, FR-SKL-004, Arch §13.4).

## 6. Coding conventions

- TypeScript `strict: true` everywhere (NFR-MAIN-01), plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; no `any`; no non-null `!` without a one-line reason.
- ESM only (`"type": "module"`), `.js` extensions on relative imports, `exports` maps per package; tsconfig, eslint and prettier come from `packages/config`.
- Naming: files and folders kebab-case; types, interfaces, classes, React components PascalCase; functions and variables camelCase; enum values exactly as §2.4; port interfaces named as Arch §7 (`Repository`, `VectorIndex`, `KeywordIndex`, `Queue`, `PubSub`, `BlobStore`, `SecretStore`, `Sandbox`, `Auth`); adapters `<Tech><Port>` (`SqliteRepository`, `KeychainSecretStore`, `InProcessQueue`); subsystems named as Arch §12.2 (graph service, run service, pre-flight, scheduler, node executor, envelope engine, prompt manager, context builder, guardrails engine, model router, tool executor, custom-node runtime, event bus, chat service, workspace service, bench service).
- Small modules: one responsibility per file, aim under 300 lines; pure functions for scheduler decisions, envelope building, prompt assembly, retry policy, chunking so they unit-test without I/O.
- Logging: pino JSON only; a child logger per subsystem; redaction paths for `apiKey`, `authorization`, `token`, `secret`, `key`, `headers.*` plus key-format patterns; prompts and tool arguments pass through the redactor before logging (FR-SYS-007, FR-TOOL-009); rotate and keep 14 days (FR-SYS-011). No `console.*` in `packages/*` or `apps/server`; `apps/cli` prints through its own output layer.
- Errors: throw an `AceError` shaped as the contracts error (`kind`, `code`, `message`, `details?`, `retryable`, `provider?`, `nodeRunId?`); map provider SDK errors to ACE kinds inside the adapter (Arch §14.2); retry only `provider` and `network` with backoff, never `auth`, `invalid_config`, `workflow`, `guardrail`, `user_cancelled` (FR-ERR-005, table §11.5).
- Cancellation: every provider call, tool call and sandbox run takes an `AbortSignal`; Stop closes provider streams within 2 s (FR-CTL-003); shutdown cancels calls and saves events, marking runs HALTED `shutdown` (FR-SYS-008).
- Transactions: batch graph ops in one transaction (NFR-REL-02); write events in the same transaction as the state change they describe; on restart mark in-flight runs HALTED (FR-SYS-009).
- Comments only where the reason is non-obvious, citing the FR/BR/ADR that forces the choice. No commented-out code; no TODO without a D-number.

## 7. Testing rules (FRS §8, Arch §31)

- Tools: Vitest for unit, integration (engine API against a temporary SQLite DB), component (Testing Library), guardrail suite and CLI/SDK tests; Playwright for E2E, desktop parity (FR-DSK-006) and performance traces.
- Every CI test runs on the mock provider (FR-PRV-010) with no API keys. The mock scripts outputs, delays, streaming, 401/429/503 and wrong-shape JSON so every node and run state is reachable (TC-EXE-008, TC-ERR-001).
- Name tests by test-case ID: `describe("TC-EXE-005 Contract violation")` with `it` blocks phrased as the TC's expected result; one `describe` per TC; NFR tests as `TC-NFR-xxx`; UAT items are not automated.
- Coverage thresholds in Vitest config: ≥ 80% for engine packages (`engine`, `contracts`, `providers`, `guardrails`, `context`, `tools`, `storage-local`), ≥ 60% for `apps/web` and `packages/ui` (NFR-MAIN-02). `pnpm test` fails below threshold.
- Cadence (FRS §8.2, Arch §18.4): unit + integration + component on every commit; E2E on every PR; provider contract tests nightly via `pnpm test:providers`, tagged `@provider`, real keys from CI secrets, excluded from `pnpm test`; guardrail rule-pack corpus every commit, classifier corpus nightly; tenant isolation tests from Phase 18.
- Fixtures (FRS §8.3): temporary SQLite DB per test run; workflows — linear (3 nodes), parallel (fan-out/merge), loop (Review→Fix), multimodal (image), RAG (5 documents), custom HTTP node (local test server); guardrail corpora — known injection prompts, documents with hidden instructions, texts with PII and fake API keys, a clean control set; tool fixtures — local HTTP test server, local SearXNG or mocked search, local MCP test server; files — sample PDF, DOCX, Markdown, PNG, MP3, MP4, a corrupt PDF, a file over the size limit. Fake keys must trip the leak detector but must never be real.
- Phase exit (FRS §8.4): 100% of Must TCs pass, ≥ 95% of Should TCs pass, no open critical or high defects, coverage and performance targets met.
- Never claim done without running `pnpm typecheck && pnpm lint && pnpm test` (plus `pnpm test:e2e` when `apps/web` or `apps/desktop` changed) and pasting the summary lines (test files, tests passed/failed, coverage per package). "Should pass" and "expected to work" are not results.
- TDD: write the TC-named failing test first, then the minimal code, then refactor. Never weaken a test, skip a TC or lower a threshold to get green; raise a DECISION NEEDED instead.

## 8. Phase discipline

- Build in FRS §10 order: 0 Foundations · 1 Contracts + DB · 2 Engine skeleton (SYS, PRJ, WF) · 3 Canvas (CAN, NODE, CON) · 4 Providers + router (PRV, MOD, RTR) · 5 Execution engine (EXE, PRM, OBS basic) · 6 Control + errors + guardrails (CTL, ERR, GRD input/output/cost/loop/approvals) · 7 Parallel + loops (PAR) · 8 Multimodal (MM, TOOL media) · 9 Chat (CHAT) · 10 Context & RAG (RAG, MEM, GRD context) · 11 Skills, custom nodes, tools (SKL, CUS, TOOL, GRD tool + Guardrail node, PRM library) · 12 Workspace + code (GIT, TOOL file/git) · 13 ACE Bench (BEN) · 14 Testing & QA · 15 Hardening (GRD classifier, OBS, NFR) · 16 Desktop (DSK) · 17 Launch (ONB, CLI, MOB responsive) · 18-21 post-v1 (HOST, HMOD, TRN, MOB-004).
- The session's work order is the phase prompt in `docs/build-prompts/`. Do what it says plus the FRs whose module header names that phase; within a phase, Must before Should before Could (PRD priorities, FRS §1.4).
- Do not start later-phase features, even "while you're in there". Leave a typed port or interface and a note in DECISIONS.md instead. Post-v1 modules (HOST, HMOD, TRN, native mobile) are never built in v1 sessions.
- A phase is done only when its Done-when gate in the phase prompt is green: every TC for the phase implemented and passing on mock, coverage met, `pnpm typecheck` and `pnpm lint` clean, DECISIONS.md updated, report delivered (§9).
- Record every decision in `docs/DECISIONS.md` as `D<n> — <title> — <date>` with Context, Options, Decision, Affects (FR/TC/Arch §/ADR/phase). D1-D17 pre-exist (D1-D8 Phase 0 basics; D9 GUARDRAIL_VIOLATION; D10 default guardrail strictness; D11 hosted auth; D12 router v1 = Fixed + Fallback; D13 child-process sandbox, Docker if available; D14 SearXNG default; D15 hosted after v1 feedback; D16 MCP in v1; D17 hosted retention 30/90/365). Number new ones from D18 upward; never renumber or rewrite an old one.
- When the docs conflict, are silent, or point at the missing Build Blueprint: STOP. Do not guess, do not pick the "obvious" answer. Post this block and wait:

  ```
  DECISION NEEDED: <one-line title>
  Unspecified: <what the docs do not say, with the exact §/FR/TC consulted and what each says>
  Options: A) ... B) ... C) ...
  Recommendation: <one option and why, max 3 lines>
  Affects: <FR-xxx, TC-xxx, Arch §n, ADR-xxx, phase(s)>
  ```

  After the answer, write the D-entry before writing the code that depends on it.

## 9. Session working method

1. Read this file, `docs/DECISIONS.md`, the phase prompt, and every FR/TC table and Arch section the prompt cites. Check `git log` and the previous phase report for deviations and open D-items.
2. Enter plan mode. Write no code yet.
3. Present the plan: packages and files touched; contracts added; migrations; ports and adapters introduced; the FR/TC coverage table (columns: FR-ID · TC-IDs · implementation file(s) · test file(s) · status); risks; DECISION NEEDED blocks.
4. Get explicit approval. Resolve every DECISION NEEDED before implementation.
5. Implement with TDD in vertical slices (contract → storage → engine → API → UI), each slice with its TC-named tests, committed as it turns green (§10).
6. Run `pnpm typecheck && pnpm lint && pnpm test` (plus `pnpm test:e2e` for UI phases). Fix until green without weakening tests or thresholds.
7. Report: pasted test summary (files, tests, failures, duration); coverage per package; the FR/TC table with final status; deviations from the plan and from the docs, each with a D-number or a DECISION NEEDED; what the next phase needs to know.
8. Never end a session with uncommitted work described as done; never describe untested work as working.

## 10. Git conventions

- Conventional commits: `type(scope): message [Phase N] [FR-xxx]`. Types: feat, fix, test, refactor, docs, chore, build, ci, perf. Scope = package or app (`contracts`, `engine`, `providers`, `guardrails`, `context`, `tools`, `storage-local`, `web`, `desktop`, `cli`, `server`, `sdk`, `ui`, `bench`, `infra`, `docs`). Example: `feat(engine): mark unreachable downstream nodes BLOCKED on failure [Phase 6] [FR-ERR-006]`.
- Small commits: one FR or one TC group per commit; tests in the same commit as the code they cover; contracts changes in their own commit before their consumers.
- Branch per phase: `phase-NN-<slug>` from `main`; merge only when the phase gate (§8) is green. Never commit directly to `main`.
- Never commit: secrets, API keys, `.env*` (except `.env.example`), the data folder (`data/`, `*.sqlite`, `*.db`, `*.db-wal`), artifact folders, `node_modules`, build output, Playwright reports and traces, Langfuse or Sentry DSNs. Keep `.gitignore` current; check `git status` and `git diff --cached` before every commit.
- Commit messages and PR bodies cite the FR/TC/D IDs affected; PR bodies include the FR/TC table and the pasted test summary.
- End every commit message with the attribution line the session's system reminder specifies.

## 11. Quick reference

### 11.1 Node state machine (Arch §19.1, FR-EXE-009)
| From | To | Trigger |
|---|---|---|
| IDLE | READY | all required inputs available |
| IDLE | BLOCKED | upstream node failed (FR-ERR-006) |
| READY | RUNNING | dispatched by scheduler (respecting provider + global concurrency) |
| READY | PAUSED | run paused (FR-CTL-001) |
| PAUSED | READY | run resumed (FR-CTL-002) |
| RUNNING | WAITING | guardrail action "ask user" (FR-GRD-013) |
| WAITING | RUNNING | user approved |
| WAITING | FAILED | user rejected → GUARDRAIL_VIOLATION |
| RUNNING | COMPLETED | output valid against the contract |
| RUNNING | FAILED | RUN_FAILED / CONTRACT_VIOLATION / GUARDRAIL_VIOLATION |
| RUNNING | STOPPED | user stop; not counted as a failure (FR-ERR-007) |
| FAILED | READY | retry, attempt + 1 (FR-ERR-003) |
| COMPLETED | READY | re-run (FR-CTL-005) or next loop iteration |

### 11.2 Run state machine (Arch §19.2, §12.3, FR-EXE-011)
| From | To | Trigger |
|---|---|---|
| PREFLIGHT | BLOCKED | pre-flight issues; zero provider calls made (FR-EXE-003, BR-08) |
| PREFLIGHT | RUNNING | all checks pass |
| RUNNING | PAUSED | pause: no new dispatch, running nodes finish |
| PAUSED | RUNNING | resume |
| RUNNING | HALTED | stop · `budget_exceeded` · unrecoverable failure · `shutdown` / crash recovery |
| RUNNING | COMPLETE | nothing RUNNING/READY/WAITING and every output node COMPLETED |
BLOCKED, HALTED, COMPLETE are terminal. Restart = new run ID, same snapshot and inputs (FR-CTL-004). Replay uses the recorded commit and envelopes (FR-GIT-007).

### 11.3 Provider states (Arch §19.3, FR-PRV-003)
UNKNOWN → CHECKING → CONNECTED | AUTH_FAILED | UNREACHABLE | RATE_LIMITED. Re-check on schedule and before each run; status pushed via `provider.status`.

### 11.4 Failure reasons (P5, BR-03, BR-12)
| Reason | Meaning |
|---|---|
| RUN_FAILED | provider, network or agent failure after the retry policy is exhausted |
| CONTRACT_VIOLATION | output failed the envelope's output contract (FR-EXE-006, FR-PAR-008) |
| GUARDRAIL_VIOLATION | a guardrail blocked, or the user rejected an approval (D9, FR-GRD-012) |
| BLOCKED | could not run: pre-flight failed or an upstream node failed |

### 11.5 Error kinds (Arch §28, FR-ERR-001, FR-ERR-005)
| kind | example | retryable | resulting state |
|---|---|---|---|
| user_cancelled | Stop pressed | no | STOPPED |
| agent | model refused / bad output | once (contract repair) | CONTRACT_VIOLATION / FAILED |
| provider | 5xx, 429 | yes, backoff | FAILED after retries; 429 marks provider RATE_LIMITED |
| auth | 401 / 403 | no | FAILED; provider AUTH_FAILED |
| network | timeout, DNS | yes, backoff | FAILED after retries |
| invalid_config | missing model | no | BLOCKED at pre-flight |
| workflow | upstream failed | no | BLOCKED |
| guardrail | policy block / rejected approval | no | GUARDRAIL_VIOLATION |

### 11.6 Guardrails (Arch §13, FR-GRD-001..018)
| Point | Checks | Default action (Arch §13.1) |
|---|---|---|
| input | size/type limits, PII, prompt-injection patterns, blocked topics | warn / block |
| context | untrusted tagging, hidden-instruction stripping, PII redaction | tag + sanitize |
| tool | tool allowed for agent, valid args, path inside project, domain allow-list, destructive action | block / ask user (destructive always asks, BR-14) |
| output | output contract, moderation, secret-leak detection, PII, required citations | block / redact / retry once |
| cost | max tokens per node, max cost per run, daily budget | stop run → HALTED `budget_exceeded` |
| loop | max iterations, max tool calls per node, identical output 3× | stop loop |
| data | no secrets in DB/logs/exports; file confinement | always on, cannot be disabled (BR-15) |
Actions: pass → continue · warn → continue + warning event · redact → continue with sanitized data, record the type removed, never the value (FR-GRD-014) · ask user → node WAITING + `node.approval_required`; approve continues, reject fails (FR-GRD-013) · block → GUARDRAIL_VIOLATION.
Default policy D10 / FR-GRD-018: warn on content issues; block secret leaks and tool abuse. Policies are versioned JSON, project default → agent override; every verdict is stored on the node run (FR-GRD-015). Guardrail node outputs sanitized data + verdict with pass/block branches (FR-GRD-016).

### 11.7 Routing policies (Arch §14.3, FR-RTR-001..007)
fixed (default) and fallback (A → B → C on provider/network failure) in v1 (D12); capability, cost, latency are v1.x (Could). Always record and show the model actually used (FR-RTR-006). Bench refuses anything but fixed (FR-RTR-007).

### 11.8 Prompt assembly order (Arch §12.5, FR-PRM-001..003)
system base → agent instructions → skills (fixed order) → guardrail instructions → context (summary, retrieved, memory; delimited and labelled untrusted) → reads → output contract. Placeholders `{{input.text}}`, `{{memory.key}}`, `{{run.iteration}}`; unknown placeholders fail validation. Same config → byte-identical prompt (TC-PRM-001); "View prompt" shows exactly what was sent with secrets redacted (FR-PRM-005).

### 11.9 Envelope (Arch §12.4)
```ts
Envelope = {
  id, runId, fromNodeId, toNodeId, iteration,
  reads: Part[],                        // text | image | audio | video | code | file | json — files are artifact refs
  context: {
    summary?, retrieved?: {chunkId, text, score, source}[],
    memory?: {key, value}[], budgetTokens,
    trust: 'trusted' | 'untrusted'       // guardrail tagging
  },
  contract: { outputTypes, jsonSchema?, maxTokens? },
  guardrailVerdicts?: Verdict[],
  createdAt
}
```
Tool loop inside one node (Arch §12.7): model → tool request → tool guardrail (allow / ask user / block) → tool executor → tool result → context guardrail → model, until final answer or max tool calls.

### 11.10 Ports and adapters (Arch §7)
| Port | Local adapter (v1) | Hosted adapter |
|---|---|---|
| Repository | SQLite (Drizzle) | Postgres (Drizzle) |
| VectorIndex | sqlite-vec | pgvector / Qdrant |
| KeywordIndex | FTS5 | Postgres FTS |
| Queue | in-process queue | BullMQ |
| PubSub | in-process emitter | Redis pub/sub |
| BlobStore | local folder | S3-compatible |
| SecretStore | keychain / safeStorage | secret manager / KMS |
| Sandbox | child process / Docker | container / microVM |
| Auth | session token | accounts + API keys |
`ProviderAdapter` (Arch §14.2): `type`, `check(): ProviderStatus`, `listModels(): ModelInfo[]`, `generate(req, signal): AsyncIterable<StreamChunk>`, `embed?(texts)`. Tool definition (Arch §16): name, description, input schema, output schema, permissions (`network`, `fsPaths`, `destructive`), timeout.

### 11.11 Key numbers (FRS §4, Arch §4, §12.6, §15.4, §24)
Canvas ≈60 fps at 200 nodes / 400 edges (NFR-PERF-01) · UI response < 100 ms (NFR-PERF-02) · engine overhead < 50 ms per node dispatch (NFR-PERF-03) · stream to screen < 200 ms (NFR-PERF-04) · engine start < 3 s, 200-node load < 1 s (NFR-PERF-05) · default 20 concurrent node runs (NFR-PERF-06) · Stop closes streams ≤ 2 s (FR-CTL-003) · loop max 1-50 (FR-CON-007) · undo ≥ 50 steps (FR-CAN-009) · upload default 100 MB (FR-MM-001) · logs 14 days (FR-SYS-011) · artifacts kept until unreferenced + 7 days · coverage ≥ 80% engine / ≥ 60% frontend (NFR-MAIN-02) · guardrail rule packs < 300 ms per node (NFR-SAFE-01) · corpus ≥ 95% caught, ≤ 5% false positives (NFR-SAFE-02) · chunks ~500-800 tokens, 10-15% overlap · token batching ~50 ms · mobile usable at 380 px (FR-MOB-001) · WCAG AA (NFR-USE-02) · hosted: 99.5% availability, p95 run-start < 1 s, RPO ≤ 15 min, RTO ≤ 4 h (NFR-HOST-01..03).
