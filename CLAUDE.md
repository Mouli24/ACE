# CLAUDE.md — ACE (two-person build: Arhant + Mouli)

This file is loaded by Claude Code in every session. Read all of it before touching anything.
It is the **starting file** of the team prompt pack in `docs/team-prompts/`. When this file and the spec docs disagree, the spec docs win and the conflict becomes a DECISION NEEDED (§7).

---

## 1. The project

**ACE** is a multimodal AI agent orchestration platform. Users build workflows by placing **agent nodes on a Canvas** and drawing **typed connections** between them. A run executes across any mix of **cloud** (Anthropic, Google, OpenAI), **local** (Ollama, LM Studio) and **custom OpenAI-compatible** models. Every handoff between nodes is an **envelope** (reads + bounded context + output contract), never raw chat history. **Guardrails** at seven points, **cost budgets** and **human approvals** are on by default. Every run executes from an **immutable snapshot** with an **append-only event log**, so it is traceable and reproducible.

v1 is **local and single-user**: a React/Vite SPA talking to a local Node.js/Hono engine over REST `/api/v1` and WebSocket `/ws`. Desktop (Electron) and hosted multi-tenant mode come later and reuse the same engine through ports and adapters.

**Sources of truth (read-only, never edited mid-build):**

| File | What it is |
|---|---|
| `docs/ACE-PRD.md` | Feature priorities (MoSCoW), user stories US-001..040, product states, principles |
| `docs/ACE-FRS.md` | Functional requirements `FR-*` (§3, each module header names its phase), NFRs (§4), business rules BR-01..18 (§5), use cases (§7), test cases `TC-*` (§8.6), traceability (§9), phases (§10), open issues OI-* (§11) |
| `docs/ARCHITECTURE.md` | How it is built: layers, ports/adapters (§7), orchestration (§12), guardrails (§13), model serving (§14), data (§15), tools (§16), state machines (§19), API (§20), security (§22), error kinds (§28), config (§29), code organization (§30), stack (§35), ADRs (§36) |
| `docs/DECISIONS.md` | Append-only log of every decision (D1–D17 seeded, D18+ added during the build). This is Claude's memory between sessions. |
| `docs/defect-log.md` | Every bug found after a feature merges |
| `docs/team-prompts/` | This pack: `CLAUDE.md` (this file) + `01-round-1-*.md` … `05-round-5-*.md` |

Never invent a requirement, endpoint, table, state name or behaviour. If the docs do not say it, it is a decision (§7), not a guess. Cite `FR-xxx` / `TC-xxx` / `BR-xx` / `ADR-xxx` / `Arch §n` in plans, tests, commits and reports.

---

## 2. The stack (locked — Arch §35, local column)

| Layer | Use |
|---|---|
| Web client | React 18, Vite, TypeScript, React Flow, Tailwind, shadcn/ui, Zustand (selection/panels/viewport/live overlay), TanStack Query (engine data), Monaco, react-resizable-panels, cmdk, MSW (dev/test mocks) |
| Client SDK | `@ace/sdk`: typed fetch client + WebSocket client (reconnect, `resume { afterSeq }`) generated/derived from `@ace/contracts` |
| Engine | Node.js 20 LTS, TypeScript, Hono (gateway), XState v5 (node/run state machines), Zod (all contracts), Vercel AI SDK (provider calls where possible), pino (logs) |
| Data | SQLite via better-sqlite3 + Drizzle ORM, sqlite-vec (vectors), FTS5 (keyword), local artifact folder (content-addressed), OS keychain via `keytar`-compatible lib (secrets) |
| Guardrails | Zod contracts, regex/key-format rule packs, Llama Guard via Ollama (optional, later) |
| Tools | child-process sandbox (Docker when available), SearXNG (search, optional), MCP client, unpdf, mammoth, sharp |
| Tooling | pnpm workspaces, ESM, Vitest, Testing Library, Playwright, ESLint, Prettier, GitHub Actions |

**Do not use:** Next.js for the app (Vite SPA only, ADR-003) · Python in product code · LangGraph / LlamaIndex / LangChain / CrewAI as the execution model (ADR-002) · Express / Fastify / NestJS (Hono only, ADR-004) · any ORM but Drizzle (ADR-005) · Kafka / RabbitMQ / Celery (ADR-006) · Qdrant / Pinecone / Chroma (ADR-007) · Redux / MobX / Jotai in `apps/web` · browser APIs (`window`, `document`, `localStorage`) anywhere under `packages/engine`, `packages/providers`, `packages/guardrails`, `packages/context`, `packages/tools`, `packages/storage-local`, `apps/server` · Node APIs (`fs`, `path`, `child_process`, `process.env`, `node:*`) anywhere under `apps/web`, `packages/ui`, `packages/sdk` · `any`, `@ts-ignore`, `console.*` in engine code · real API keys anywhere in the repo.

Canonical root scripts (Arhant maintains them; nobody adds alternatives):

| Script | What it does |
|---|---|
| `pnpm dev` | Starts engine (`apps/server`, port 4747) and web (`apps/web`, port 5173) together and prints the login URL with the session token |
| `pnpm dev:engine` / `pnpm dev:web` | One side only |
| `pnpm build` | Builds every package and app |
| `pnpm typecheck` / `pnpm lint` | Whole workspace |
| `pnpm test` | Unit + integration + component, every package, mock provider only, **zero env vars needed** |
| `pnpm test:e2e` | Playwright in `apps/web/e2e` against MSW mocks (Mouli's suite) |
| `pnpm test:acceptance` | Cross-tests in `tests/acceptance/**` against the **real engine** (temp DB, mock provider) + real web build |
| `pnpm test:providers` | Nightly, tagged `@provider`, real keys, excluded from `pnpm test` |

---

## 3. Team and ownership — no overlap, ever

Two developers, each with Claude Code. Ownership is by **path**, permanent for the whole build, and it is the rule that makes parallel work merge cleanly.

### 3.1 Arhant owns — the engine side

| Path | Contents |
|---|---|
| `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.base.json`, `.npmrc`, `.gitattributes`, `.gitignore`, `.editorconfig`, `.github/workflows/**` | Workspace root, CI |
| `packages/config/**` | Shared tsconfig / ESLint / Prettier presets |
| `packages/contracts/**` | **The shared contract**: every Zod schema, enum, API/WS message type, `formatVersion`. Implemented by Arhant exactly as the round's "Shared contract" section says. |
| `packages/engine/**` | Orchestration core: gateway, graph service, run service, pre-flight, scheduler, node executor, envelope engine, prompt manager, context builder, guardrails engine wiring, events, chat service, usage, ports |
| `packages/storage-local/**` | SQLite/Drizzle repository, migrations, blob store, keychain secret store, in-process queue/pubsub, sqlite-vec, FTS5 |
| `packages/providers/**` | `ProviderAdapter` interface, adapters (anthropic, google, openai, openai_compatible, ollama, **mock**), model catalog + manifest + price table, router |
| `packages/guardrails/**` | Policies, rule packs, check implementations, verdicts |
| `packages/context/**` | Parsers, chunking, embeddings, hybrid retrieval, summaries |
| `packages/tools/**` | Tool registry, sandbox, HTTP tool, web search, MCP client, media |
| `apps/server/**` | Local engine entry point (`ace-engine`), config loading, adapter wiring |
| `tests/acceptance/round-N/arhant-tests-mouli.e2e.ts` | Arhant's cross-test of Mouli's feature (Playwright against real engine + web) |
| `tests/acceptance/round-N/REPORT.md` — section "Arhant → Mouli" | His verification write-up |

### 3.2 Mouli owns — the web side

| Path | Contents |
|---|---|
| `apps/web/**` | The React/Vite SPA: routes, layout, Canvas, nodes, config panel, inspector, runs, providers UI, guardrails UI, chat, knowledge, usage, onboarding, settings, `src/mocks/**` (MSW handlers + fake WS), `e2e/**` (Playwright) |
| `packages/ui/**` | Design tokens (dark dotted canvas, provider accent colours, status rings, serif/mono), shared components |
| `packages/sdk/**` | `@ace/sdk`: typed REST client (`createAceClient`), WebSocket client with reconnect + `resume { afterSeq }`, event typing — built on `@ace/contracts` |
| `tests/acceptance/round-N/mouli-tests-arhant.test.ts` | Mouli's cross-test of Arhant's feature (Vitest over HTTP/WS against the real engine) |
| `tests/acceptance/round-N/REPORT.md` — section "Mouli → Arhant" | Her verification write-up |
| `README.md` | From-clone-to-first-run guide |

### 3.3 Shared files — append-only, tiny commits

| File | Rule |
|---|---|
| `docs/DECISIONS.md` | Append one row at a time (`D18`, `D19`, …). Pull → append → push within a minute. Never edit an existing row. |
| `docs/defect-log.md` | Append rows; the **owner** of the feature closes them. |
| `CLAUDE.md` §9 Feature Log | Each person edits **only their own rows** and only the status/SHA/date/notes cells. Structure never changes mid-round. |
| `tests/acceptance/round-N/REPORT.md` | Two sections, one per person; each edits only their own. Created by whoever merges second (from the template in the round file). |
| `tests/acceptance/fixtures/**` | Round-N fixture workflows/files: created by Arhant (he owns the engine that loads them); Mouli reads them. |

### 3.4 The rules that keep this working

1. **Never edit a path you do not own.** Not "just a one-liner", not "to unblock myself". If your feature needs a change on the other side: (a) if it is a contract change, post a DECISION NEEDED and Arhant lands it in a contracts-only PR; (b) if it is a bug, log it in `docs/defect-log.md` and the owner fixes it; (c) if it is a missing feature, it goes into the next round's prompt.
2. **`packages/contracts` is the only seam.** Each round file has a "Shared contract" section. Arhant implements it *first* (Step 0 of the round) in a small PR that Mouli reviews against the section text. Mouli codes against it — using MSW mocks until Arhant's engine feature merges. If the merged engine and the contract disagree, the contract section wins and the engine is the defect.
3. **Dependency rules (Arch §30):** `engine` imports only `contracts` and its own port interfaces · `storage-local`, `providers`, `guardrails`, `context`, `tools` implement engine ports and import `contracts` · `web` imports `sdk`, `ui`, `contracts` and never Node modules · `sdk` and `ui` import only `contracts` · apps import packages, packages never import apps.
4. **Adding a dependency** goes in *your own* package's `package.json` (never the root, except Arhant for root-level tooling). Lockfile conflicts: `git checkout --theirs pnpm-lock.yaml && pnpm install && git add pnpm-lock.yaml`. Never hand-edit the lockfile.
5. **Drizzle migrations** are timestamped and never edited once on `main`; add a new one.
6. **New folders outside your ownership map = drift.** Revert them.

---

## 4. Repository layout (owner in brackets)

```
ace/
├─ CLAUDE.md                          [shared: §9 rows only]
├─ README.md                          [Mouli]
├─ package.json  pnpm-workspace.yaml  tsconfig.base.json  .npmrc  .gitattributes  .gitignore  [Arhant]
├─ .github/workflows/                 [Arhant]  ci.yml (PR), nightly-providers.yml
├─ apps/
│  ├─ server/                         [Arhant]  local engine entry, config, adapter wiring
│  └─ web/                            [Mouli]   Vite SPA · src/app · src/canvas · src/nodes · src/config-panel ·
│                                               src/inspector · src/runs · src/providers · src/guardrails ·
│                                               src/chat · src/knowledge · src/usage · src/onboarding ·
│                                               src/settings · src/mocks · e2e/
├─ packages/
│  ├─ config/                         [Arhant]  shared tsconfig/eslint/prettier presets
│  ├─ contracts/                      [Arhant]  Zod schemas, enums, API + WS types  (the seam)
│  ├─ engine/                         [Arhant]  orchestration core + ports
│  ├─ storage-local/                  [Arhant]  SQLite/Drizzle, blobs, keychain, sqlite-vec, FTS5
│  ├─ providers/                      [Arhant]  adapters, mock, catalog, router
│  ├─ guardrails/                     [Arhant]  policies, rule packs, checks
│  ├─ context/                        [Arhant]  parsers, chunking, embeddings, retrieval
│  ├─ tools/                          [Arhant]  registry, sandbox, http, search, mcp, media
│  ├─ sdk/                            [Mouli]   typed client + WS client
│  └─ ui/                             [Mouli]   design tokens + shared components
├─ tests/
│  └─ acceptance/
│     ├─ fixtures/                    [Arhant]  fixture workflows/files per round
│     ├─ playwright.config.ts         [Arhant]  boots real engine (temp DB, mock provider) + web preview
│     ├─ vitest.config.ts             [Arhant]  boots real engine for HTTP/WS tests
│     └─ round-N/
│        ├─ arhant-tests-mouli.e2e.ts [Arhant]
│        ├─ mouli-tests-arhant.test.ts[Mouli]
│        └─ REPORT.md                 [both, own section]
└─ docs/
   ├─ ACE-PRD.md  ACE-FRS.md  ARCHITECTURE.md   (read-only)
   ├─ DECISIONS.md  defect-log.md               (shared, append-only)
   └─ team-prompts/                              (this pack)
```

Reserved for later rounds (do not create yet): `apps/desktop`, `apps/cli`, `apps/site`, `packages/storage-cloud`, `services/training`, `bench/`, `infra/`.

---

## 5. The round process

There are **5 rounds**. In every round Arhant builds one engine feature and Mouli builds one web feature, on separate branches, at the same time. A round is closed only when both features are **merged** and **cross-verified**.

```
Step 0  Arhant: contracts-only PR for the round  →  Mouli reviews vs "Shared contract" section  →  merge (same day)
Step 1  Arhant: round-N/arhant-<slug>   ║   Mouli: round-N/mouli-<slug>      (parallel, disjoint paths)
Step 2  Each opens a PR; the PARTNER reviews (§6.1) and approves; "Rebase and merge"; second merger rebases first
Step 3  Both merged → cross-testing (§6.2): Arhant tests Mouli's feature, Mouli tests Arhant's → REPORT.md
Step 4  Defects → docs/defect-log.md → OWNER fixes on round-N/fix-<owner>-<n> → re-verify
Step 5  Both rows VERIFIED → tag round-N → update Feature Log (§9) → open the next round file
```

Branch names: `round-N/arhant-<slug>`, `round-N/mouli-<slug>`, `round-N/contracts`, `round-N/fix-<owner>-<n>`.
Rebase, never merge `main` into a branch. `git fetch origin && git rebase origin/main && git push --force-with-lease`.
Commits: Conventional Commits with round + FR IDs: `feat(engine): scheduler dispatch respects provider concurrency [R2] [FR-EXE-004]`.
PR title: `feat(<scope>): <feature name> [R<N>]`; PR body = the Deliverable report from the Claude session (FR/TC table, real test output, coverage).

**Nobody starts Round N+1 until Round N is tagged.** Waiting is the correct state: review the partner's PR, run your cross-tests, close defects.

---

## 6. Review and cross-testing

### 6.1 PR review (before merge, by the partner, ≤ 20 min)
1. Coverage table in the PR body: every FR of the feature, its TC IDs, the test file. Nothing from a later round.
2. `git diff --stat` against the ownership map (§3). Anything outside = request changes.
3. Check out, `pnpm install && pnpm typecheck && pnpm lint && pnpm test`. If a test needs a key, it is a defect.
4. Grep for enum drift: `rg '"Completed"|"complete"|"Halted"|"HALT"|"ask user"' --glob '!packages/contracts/**'`.
5. Read the two most important tests; confirm they would fail if the behaviour broke.

### 6.2 Cross-testing (after both merge, mandatory, before Round N+1)

| Who | Tests whose feature | Where (file) | How |
|---|---|---|---|
| **Arhant** | **Mouli's** web feature | `tests/acceptance/round-N/arhant-tests-mouli.e2e.ts` | Playwright driving the real UI against the **real engine** (temp DB, mock provider). Plus a manual pass listed in the round file. |
| **Mouli** | **Arhant's** engine feature | `tests/acceptance/round-N/mouli-tests-arhant.test.ts` | Vitest calling the real engine over HTTP + WS through `@ace/sdk` (temp DB, mock provider). Plus a manual pass listed in the round file. |

Both run with `pnpm test:acceptance` and stay in CI forever (regression). Each round file lists exactly which TC IDs and scenarios each person must cover. The tester **never fixes** the other's code — findings go to `docs/defect-log.md` with severity (FRS §8.5: critical / high / medium / low); the owner fixes; the tester re-runs. Critical and high block the round; medium and low may be carried with a note in REPORT.md.

Outcome is written in `tests/acceptance/round-N/REPORT.md` and in the Feature Log row: `VERIFIED by <name>, <date>` or `MERGED — verification failed (D-0nn)`.

---

## 7. Non-negotiable engineering rules

- **Exact names, defined once in `packages/contracts`, imported everywhere:**
  node states `IDLE READY RUNNING WAITING COMPLETED PAUSED STOPPED BLOCKED FAILED` · run states `PREFLIGHT RUNNING PAUSED COMPLETE BLOCKED HALTED` · failure reasons `RUN_FAILED CONTRACT_VIOLATION GUARDRAIL_VIOLATION BLOCKED` · provider states `UNKNOWN CHECKING CONNECTED AUTH_FAILED UNREACHABLE RATE_LIMITED` · error kinds `user_cancelled agent provider auth network invalid_config workflow guardrail` · guardrail actions `pass warn redact ask_user block` (UI label "ask user") · guardrail points `input context tool output cost loop data` · routing policies `fixed fallback capability cost latency` · data types `text image audio video code json file` · halt reasons `stopped budget_exceeded failure shutdown crash`.
- **Envelopes, not history** (BR-02, ADR-008): every handoff is an `Envelope` (Arch §12.4); files travel as artifact references; context never exceeds `budgetTokens`.
- **Distinct states** (BR-03, BR-12): never merge `CONTRACT_VIOLATION` / `RUN_FAILED` / `GUARDRAIL_VIOLATION` / `BLOCKED`; run `COMPLETE` ≠ `HALTED`; node `COMPLETED` (note the D) ≠ run `COMPLETE`.
- **Immutable runs** (BR-04, ADR-009): snapshot written once at start; `events` is append-only with a monotonic `seq`; reconnect = `resume { afterSeq }`.
- **Engine owns truth** (BR-01): the web app renders TanStack Query data patched by WS events; graph edits are batched `graph-ops` with `baseVersion`; a 409 refetches and reapplies.
- **Security** (FR-SYS-001..003, FR-PRV-002, BR-07): engine binds `127.0.0.1` only; every REST request and WS connection carries the session token (missing/wrong → 401, WS closed); `Origin` allow-list (foreign → 403); secrets only in the keychain through `SecretStore`; API returns `keySet: true/false`, never a key; no secret in DB, logs, exports, fixtures or displayed prompts; file access confined to the project folder.
- **Untrusted by default** (BR-13): retrieved chunks, tool results and upstream outputs are labelled untrusted in the prompt and never executed as instructions.
- **Safe by default** (D10): new project policy = warn on content issues, block secret leaks and tool abuse; data guardrails cannot be disabled (BR-15).
- **Config precedence** node → project → user → engine → defaults, Zod-validated at startup (FR-SYS-010).
- **Tests:** TDD on the mock provider; `pnpm test` passes with zero env vars; tests named by TC ID — `describe("TC-EXE-005 Contract violation")` — or by FR ID when no TC exists; coverage ≥ 80 % engine-side packages, ≥ 60 % `apps/web` + `packages/ui` + `packages/sdk` (NFR-MAIN-02); never weaken a test or threshold to get green.
- **Never claim done** without pasting the real `pnpm typecheck && pnpm lint && pnpm test` summary.
- **DECISION NEEDED** — when the docs conflict, are silent, or the round file asks for something the docs do not define, stop and post exactly this, then wait:

  ```
  DECISION NEEDED — <short title>
  Where: <FR ID / Arch § / round file step>
  Conflict or gap: <what each doc says, or what is missing>
  Options: A) ... B) ... (C) ...)
  Recommendation: <one option and why, two lines>
  Blocked: <what cannot proceed until answered>
  ```
  The answer is appended to `docs/DECISIONS.md` as `| D<n> | <title> | <decision> | <affects FR/§> | <date> | <who> |` in the same session.

---

## 8. Claude Code session method (both developers)

1. `/clear`. Start in plan mode (`claude --permission-mode plan` or Shift+Tab).
2. Paste the **preamble** from the round file, then your **feature prompt** from the round file.
3. Claude reads `CLAUDE.md`, `docs/DECISIONS.md`, and only the FRS/Arch sections the prompt names (by offset/limit, never whole files).
4. Claude presents a plan with an **FR/TC coverage table** (FR ID · TC IDs · implementation file · test file) and every DECISION NEEDED. You check: all FRs present, nothing from a later round, every file inside your ownership map. Approve or push back with FR IDs.
5. Implement with TDD in small commits. One feature per session; if it does not fit, end with a handoff paragraph (done / green TCs / last SHA / next) and resume in a fresh session with preamble + paragraph.
6. Finish with the **Deliverable report**: FR/TC table with status, real `pnpm test` output, coverage per package, `typecheck`/`lint` output, files changed, open DECISION NEEDED items. Paste it into the PR body.

---

## 9. Feature Log — update every time a feature is completed

Status values: `TODO` → `IN PROGRESS` → `IN REVIEW` → `MERGED` → `VERIFIED` (or `BLOCKED`). Edit **only your own rows**. `VERIFIED` is written by the **partner** after cross-testing.

| Round | ID | Feature | Owner | Branch | Status | Merged SHA | Date | Verified by | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 1 | C1 | Round 1 contract (enums, graph entities, graph-ops, errors, settings, WS core) | Arhant | `round-1/contracts` | VERIFIED | 4a85aea | 2026-09-23 | Mouli (review) | Step 0; reached `main` inside PR #2, no separate contracts PR. Exercised end-to-end by both cross-test suites — `ApiError`, `WorkflowExport`, the graph-ops union and the WS frames are all asserted against the real engine, and `packages/contracts` is 276/276 green. D-001 was a C1 defect (a `.partial()` patch schema still re-applying `.default()`); fixed in 3c610e5 and now carries a permanent regression test. |
| 1 | A1 | Engine skeleton: workspace, storage, gateway, projects + workflows API, event log + WS hub | Arhant | `round-1/arhant-engine-skeleton` | VERIFIED | 4a85aea | 2026-09-23 | Mouli | Cross-tested in PR #9 by `tests/acceptance/round-1/mouli-tests-arhant.test.ts` — 26 scenarios over HTTP + WS through `@ace/sdk`, all green. Report: `tests/acceptance/round-1/REPORT.md`. §8.2 manual pass now complete: clean clone green with no env vars (701 unit tests), LAN `curl` refused at the socket (`BIND_HOST` is `127.0.0.1` only, confirmed with `netstat`), `kill -9` mid-burst then restart leaves the DB open with every batch whole and no dangling edges. Findings D-002, D-007, D-008 fixed and re-verified; D-010 (formatting drift on the D-007 fix) closed on review of #9. |
| 1 | M1 | Web shell + Canvas: layout, React Flow canvas, nodes, typed connections, config panel, SDK v1 | Mouli | `round-1/mouli-web-canvas` | VERIFIED | 19ce6d0 | 2026-09-23 | Arhant | Cross-tested by `tests/acceptance/round-1/arhant-tests-mouli.e2e.ts` (13/13 green, real engine + real build). Findings D-003..D-006 fixed and re-verified. Report: `tests/acceptance/round-1/REPORT.md`. Both cross-tests, the report and the fixes are on **PR #9** (CI green) awaiting Arhant's review. Decisions from this work: D28–D32 |
| 2 | C2 | Round 2 contract (providers, models, runs, node runs, envelope, run events) | Arhant | `round-2/contracts` | TODO | | | Mouli (review) | Step 0 |
| 2 | A2 | Providers + model catalog + router + run engine (snapshot, pre-flight, scheduler, executor, envelopes, prompts, streaming) | Arhant | `round-2/arhant-providers-execution` | IN REVIEW | | 2026-09-24 | Mouli | PR #12, rebased on `main`; review round 1 addressed. Green with zero env vars: typecheck, lint, build, test 1389 passed + 3 todo (contracts 474 · engine 439 · providers 146 · storage-local 98 · server 43 · web 127 · ui 39 · sdk 23). Coverage stmts/branches: engine 93.2/84.3 · providers 94.2/81.8 · storage-local 98.4/88.1 · server 96.5/81.6 · contracts 99.7/93.9. NFR on this machine: TC-NFR-002 0.35 ms dispatch per node · TC-NFR-003 first `node.token` 49.7 ms after the adapter yielded · TC-NFR-005 22 nodes at concurrency 20, no errors. `POST /workflows/:id/runs` answers at pre-flight, not at the end (D65); `GET /providers` is `{ items }` (D64). Decisions D51-D65 (C2's and A2's, renumbered per D42). Not here: TC-PRV-008 (D56, rounds 6+); TC-EXE-009 and TC-EXE-013 client halves land with M2; TC-RTR-006 `todo` per D12. Fixtures: `tests/acceptance/fixtures/round-2/` — the provider id is a placeholder the harness rewrites. |
| 2 | M2 | Providers & models UI + run UI (start, live states, streaming, inspector, view prompt, history) + SDK WS resume | Mouli | `round-2/mouli-providers-run-ui` | IN PROGRESS | | 2026-09-24 | Arhant | All 11 items of R2 §5 built. SDK v2 + `RunEventBuffer` (edfcf70) · mock engine, scenarios, prompts, node runs (ad3e4da, 9a99574) · `@ace/ui` status ring / streaming text / provider chip (c517be4) · providers screen, live chips, models catalogue (f16120a) · config panel model picker + fallback editor, Start + input dialog, live Canvas overlay, inspector + View prompt, runs screens, resilience (this commit). Green: typecheck, lint, `pnpm test` 1030 (web 212 in 33 files), `pnpm test:e2e` incl. 10 new round-2 specs. Decisions D43–D49. Note: two Claude sessions shared this worktree for part of M2 (D49); `packages/ui` came from the second. Next: PR for Arhant's review, then cross-tests |
| 3 | C3 | Round 3 contract (controls, approvals, guardrail policies/verdicts, loop + merge config, review contract) | Arhant | `round-3/contracts` | TODO | | | Mouli (review) | Step 0 |
| 3 | A3 | Run controls + error model/retries + guardrail engine (input/output/cost/loop, actions, approvals) + parallel/merge + loop edges | Arhant | `round-3/arhant-control-guardrails-loops` | TODO | | | Mouli | |
| 3 | M3 | Controls toolbar + error cards + approval card + policy editor + verdicts + merge/loop UI + iterations + events/errors panel | Mouli | `round-3/mouli-control-guardrails-ui` | TODO | | | Arhant | |
| 4 | C4 | Round 4 contract (artifacts, tools, tool calls, MCP servers, messages, chat threads) | Arhant | `round-4/contracts` | TODO | | | Mouli (review) | Step 0 |
| 4 | A4 | Artifact store + multimodal envelopes + tool registry/loop/sandbox/HTTP/search/MCP + tool guardrails + chat service | Arhant | `round-4/arhant-multimodal-tools-chat` | TODO | | | Mouli | |
| 4 | M4 | Uploads/drop + typed output renderers + chat panel (timeline, direct chat) + tools UI + tool calls in inspector | Mouli | `round-4/mouli-multimodal-chat-ui` | TODO | | | Arhant | |
| 5 | C5 | Round 5 contract (knowledge bases, chunks, retrieval node, memory, usage, trace, templates, backup) | Arhant | `round-5/contracts` | TODO | | | Mouli (review) | Step 0 |
| 5 | A5 | Knowledge bases (ingest, hybrid search, retrieval node) + context builder/summaries/context guardrails + memory + usage/trace + templates + export/import/backup | Arhant | `round-5/arhant-knowledge-memory-usage` | TODO | | | Mouli | |
| 5 | M5 | Knowledge screens + retrieval/sources UI + memory view + usage/trace views + onboarding wizard + canvas productivity + settings + responsive | Mouli | `round-5/mouli-knowledge-onboarding-ui` | TODO | | | Arhant | |

### 9.1 Round gates

| Round | Contract merged | A merged | M merged | Cross-tests green | Tag | Date | Notes |
|---|---|---|---|---|---|---|---|
| 1 | inside A1's PR (no separate `round-1/contracts` PR) | 4a85aea | 19ce6d0 | green on `main` (126de3d) — 33 vitest + 13 e2e, plus the 5 §8.1 manual-pass checks | `round-1` | 2026-09-23 | Done since the last update: PR #9 reviewed and merged · every manual check REPORT.md listed as **not done** now run and recorded with its output (clean clone, LAN curl, `kill -9` during a burst; pane resize, 3,000-character paste, engine killed mid-drag, browser zoom) · C1 and A1 set to VERIFIED. **Still open: the §1 demo script walked by both against the real engine** — every step of it is covered automatically by the e2e suite, but "by both" is the one thing a suite cannot stand in for. Open defect: D-009 against M1 (a 401 shown as "Workflow not found."), Medium, does not block the gate. |
| 2 | | | | | `round-2` | | |
| 3 | | | | | `round-3` | | |
| 4 | | | | | `round-4` | | |
| 5 | | | | | `round-5` | | |

### 9.2 After Round 5 (not yet prompted — Rounds 6+)
Skills + prompt library (SKL, FR-PRM-006/007) · Custom nodes (CUS) · Git workspace, code panel, replay, diffs (GIT) · ACE Bench (BEN) · Guardrail node (FR-GRD-016) · local classifier (FR-GRD-017) · Langfuse/Sentry (FR-OBS-005/006) · CLI providers (FR-PRV-008) · smart routing (FR-RTR-003..005) · audio transcription (FR-MM-008) · Testing & QA phase (FRS §8.4 exit, UAT §8.7) · Hardening (NFR suites) · Desktop (DSK) · CLI + OpenAPI (CLI) · native mobile (post-v1). Same ownership map applies when these are prompted.

---

## 10. Quick reference

**Node state machine (Arch §19.1):** IDLE→READY (inputs available) · IDLE→BLOCKED (upstream failed) · READY→RUNNING (dispatched) · READY→PAUSED / PAUSED→READY · RUNNING→WAITING (ask_user) · WAITING→RUNNING (approved) · WAITING→FAILED (rejected, GUARDRAIL_VIOLATION) · RUNNING→COMPLETED · RUNNING→FAILED (RUN_FAILED / CONTRACT_VIOLATION / GUARDRAIL_VIOLATION) · RUNNING→STOPPED (user stop) · FAILED→READY (retry, attempt+1) · COMPLETED→READY (re-run / loop iteration).

**Run state machine (Arch §19.2):** PREFLIGHT→BLOCKED (issues, zero provider calls) · PREFLIGHT→RUNNING · RUNNING⇄PAUSED · RUNNING→HALTED (stop / budget_exceeded / unrecoverable failure / shutdown / crash) · RUNNING→COMPLETE (nothing RUNNING/READY/WAITING and every Output node COMPLETED).

**Error kinds (Arch §28):** user_cancelled → STOPPED, no retry · agent → once (contract repair) · provider (5xx/429) → retry with backoff · auth (401/403) → no retry, provider AUTH_FAILED · network → retry with backoff · invalid_config → BLOCKED at pre-flight · workflow → BLOCKED · guardrail → GUARDRAIL_VIOLATION.

**Envelope (Arch §12.4):** `{ id, runId, fromNodeId, toNodeId, iteration, reads: Part[], context: { summary?, retrieved?, memory?, budgetTokens, trust }, contract: { outputTypes, jsonSchema?, maxTokens? }, guardrailVerdicts?, createdAt }`.

**Prompt assembly order (Arch §12.5):** system base → agent instructions → skills → guardrail instructions → context (summary, retrieved, memory — delimited, labelled untrusted) → reads → output contract. Same config → byte-identical prompt.

**Guardrail points → default action (Arch §13.1):** input warn/block · context tag+sanitize · tool block/ask_user (destructive always asks) · output block/redact · cost HALTED `budget_exceeded` · loop stop loop (identical output 3×) · data always on.

**Ports (Arch §7):** Repository · VectorIndex · KeywordIndex · Queue · PubSub · BlobStore · SecretStore · Sandbox · Auth — interfaces in `packages/engine/src/ports/`, local adapters in `packages/storage-local` (and `packages/tools` for Sandbox).

**Key numbers:** Canvas ≈60 fps @ 200 nodes/400 edges · dispatch overhead < 50 ms · stream to screen < 200 ms · Stop cancels ≤ 2 s · loop max 1–50 · undo ≥ 50 · upload ≤ 100 MB default · 20 concurrent node runs default · token batching ~50 ms · chunks 500–800 tokens, 10–15 % overlap · mobile usable at 380 px · logs kept 14 days · coverage 80/60.

**Ports and URLs:** engine `http://127.0.0.1:4747` (`/api/v1`, `/ws`, `/health`) · web dev `http://localhost:5173` · token printed by the engine at start and passed as `?token=` on first load, stored in `sessionStorage`, sent as `Authorization: Bearer` on REST and `?token=` on WS.
