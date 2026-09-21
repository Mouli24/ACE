# 01 — Kickoff Prompt (Phase 0: Foundations)

**What this is.** The very first message you paste into Claude Code to start building ACE. It runs Phase 0 only: the monorepo, tooling, CI, decisions and ADRs. No product features.

**When to paste it.** In an EMPTY repository, after you have:
1. copied `CLAUDE.md` to the repo root;
2. copied `ACE-PRD.md`, `ACE-FRS.md`, `ARCHITECTURE.md` into `docs/`;
3. copied this folder to `docs/build-prompts/` (it must contain `phase-00-foundations.md`).

Open Claude Code in the repo root and paste everything inside the fenced block below as one message.

---

## The kickoff prompt

```text
We are starting a new project called ACE. ACE is a multimodal AI agent orchestration platform: a visual Canvas where users connect agent nodes and run workflows across cloud, local and custom models. Every handoff between nodes is an envelope (never chat history); runs are immutable snapshots with append-only events; guardrails, budgets and human approvals are on by default; and a governed benchmark (ACE Bench) measures it. v1 is a local web app (React/Vite SPA + Node.js/Hono engine), then an Electron desktop app. Hosted multi-tenant mode is post-v1.

We build it phase by phase, one phase per Claude Code session, from prompt files in docs/build-prompts/. This session is Phase 0: Foundations. Nothing from later phases gets built today.

STEP 1 — READ (do not skim, do not guess)
- CLAUDE.md (repo root)
- docs/ACE-PRD.md — priorities, user stories US-001..040, product principles
- docs/ACE-FRS.md — §1 (esp. §1.3 definitions), §2 (esp. §2.4 constraints), §5 business rules, §10 phase list, §11 open issues
- docs/ARCHITECTURE.md — §3 principles P1–P10, §7 deployment modes and port/adapter table, §30 code organization and dependency rules, §35 tech stack, §36 ADRs, §39 open decisions; also §18.4 CI pipeline and §31 testing architecture
- docs/build-prompts/phase-00-foundations.md — the detailed spec for this session. If it and this message disagree, the phase file wins.

These documents are the only sources of truth. If they conflict or are silent on something you need, stop and post a "DECISION NEEDED" block with the options and your recommendation instead of guessing.

STEP 2 — PLAN (enter plan mode; present the plan; wait for my approval)
Produce a Phase 0 plan that covers, at minimum:

1. pnpm workspace monorepo laid out EXACTLY as Arch §30: apps/web, apps/desktop, apps/site, apps/cli, apps/server; packages/contracts, engine, providers, guardrails, context, tools, storage-local, storage-cloud, sdk, ui, config; services/training; bench/; infra/; docs/. Every apps/* and packages/* directory gets a package.json, a tsconfig.json extending the shared config, a src/index.ts (may export nothing yet) and a README.md one-liner — even if it is otherwise empty. Package names follow one scheme (e.g. @ace/contracts, @ace/engine).
2. TypeScript strict mode everywhere, with shared tsconfig / ESLint / Prettier presets living in packages/config (Arch §30). Encode the §30 dependency rules where tooling allows (ESLint no-restricted-imports or equivalent): engine depends on contracts and interfaces only; storage-* implement engine ports; web never imports Node modules; engine never imports browser APIs.
3. Test wiring: Vitest for unit + integration, Vitest + Testing Library for component, Playwright for E2E (Arch §31). Test files are named by test-case ID, e.g. describe("TC-EXE-005 Contract violation"). Provider contract tests are tagged so they only run under pnpm test:providers with real keys; everything else runs on the mock provider with no API keys.
4. Canonical root scripts, exactly these names: pnpm dev, pnpm build, pnpm typecheck, pnpm lint, pnpm test (unit + integration + component), pnpm test:e2e, pnpm test:providers (nightly, tagged, real keys). Each must succeed on the empty skeleton (a workspace with zero tests must still exit 0).
5. GitHub Actions per Arch §18.4: a PR workflow running lint → typecheck → unit → integration → component → E2E (mock) → build; a scheduled nightly workflow on main for provider contract tests (skips cleanly when secrets are absent); a tag workflow stub for installer builds (Phase 16 fills it in). No CI job needs API keys.
6. docs/DECISIONS.md recording D1–D17 using the recommended answers from Arch §39 and FRS §11. The "Build Blueprint" that §39 cites for D1–D8 is NOT in this repo; derive D1–D8 from the ADRs, FRS and PRD as follows, citing the source next to each:
   D1 runtime = TypeScript/Node engine, Hono gateway, Vite SPA, Electron later (ADR-001, ADR-003, ADR-004, FRS §2.4).
   D2 node dragging = free dragging plus an auto-layout button (ADR-010, FR-CAN-004).
   D3 loops = only via loop edges with a max-iterations limit (ADR-011).
   D4 pause = no new dispatch, running nodes finish, run shows PAUSED (FR-CTL-001).
   D5 mid-run edits = the run keeps its snapshot; edits apply to the next run with a notice (FR-EXE-002, FR-NODE-009, ADR-009).
   D6 multimodal = files move between nodes as artifact references, never inline copies (FR-MM-004).
   D7 custom nodes = HTTP manifest nodes and sandboxed script nodes, both in v1 (OI-03, FR-CUS-001/002/005).
   D8 self-improvement = out of scope for v1 (FRS §1.2, PRD "Won't").
   D9 add GUARDRAIL_VIOLATION as a distinct failure reason (yes). D10 guardrail default = warn for content, block for secrets and tool abuse. D11 hosted auth = self-hosted library. D12 router v1 = fixed + fallback. D13 sandbox = child process, Docker when available. D14 web search = SearXNG. D15 hosted mode starts after v1 launch feedback. D16 MCP tools in v1 = yes (Should). D17 hosted retention = 30/90/365 days by plan.
   Also list the remaining FRS §11 items (OI-01..06, OI-16) as OPEN with their needed-by phase. Give DECISIONS.md a short "how to add a decision" section; later phases append to it.
7. docs/adr/ with one file per ADR-001..016 from Arch §36 (title, status, context, decision, consequences). Keep the statuses as §36 states them (Accepted / Locked / Proposed).
8. A mock provider stub in packages/providers implementing the ProviderAdapter shape from Arch §14.2 (type, check, listModels, generate as an AsyncIterable of chunks, optional embed) with deterministic outputs and a way to simulate errors (FR-PRV-010). Use minimal local types for now; Phase 1 replaces them with packages/contracts. Include one unit test: describe("TC-PRV-010 Mock provider").
9. README.md at the root: what ACE is, prerequisites (Node LTS, pnpm), the root scripts, the repo layout, a pointer to docs/ and the phase process.
10. Housekeeping: .gitignore, .editorconfig, .nvmrc or engines field, LICENSE placeholder, and CLAUDE.md left untouched.

Present the plan as a numbered checklist with the files you will create for each item. Also state anything you are unsure about as DECISION NEEDED blocks. Then wait.

STEP 3 — IMPLEMENT (only after I approve)
Implement the approved plan. Work in small commits (Conventional Commits, one per plan item where sensible). Do not add product code, schemas beyond the mock stub, UI, or database work — those belong to Phases 1–3.

STEP 4 — VERIFY AND REPORT
Run pnpm install, pnpm typecheck, pnpm lint, pnpm test, pnpm build and pnpm test:e2e (a trivial smoke test is fine). Paste the real output summary. Finish with a Deliverable report: files created, the tree compared against Arch §30, script results, CI workflow names, decisions recorded, ADRs written, and anything left open for Phase 1.
```

---

## Verification checklist (you, after the kickoff session)

Run these from the repo root and tick each one before starting Phase 1:

- [ ] `pnpm install` completes with no errors.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` all exit 0.
- [ ] `pnpm test:e2e` runs (a smoke test is enough) and `pnpm test:providers` exists and skips cleanly without keys.
- [ ] `tree -L 2` (or `Get-ChildItem -Depth 1`) matches Arch §30: all 5 `apps/*`, all 11 `packages/*`, `services/training`, `bench/`, `infra/`, `docs/` exist, each app/package with `package.json` + `tsconfig.json`.
- [ ] `packages/config` holds the shared tsconfig / ESLint / Prettier presets and every package extends them.
- [ ] `docs/DECISIONS.md` exists with D1–D17 recorded and OI-01..06, OI-16 listed as open.
- [ ] `docs/adr/` contains ADR-001 through ADR-016.
- [ ] `.github/workflows/` contains the PR pipeline (lint → typecheck → unit → integration → component → E2E → build) and the nightly provider workflow.
- [ ] `packages/providers` contains the mock provider stub and its `TC-PRV-010` test passes.
- [ ] `README.md` documents the root scripts; `CLAUDE.md` is unchanged.
- [ ] The Deliverable report lists nothing from Phase 1 or later as "done".

If any item fails, ask Claude Code to fix it in the same session before moving on. The Phase 0 gate is: all root scripts green on a clean clone with no API keys.

---

## Session-start preamble for every later phase

Start each new Claude Code session (Phase 1 onward) by pasting exactly this, then the phase-file line:

```text
Read CLAUDE.md and docs/DECISIONS.md. We are building ACE phase by phase from docs/build-prompts/. All earlier phases are done and their gates are green. Open the phase file I name below and follow it exactly: enter plan mode first, present a plan with an FR/TC coverage table, wait for my approval, then implement with TDD on the mock provider. Never start later-phase features. If the docs conflict or are silent, stop and post a DECISION NEEDED block instead of guessing. Finish with the Deliverable report the phase file asks for.
```

Phase file: docs/build-prompts/<file>

---

## Phase files, in order

One session per file. Do not start a file until the previous phase's gate is green (FRS §10, Arch §34).

| Phase | File | FRS modules |
|---|---|---|
| 0 | `phase-00-foundations.md` | — (this kickoff) |
| 1 | `phase-01-contracts-db.md` | schemas for all modules, local storage adapters |
| 2 | `phase-02-engine-skeleton.md` | SYS, PRJ, WF |
| 3 | `phase-03-canvas.md` | CAN, NODE, CON |
| 4 | `phase-04-providers-router.md` | PRV, MOD, RTR |
| 5 | `phase-05-execution-engine.md` | EXE, PRM, OBS (basic) |
| 6 | `phase-06-control-errors-guardrails.md` | CTL, ERR, GRD |
| 7 | `phase-07-parallel-loops.md` | PAR, CON (loop edges) |
| 8 | `phase-08-multimodal.md` | MM, TOOL (media) |
| 9 | `phase-09-chat.md` | CHAT |
| 10 | `phase-10-context-rag.md` | RAG, MEM, GRD (context) |
| 11 | `phase-11-skills-custom-nodes-tools.md` | SKL, CUS, TOOL, GRD (tool), PRM (library) |
| 12 | `phase-12-workspace-code.md` | GIT, TOOL (file, git) |
| 13 | `phase-13-ace-bench.md` | BEN |
| 14 | `phase-14-testing-qa.md` | all test cases, FRS §8 |
| 15 | `phase-15-hardening.md` | GRD (classifier), OBS, NFRs |
| 16 | `phase-16-desktop.md` | DSK |
| 17 | `phase-17-launch.md` | ONB, CLI, MOB (responsive) |

Phases 18–21 (hosted platform, hosted models, fine-tuning, mobile app) are post-v1 and have no prompt files yet.
