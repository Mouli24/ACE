# Post-v1 Phases 18–21 — Outline (not build prompts)

> **BANNER — DO NOT START ANY OF THESE PHASES BEFORE v1 LAUNCH FEEDBACK.** Decision D15 (docs/DECISIONS.md; FRS OI-13; Arch §39) fixes the start of hosted mode as "after v1 launch feedback", i.e. after Phase 17 has shipped and users have been heard. Arch §38 rates "scope creep from hosted features" a High-likelihood risk: hosted work only after v1 launch. This file exists so that Phases 0–17 leave the doors open; it is NOT a licence to build any of it during v1. Full build prompts for 18–21 are written only once D15 is closed.

**Sources.** docs/ACE-FRS.md §3.29–§3.32, §4 (NFR-HOST-01..05, NFR-PORT-01, NFR-VER-01), §5 (BR-07, BR-16, BR-17, BR-18), §8.2, §8.6 "Hosted, Hosted Models, Fine-Tuning", §10; docs/ARCHITECTURE.md §7, §9.2, §11, §13.2, §14, §15, §16, §17, §18.2–18.4, §20, §22, §23, §25, §26, §27, §29, §30, §32, §33.3, §34; docs/DECISIONS.md D11, D15, D17; docs/ACE-PRD.md US-039, US-040.
**Ordering.** Phase 18 is the prerequisite for 19 and 20 (accounts, workers, GPU pool, registry). 19 and 20 are optional (FRS §10). 21 needs the Phase 17 SDK and, in practice, Phase 18: a phone cannot reach an engine bound to 127.0.0.1 (FR-SYS-001).
**Conventions carried over from v1.** Tests named by TC ID, e.g. `describe("TC-HOST-007 Cross-tenant access")`; CI runs on the mock provider (FR-PRV-010) with no API keys; root scripts `pnpm test`, `pnpm test:e2e`, `pnpm test:providers`; `/api/v1` additive only; exact state, reason, error-kind and provider-state names from the contracts.
**Where v1 prompts must cite this file.** Phase 1 (contracts + DB: items 18.1, 18.6, 18.7, 20.3), Phase 2 (gateway: 18.5, 18.10), Phase 5 (executor/events: 18.3, 18.4, 18.8), Phase 6 (approval payload: 21.3), Phase 13 (bench hash: 20.1), Phase 17 (SDK/export: 18.7, 21.1, 21.2).

---

## Phase 18 — Hosted platform (HOST)

**Goal.** Run the unchanged `packages/engine` in Mode B (Arch §7): multi-user, teams, metering, billing and tenant isolation, achieved by swapping adapters only (NFR-PORT-01, P7, ADR-016).
**Modules / FR IDs.** HOST FR-HOST-001..015; BR-07, BR-18; NFR-HOST-01..05; US-039; TC-HOST-001..010; test level "Tenant isolation (hosted)" (FRS §8.2).
**Arch sections.** §7, §9.2, §11, §13.2 (hosted column), §15.1, §15.3 hosted tables, §15.4, §18.2–18.4, §20.1 (`Idempotency-Key`), §20.2 "Hosted only", §22, §23, §25, §26, §27, §29 (Hosted row), §33.3 hosted routes; D11 (self-hosted auth library), D17 (retention 30/90/365 days).
**Key work items.**
- `apps/server`: gateway + API entry behind Caddy/Nginx TLS; Hono middleware chain auth → rate limit → Zod validation; request ID + OpenTelemetry trace ID on every request.
- Auth (D11, self-hosted library such as Better Auth / Auth.js): email + OAuth sign-up, login, logout, password reset; optional MFA; sessions; scoped API keys hashed at rest (revoked key → 401).
- Tables `users`, `workspaces`, `memberships`, `api_keys`, `usage_records`, `subscriptions`, `audit_log` (§15.3); roles owner/editor/viewer; invite and remove members by email; audit log of logins, key changes, policy changes, deletions.
- Tenant isolation (§23): `workspace_id` on every tenant-owned row, enforced in the repository layer AND by Postgres row-level security; workspace-prefixed S3 keys; workspace identity on sandbox and worker jobs; no cross-workspace cache keys.
- Rate limits: Redis token bucket per user / API key / workspace / route → 429 with retry time.
- Metering and billing: per-node-run usage aggregated per workspace/day; plans; Stripe (test mode first); plan limits and workspace budgets halt runs with reason `plan_limit`; `usage.updated` WS event.
- `Idempotency-Key` on `POST /workflows/:id/runs`: duplicate request returns the same run.
- Retention jobs by plan (D17) for runs, node runs and events; artifacts unreferenced + 7 days; logs 30 days; daily backups + PITR (RPO ≤ 15 min, RTO ≤ 4 h).
- Local → hosted move (FR-HOST-014): import the v1 export bundle (workflows, KBs, skills); secrets excluded; provider keys re-entered.
- Workers: BullMQ engine workers + ingestion workers, stateless, scaled on queue depth; worker crash → job redelivered; node runs idempotent by attempt ID (§25).
- Hosted guardrail extras (§13.2): Presidio PII service, hosted injection classifier, Llama Guard via provider endpoint or vLLM, workspace-level policies.
- `apps/site` (Next.js, ADR-003): home, features, pricing, docs; linked from `/login` (FR-HOST-015).
- Infra: Docker images web/gateway/api/workers/ingestion/sandbox; Terraform; staging with synthetic data; pipeline tag → images → deploy staging → smoke → prod; Prometheus + Grafana, central logs, Langfuse, Sentry; alerts per §26.
**Adapters to implement (Arch §7 port table)** — in `packages/storage-cloud` unless noted: `Repository` → Postgres (Drizzle) · `VectorIndex` → pgvector (Qdrant only at scale, ADR-007) · `KeywordIndex` → Postgres FTS · `Queue` → BullMQ · `PubSub` → Redis pub/sub · `BlobStore` → S3-compatible · `SecretStore` → cloud secret manager / KMS · `Sandbox` → container / microVM with gVisor or Firecracker (`packages/tools`) · `Auth` → accounts + API keys (`apps/server`).
**Done when.** TC-HOST-001..010 pass; automated cross-workspace tests prove NFR-HOST-04; `pnpm test` still runs the engine suite on SQLite and the same integration suite passes on Postgres; staging meets NFR-HOST-01/02 under load; the `packages/engine` diff for this phase is adapter wiring only.
**v1 must not break this.**
1. **`workspace_id` column strategy (Phase 1).** Local mode has one implicit workspace (§15.2). Every repository method takes a scope (`{ workspaceId }`) from day one and local passes the implicit ID. Tenant-owned tables get `workspace_id` either now (one default workspace row) or through a forward-only, backfillable migration. Nothing inside `packages/engine` may assume "there is only one tenant".
2. **Ports are interfaces in `packages/engine`** (`Repository`, `VectorIndex`, `KeywordIndex`, `Queue`, `PubSub`, `BlobStore`, `SecretStore`, `Sandbox`, `Auth`); `storage-local` implements them (§30 dependency rules). No SQLite-specific SQL, driver types or file paths leak into engine; the Drizzle schema uses column types and one timestamp convention that map to both dialects (ADR-005).
3. **Stateless engine.** Scheduler and run state live in the DB, not in module singletons; the node executor is re-entrant; `node_runs` carry an attempt ID so a redelivered job is idempotent (§25).
4. **Events.** Per-run monotonic `seq` persisted in `events`; `resume { afterSeq }` replays from the table, never from an in-memory buffer (§21.4); the WebSocket hub reads through the `PubSub` port, not from the scheduler directly.
5. **Auth port.** Route handlers see a `Principal` (user, workspace, roles, key scopes) produced by middleware and never read the raw token; the middleware chain stays composable so rate limiting slots in later.
6. **Contracts reserve hosted vocabulary.** Halt reason `plan_limit` next to `shutdown` and `budget_exceeded` (halt reasons are an additive enum; no exhaustive switches that throw on unknown values); 429 with retry-after expressible in the error envelope (`details` open, `retryable: true`); endpoint groups `/auth/*`, `/workspaces`, `/members`, `/api-keys`, `/usage`, `/billing` and SPA routes `/login`, `/signup`, `/account`, `/team`, `/api-keys`, `/usage` are reserved (§20.2, §33.3).
7. **Secrets excluded from exports** (BR-07, NFR-SEC-02, §22.2 "export filter"). DB rows hold secret references from the `SecretStore`; workflow files, project exports, backups (FR-SYS-012) and `ace export` carry provider IDs only. The Phase 17 export bundle (workflows, KBs, skills, with `formatVersion`) is the hosted import format — design it as such.
8. **Metering data shape.** Usage per node run with timestamp, provider, model, tokens, cost and price-table version (FR-OBS-002/003), so it can be re-aggregated per workspace/day without re-reading events.
9. **Config via env + Zod** (§29): no hard-coded data-folder paths in engine; retention and artifact GC run as scheduled jobs through the `Queue` port so plan-based retention is configuration, not new code.
10. **Logs.** pino JSON with redaction and a request ID on every line; keep a trace-ID field free for OTel.
11. **Test harness parameterised by storage adapter** (temp SQLite today) so the Phase 18 Postgres run reuses the v1 integration suite unchanged; fixtures never assume SQLite.
12. **No browser/Node leakage.** `web` never imports Node modules, `engine` never imports browser APIs (§30): the engine must boot inside a headless BullMQ worker with no Electron or DOM present.
13. **`apps/site` stays public-site only** (ADR-003); v1 user docs are Markdown under `docs/` so the site can render them.

---

## Phase 19 — Hosted models (HMOD, optional)

**Goal.** Serve selected open models on an ACE-run GPU pool (vLLM or TGI) as "ACE hosted" catalog entries, autoscaled with demand and metered like every other provider.
**Modules / FR IDs.** HMOD FR-HMOD-001..003; BR-16; TC-HMOD-001; MOD, RTR and OBS unchanged.
**Arch sections.** §9.2 (VLLM node), §13.2 (Llama Guard on vLLM), §14.1 "Self-hosted open models" row, §14.2, §14.3, §14.4, §18.2 GPUs, §26, §27; ADR-014.
**Key work items.**
- `packages/providers`: a `vllm`/`tgi` `ProviderAdapter` (OpenAI-compatible transport, ACE-managed endpoint, no user key): `check()` → CONNECTED / UNREACHABLE / RATE_LIMITED, `listModels()` from the pool manifest, streaming `generate()`, optional `embed()`.
- Catalog: hosted entries flagged "ACE hosted" with the standard fields (§14.4) plus an internal price row in the versioned manifest so cost is estimated like any provider.
- GPU pool: vLLM/TGI node pool autoscaled on request queue / GPU utilisation (§18.2); per-model concurrency limits and backoff; capacity exhaustion → error kind `provider`, retryable, provider state RATE_LIMITED.
- Metering: tokens and cost per node run into `usage_records` (FR-HMOD-003); visible in Usage by provider/model/day.
- Hosted moderation: Llama Guard served from the same pool (§13.2); nightly `pnpm test:providers` contract tests against a staging pool; scale-up load test.
**Adapters.** No new §7 port. One new `ProviderAdapter` (§14.2) in `packages/providers`; infra only in `infra/` (Terraform / k8s GPU pool).
**Done when.** TC-HMOD-001 passes; "ACE hosted" models appear in the catalog and are eligible for fallback/capability/cost/latency routing; the autoscale load test passes; usage totals match metered tokens.
**v1 must not break this.**
1. `ProviderAdapter` (§14.2) is the only extension point: no `switch (provider.type)` special cases in the engine, scheduler or pre-flight.
2. The OpenAI-compatible adapter accepts a custom base URL and a keyless configuration (Ollama and LM Studio already need this); provider states UNKNOWN, CHECKING, CONNECTED, AUTH_FAILED, UNREACHABLE, RATE_LIMITED are the whole status vocabulary.
3. `ModelInfo` / catalog schema is additive (room for a hosted/origin tag); pricing lives in the versioned manifest (FR-OBS-003), never in code.
4. Router policies (fixed and fallback in v1; capability, cost, latency in v1.x) read only catalog fields, so a hosted model needs no router change; bench runs keep fixed routing (BR-16).
5. Concurrency and backoff are per provider instance, not global constants; the mock provider remains the only CI provider and real-endpoint tests stay tagged for `test:providers`.

---

## Phase 20 — Fine-tuning (TRN, optional)

**Goal.** Turn consented, PII-free graded results into LoRA/QLoRA adapters for small open models in defined roles (reviewer/judge, router, guardrail classifier), gate them on ACE Bench, register and deploy them.
**Modules / FR IDs.** TRN FR-TRN-001..007; BR-06, BR-17; US-040; TC-TRN-001..003; reads BEN (FR-BEN-002, 004, 006, 008).
**Arch sections.** §9.2 (training service → registry → vLLM), §17, §13.2 (classifier roles), §14.4, §18.2 (training image), §30 `services/training`; ADR-015.
**Key work items.**
- `services/training` (Python: Hugging Face Transformers + PEFT or Unsloth; containerised): dataset builder, PII removal (Presidio), trainer, evaluator. Talks to ACE only through the generated OpenAPI client with a scoped API key (FR-HOST-005) and the `BlobStore` for datasets and adapters — never the database directly.
- Consent: per-user "share graded runs for training" flag; the dataset builder admits only consented records (FR-TRN-001) and fails the build if any frozen `bench_tasks` hash appears (FR-TRN-003, BR-17).
- Model registry table: version, base model, dataset hash, metrics, approval status; only approved rows are deployable (FR-TRN-006).
- Eval gate: candidate vs baseline on the non-frozen ACE Bench split through the bench service; report attached to the registry row (FR-TRN-005).
- Deploy: approved adapters → Phase 19 vLLM pool, or GGUF export selectable in Ollama (FR-TRN-007); catalog shows base model + version.
- New additive endpoint group (`/training/*`, hosted only); job dispatch through the `Queue` port; training image in the §18.2 image list.
**Adapters.** None new in the §7 table: reuses the Phase 18 `Sandbox` (container) for jobs, `BlobStore` for datasets/adapters, `Queue` for dispatch and `Repository` for the registry.
**Done when.** TC-TRN-001..003 pass; a non-consented or PII-bearing record never reaches a dataset; a frozen-task leak fails the build; only an approved model is selectable in the catalog.
**v1 must not break this.**
1. Freeze hash (FR-BEN-002) is computed over canonical JSON of the task and stored on `bench_tasks`; bench runs stay separate from normal runs (FR-BEN-008) and keep workflow/prompt/model snapshots and imported scores in queryable columns (FR-BEN-004/006).
2. Runs, node runs, outputs and artifacts remain immutable and reconstructable (ADR-008/009): referenced, never overwritten.
3. `runs`, `bench_runs` and settings schemas stay open to additive columns (the consent flag arrives later; migrations forward-only, §32).
4. Guardrail PII and secret-leak rule packs are pure, importable functions in `packages/guardrails`, usable by the dataset builder outside the node loop; redaction records the type removed, never the value.
5. The Ollama adapter accepts user-supplied/custom model IDs (GGUF imports) so exported adapters are selectable locally.
6. The OpenAPI document generated from contracts (FR-CLI-007) is complete enough for a non-TypeScript client; `pnpm test` never needs Python; the `services/training` path stays reserved and empty.

---

## Phase 21 — Mobile app (MOB-004, optional)

**Goal.** A native React Native app for monitoring runs and answering guardrail approvals, built on the Phase 17 SDK; workflow building stays on desktop/web (Arch §10.3).
**Modules / FR IDs.** FR-MOB-004 (builds on FR-MOB-001..003 responsive views, Phase 17; TC-MOB-001/002); FR-GRD-006/011/013 approvals ("ask user" → node WAITING; approve/reject); FR-CLI-006 SDK; FR-HOST-001/005 for sign-in. New TC-MOB-003+ are added to FRS §8.6 when the phase is prompted.
**Arch sections.** §10.3, §10.5, §11 (auth), §20.2 Runs/Approvals, §20.3, §21.2, §21.4, §22.2 (repudiation: approval events carry user + timestamp), §33.3.
**Key work items.**
- `apps/mobile` (React Native / Expo; add to §30 when started) on `packages/sdk`: sign-in (hosted account or API key), runs list, run detail (state, trace, outputs, cost), approval inbox with content preview and approve/reject, read-only chat, provider status.
- Live updates over the gateway WebSocket with `resume { afterSeq }`; cached last-known state when offline.
- Push notifications for `node.approval_required` and `run.completed|paused` via a server-side event subscriber (hosted); deep links to `/runs/:runId`.
- Store builds (iOS/Android) from CI; simulator E2E on the mock provider.
- Open decision to record at start: reaching a local engine from a phone (engine binds 127.0.0.1, FR-SYS-001) — hosted only, or an explicit desktop pairing opt-in.
**Adapters.** None new in the §7 table on the server; the app consumes the hosted `Auth` adapter (sessions / scoped API keys) and `PubSub` fan-out through the gateway.
**Done when.** App shows runs and approvals (FR-MOB-004 acceptance); approving from the phone moves a WAITING node on (TC-GRD-008 behaviour); reconnect replays missed events; store builds ship from CI.
**v1 must not break this.**
1. `packages/sdk` is platform-neutral: generated from contracts, uses standard `fetch` and `WebSocket`, no `node:` imports or hard `ws` dependency, transport injectable (browser, Node, Electron, Hermes).
2. The SDK event-stream helper supports `subscribe`, `unsubscribe` and `resume { afterSeq }`; WebSocket auth accepts a bearer token outside cookies.
3. The `node.approval_required` payload is self-contained for a small screen: run ID, node run ID, node name, guardrail point, reason, content preview, allowed decisions — no graph fetch needed; approve/reject endpoints record user and timestamp.
4. Run, approval and chat view logic (selectors, formatting, state derivation) lives in platform-neutral modules separate from DOM components, so React Native reuses the logic even though it cannot reuse `packages/ui` components.
5. `/runs/:runId` and approval screens are deep-linkable (§33.3); the event bus allows server-side subscribers (the future notification dispatcher) besides the WebSocket hub.
6. Responsive views (FR-MOB-001..003) are usable at 380 px in Phase 17; the read-only Canvas is a web requirement, not a mobile-app one.
