# ACE Build Prompt Pack — How to use it with Claude Code

This folder is a prompt pack for building ACE one phase per Claude Code session. The only sources of truth are `docs/ACE-PRD.md`, `docs/ACE-FRS.md` and `docs/ARCHITECTURE.md`; the phase files only tell Claude which sections to read and what "done" means. `docs/DECISIONS.md` is the memory that survives `/clear`. Everything in CI runs on the mock provider (FR-PRV-010) with no API keys.

## 1. What is in this folder

| File | Purpose |
|---|---|
| `00-README.md` | This guide: setup, session loop, review, decisions, special phases, effort, troubleshooting |
| `CLAUDE.md` | Copy to the repo root. Rules Claude reads every session: doc paths, quick reference of state/error/guardrail names, root scripts, dependency rules, "never guess" rule |
| `01-KICKOFF-PROMPT.md` | The first session (Phase 0) prompt, its verification checklist, and the session-start preamble reused by every later phase |
| `phase-00-foundations.md` | Phase 0: monorepo per Arch §30, root scripts, CI per Arch §18.4, DECISIONS.md with D1–D17, ADR files, mock provider stub |
| `phase-01-contracts-db.md` | Phase 1: Zod contracts for all modules (incl. guardrail + tool schemas), SQLite/Drizzle storage adapters (Arch §15) |
| `phase-02-engine-skeleton.md` | Phase 2: SYS, PRJ, WF — Hono gateway, token/origin checks, event bus, WebSocket hub |
| `phase-03-canvas.md` | Phase 3: CAN, NODE, CON — SPA shell, React Flow canvas, design system |
| `phase-04-providers-router.md` | Phase 4: PRV, MOD, RTR — adapters, catalog, mock provider, router (fixed + fallback, D12) |
| `phase-05-execution-engine.md` | Phase 5: EXE, PRM, OBS (basic) — scheduler, envelopes, state machines (Arch §19), streaming |
| `phase-06-control-errors-guardrails.md` | Phase 6: CTL, ERR, GRD (input, output, cost, loop, approvals) |
| `phase-07-parallel-loops.md` | Phase 7: PAR — merge node, loop edges, loop limits |
| `phase-08-multimodal.md` | Phase 8: MM, TOOL (media) — artifact store, media tools |
| `phase-09-chat.md` | Phase 9: CHAT — timeline, agent threads |
| `phase-10-context-rag.md` | Phase 10: RAG, MEM, GRD (context) — parsers, chunking, hybrid search, memory |
| `phase-11-skills-custom-nodes-tools.md` | Phase 11: SKL, CUS, TOOL, GRD (tool + Guardrail node), PRM (library) — sandbox, search, MCP |
| `phase-12-workspace-code.md` | Phase 12: GIT, TOOL (file, git) — workspace, code panel, replay |
| `phase-13-ace-bench.md` | Phase 13: BEN — frozen tasks, arms, blind judging |
| `phase-14-testing-qa.md` | Phase 14: all FRS §8.6 test cases, exit criteria §8.4, UAT §8.7, deliverables §8.8 |
| `phase-15-hardening.md` | Phase 15: GRD (classifier via Ollama), OBS, NFRs, security review |
| `phase-16-desktop.md` | Phase 16: DSK — Electron, packaging, signing, auto-update |
| `phase-17-launch.md` | Phase 17: ONB, CLI, SDK, OpenAPI, MOB (responsive), docs |
| `post-v1-phases-18-21.md` | Outline only: hosted platform, hosted models, fine-tuning, mobile app. Not built in v1 |

## 2. One-time setup

1. Create the repo at a short path without spaces: `mkdir D:\ace`, `cd D:\ace`, `git init` (see §8 for why).
2. Copy `ACE-PRD.md`, `ACE-FRS.md`, `ARCHITECTURE.md` into `docs/`. Copy this folder to `docs/build-prompts/`. Copy `CLAUDE.md` from this folder to the repo root. Phase 0 creates `docs/DECISIONS.md` and `docs/adr/` itself.
3. Commit: `git add -A` then `git commit -m "docs: add ACE spec and build prompt pack"`.
4. Install Node LTS, pnpm, git and Claude Code (`npm install -g @anthropic-ai/claude-code`). Docker, Ollama and SearXNG are optional and only matter in the phases listed in §7.
5. Recommended Claude Code settings:
   - Start every phase in **plan mode** (`claude --permission-mode plan`, or press Shift+Tab until the prompt shows plan mode). Nothing is written until you approve the plan.
   - For implementation use the default (ask) mode or "accept edits". Keep Bash prompts on so you see every `git`, `rm` and `pnpm` command. Never use `--dangerously-skip-permissions` on this repo.
   - In `.claude/settings.json`, allow the test loop without prompts: `Bash(pnpm test:*)`, `Bash(pnpm typecheck)`, `Bash(pnpm lint)`, `Bash(pnpm build)`.
   - **One phase per session.** `/clear` before each phase; never run two phases in one context.
   - Treat `docs/DECISIONS.md` as append-only. Claude reads it at every session start, so it is the only memory that survives `/clear`.

## 3. The session loop (every phase from 1 to 17)

1. `/clear`.
2. Paste the session-start preamble exactly as written (it is also at the end of `01-KICKOFF-PROMPT.md`), followed by the phase-file line:

   > Read CLAUDE.md and docs/DECISIONS.md. We are building ACE phase by phase from docs/build-prompts/. All earlier phases are done and their gates are green. Open the phase file I name below and follow it exactly: enter plan mode first, present a plan with an FR/TC coverage table, wait for my approval, then implement with TDD on the mock provider. Never start later-phase features. If the docs conflict or are silent, stop and post a DECISION NEEDED block instead of guessing. Finish with the Deliverable report the phase file asks for.
   >
   > Phase file: docs/build-prompts/phase-05-execution-engine.md

3. Review the plan. Check its FR/TC coverage table against the FRS module header for this phase (e.g. "### 3.9 Execution (EXE) — Phase 5"): every FR of the phase's modules must appear with its TC IDs, and nothing from a later phase may appear. Tests are named by test-case ID, e.g. `describe("TC-EXE-005 Contract violation")`.
4. Answer any DECISION NEEDED blocks (§5), then approve.
5. Let it implement with TDD: failing test, code, green, on the mock provider only. Small Conventional Commits, as in Phase 0.
6. Demand evidence: the real `pnpm test` output (not a summary), coverage figures, and `pnpm typecheck` / `pnpm lint` clean.
7. Check the phase file's **Done-when gate yourself**: run the commands, open the UI where the gate says so. Do not accept "all tests pass" from the transcript alone.
8. Commit and tag: `git commit -m "feat(phase-5): execution engine gate green"` then `git tag phase-5`.
9. Append every decision made during the session to `docs/DECISIONS.md` and commit it.
10. Next phase: back to step 1.

### When a phase is too big for one session

Split by FRS module, in the order the phase file lists them. Suggested splits:

| Phase | Session A | Session B | Session C |
|---|---|---|---|
| 1 | Contracts (all module schemas, enums, error schema) | Storage adapters (SQLite/Drizzle, migrations, keychain) | — |
| 3 | Canvas shell + nodes (CAN, NODE) | Connections + validation (CON, FR-WF-006) | — |
| 6 | CTL + ERR | GRD input/output/cost/loop + approvals | — |
| 10 | RAG ingestion + hybrid search | MEM + GRD context | — |
| 11 | SKL + CUS | TOOL (sandbox, search, HTTP, MCP) | GRD tool checks + Guardrail node + PRM library |
| 14 | Unit/integration/component gaps + E2E | Performance, recovery, security, guardrail corpora | UAT §8.7 + reports |

Ask Claude to end a split session with a handoff paragraph (what is done, which TCs are green, last commit, what is next). Resume in a fresh session with the preamble plus that paragraph, for example:

> Phase file: docs/build-prompts/phase-11-skills-custom-nodes-tools.md. Continue Phase 11 from TOOL; here is what is done: SKL and CUS implemented, TC-SKL-001..003 and TC-CUS-001..007 green, committed as 4f2a1c9. Do not touch SKL/CUS files except to fix a failing test.

## 4. How to review Claude's work

- **Coverage table first.** Ask: "Show the FR/TC coverage table for this phase with the test file and status of each TC." Anything skipped or deferred needs a written reason in the Deliverable report.
- **Run it yourself.** `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm test:e2e` where the phase has E2E. If `pnpm test` asks for an API key, that is a defect (§8).
- **`/code-review` before merging.** Run it on the phase diff at high effort; fix correctness findings before tagging.
- **Adversarial review by a subagent.** Prompt: "Spawn a subagent. It must read docs/ACE-FRS.md §3.9 and the EXE table in §8.6, plus docs/ARCHITECTURE.md §12.3–12.4, then review packages/engine against each FR-EXE-* and TC-EXE-* looking for: requirements silently narrowed, state transitions not in Arch §19, envelopes carrying chat history instead of bounded context, and tests that pass without exercising the behaviour. Report findings by FR ID." Swap the section numbers per phase.
- **Secrets in logs (TC-SYS-008, FR-GRD-010, FR-WF-007).** After a run with a keyed provider, grep the log folder and an exported workflow for the key. Repeat in Phases 4, 6, 12 and 16 (keychain migration).
- **State names.** Compare against the quick reference in `CLAUDE.md`: node states IDLE, READY, RUNNING, WAITING, COMPLETED, PAUSED, STOPPED, BLOCKED, FAILED; run states PREFLIGHT, RUNNING, PAUSED, COMPLETE, BLOCKED, HALTED; failure reasons RUN_FAILED, CONTRACT_VIOLATION, GUARDRAIL_VIOLATION, BLOCKED; provider states UNKNOWN, CHECKING, CONNECTED, AUTH_FAILED, UNREACHABLE, RATE_LIMITED; error kinds user_cancelled, agent, provider, auth, network, invalid_config, workflow, guardrail. The common slip is node COMPLETED vs run COMPLETE. Grep for `"Completed"`, `"complete"`, `"Halted"` string literals outside `packages/contracts`.
- **Dependency rules (Arch §30).** `engine` imports only `contracts` and its own ports; `apps/web` never imports Node modules; `engine` never imports browser APIs. Grep for `node:`/`from "fs"` under `apps/web` and for `window.`/`document.` under `packages/engine`.
- **Scope.** Diff the file list against the phase's modules. New folders for later-phase modules mean drift (§8).

## 5. DECISION NEEDED protocol

Claude must stop and post this block whenever the three docs conflict, are silent, or a phase file asks for something the docs do not define:

```
DECISION NEEDED — <short title>
Where: <FR ID / Arch § / phase file step>
Conflict or gap: <what each doc says, or what is missing>
Options: A) ... B) ... (C) ...)
Recommendation: <one option and why, in two lines>
Blocked: <what cannot proceed until answered>
```

How to answer: reply in chat with the option letter (or your own wording), then have Claude append a row to `docs/DECISIONS.md`. Phase 0 seeds D1–D17 from Arch §39 and FRS §11 and lists OI-01..06 and OI-16 as open; new decisions continue from D18:

```
| D18 | Transform node operation list (OI-06) | Template, JSON extract, join only in v1 | Phase 3 | 2026-09-16 |
```

Rules: every answer goes into `DECISIONS.md` in the same session, even "take the recommended option"; a decision that narrows or changes an FR names the FR ID; Claude never resolves a DECISION NEEDED on its own. FRS §11 and Arch §39 already carry a "Recommended" column, so expect questions about OI-06 (Phase 3), OI-01/OI-10 (Phase 4), OI-08 (Phase 6), OI-02 (Phase 10), OI-03/11/12/14 (Phase 11), OI-04 (Phase 13), OI-16 (Phase 14), OI-05 (Phase 16), OI-13 (Phase 17).

## 6. Special phases

- **Phase 0 — Foundations (kickoff).** Use `01-KICKOFF-PROMPT.md` instead of the generic preamble. Output: the monorepo skeleton of Arch §30 (`apps/`, `packages/`, `services/training`, `bench/`, `infra/`, `docs/`), shared tsconfig/ESLint/Prettier in `packages/config` with the §30 dependency rules enforced, root scripts `pnpm dev|build|typecheck|lint|test|test:e2e|test:providers`, GitHub Actions per Arch §18.4 (PR: lint → typecheck → unit → integration → component → E2E (mock) → build; nightly `test:providers`; tag stub), `docs/DECISIONS.md` with D1–D17, `docs/adr/` with ADR-001..016, a mock provider stub with `TC-PRV-010`. Gate: all root scripts green on a clean clone with no API keys; tick the checklist in `01-KICKOFF-PROMPT.md`.
- **Phase 14 — Testing & QA.** Not feature work (FRS §8.1). Entry: feature complete, builds pass, fixtures ready (§8.3: fixture workflows, guardrail corpora, tool fixtures, sample files). Exit (§8.4): 100% of Must TCs pass, ≥95% of Should TCs pass, no open critical/high defects (§8.5), coverage and performance targets met. The 19 TC-NFR cases need real timing runs and the browser matrix (TC-NFR-011); TC-NFR-014 needs the corpora (OI-16). The UAT checklist §8.7 (15 items) is done by a human — you — and all must pass. Deliverables §8.8: test plan, defect log, performance report, security review report, UAT sign-off, final summary. Plan three or more sessions.
- **Phase 15 — Hardening.** Security review (Arch §22), observability (Arch §26), NFRs, FR-GRD-017 local moderation via Llama Guard on Ollama. Ollama is optional: the criterion is "works offline with Ollama running", and the rule-pack fallback must make every test pass with Ollama absent (CI has none). To try it locally: install Ollama, `ollama pull llama-guard3`.
- **Phase 16 — Desktop.** Buy code-signing certificates before packaging (OI-05: Windows Authenticode, Apple Developer ID + notarization); unsigned builds are fine for development but trip SmartScreen/Gatekeeper. Native modules (better-sqlite3, sqlite-vec, keychain) must be rebuilt against Electron's Node ABI on each OS (Arch §38 risk; §8 below). FR-DSK-003 migrates secrets to OS secure storage — re-run the secrets-in-logs check. FR-DSK-006 requires the full E2E suite to pass inside Electron.
- **Phase 17 — Launch.** ONB (templates must run on the mock provider, FR-ONB-002), CLI (`ace connect|run|runs|export|import|bench`), SDK and OpenAPI generated from `packages/contracts`, responsive views (the Phase 17 part of MOB only), docs. D15/OI-13: hosted mode starts only after launch feedback — do not open `post-v1-phases-18-21.md` in a build session.

## 7. Rough effort (estimate)

One session means one focused Claude Code session of a few hours. These are estimates, not commitments.

| Phase | Sessions (est.) | Real services needed | Runs on mock / local only |
|---|---|---|---|
| 0 Foundations | 1 | — | yes |
| 1 Contracts + DB | 2 | — | yes (temp SQLite) |
| 2 Engine skeleton | 1–2 | — | yes |
| 3 Canvas | 2–3 | — | yes |
| 4 Providers + router | 2 | Optional: one real key and Ollama for a manual smoke test; real keys only in nightly `test:providers` | CI: yes |
| 5 Execution engine | 2–3 | — | yes |
| 6 Control + errors + guardrails | 2–3 | — | yes |
| 7 Parallel + loops | 1–2 | — | yes |
| 8 Multimodal | 1–2 | Local libraries only (sharp, unpdf, mammoth) + fixture files | yes |
| 9 Chat | 1 | — | yes |
| 10 Context & RAG | 2–3 | Optional Ollama for real embeddings; tests use a mock embedder | CI: yes |
| 11 Skills, custom nodes, tools | 3–4 | Optional Docker (sandbox), SearXNG (search); local HTTP and MCP test servers | CI: yes (child-process sandbox, mocked search) |
| 12 Workspace + code | 1–2 | git binary on PATH | yes |
| 13 ACE Bench | 1–2 | Real keys only for a real experiment; tests on mock | CI: yes |
| 14 Testing & QA | 3–5 | Browser matrix; real keys for nightly contract tests; corpora | CI: yes |
| 15 Hardening | 2–3 | Optional Ollama + Llama Guard | CI: yes (rule packs) |
| 16 Desktop | 2–3 | Electron toolchain per OS, signing certificates, GitHub Releases for updates | E2E runs inside Electron |
| 17 Launch | 2 | — | yes |
| **Total v1** | **~32–45** | | |

## 8. Troubleshooting

- **Context too long.** Use `/compact` with an instruction: "keep the FR/TC coverage table, the list of green TCs and open DECISION NEEDED items". If that is not enough, end with a handoff paragraph and resume per §3. Claude should read the FRS/Arch by offset/limit for the sections the phase file names, never the whole documents.
- **Claude drifts into later phases.** Say: "Stop. That module is Phase N per its FRS §3 header. Revert it (`git diff`, then remove) and continue with the current phase only." Check the diff for new folders; if the drift revealed a real gap, record it in `DECISIONS.md`. The phase gate is the only definition of done.
- **Tests require keys.** `pnpm test` must pass with no environment variables set. Anything that touches a real provider belongs in `pnpm test:providers` (tagged, nightly, FRS §8.2). Ask Claude to move the test and to cover the same behaviour with a mock-provider script (FR-PRV-010), including simulated errors and delays.
- **Claude changes state names.** The enums live once in `packages/contracts` and everything imports them; ask for a unit test that asserts the exact string values listed in `CLAUDE.md`. Grep for renamed or re-cased variants (`Completed`, `COMPLETE` on a node, `HALT`, `Halted`) and reject the phase until they are gone.
- **Electron native module rebuilds.** Native modules must match the Electron ABI: run `electron-builder install-app-deps` (or `electron-rebuild`) in `apps/desktop` after every Electron or module upgrade, mark them as externals in the bundler, and build installers in CI per platform (Arch §18.4, §38). Put `node-linker=hoisted` in `.npmrc` if packaging misses dependencies.
- **Windows path issues.** Keep the repo at a short path without spaces (`D:\ace`); enable long paths (`git config --system core.longpaths true`, Windows `LongPathsEnabled`). Add `.gitattributes` with `* text=auto eol=lf` so lint does not fight CRLF. Use `path.join`/`pathToFileURL` in code, never `/` concatenation; quote paths in scripts; use `cross-env` or Node scripts for env vars in `package.json`. Tests that check "path inside the project" (FR-GRD-005, TC-NFR-008) must normalise drive letters and separators before comparing.
