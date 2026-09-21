# ACE — Feature Prompt Pack (2-developer build plan)

**Repo:** `ace` · **Owners:** Mouli Lohani (**M**) and Arhant (**A**)
**Sources of truth:** `docs/ACE-PRD.md`, `docs/ACE-FRS.md`, `docs/ARCHITECTURE.md`. Nothing here overrides them.
**This file lives at:** `docs/prompt.md` — it is the shared status board. Whoever finishes a feature updates its row **here** so the other person knows without asking.

> Everything in this pack runs on the **mock provider** (FR-PRV-010) with **no API keys** and **no paid services**. Where a real model is genuinely needed (Phase 15 moderation, Phase 10 embeddings), use **Ollama** locally — free, and always with a rule-pack / mock-embedder fallback so CI passes without it.

---

## 1. How to use this file

1. Look at the **Status Board** (§6). Find the first feature in your column that is `TODO` and whose `Depends on` features are all `MERGED`.
2. Open its block in §7. Follow the **git start ritual** (§3.1).
3. Open a **new Claude Code session** (`/clear`), paste the **session preamble** (§5) followed by that feature's **Prompt** text. One feature = one session.
4. Work through the block's **Done when** gate yourself. Do not accept "all tests pass" from the transcript.
5. Follow the **git finish ritual** (§3.2), open the PR, and **update the Status Board row** (§3.4).
6. When your partner's feature merges, **verify it yourself** (§3.6) before you touch anything else. This is a hard gate, not a courtesy.
7. Wait for the wave to close (§3.5), then take your next feature.

**Never** start a feature from a later wave. **Never** edit files outside your `I own` list.

---

## 2. Ground rules (apply to every single prompt)

| # | Rule |
|---|---|
| R1 | **Plan mode first.** `claude --permission-mode plan`. Claude must present an FR/TC coverage table and wait for approval before writing anything. |
| R2 | **One feature per session.** `/clear` between features. Never two features in one context. |
| R3 | **TDD on the mock provider.** Failing test → code → green. `pnpm test` must pass with zero environment variables set. Anything touching a real provider goes in `pnpm test:providers` (nightly, tagged). |
| R4 | **Tests are named by TC ID:** `describe("TC-EXE-005 Contract violation")`. A phase gate is the only definition of done. |
| R5 | **Never guess.** If the three docs conflict or are silent, Claude stops and posts a `DECISION NEEDED` block (§5.2). It never resolves one itself. |
| R6 | **Every answered decision** is appended to `docs/DECISIONS.md` in the same session, continuing from D18. A decision that narrows an FR names the FR ID. |
| R7 | **Enums live once** in `packages/contracts`. Use the exact strings in `CLAUDE.md`. The classic slip is node `COMPLETED` vs run `COMPLETE`. |
| R8 | **Dependency rules (Arch §30).** `engine` imports only `contracts` + its own ports · `apps/web` never imports node modules · `engine` never touches `window`/`document`. |
| R9 | **Scope guard.** Only the files in your `I own` list. Touching a shared file needs the §4 protocol. New folders for a later feature's module = drift; revert it. |
| R10 | **Never** `--dangerously-skip-permissions`. Keep Bash prompts on so you see every `git`, `rm` and `pnpm`. |
| R11 | **Secrets check** after every feature that touches providers, logs, exports or the keychain (F11, F12, F22, F37, F45): grep the log folder and an exported workflow for the key. |
| R12 | **Conventional Commits**, small and frequent: `feat(f16): envelope builder`, `test(f16): TC-EXE-006`, `fix(f16): ...`. |

---

## 3. Git workflow — the no-conflict protocol

`main` is protected: no direct pushes after F00, except the Status Board commit in §3.4.
Branch naming: `feat/<feature-id>-<slug>` — e.g. `feat/f16-node-executor`.

### 3.1 Start ritual (run **every** time you begin a feature)

```bash
git checkout main
git pull --ff-only origin main        # ALWAYS ff-only. If this fails, you committed to main — see §8.
pnpm install                          # the other person may have added deps
pnpm typecheck && pnpm test           # main must be green BEFORE you branch
git checkout -b feat/f16-node-executor
```

### 3.2 While you work — rebase, never merge

```bash
# at least once a day, and always before you push:
git fetch origin
git rebase origin/main                # NEVER `git merge main` into your branch
# resolve, then:
git rebase --continue
pnpm install && pnpm typecheck && pnpm lint && pnpm test
git push --force-with-lease           # safe because the branch is yours alone
```

### 3.3 Finish ritual

```bash
git fetch origin && git rebase origin/main
pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e   # e2e only where the feature has it
git push --force-with-lease
gh pr create --title "feat(f16): node executor and envelope engine" --body "Closes F16. FR/TC table in the Deliverable report."
```

* The **other person reviews** — that is the whole point of the alternating order. Review checklist in §8.
* Merge with **"Rebase and merge"** (not squash). This keeps both authors' individual commits, so `git log` reads `A, M, A, M…` and the shared history shows real two-person collaboration.
* Delete the branch after merge.

### 3.4 Status Board update (this is the "tell the other person" step)

Immediately after your PR merges — this commit is the **only** allowed direct push to `main`, and it must touch **only** `docs/prompt.md`:

```bash
git checkout main && git pull --ff-only origin main
# edit the F16 row in docs/prompt.md §6: status MERGED, commit sha, date, notes
git add docs/prompt.md
git commit -m "docs(prompt): F16 merged"
git push origin main                  # push within 60 seconds of pulling — keep the window tiny
```

If this push is rejected, `git pull --rebase origin main` and push again. The row is one line, so a rebase conflict is resolved in seconds.

### 3.5 Wave gates

Features are grouped into **waves**. A wave has exactly one **A** feature and one **M** feature designed to touch **disjoint files**, so they can run at the same time with zero conflicts.

> **Both features of a wave must be merged into `main` AND cross-verified (§3.6) before either person starts the next wave.**

If you finish first: review your partner's PR, then do the wave's chores (update `DECISIONS.md`, run the phase gate, write the handoff note in §9). Do **not** start the next wave early — that is where every merge conflict in a two-person repo comes from.

When a wave closes the last feature of a **phase**, whoever merged second runs the phase gate and tags:

```bash
git checkout main && git pull --ff-only origin main
pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e
git tag phase-5 && git push origin phase-5
```

### 3.6 Cross-verification gate — you test the feature **your partner** built

A feature is not finished when its PR merges. It is finished when **the other person has independently proved it works.** The builder is the worst possible tester of their own feature: they know which paths they exercised and they unconsciously avoid the ones they didn't.

> **Rule: before you start your next feature, you must have verified your partner's most recently merged one and recorded the result.**

So the real order of a wave is:

```
A builds F09  ──┐                     ┌── M verifies F09  ──┐
                ├── both merge to main┤                     ├── wave closes → next wave
M builds F10  ──┘                     └── A verifies F10  ──┘
```

**Who verifies what:** always the person who did **not** build it. Mouli verifies every Arhant feature; Arhant verifies every Mouli feature. F00 is verified by Arhant on his first clone; F49 is verified by both.

**How to verify** — a fresh session, the §5.3 prompt, and then these by hand:

1. **Clean-clone test.** Not your working copy — a fresh clone into a new folder, `pnpm install`, then `pnpm typecheck && pnpm lint && pnpm test`. This is the step that catches missing files, unlisted dependencies and machine-specific assumptions.
2. **Run the feature's `Done when` gate yourself**, literally, including opening the UI where it says to. You are not re-reading his report; you are reproducing it.
3. **Re-run every TC ID** listed in the feature block and confirm each one exists, is named by its TC ID, and actually fails when the behaviour is broken. Pick the two most important, comment out a line of implementation, confirm red, restore.
4. **Try to break it.** Ten minutes of deliberate abuse the builder wouldn't have tried: empty input, huge input, the wrong data type, disconnect mid-run, two things at once, cancel halfway, reload the page at the worst moment.
5. **Check it against the FR text**, not against his tests. Open the FRS rows for those FR IDs and read the acceptance criteria as written. Tests can be narrowed to match an implementation; the FRS cannot.
6. **Check the seam.** If his feature published an interface you depend on, write a throwaway consumer of it now, before you're mid-feature and blocked.

**Recording the outcome** — one of two things, always written down:

- **Verified.** Set his Status Board row to `VERIFIED`, with `verified by <your name>, <date>` in Notes. Commit it as `docs(prompt): F09 verified`.
- **Not verified.** Log every finding in `docs/defect-log.md` with severity, set the row to `MERGED` with `verification failed — D-012, D-013` in Notes, and tell him. **He fixes them** (§4.5), you re-verify. The wave does not close until his row reads `VERIFIED`.

A critical or high defect blocks the wave. Medium and low may be logged and carried to Phase 14 by mutual agreement, written in the handoff log (§9) with the reason.

**Timebox:** 30–45 minutes for most features, longer for F15/F16, F21/F22, F34/F36 and anything in Phase 14. If verification is taking more than half a session, that itself is a finding — say so in the log.

---

## 4. Shared-file protocol (the only files both of you may touch)

| File | Rule |
|---|---|
| `docs/DECISIONS.md` | **Append-only.** New rows at the end only, never edit an existing row. Pull → append one row → commit → push, all inside one minute. |
| `docs/prompt.md` (this file) | Status Board rows only, per §3.4. Never restructure it mid-wave. |
| `packages/contracts/src/index.ts` and other barrels | **Pre-created by F00 with every export line already present**, pointing at placeholder files. You only fill in your own placeholder file — you never add a line to a barrel. If a barrel line is genuinely missing, post a `DECISION NEEDED`. |
| `package.json` / `pnpm-lock.yaml` | Adding a dependency is its **own commit**, pushed to your branch immediately, and announced in the wave chat. On a lockfile conflict: `git checkout --theirs pnpm-lock.yaml && pnpm install && git add pnpm-lock.yaml`. Never hand-edit the lockfile. |
| `CLAUDE.md` | **Mouli owns it.** Arhant requests changes in the PR description. |
| `.github/workflows/**` | **Mouli owns it** after F00. |
| Drizzle migrations | Filenames are timestamped, so they never collide. Never edit a migration that is already on `main` — add a new one. |

**Golden rule:** if your feature seems to need a file from your partner's `I own` list, stop. Either the seam is defined wrong (post a `DECISION NEEDED`) or you are drifting into their feature.

### 4.5 Defect protocol — where bugs get tracked

`docs/defect-log.md` is created in F00 and exists from day one. Anything found **after** a feature merges — whether during verification (§3.6), during a later feature, or at a phase gate — gets a row:

```
| ID | Sev | Feature | FR / TC | What's wrong | Found by | Owner | Branch | Status |
| D-007 | high | F21 | FR-GRD-014 / TC-GRD-018 | redaction verdict stores the value | Arhant (verifying F21) | Arhant | fix/d-007-redaction | open |
```

Severity per FRS §8.5: **critical** = data loss or security hole · **high** = main feature broken, no workaround · **medium** = workaround exists · **low** = cosmetic.

1. **The owner of the feature that introduced the bug fixes it** — not whoever found it. The finder logs it and stops. The only exception is a genuine one-liner in a file you already own in the current wave.
2. **Every fix ships a regression test**, named `TC-<MODULE>-R<nn>`, added to the coverage matrix and referenced in the defect row. A fix with no test will be re-broken.
3. **Fix branches are `fix/d-0nn-<slug>`**, reviewed like any other PR, and the defect row goes to `closed` with the SHA when it merges.
4. **Critical and high block the wave from closing.** Medium and low may be carried to Phase 14 by mutual agreement, recorded in the handoff log.

Bugs you find and fix **inside your own session, before your PR merges**, need no log row — but they do need a failing test first, a separate `fix(f16):` commit, and a "defects found in-session" line in the Deliverable report so your verifier knows where to look hardest.

`DECISIONS.md` is for decisions, `defect-log.md` is for defects. A bug that turns out to be a spec ambiguity produces **both** — a DECISION NEEDED row and a defect row referencing it.

---

## 5. The session preamble — paste this before every feature prompt

### 5.1 Preamble

```
Read CLAUDE.md, docs/DECISIONS.md, and the feature block named at the end of this message in docs/prompt.md.

We are building ACE feature by feature. The only sources of truth are docs/ACE-PRD.md, docs/ACE-FRS.md and
docs/ARCHITECTURE.md. Read only the sections this feature names, by offset/limit — never load a whole document.

Rules for this session:
1. Enter plan mode first. Present a plan containing an FR/TC coverage table: every FR ID of this feature, its
   TC IDs, the test file each will live in, and the approach. Wait for my approval before writing anything.
2. Implement with TDD on the mock provider only (FR-PRV-010). No API keys. `pnpm test` must pass with no
   environment variables set. No paid service may be required by any test.
3. Name every test by its test-case ID, e.g. describe("TC-EXE-005 Contract violation").
4. Work only inside the "I own" file list in the feature block. Do not create or edit any other file,
   including barrels, CI files, CLAUDE.md or package.json, unless the block explicitly says so.
5. Never implement anything from a later feature block. If you notice a gap, report it; do not fill it.
6. If the docs conflict or are silent, stop and post a DECISION NEEDED block (format below). Never decide yourself.
7. Use the exact enum strings from CLAUDE.md. Node states IDLE, READY, RUNNING, WAITING, COMPLETED, PAUSED,
   STOPPED, BLOCKED, FAILED. Run states PREFLIGHT, RUNNING, PAUSED, COMPLETE, BLOCKED, HALTED. Failure reasons
   RUN_FAILED, CONTRACT_VIOLATION, GUARDRAIL_VIOLATION, BLOCKED. Provider states UNKNOWN, CHECKING, CONNECTED,
   AUTH_FAILED, UNREACHABLE, RATE_LIMITED. Error kinds user_cancelled, agent, provider, auth, network,
   invalid_config, workflow, guardrail.
8. Respect Arch §30 dependency rules: engine imports only contracts and its own ports; apps/web never imports
   node modules; packages/engine never uses window or document.
9. Commit in small Conventional Commits as you go. Never commit to main, never push, never force-push.
10. Finish with a Deliverable report: the FR/TC coverage table with pass/fail status, the real `pnpm test`
    output (not a summary), coverage figures, `pnpm typecheck` and `pnpm lint` output, the list of files you
    created or changed, and any DECISION NEEDED still open.

Feature block:
```

### 5.2 DECISION NEEDED format (Claude must use exactly this)

```
DECISION NEEDED — <short title>
Where: <FR ID / Arch § / feature block step>
Conflict or gap: <what each doc says, or what is missing>
Options: A) ... B) ... (C) ...)
Recommendation: <one option and why, in two lines>
Blocked: <what cannot proceed until answered>
```

Answer in chat with a letter, then have Claude append the row to `docs/DECISIONS.md` (`| D18 | ... | ... | Phase n | date |`) in the same session.

### 5.3 Verification session prompt — paste this when checking your partner's merged feature

A **fresh session** (`/clear`), on `main` after his PR merged, in **plan mode off** — this session reads and tests, it does not implement.

```
You are verifying a feature another developer built and merged. You did not write it. Your job is to find
out whether it actually meets its requirements — not to agree that it does, and not to fix anything.

Feature under verification: <F-ID> <name>  (its block is in docs/prompt.md §7)
Requirements: read ONLY the FRS sections and Architecture sections that block names, by offset/limit.

Do this in order and report as you go:

1. Read the feature block in docs/prompt.md: its FR IDs, TC IDs, "I own" list and "Done when" gate.
2. Read the FRS acceptance criteria for each FR ID, as written. Judge the code against the FRS text, NOT
   against the tests that were shipped with it — tests can be narrowed to match an implementation.
3. For each TC ID: find the test, confirm it exists and is named by its TC ID, and read it. Report any test
   that would still pass if the behaviour were broken, and say exactly why.
4. Run `pnpm typecheck`, `pnpm lint`, `pnpm test` and the feature's e2e specs if it has any. Paste the real
   output, not a summary.
5. Check scope: list every file the feature changed and flag anything outside its "I own" list.
6. Check for silent narrowing: any FR whose implementation is weaker than its acceptance criteria, any
   TODO/"simplified for now"/disabled test, any requirement met only for the happy path.
7. Check the enums: grep for "Completed", "complete", "Halted", "HALT" outside packages/contracts, and for
   node modules under apps/web and window/document under packages/engine.
8. Propose 8-10 adversarial cases the builder probably did not try (empty input, oversized input, wrong data
   type, cancel mid-operation, reload at the worst moment, two operations at once, missing dependency,
   permission denied). Write them as throwaway tests in a scratch file, run them, and report what happened.

Then output a VERIFICATION REPORT:
- Verdict: VERIFIED or NOT VERIFIED
- FR-by-FR table: FR ID | acceptance criteria met? | evidence
- TC-by-TC table: TC ID | test exists? | meaningful? | passes?
- Findings, each with: what's wrong, severity (critical/high/medium/low), the FR or TC it violates, and
  reproduction steps — formatted as rows ready to paste into docs/defect-log.md
- Anything you could not verify, and why

Do NOT modify any product code, any test, or any document. If you think something needs fixing, report it.
Scratch test files go in a folder you delete before finishing.
```

Read the report yourself, then do the manual half of §3.6 — the clean clone, the `Done when` gate with your own hands, and ten minutes of deliberate abuse. Claude's report is input to your verification, not a substitute for it.

---

## 6. Status Board — **update your row the moment your PR merges**

Status values: `TODO` · `IN PROGRESS` · `IN REVIEW` · `MERGED` · `VERIFIED` · `BLOCKED`

`MERGED` means the code is on `main`. **`VERIFIED` means the other person proved it works** (§3.6) — that is the status that lets a wave close. When you verify your partner's feature, put `verified by <name>, <date>` in its Notes column; when verification fails, leave it `MERGED` and put `verification failed — D-0nn` there instead.

| Wave | Phase | ID | Feature | Owner | Depends on | Status | Commit | Date | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 0 | 0 | F00 | Foundations + skeleton scaffold | M | — | TODO | | | blocks everything |
| 1 | 1 | F01 | Contracts: core, errors, graph | A | F00 | TODO | | | |
| 1 | 1 | F02 | Contracts: runtime, guardrails, tools | M | F00 | TODO | | | |
| 2 | 1 | F03 | Local storage adapters | A | F01, F02 | TODO | | | |
| 2 | 2 | F04 | Gateway + SYS | M | F01, F02 | TODO | | | |
| 3 | 2 | F05 | Projects + Workflows API | A | F03, F04 | TODO | | | |
| 3 | 2 | F06 | Event bus + WebSocket hub | M | F03, F04 | TODO | | | |
| 4 | 3 | F07 | Canvas shell + design system | A | F05, F06 | TODO | | | |
| 4 | 3 | F08 | Nodes: palette, cards, config panel | M | F05, F06 | TODO | | | |
| 5 | 3 | F09 | Connections + graph validation | A | F07, F08 | TODO | | | |
| 5 | 3 | F10 | Canvas productivity | M | F07, F08 | TODO | | | tag `phase-3` |
| 6 | 4 | F11 | Provider adapters + secrets | A | F09, F10 | TODO | | | |
| 6 | 4 | F12 | Model catalog + providers UI | M | F09, F10 | TODO | | | |
| 7 | 4 | F13 | Model router (fixed + fallback) | A | F11, F12 | TODO | | | |
| 7 | 4 | F14 | Mock provider (full) | M | F11, F12 | TODO | | | tag `phase-4` |
| 8 | 5 | F15 | Run service, pre-flight, scheduler | A | F13, F14 | TODO | | | |
| 8 | 5 | F16 | Node executor + envelope engine | M | F13, F14 | TODO | | | |
| 9 | 5 | F17 | Prompt management | A | F15, F16 | TODO | | | |
| 9 | 5 | F18 | Run history, trace, cost metering | M | F15, F16 | TODO | | | tag `phase-5` |
| 10 | 6 | F19 | Execution control | A | F17, F18 | TODO | | | |
| 10 | 6 | F20 | Errors, retries, BLOCKED cascade | M | F17, F18 | TODO | | | |
| 11 | 6 | F21 | Guardrail engine + input/output | A | F19, F20 | TODO | | | |
| 11 | 6 | F22 | Cost/loop guardrails + approvals | M | F19, F20 | TODO | | | tag `phase-6` |
| 12 | 7 | F23 | Parallel branches + merge node | A | F21, F22 | TODO | | | |
| 12 | 7 | F24 | Loop edges + iterations | M | F21, F22 | TODO | | | tag `phase-7` |
| 13 | 8 | F25 | Artifact store + uploads | A | F23, F24 | TODO | | | |
| 13 | 8 | F26 | Media tools + output renderers | M | F23, F24 | TODO | | | tag `phase-8` |
| 14 | 9 | F27 | Timeline + messages | A | F25, F26 | TODO | | | |
| 14 | 9 | F28 | Direct agent chat | M | F25, F26 | TODO | | | tag `phase-9` |
| 15 | 10 | F29 | KB ingestion pipeline | A | F27, F28 | TODO | | | |
| 15 | 10 | F30 | Hybrid search + retrieval + context | M | F27, F28 | TODO | | | |
| 16 | 10/11 | F31 | Agent memory + summary cache | A | F29, F30 | TODO | | | tag `phase-10` |
| 16 | 11 | F32 | Skills + prompt library | M | F29, F30 | TODO | | | |
| 17 | 11 | F33 | Custom nodes (HTTP + script) | A | F31, F32 | TODO | | | |
| 17 | 11 | F34 | Tool registry + sandbox + tool loop | M | F31, F32 | TODO | | | |
| 18 | 11 | F35 | Web search, HTTP, MCP | A | F33, F34 | TODO | | | |
| 18 | 11 | F36 | Tool guardrails + Guardrail node | M | F33, F34 | TODO | | | tag `phase-11` |
| 19 | 12 | F37 | Git workspace + code panel | A | F35, F36 | TODO | | | |
| 19 | 12 | F38 | Replay + diffs | M | F35, F36 | TODO | | | tag `phase-12` |
| 20 | 13 | F39 | Bench tasks + experiments | A | F37, F38 | TODO | | | |
| 20 | 13 | F40 | Blind export + scores + report | M | F37, F38 | TODO | | | tag `phase-13` |
| 21 | 15/14 | F41 | Observability + usage screen | A | F39, F40 | TODO | | | |
| 21 | 14 | F42 | E2E suites + fixtures | M | F39, F40 | TODO | | | |
| 22 | 14 | F43 | Performance, recovery, security tests | A | F41, F42 | TODO | | | |
| 22 | 15 | F44 | Guardrail corpora + hardening | M | F41, F42 | TODO | | | tags `phase-14`, `phase-15` |
| 23 | 16 | F45 | Desktop (Electron) | A | F43, F44 | TODO | | | tag `phase-16` |
| 23 | 17 | F46 | CLI + SDK + OpenAPI | M | F43, F44 | TODO | | | |
| 24 | 17 | F47 | Onboarding + templates | A | F45, F46 | TODO | | | |
| 24 | 17 | F48 | Responsive views + docs | M | F45, F46 | TODO | | | tag `phase-17` |
| 25 | 14 | F49 | UAT + final test summary | Both | F47, F48 | TODO | | | release gate |

### 6.1 Open defects

Full log with reproduction steps lives in `docs/defect-log.md`; this table is the at-a-glance view your partner sees on `git pull`. Critical and high block the current wave from closing.

| ID | Sev | Feature | FR / TC | Summary | Found by | Owner | Status |
|---|---|---|---|---|---|---|---|
| — | — | — | — | *(none yet)* | — | — | — |

---

## 7. The feature prompts

Format of each block:
**Branch** · **Wave** · **Phase** · **Depends on** — what must be `MERGED` first
**FRs / TCs** — what the plan's coverage table must contain, and nothing more
**Read** — the only sections Claude may open
**I own** — the only paths Claude may create or edit
**Seam** — the interface shared with the partner's parallel feature
**Prompt** — paste §5.1 preamble, then this
**Done when** — the gate *you* run by hand before opening the PR

Every block also carries an implicit final line: **Verified by** the person who did *not* build it, using §5.3 plus the manual checks in §3.6, after the PR merges and before either of you starts the next wave. The `Done when` gate is the builder's; verification is the partner's, and it is run against the FRS text rather than against the tests that shipped.

---

### F00 — Repo foundations and skeleton scaffold · **Mouli** (solo; Arhant waits)

**Branch** `feat/f00-foundations` (pushed straight to `main`, the one exception) · **Wave 0** · **Phase 0** · **Depends on** —
**FRs/TCs** TC-PRV-010 (mock stub only)
**Read** Arch §30 (code organization), §18.1, §18.4, §39 · FRS §11
**I own** everything (the repo is empty)
**Seam** this feature *creates* every seam the rest of the pack relies on.

**Prompt**
> Create the ACE monorepo skeleton exactly as Arch §30 describes: `apps/{web,desktop,site,cli,server}`, `packages/{contracts,engine,providers,guardrails,context,tools,storage-local,storage-cloud,sdk,ui,config}`, `services/training`, `bench/`, `infra/`, `docs/`.
> 1. pnpm workspace, TypeScript strict, shared tsconfig/ESLint/Prettier in `packages/config`, and an ESLint rule set enforcing the Arch §30 dependency rules (engine must not import browser APIs; apps/web must not import node builtins).
> 2. Root scripts: `pnpm dev | build | typecheck | lint | test | test:e2e | test:providers`. `test:providers` is tagged and excluded from `test`.
> 3. GitHub Actions per Arch §18.4: PR → lint → typecheck → unit → integration → component → E2E (mock) → build. Nightly `test:providers`. Tag job as a stub.
> 4. `docs/DECISIONS.md` seeded with D1–D17 from Arch §39 and FRS §11, plus OI-01..06 and OI-16 listed as open. `docs/adr/` with ADR-001..016 as one file each.
> 5. `CLAUDE.md` at the repo root: doc paths, the full enum quick reference, root scripts, dependency rules, and the "never guess — post DECISION NEEDED" rule.
> 6. A mock provider stub in `packages/providers/src/mock/` with a passing `TC-PRV-010` test.
> 7. **Conflict-avoidance scaffold, this is critical:** create every source folder that later features will fill, each with a placeholder module exporting nothing but a typed `TODO` marker, and create every barrel `index.ts` **already containing the export line for each placeholder**. Later features must only edit their own placeholder file, never a barrel. List the full map in `docs/FILE-OWNERSHIP.md` with the owning feature ID beside each path.
> 8. `.gitattributes` with `* text=auto eol=lf`; `.npmrc` with `node-linker=hoisted`.
> 9. `docs/defect-log.md` with the §4.5 table header and the FRS §8.5 severity scale written at the top, plus `docs/verification/` holding one `README.md` explaining that each feature's verification report is committed here as `<F-ID>-verification.md`.

**Done when** clean clone → `pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build` all green with **no environment variables**, CI green on a throwaway PR, and `docs/FILE-OWNERSHIP.md` lists a path for every feature F01–F49.
**Then** push `main`, tag `phase-0`, and tell Arhant to clone. Both of you run §3.1 before Wave 1.

---

### F01 — Contracts: core enums, error schema, graph entities · **Arhant**

**Branch** `feat/f01-contracts-core` · **Wave 1** · **Phase 1** · **Depends on** F00
**FRs** FR-SYS-006, FR-WF-005, FR-NODE-001/006, FR-CON-002/003/005 **TCs** TC-SYS-007, TC-WF-005
**Read** FRS §3.1, §3.3–3.6 · Arch §15.2–15.3, §20.1, §28
**I own** `packages/contracts/src/common/**`, `packages/contracts/src/graph/**`, their tests
**Seam** F02 (Mouli) fills `runtime/`, `guardrails/`, `tools/`, `bench/` in the same package. Do not open those folders. Barrels are already wired by F00.

**Prompt**
> Fill the core contract placeholders in `packages/contracts/src/common/` and `src/graph/` with Zod schemas and inferred types:
> 1. `common/enums.ts` — node states, run states, failure reasons, provider states, error kinds, data types (text, image, audio, video, code, file, json). Exact strings from CLAUDE.md, with a unit test asserting every literal value.
> 2. `common/errors.ts` — the one error shape `{ error: { kind, code, message, details?, retryable } }` (FR-SYS-006, Arch §28), plus a helper to build each kind.
> 3. `common/pagination.ts`, `common/version.ts` — cursor pagination and the `If-Match` version token used for 409 conflicts (FR-WF-005).
> 4. `graph/` — project, workflow, node, port, edge, and the node-kind discriminated union (agent, model, input, output, merge, transform, retrieval, guardrail, custom). Port typing must make FR-CON-002 (type mismatch) and FR-CON-005 (single vs multi input) decidable from the schema alone.
> 5. Export an `isConnectionAllowed(sourcePort, targetPort)` pure function with tests for TC-CON-002 and TC-CON-006 shapes. Cycle detection belongs to F09 — do not write it.
> Everything is pure schema and pure functions: no I/O, no database, no HTTP.

**Done when** `pnpm test --filter contracts` green, enum-literal test present, and `pnpm typecheck` clean across the workspace.

---

### F02 — Contracts: runtime, envelope, events, guardrails, tools, bench · **Mouli**

**Branch** `feat/f02-contracts-runtime` · **Wave 1** · **Phase 1** · **Depends on** F00
**FRs** FR-EXE-006/007/010, FR-GRD-011/012/015, FR-TOOL-001, FR-BEN-004 **TCs** TC-EXE-005, TC-GRD-016/017
**Read** FRS §3.9, §3.24, §3.26, §3.20 · Arch §12.4 (envelope), §13.1–13.3, §16, §20.3
**I own** `packages/contracts/src/runtime/**`, `src/guardrails/**`, `src/tools/**`, `src/bench/**`, their tests
**Seam** F01 (Arhant) owns `common/` and `graph/`. Import from them; never edit them. If an enum you need is missing there, post a DECISION NEEDED rather than defining a second copy.

**Prompt**
> Fill the runtime contract placeholders with Zod schemas and inferred types:
> 1. `runtime/envelope.ts` — the envelope exactly as Arch §12.4: `reads: Part[]`, bounded `context` (summary, retrieved chunks with score+source, memory, `budgetTokens`, `trust: 'trusted' | 'untrusted'`), `contract` (outputTypes, jsonSchema?, maxTokens?), `guardrailVerdicts?`, ids and iteration. Include a `validateAgainstContract(output, contract)` pure function whose failure maps to `CONTRACT_VIOLATION` (TC-EXE-005). Envelopes must be structurally incapable of carrying raw chat history (BR-02) — add a test asserting that.
> 2. `runtime/run.ts`, `runtime/node-run.ts` — run snapshot, node run record with the FR-EXE-010 fields (inputs, outputs, model used, tokens, cost estimate, time, error, attempt, iteration).
> 3. `runtime/events.ts` — the ordered event envelope with a monotonic sequence number, and the full server→client event union from Arch §20.3.
> 4. `guardrails/` — guardrail policy (versioned), check definitions for the 7 points in Arch §13.1, the five actions (pass, warn, redact, ask user, block), and the verdict record. A redaction verdict must be able to record the *type* removed and be unable to hold the value (FR-GRD-014).
> 5. `tools/` — tool definition with name, description, input/output schema, permissions (`network`, `fsPaths`, `destructive`), timeout; plus the tool-call log record.
> 6. `bench/` — bench task (with freeze hash), experiment, arm, bench run record (FR-BEN-004).
> Pure schema only. No engine logic, no scheduler, no policy evaluation — that is F21.

**Done when** `pnpm test --filter contracts` green, the "envelope cannot carry history" and "redaction holds no value" tests exist, `pnpm typecheck` clean.

---

### F03 — Local storage adapters · **Arhant**

**Branch** `feat/f03-storage-local` · **Wave 2** · **Phase 1** · **Depends on** F01, F02
**FRs** FR-SYS-012, FR-PRV-002, FR-MM-002, NFR-REL-02, NFR-REL-03 **TCs** TC-SYS-014, TC-NFR-006, TC-NFR-007
**Read** FRS §3.1 (SYS-012), §3.13 (MM-002) · Arch §7 (ports table), §15.1–15.4
**I own** `packages/storage-local/**`, `packages/engine/src/ports/**` (the port interfaces only)
**Seam** you define the `Repository`, `BlobStore`, `SecretStore`, `Queue`, `PubSub`, `VectorIndex`, `KeywordIndex` interfaces in `packages/engine/src/ports/`. F04 (Mouli) consumes them and must not edit them. Publish the interface signatures in the PR description the moment they compile, before you finish the implementation.

**Prompt**
> Implement the local-mode adapters behind the ports-and-adapters interfaces (Arch §7, P7):
> 1. In `packages/engine/src/ports/`, declare the interfaces only: `Repository`, `BlobStore`, `SecretStore`, `Queue`, `PubSub`, `VectorIndex`, `KeywordIndex`. No implementations here.
> 2. In `packages/storage-local/`, implement them with better-sqlite3 + Drizzle: every table in Arch §15.3 that exists in local mode, forward-only migrations, indexes on foreign keys, run status and created time.
> 3. Writes must be atomic — a killed process leaves the graph fully old or fully new (TC-NFR-006). Take an automatic backup before every migration (TC-NFR-007).
> 4. `BlobStore`: content-addressed artifact folder, so an identical file stored twice returns the same id (TC-MM-002).
> 5. `SecretStore`: OS keychain, with a clear typed error when the keychain is unavailable. Secrets must never be writable into any SQLite table — enforce it in the repository layer and test it.
> 6. In-process `Queue` and `PubSub` implementations.
> 7. Export/restore of the whole data folder (FR-SYS-012, TC-SYS-014).
> Use a temporary database per test. No network, no provider calls.

**Done when** `pnpm test --filter storage-local` green, kill-mid-write test passes, and a grep of a populated test database finds no secret material.

---

### F04 — Gateway and system layer (SYS) · **Mouli**

**Branch** `feat/f04-gateway-sys` · **Wave 2** · **Phase 2** · **Depends on** F01, F02
**FRs** FR-SYS-001..011 **TCs** TC-SYS-001..013
**Read** FRS §3.1 + SYS rows in §8.6 · Arch §11, §22.1, §29
**I own** `apps/server/**`, `packages/engine/src/gateway/**`, `packages/engine/src/config/**`, `packages/engine/src/logging/**`
**Seam** consume the port interfaces from `packages/engine/src/ports/` (F03). While F03 is unmerged, code against the interface signatures Arhant posted and use an in-memory fake in tests.

**Prompt**
> Build the local engine entry point and gateway:
> 1. Hono server bound to `127.0.0.1` only (FR-SYS-001, TC-SYS-001), a random per-start session token required on every REST request and WebSocket connection (FR-SYS-002), and an origin allow-list returning 403 (FR-SYS-003).
> 2. `GET /health` with version and db status (FR-SYS-004). Zod validation middleware on every route. Request IDs on every response.
> 3. One error format everywhere (FR-SYS-006) — a middleware that converts any thrown error to the FR-SYS-006 shape; test 400/401/404/409 (TC-SYS-007).
> 4. pino JSON logging with secret redaction, daily rotation, 14-day retention (FR-SYS-007, FR-SYS-011).
> 5. Config resolution node → project → user → engine → defaults, Zod-validated at startup; invalid config refuses to start with a clear message (FR-SYS-010, TC-SYS-011/012).
> 6. Settings read/update persisted across restart (FR-SYS-005).
> 7. Graceful shutdown: stop dispatching, cancel in-flight calls, persist events, mark the active run `HALTED` with reason `shutdown` (FR-SYS-008). On restart, any run left `RUNNING` becomes `HALTED` (FR-SYS-009). Both need tests even though the run engine itself arrives in F15 — use a repository fake.
> Route handlers for projects, workflows, runs belong to F05/F15. Register the router mount points only.

**Done when** TC-SYS-001..013 green, `curl` from another machine on the LAN is refused, and a full request cycle leaves no token in the log files.

---

### F05 — Projects and Workflows API · **Arhant**

**Branch** `feat/f05-projects-workflows` · **Wave 3** · **Phase 2** · **Depends on** F03, F04
**FRs** FR-PRJ-001..004, FR-WF-001..008 **TCs** TC-PRJ-001..004, TC-WF-001..008
**Read** FRS §3.2, §3.3 + PRJ/WF rows in §8.6 · Arch §12.2, §20.2, §32
**I own** `packages/engine/src/projects/**`, `packages/engine/src/workflows/**`, their routes and tests
**Seam** F06 (Mouli) owns the event bus. Emit domain events through the `EventBus` interface he declares; do not implement it.

**Prompt**
> Implement project and workflow services plus their `/api/v1` routes:
> 1. Projects: create with name + folder (create the folder, init git), list, open, rename, delete with confirmation, reopen-last-project, and validation that the folder exists and is writable naming the bad path (FR-PRJ-001..004).
> 2. Workflows: create, tabs, rename, duplicate with fresh ids, delete, autosave on every edit (FR-WF-001..004).
> 3. `POST /workflows/:id/graph-ops` — batched graph operations applied in **one transaction**, guarded by `If-Match: <version>`; a stale write returns 409 (FR-WF-005, TC-WF-005).
> 4. `POST /workflows/:id/validate` returning issues with severity, message and node/edge reference (FR-WF-006). Use `isConnectionAllowed` from contracts; do not duplicate the rules.
> 5. Export to JSON with a `formatVersion` and **no secrets** (FR-WF-007, TC-WF-007); import with version checking and a clear error on unsupported versions (FR-WF-008).
> Cycle detection and canvas behaviour are F09/F07. Keep this layer headless and fully testable over HTTP with a temp database.

**Done when** TC-PRJ-001..004 and TC-WF-001..008 green, and an exported workflow from a keyed provider config contains no key.

---

### F06 — Event bus, WebSocket hub, reconnect · **Mouli**

**Branch** `feat/f06-events-ws` · **Wave 3** · **Phase 2** · **Depends on** F03, F04
**FRs** FR-EXE-014, NFR-REL-01 **TCs** TC-EXE-013
**Read** FRS §3.9 (EXE-014) · Arch §12.2 (event bus), §20.3, §21.4
**I own** `packages/engine/src/events/**`, `packages/engine/src/ws/**`, `packages/sdk/src/events/**`
**Seam** you declare `EventBus` (`emit`, `subscribe`) and the `resume` protocol. F05 emits through it. Post the interface in your PR description as soon as it compiles.

**Prompt**
> Build the ordered event system and WebSocket hub:
> 1. An append-only event log with a monotonic per-run sequence number, persisted through the `Repository` port. Events use the contracts from F02 — do not define new event shapes.
> 2. `EventBus` with `emit` and `subscribe`, backed by the in-process `PubSub` port so the same code works with Redis later (Arch §7).
> 3. `/ws` hub: token-checked, handling `subscribe`, `unsubscribe`, and `resume { afterSeq }`. On resume, replay every missed event from the log in order, then continue live (Arch §21.4, TC-EXE-013).
> 4. Token batching of roughly 50 ms before sending stream chunks to clients (Arch §24) — implement the batching utility now, even though streams arrive in F16.
> 5. A typed client-side event stream helper in `packages/sdk/src/events/` that reconnects and resumes automatically.
> 6. Test: drop the socket mid-stream with 200 buffered events, reconnect, assert every event arrives exactly once and in order.

**Done when** TC-EXE-013 green with a forced disconnect, no duplicate or missing sequence numbers, and `pnpm typecheck` clean. **Wave 3 closes Phase 2** — second merger runs the phase gate and tags `phase-2`.

---

### F07 — Canvas shell, design system, navigation · **Arhant**

**Branch** `feat/f07-canvas-shell` · **Wave 4** · **Phase 3** · **Depends on** F05, F06
**FRs** FR-CAN-001, 003, 004, 007, 010 **TCs** TC-CAN-002, 003, 006, 009 · NFR-PERF-01, NFR-PERF-05
**Read** FRS §3.4 + CAN rows in §8.6 · Arch §10.1, §33.2–33.3
**I own** `apps/web/src/app/**`, `apps/web/src/canvas/**`, `packages/ui/**`
**Seam** F08 (Mouli) owns node components and the config panel. You provide the canvas surface and the layout slots; he fills them. Agree the `NodeComponentProps` shape in `packages/ui` before either of you writes UI.

**Prompt**
> Build the SPA shell and the canvas surface:
> 1. React + Vite SPA with the routes in Arch §33.3, TanStack Query for engine data, Zustand for selection/panels/viewport, and the single WebSocket client from the SDK patching both.
> 2. The design system in `packages/ui`: dark dotted canvas, provider accent colours, status rings, serif for human text, monospace for machine text, WCAG AA contrast. Tailwind + shadcn/ui.
> 3. React Flow canvas: select one / multi (Shift, Ctrl) / box select, drag to move with positions persisted through batched graph-ops, pan, zoom on mouse and trackpad, fit-to-view, minimap (FR-CAN-003/004/007).
> 4. A loading state so the graph never renders half-drawn (FR-CAN-010, TC-CAN-009).
> 5. Virtualized rendering and memoized nodes so a 200-node / 400-edge graph stays around 60 fps (NFR-PERF-01) and loads in under a second (NFR-PERF-05). Include the perf harness that generates the 200-node fixture.
> The node palette, node cards and config panel are F08 — render `props.children` slots for them and stop there.

**Done when** TC-CAN-002/003/006/009 green in Playwright, the 200-node fixture measured at ≈60 fps, positions identical after reload.

---

### F08 — Nodes: palette, node cards, configuration panel · **Mouli**

**Branch** `feat/f08-nodes-config` · **Wave 4** · **Phase 3** · **Depends on** F05, F06
**FRs** FR-CAN-002, FR-NODE-001..013 **TCs** TC-CAN-001, TC-NODE-001..010
**Read** FRS §3.5 + NODE rows in §8.6 · Arch §10.1, §12.7
**I own** `apps/web/src/nodes/**`, `apps/web/src/config-panel/**`
**Seam** consume `NodeComponentProps` and the design tokens from `packages/ui` (F07). Do not edit `apps/web/src/canvas/**`.

**Prompt**
> Build the node palette, node cards and configuration panel:
> 1. Palette with the node kinds available in Phase 3 (Agent, Model, Input, Output, Merge, Transform); click or drag adds a node at the drop point and persists it (FR-CAN-002, FR-NODE-001).
> 2. Node card: provider accent colour that never changes with state, a separate status ring for state, and a model chip that updates immediately on model change (FR-NODE-005, FR-NODE-010, TC-NODE-009).
> 3. Config panel with every FR-NODE-003 field: name, provider, model, routing policy, system instructions, input/output types, tools, skills, context policy, memory, guardrail policy, execution settings. Fields whose backends land later (tools, skills, memory) render disabled with "available in a later phase" — do not stub fake behaviour.
> 4. Declared input/output data types create matching typed ports (FR-NODE-006, TC-NODE-005).
> 5. Execution settings validated against allowed ranges with inline errors that block saving (FR-NODE-007, TC-NODE-006). Invalid config marks the node so pre-flight can name it (FR-NODE-008).
> 6. Editing during an active run shows "applies to the next run" and does not mutate the running snapshot (FR-NODE-009, TC-NODE-008).
> 7. Input node collects text and/or files at run start; Output node shows the final result (FR-NODE-011/012). Transform node UI for template / extract-JSON-field / join (FR-NODE-013, OI-06).
> The model picker filters by availability and data type — read the catalog through a typed hook and fail gracefully while F12 is unmerged.

**Done when** TC-NODE-001..010 green, all config fields survive a reload, and TC-CAN-001 passes.

---

### F09 — Connections, typed ports, graph validation · **Arhant**

**Branch** `feat/f09-connections` · **Wave 5** · **Phase 3** · **Depends on** F07, F08
**FRs** FR-CON-001..006, FR-WF-006 **TCs** TC-CON-001..006, TC-WF-006
**Read** FRS §3.6 + CON rows in §8.6 · Arch §12.3
**I own** `apps/web/src/edges/**`, `packages/engine/src/workflows/cycles.ts`, `packages/engine/src/workflows/validate.ts`
**Seam** uses `isConnectionAllowed` from contracts (F01) and the validate route from F05. Extend `validate.ts` only; do not touch other files in `workflows/`.

**Prompt**
> Implement connections and graph validation:
> 1. Drag from an output port to an input port creates and persists an edge (FR-CON-001).
> 2. Incompatible data types are refused **with the reason shown to the user** (FR-CON-002, TC-CON-002).
> 3. Cycle detection in `packages/engine/src/workflows/cycles.ts`: a plain edge that would close a cycle is refused; a loop edge is the only legal cycle (FR-CON-003, BR-05). Loop edge *behaviour* is F24 — here only the validation rule and the visual distinction.
> 4. Delete an edge by key or context menu (FR-CON-004). Fan-out from one output to many inputs; a single-input port refuses a second edge (FR-CON-005, TC-CON-005/006).
> 5. Edge shows its data type, and hovering shows a short summary of the last transferred data (FR-CON-006) — render "no data yet" until runs exist.
> 6. Wire the validation panel: every issue lists severity, message and the node or edge it refers to (FR-WF-006, TC-WF-006).

**Done when** TC-CON-001..006 and TC-WF-006 green, and a refused connection always states why.

---

### F10 — Canvas productivity: undo/redo, auto-layout, shortcuts · **Mouli**

**Branch** `feat/f10-canvas-productivity` · **Wave 5** · **Phase 3** · **Depends on** F07, F08
**FRs** FR-CAN-005, 006, 008, 009, 011, 012, 013 **TCs** TC-CAN-004, 005, 007, 008, 010
**Read** FRS §3.4 + CAN rows in §8.6 · Arch §10.1, ADR-010
**I own** `apps/web/src/canvas/interactions/**`, `apps/web/src/canvas/layout/**`
**Seam** F09 (Arhant) owns edges. Deleting a node must remove its edges through the graph-ops API, not by editing edge components.

**Prompt**
> Add canvas productivity features:
> 1. Delete selected nodes and their edges with no dangling edges left (FR-CAN-005, TC-CAN-004).
> 2. Duplicate nodes with config copied and new ids, offset on the canvas, fully independent of the original (FR-CAN-006, TC-CAN-005).
> 3. Auto-arrange: a pure `LayoutFn` producing a left-to-right layout with no overlaps, triggered by a button — free dragging stays available per ADR-010 (FR-CAN-008, TC-CAN-007).
> 4. Undo/redo of at least 50 graph edits covering add, move, delete and connect, in order (FR-CAN-009, TC-CAN-008). Undo must replay through batched graph-ops so the engine stays the source of truth (P2) — never mutate local state alone.
> 5. Right-click menus for node, edge and empty canvas (FR-CAN-011); shortcuts Delete, Ctrl+D, Ctrl+A, Ctrl+Z/Y, F (FR-CAN-012, TC-CAN-010).
> 6. Copy/paste nodes between workflows keeping config and assigning new ids (FR-CAN-013).

**Done when** TC-CAN-004/005/007/008/010 green, undo survives a page reload boundary correctly, and no orphan edges exist after any delete.
**Wave 5 closes Phase 3** — run the gate, open the UI, tag `phase-3`.

---

### F11 — Provider adapters, secrets, status checks · **Arhant**

**Branch** `feat/f11-provider-adapters` · **Wave 6** · **Phase 4** · **Depends on** F09, F10
**FRs** FR-PRV-001..003, 005, 006, 008, 009 **TCs** TC-PRV-001..004, 006, 007, 008, 009
**Read** FRS §3.7 + PRV rows in §8.6 · Arch §14.1–14.2, §19.3, §22.1
**I own** `packages/providers/src/adapters/**`, `packages/providers/src/status/**`
**Seam** you own the `ProviderAdapter` interface (Arch §14.2). F12 (Mouli) consumes `listModels()`; F13 consumes `generate()`. Publish the exact signatures in your PR description first.

**Prompt**
> Implement the provider layer (Arch §14.2), built on the Vercel AI SDK where possible:
> 1. `ProviderAdapter` interface: `check()`, `listModels()`, `generate()` returning an async iterable of stream chunks with an AbortSignal, optional `embed()`.
> 2. Adapters: Anthropic, Google, OpenAI, OpenAI-compatible (base URL + optional key + model list, so Ollama and LM Studio work), and Ollama auto-detection on the default local address (FR-PRV-001, 006, 007).
> 3. Keys go to the keychain through the `SecretStore` port and are **never** returned by the API — responses carry only "key set: yes/no" (FR-PRV-002, TC-PRV-002).
> 4. `check()` maps to the provider state machine (Arch §19.3): CONNECTED, AUTH_FAILED, UNREACHABLE, RATE_LIMITED (FR-PRV-003, TC-PRV-003/004).
> 5. Edit, rotate key, remove; removing an in-use provider needs confirmation and marks dependent nodes invalid (FR-PRV-005, TC-PRV-006).
> 6. Per-provider concurrency limit and backoff, honoured by a semaphore the executor will later share (FR-PRV-009, TC-PRV-009).
> 7. CLI provider detection (Claude Code, Codex, Gemini) with login status and an install hint when missing — detection only, no execution yet (FR-PRV-008, OI-01).
> Map every provider error onto the ACE error kinds from F01. Tests use recorded fixtures and the mock adapter — **no real API calls in `pnpm test`**.

**Done when** TC-PRV-001..004/006..009 green with no network access, and `GET /providers` never exposes a key.

---

### F12 — Model catalog and providers UI · **Mouli**

**Branch** `feat/f12-model-catalog` · **Wave 6** · **Phase 4** · **Depends on** F09, F10
**FRs** FR-MOD-001..006, FR-PRV-004 **TCs** TC-MOD-001..004, TC-PRV-005
**Read** FRS §3.8 + MOD rows in §8.6 · Arch §14.4, §10.1, §27 (price table)
**I own** `packages/providers/src/catalog/**`, `apps/web/src/providers/**`
**Seam** call `ProviderAdapter.listModels()` from F11. Do not edit adapter files. While F11 is unmerged, code against the posted signature with a fake adapter.

**Prompt**
> Build the model catalog and the providers screen:
> 1. Discovery where the provider supports listing; a **versioned manifest** fallback where it does not, with the source recorded as `discovered` or `manifest` (FR-MOD-001/002, TC-MOD-001/002).
> 2. Each model records provider, model id, display name, input/output types, context window, tool support, JSON mode, availability, last checked (FR-MOD-003).
> 3. Filters by provider, data type and availability (FR-MOD-004, TC-MOD-003). Refresh on demand and daily, with the timestamp shown (FR-MOD-006).
> 4. Nodes using an unavailable model are flagged by validation before any run (FR-MOD-005, TC-MOD-004).
> 5. Provider status in the top bar and settings, refreshed on a schedule and pushed over the WebSocket so it updates without a page reload (FR-PRV-004, TC-PRV-005).
> 6. The manifest also carries the **versioned price table** used later for cost estimates (Arch §27, FR-OBS-003) — define the schema and ship version 1; the cost maths is F18.

**Done when** TC-MOD-001..004 and TC-PRV-005 green, stopping Ollama updates the UI live, and the price table is versioned and immutable per version.

---

### F13 — Model router: fixed and fallback · **Arhant**

**Branch** `feat/f13-router` · **Wave 7** · **Phase 4** · **Depends on** F11, F12
**FRs** FR-RTR-001, 002, 006, 007 (003–005 stubs) **TCs** TC-RTR-001..006
**Read** FRS §3.25 + RTR rows in §8.6 · Arch §14.3 · D12/OI-10
**I own** `packages/providers/src/router/**`
**Seam** consumes `ProviderAdapter` (F11) and the catalog (F12). The executor (F16) calls `router.resolve(node, requirements)`.

**Prompt**
> Implement the model router per Arch §14.3 and decision D12:
> 1. `Fixed` is the default policy for every new agent (FR-RTR-001, TC-RTR-001).
> 2. `Fallback chain`: on a provider or network failure, try the next model in the list; auth and config errors must **not** trigger fallback (FR-RTR-002, TC-RTR-002/003).
> 3. The model actually used is always returned and recorded so the node and inspector can show it (FR-RTR-006, TC-RTR-004).
> 4. Bench runs refuse any non-Fixed policy (FR-RTR-007, BR-16, TC-RTR-005).
> 5. Capability, cost-aware and latency-aware policies: implement the policy interface and leave them behind a feature flag with tests marked `todo`, unless D12 has been changed in DECISIONS.md — check it first and post a DECISION NEEDED if it disagrees with FRS §3.25.
> Router is pure selection logic over the catalog plus recent measurements. It must not call providers itself.

**Done when** TC-RTR-001..005 green on the mock provider, and a forced 503 on the primary produces an answer from the secondary with the used model recorded.

---

### F14 — Mock provider (full) · **Mouli**

**Branch** `feat/f14-mock-provider` · **Wave 7** · **Phase 4** · **Depends on** F11, F12
**FRs** FR-PRV-010 **TCs** TC-PRV-010 (plus it underwrites every later TC)
**Read** FRS §3.7 (PRV-010), §8.3 (test environment) · Arch §14.1
**I own** `packages/providers/src/mock/**`, `packages/providers/src/test-fixtures/**`
**Seam** implements the F11 `ProviderAdapter` interface. This is the single most reused piece of the repo — over-document it.

**Prompt**
> Expand the Phase 0 mock provider stub into the harness every later phase depends on (FRS §8.3):
> 1. Deterministic outputs keyed by input hash, so the same workflow always produces the same result.
> 2. Scripted behaviours selectable per test: token-by-token streaming with configurable delay, malformed JSON (for CONTRACT_VIOLATION), refusal, tool-call requests, 429 then success, 503, 401, timeout, and an output containing a fake API key (for secret-leak guardrail tests).
> 3. Configurable latency and a deterministic token/cost accounting so cost-total tests are exact.
> 4. A mock embedder producing stable vectors, so RAG tests in Phase 10 never need a real model.
> 5. Multimodal support: accept image/audio/video parts, and simulate a text-only model refusing them for pre-flight tests.
> 6. A `scripts/` helper that builds each fixture workflow from FRS §8.3 (linear, parallel, loop, multimodal, RAG, custom HTTP node) against the mock.
> 7. Document every scripted behaviour in `packages/providers/src/mock/README.md` with the TC IDs that use it.

**Done when** TC-PRV-010 green, every scripted behaviour has a test, and `pnpm test` still needs zero environment variables.
**Wave 7 closes Phase 4** — run the gate, tag `phase-4`.

---

### F15 — Run service, snapshots, pre-flight, scheduler · **Arhant**

**Branch** `feat/f15-scheduler` · **Wave 8** · **Phase 5** · **Depends on** F13, F14
**FRs** FR-EXE-001..004, 011, 012 **TCs** TC-EXE-001..004, 010, 011 · NFR-PERF-03, NFR-PERF-06
**Read** FRS §3.9 + EXE rows in §8.6 · Arch §12.3 (scheduler algorithm), §19.1–19.2, §21.1
**I own** `packages/engine/src/runs/**`, `packages/engine/src/scheduler/**`, `packages/engine/src/preflight/**`
**Seam** you call `nodeExecutor.execute(nodeRun)` — an interface F16 (Mouli) implements. Declare the interface here in your first commit and post it; use a fake executor in your own tests.

**Prompt**
> Implement the run lifecycle and scheduler exactly as Arch §12.3:
> 1. Start a run: freeze an **immutable snapshot** of the workflow at dispatch; later edits never affect a running run (FR-EXE-002, BR-04, TC-EXE-002).
> 2. Pre-flight: providers reachable, models available and capable, guardrail policies resolvable, budgets present. Any failure → run `BLOCKED` with the full issue list and **zero provider calls** (FR-EXE-003, BR-08, TC-EXE-003).
> 3. Scheduler loop per Arch §12.3: mark nodes READY when all required inputs are available, dispatch respecting global and per-provider concurrency, handle success, failure, and the WAITING state. Nodes run only when their dependencies are complete (FR-EXE-004, TC-EXE-004).
> 4. XState v5 machines transcribed from Arch §19.1 and §19.2 — node and run state machines, with a test asserting every transition in those diagrams and rejecting transitions that are not there.
> 5. Terminal states: all output nodes completed → `COMPLETE`, otherwise `HALTED` (FR-EXE-011, BR-03, TC-EXE-010).
> 6. Run history per workflow with status, duration, tokens, cost, newest first (FR-EXE-012, TC-EXE-011).
> 7. Dispatch overhead under 50 ms per node measured with 100 instant mock nodes (NFR-PERF-03, TC-NFR-002); default 20 concurrent node runs, configurable (NFR-PERF-06).
> Parallel branches, merges and loops are F23/F24 — implement the dependency ordering they will build on, nothing more.

**Done when** TC-EXE-001..004/010/011 green, the state-machine transition test exists, and dispatch overhead is measured and recorded in the Deliverable report.

---

### F16 — Node executor, envelope engine, streaming · **Mouli**

**Branch** `feat/f16-node-executor` · **Wave 8** · **Phase 5** · **Depends on** F13, F14
**FRs** FR-EXE-005..010, 015 **TCs** TC-EXE-005..009, 014 · NFR-PERF-04
**Read** FRS §3.9 + EXE rows in §8.6 · Arch §12.4 (envelope), §21.1, §24
**I own** `packages/engine/src/nodes/**`, `packages/engine/src/envelopes/**`
**Seam** implement the `NodeExecutor` interface F15 declares. Call `router.resolve()` (F13) and the adapter's `generate()` (F11). Do not edit the scheduler.

**Prompt**
> Implement single-node execution and the envelope engine:
> 1. Build the envelope for each handoff from the contracts in F02: reads plus bounded context plus output contract. **Never** pass raw conversation history (BR-02, P3).
> 2. Enforce the token budget: an oversized upstream output is summarised or truncated to fit `budgetTokens`, and the envelope's token count never exceeds it (FR-EXE-007, TC-EXE-006). The summary **cache** is F31 — call a `Summariser` port and use a trivial implementation now.
> 3. Outputs are validated against the downstream contract; a failure is `CONTRACT_VIOLATION`, never `RUN_FAILED` (FR-EXE-006, BR-03, TC-EXE-005).
> 4. Stream model output to the UI through the F06 event bus with roughly 50 ms batching; text must reach the screen within 200 ms of arriving (FR-EXE-008, NFR-PERF-04, TC-EXE-007/TC-NFR-003).
> 5. Record the full node run: inputs, outputs, model actually used, tokens, cost estimate, duration, error, attempt, iteration (FR-EXE-010, TC-EXE-009).
> 6. Every node state from Arch §19.1 is emitted and visually distinct in the UI (FR-EXE-009, TC-EXE-008), and edges animate on transfer (FR-EXE-015, TC-EXE-014).
> The tool-calling loop is F34 and guardrail hooks are F21 — leave clearly named extension points with `// F21 hook` comments and no behaviour.

**Done when** TC-EXE-005..009/014 green, stream latency measured under 200 ms, and a 50k-token upstream output produces a 4k-budget envelope.

---

### F17 — Prompt management · **Arhant**

**Branch** `feat/f17-prompts` · **Wave 9** · **Phase 5** · **Depends on** F15, F16
**FRs** FR-PRM-001..005, 007 **TCs** TC-PRM-001..005
**Read** FRS §3.23 + PRM rows in §8.6 · Arch §12.5
**I own** `packages/engine/src/prompts/**`, `apps/web/src/inspector/prompt/**`
**Seam** the executor (F16) calls `promptManager.assemble(node, envelope)`. Add the call at the `// F17 hook` marker only.

**Prompt**
> Implement prompt management per Arch §12.5:
> 1. Fixed assembly order, always: system base → agent instructions → skills → guardrail instructions → context (summary, retrieved, memory) → reads → output contract. The same config must produce a byte-identical prompt every time (FR-PRM-001, TC-PRM-001).
> 2. Context sections are clearly delimited and untrusted content is labelled as untrusted inside marked blocks (FR-PRM-002, BR-13, TC-PRM-002). Skills and guardrail instructions have no content yet — render their empty sections so the order is already fixed.
> 3. Placeholders `{{input.text}}`, `{{memory.key}}`, `{{run.iteration}}`; an unknown placeholder is a validation issue, not a silent blank (FR-PRM-003, TC-PRM-003).
> 4. Agent prompts are versioned; every node run records the version used (FR-PRM-004, TC-PRM-004).
> 5. "View prompt" in the inspector shows exactly what was sent, with secrets redacted (FR-PRM-005, TC-PRM-005).
> 6. Side-by-side diff of two prompt versions (FR-PRM-007).
> The project prompt library (FR-PRM-006) is F32 — do not build it.

**Done when** TC-PRM-001..005 green, and the same node assembled twice is byte-identical.

---

### F18 — Run history, trace view, token and cost metering · **Mouli**

**Branch** `feat/f18-trace-cost` · **Wave 9** · **Phase 5** · **Depends on** F15, F16
**FRs** FR-OBS-001, 002, 003, 007 **TCs** TC-OBS-001, 002, 003
**Read** FRS §3.27 + OBS rows in §8.6 · Arch §26, §27
**I own** `packages/engine/src/usage/**`, `apps/web/src/runs/**`, `apps/web/src/inspector/trace/**`
**Seam** reads node runs written by F16 and the price table from F12. Read-only over both.

**Prompt**
> Build the run trace and cost metering:
> 1. A trace view per run: node runs, tool calls and guardrail verdicts in event-log order, matching the event sequence exactly (FR-OBS-001, TC-OBS-001). Tool and guardrail rows render empty until F21/F34 land — build the timeline to accept them now.
> 2. Tokens and estimated cost recorded per node run and totalled per run, per workflow and per day; the run total must equal the sum of its node runs (FR-OBS-002, TC-OBS-002).
> 3. Cost estimates use the **versioned** price table from F12: changing the price table must never alter a past estimate (FR-OBS-003, TC-OBS-003) — store the price-table version on the node run.
> 4. Basic health metrics in settings: runs started/completed/halted, node failures by kind, provider latency (FR-OBS-007).
> 5. Run list and run detail screens with status, duration, tokens and cost, newest first.
> Langfuse, Sentry and the full usage screen are F41.

**Done when** TC-OBS-001..003 green, and re-pricing a model leaves last week's run totals untouched.
**Wave 9 closes Phase 5** — run the gate, tag `phase-5`.

---

### F19 — Execution control · **Arhant**

**Branch** `feat/f19-control` · **Wave 10** · **Phase 6** · **Depends on** F17, F18
**FRs** FR-CTL-001..006, FR-EXE-013 **TCs** TC-CTL-001..006, TC-EXE-012
**Read** FRS §3.10 + CTL rows in §8.6 · Arch §19.2
**I own** `packages/engine/src/runs/control/**`, `apps/web/src/runs/controls/**`
**Seam** drives the scheduler (F15) through its public API. Do not change the scheduler loop itself; if you need a hook there, post a DECISION NEEDED.

**Prompt**
> Implement run controls:
> 1. Pause: no new nodes dispatch, running nodes finish, run shows `PAUSED` (FR-CTL-001, TC-CTL-001). Resume continues from exactly where it stopped (FR-CTL-002).
> 2. Stop: cancel in-flight provider calls via AbortSignal within 2 seconds, nodes become `STOPPED`, run becomes `HALTED` (FR-CTL-003, TC-CTL-003).
> 3. Restart: a new run id with the same snapshot and inputs (FR-CTL-004, TC-CTL-004).
> 4. Re-run a single node with the latest upstream outputs, executing only that node (FR-CTL-005, TC-CTL-005).
> 5. Start a run from a chosen node, reusing earlier upstream outputs without re-calling them (FR-EXE-013, TC-EXE-012).
> 6. Control buttons enable and disable strictly from run state — Resume only when paused, and so on (FR-CTL-006, TC-CTL-006).
> A stopped node must be visibly different from a failed one; do not merge the two states.

**Done when** TC-CTL-001..006 and TC-EXE-012 green, and a stop during streaming closes the provider stream within 2 seconds (measured).

---

### F20 — Error model, retries, BLOCKED cascade · **Mouli**

**Branch** `feat/f20-errors` · **Wave 10** · **Phase 6** · **Depends on** F17, F18
**FRs** FR-ERR-001..008 **TCs** TC-ERR-001..009
**Read** FRS §3.11 + ERR rows in §8.6 · Arch §28
**I own** `packages/engine/src/errors/**`, `packages/engine/src/runs/retry/**`, `apps/web/src/errors/**`
**Seam** F19 (Arhant) owns control. Cancellation is his state (`STOPPED`); you must classify it as `user_cancelled` and never as a failure.

**Prompt**
> Implement the error model from Arch §28:
> 1. Classify every error into the eight kinds: user_cancelled, agent, provider, auth, network, invalid_config, workflow, guardrail. One test per kind driven by the mock provider (FR-ERR-001, TC-ERR-001). `guardrail` is wired here as a kind; its producer is F21.
> 2. Error view: failed node, kind, message, provider, state and a Retry button (FR-ERR-002, TC-ERR-002). Every message says what happened **and what to do next** (NFR-USE-03).
> 3. Manual retry with the same inputs, incrementing the attempt number into a new node run (FR-ERR-003, TC-ERR-003); retry-with-downstream (FR-ERR-004, TC-ERR-004).
> 4. Automatic retry policy: network and rate-limit retry with backoff; auth and invalid_config never retry (FR-ERR-005, TC-ERR-005/006).
> 5. Nodes unreachable because an upstream node failed become `BLOCKED`, never `FAILED` (FR-ERR-006, BR-03, TC-ERR-007).
> 6. Cancellation renders differently from failure and is excluded from failure counts (FR-ERR-007, TC-ERR-008).
> 7. Fix a failed node's config and re-run it without rebuilding the workflow (FR-ERR-008, TC-ERR-009).

**Done when** TC-ERR-001..009 green, and a 401 from the mock produces exactly one attempt.

---

### F21 — Guardrail engine, policies, input and output checks · **Arhant**

**Branch** `feat/f21-guardrails-core` · **Wave 11** · **Phase 6** · **Depends on** F19, F20
**FRs** FR-GRD-001..005, 007, 010..012, 014, 015, 018 **TCs** TC-GRD-001..007, 010, 011, 015..019
**Read** FRS §3.24 + GRD rows in §8.6 · Arch §13.1–13.4 · D9, D10
**I own** `packages/guardrails/**`, `packages/engine/src/guardrails/**`, `apps/web/src/guardrails/**`
**Seam** F22 (Mouli) adds the cost, loop and approval points and the UI for approvals. You own the policy engine, the verdict pipeline and the input/output/context/tool check definitions; he registers additional checks through your `registerCheck()` API. Publish that API in your first commit.

**Prompt**
> Build the guardrail engine per Arch §13:
> 1. Policies are created, edited, **versioned** and testable via `POST /guardrail-policies/:id/test`; the run records the policy version used (FR-GRD-001, TC-GRD-001).
> 2. Project default policy with per-agent override (FR-GRD-002, TC-GRD-002).
> 3. Input guardrails: size/type limits, PII regex rule pack, prompt-injection rule pack, blocked topics (FR-GRD-003, TC-GRD-003/004).
> 4. Context guardrails: retrieved chunks, upstream outputs and tool results tagged untrusted, hidden instructions stripped (FR-GRD-004, BR-13, TC-GRD-005). Retrieval arrives in F30 — test with a fixture document containing a hidden instruction.
> 5. Tool guardrail **check definitions** only (allowed tool, valid arguments, path inside project, domain allow-list) — the tool executor that calls them is F34/F36 (FR-GRD-005, TC-GRD-006/007).
> 6. Output guardrails: contract check, moderation via rule pack, secret-leak detection by key format, PII, required citations (FR-GRD-007, TC-GRD-010/011).
> 7. Data guardrails always on and **not disableable**: secrets never stored or logged, file access confined (FR-GRD-010, BR-15, TC-GRD-015).
> 8. Five actions — pass, warn, redact, ask user, block (FR-GRD-011, TC-GRD-016). A block fails the node with `GUARDRAIL_VIOLATION`, distinct from `CONTRACT_VIOLATION` (D9, BR-12, TC-GRD-017). Redaction records the type removed, never the value (FR-GRD-014, TC-GRD-018). Every verdict is stored on the node run and shown in the inspector (FR-GRD-015, TC-GRD-019).
> 9. Default policy per D10: warn on content issues, block secret leaks and tool abuse (FR-GRD-018).
> Rule packs only — the local classifier (Llama Guard on Ollama) is F44. Rule-pack checks must add under 300 ms per node (NFR-SAFE-01).

**Done when** TC-GRD-001..007/010/011/015..019 green, guardrail overhead measured under 300 ms per node, and data guardrails cannot be switched off through any API.

---

### F22 — Cost and loop guardrails, budgets, approvals · **Mouli**

**Branch** `feat/f22-budgets-approvals` · **Wave 11** · **Phase 6** · **Depends on** F19, F20
**FRs** FR-GRD-006, 008, 009, 013 **TCs** TC-GRD-008, 009, 012, 013, 014
**Read** FRS §3.24 (GRD-006/008/009/013) · Arch §13.1, §21.2 (approval flow), §19.1 (WAITING)
**I own** `packages/engine/src/budgets/**`, `packages/engine/src/approvals/**`, `apps/web/src/approvals/**`
**Seam** register your checks through F21's `registerCheck()` API. Do not edit `packages/guardrails/**`.

**Prompt**
> Implement cost guardrails, loop guardrails and human approvals:
> 1. Cost guardrails: max tokens per node, max cost per run, daily budget. Exceeding a cap stops the run as `HALTED` with reason `budget_exceeded` (FR-GRD-008, TC-GRD-012).
> 2. Loop guardrails: max iterations, max tool calls per node, and repeated-output detection that stops a loop when the same output appears three times in a row (FR-GRD-009, TC-GRD-013/014). The loop machinery itself is F24 — enforce the limits through the scheduler's iteration counter.
> 3. Approvals: an "ask user" verdict puts the node in `WAITING` and emits `node.approval_required` (Arch §21.2). `POST /node-runs/:id/approve` continues; `reject` fails the node with `GUARDRAIL_VIOLATION`. Every decision is logged with timestamp (FR-GRD-013, TC-GRD-008/009).
> 4. Destructive tool actions require approval by default (FR-GRD-006, BR-14) — register the check now; the tool executor calls it in F34.
> 5. Approval card UI on the canvas and in the run view, answerable with the keyboard, and laid out so it already works at 380 px (this is what FR-MOB-002 will test in F48).
> 6. A run that sits in `WAITING` must not hold provider concurrency slots.

**Done when** TC-GRD-008/009/012/013/014 green, a rejected approval yields `GUARDRAIL_VIOLATION`, and a $0.01 cap halts an expensive run with the right reason.
**Wave 11 closes Phase 6** — run the gate, tag `phase-6`.

---

### F23 — Parallel branches and merge node · **Arhant**

**Branch** `feat/f23-parallel-merge` · **Wave 12** · **Phase 7** · **Depends on** F21, F22
**FRs** FR-PAR-001, 002 **TCs** TC-PAR-001, 002, 003 · NFR-PERF-06
**Read** FRS §3.12 + PAR rows in §8.6 · Arch §12.3
**I own** `packages/engine/src/scheduler/parallel/**`, `apps/web/src/nodes/merge/**`
**Seam** F24 (Mouli) adds loop edges to the same scheduler. You own the fan-out/merge path; he owns the loop path. Neither edits the other's file.

**Prompt**
> Implement parallel execution and the merge node:
> 1. Independent branches dispatch concurrently within global and per-provider concurrency limits; two 2-second branches finish in about 2 seconds, not 4 (FR-PAR-001, TC-PAR-001).
> 2. Merge node with two modes: wait for **all** inputs, or proceed on the **first** input. Output is ordered by input port, deterministically (FR-PAR-002, TC-PAR-002/003).
> 3. In "any" mode, the losing branches are marked appropriately and never silently reported as failures.
> 4. Verify NFR-PERF-06: 20 simultaneous node runs complete with no errors and the UI stays responsive (TC-NFR-005).
> 5. Merge node UI: mode selector, and input ports that show which branch fed which slot.

**Done when** TC-PAR-001..003 and TC-NFR-005 green with timings recorded in the Deliverable report.

---

### F24 — Loop edges, iterations, exit conditions · **Mouli**

**Branch** `feat/f24-loops` · **Wave 12** · **Phase 7** · **Depends on** F21, F22
**FRs** FR-CON-007, FR-PAR-003..007 **TCs** TC-CON-007, TC-PAR-004..008
**Read** FRS §3.12, §3.6 (CON-007) · Arch §12.3 (loop edge handling), ADR-011
**I own** `packages/engine/src/scheduler/loops/**`, `apps/web/src/edges/loop/**`
**Seam** loop limits are enforced by F22's loop guardrail — call it, do not reimplement it.

**Prompt**
> Implement loop edges per ADR-011:
> 1. A loop edge carries a max iteration count (1–50) and an exit condition; 0 and 51 are refused (FR-CON-007, TC-CON-007). Loop edges are drawn distinctly from data edges.
> 2. The scheduler requeues the target with `iteration + 1` while the exit condition is unmet and the maximum is not reached; the count can never exceed the maximum (FR-PAR-003, TC-PAR-005).
> 3. Exit conditions evaluate a field of the upstream node's structured output, e.g. `verdict == "approved"` (FR-PAR-004, TC-PAR-004).
> 4. Every iteration is recorded as its own node run; the UI shows the count and lets the user select each iteration's output (FR-PAR-005, TC-PAR-006).
> 5. On reaching the maximum, either continue with the last output or fail, as configured (FR-PAR-006, TC-PAR-007).
> 6. A standard review contract — score, verdict, issues — validated like any other output contract; a reviewer returning no verdict is a `CONTRACT_VIOLATION` (FR-PAR-007, TC-PAR-008).
> Call the F22 loop guardrail for max-iteration, max-tool-call and repeated-output enforcement.

**Done when** TC-CON-007 and TC-PAR-004..008 green, and a reviewer that never approves produces exactly `max` iterations.
**Wave 12 closes Phase 7** — run the gate, tag `phase-7`.

---

### F25 — Artifact store, uploads, deduplication, download · **Arhant**

**Branch** `feat/f25-artifacts` · **Wave 13** · **Phase 8** · **Depends on** F23, F24
**FRs** FR-MM-001..005, 009 **TCs** TC-MM-001..005, 008
**Read** FRS §3.13 + MM rows in §8.6 · Arch §15.1, §16
**I own** `packages/engine/src/artifacts/**`, `apps/web/src/artifacts/upload/**`
**Seam** F26 (Mouli) owns media processing and rendering. You own storage, references and the upload path.

**Prompt**
> Implement the artifact layer:
> 1. Upload with a configurable size limit, default 100 MB; larger files are refused with a clear message (FR-MM-001, TC-MM-001). File-type checks per NFR-SEC-05.
> 2. Content-addressed storage through the `BlobStore` port: the same file uploaded twice yields one artifact (FR-MM-002, TC-MM-002).
> 3. All seven data types accepted and passed between nodes: text, image, audio, video, code, structured data, files (FR-MM-003, TC-MM-003).
> 4. Files move between nodes as **references inside the envelope**, never as bytes in a message (FR-MM-004, TC-MM-004) — extend the envelope `Part` handling, not the envelope schema.
> 5. A model that cannot accept a data type is flagged in pre-flight, before any call (FR-MM-005, TC-MM-005).
> 6. Any artifact can be downloaded and the downloaded bytes hash-match the original (FR-MM-009, TC-MM-008).
> 7. Retention: artifacts are kept until unreferenced plus 7 days (Arch §15.4) — implement the sweep with a test that fakes the clock.

**Done when** TC-MM-001..005/008 green and an envelope carrying an image contains no raw bytes.

---

### F26 — Media tools and typed output rendering · **Mouli**

**Branch** `feat/f26-media-rendering` · **Wave 13** · **Phase 8** · **Depends on** F23, F24
**FRs** FR-MM-006..008 **TCs** TC-MM-006, 007, 009
**Read** FRS §3.13 (MM-006..008) · Arch §16 (media row), §10.1
**I own** `packages/tools/src/media/**`, `apps/web/src/outputs/**`
**Seam** consumes artifact references from F25. Never write to the blob store directly — go through his service.

**Prompt**
> Implement media tools and output rendering:
> 1. Media tools with local libraries only (sharp for images; frame extraction; optional local Whisper server for transcription). Nothing paid, nothing cloud (FR-MM-008).
> 2. Output rendering by type: formatted text, syntax-highlighted code, JSON tree, image, audio player, video player, and a download control for anything else (FR-MM-006, TC-MM-006).
> 3. Drop a file directly onto an Input node to attach it (FR-MM-007, TC-MM-007).
> 4. Audio-to-text conversion for models that do not accept audio, as an explicit transcription step the user can see — never a silent substitution (FR-MM-008). If no local transcriber is present, the step reports "transcription unavailable" and the pre-flight type check blocks the run instead.
> 5. End-to-end vision flow test: image → vision agent → text agent, description passed downstream (TC-MM-009) on the mock provider.

**Done when** TC-MM-006/007/009 green and every output type renders correctly at both desktop and 380 px width.
**Wave 13 closes Phase 8** — run the gate, tag `phase-8`.

---

### F27 — Timeline and messages · **Arhant**

**Branch** `feat/f27-timeline` · **Wave 14** · **Phase 9** · **Depends on** F25, F26
**FRs** FR-CHAT-001, 002, 003 **TCs** TC-CHAT-001, 002, 003
**Read** FRS §3.14 + CHAT rows in §8.6 · Arch §12.2 (chat service), §20.3
**I own** `packages/engine/src/chat/timeline/**`, `apps/web/src/chat/timeline/**`
**Seam** F28 (Mouli) owns direct agent threads. You own the workflow-level timeline; threads render inside a slot you expose.

**Prompt**
> Build the workflow timeline:
> 1. Six visually distinct message types: user messages, agent messages, outputs, workflow events, errors, system events (FR-CHAT-001, TC-CHAT-001).
> 2. Filters by run, node and type, combinable (FR-CHAT-002, TC-CHAT-002).
> 3. A user message sent into the workflow reaches the Input node (FR-CHAT-003, TC-CHAT-003).
> 4. The timeline is driven entirely by the event log so it survives reconnects and replays identically — never by local UI state.
> 5. Virtualize the list; a 5,000-message run must stay smooth.

**Done when** TC-CHAT-001..003 green and the timeline after a reconnect matches the timeline before it, message for message.

---

### F28 — Direct agent chat · **Mouli**

**Branch** `feat/f28-agent-chat` · **Wave 14** · **Phase 9** · **Depends on** F25, F26
**FRs** FR-CHAT-004..008 **TCs** TC-CHAT-004..007, TC-GRD-022
**Read** FRS §3.14 (CHAT-004..008) · Arch §12.2, §20.2 (chat endpoints)
**I own** `packages/engine/src/chat/threads/**`, `apps/web/src/chat/threads/**`
**Seam** uses the prompt manager (F17) and the guardrail engine (F21) unchanged.

**Prompt**
> Build direct agent chat:
> 1. Chat with one agent from its Chat tab using that agent's model, instructions and context (FR-CHAT-004, TC-CHAT-004).
> 2. Direct chats are separate threads and **never** modify run records — assert the run record is byte-identical before and after a chat (FR-CHAT-005, BR-01, TC-CHAT-005).
> 3. Replies stream through the same batching path as runs (FR-CHAT-006, TC-CHAT-006).
> 4. File attachments in chat reach the model as artifact references (FR-CHAT-007, TC-CHAT-007).
> 5. The agent's guardrail policy applies to direct chat; a blocked input is refused with the guardrail reason (FR-CHAT-008, TC-GRD-022).

**Done when** TC-CHAT-004..007 and TC-GRD-022 green, and a chat after a run leaves the run record untouched.
**Wave 14 closes Phase 9** — run the gate, tag `phase-9`.

---

### F29 — Knowledge base ingestion pipeline · **Arhant**

**Branch** `feat/f29-kb-ingestion` · **Wave 15** · **Phase 10** · **Depends on** F27, F28
**FRs** FR-RAG-001, 002, 003, 009 **TCs** TC-RAG-001, 002, 003, 008
**Read** FRS §3.15 + RAG rows in §8.6 · Arch §12.6 (left half), §21.3
**I own** `packages/context/src/ingest/**`, `packages/tools/src/parsers/**`, `apps/web/src/knowledge/**`
**Seam** F30 (Mouli) owns retrieval. Your output contract is the chunk record and the index write; publish it in your first commit.

**Prompt**
> Build the ingestion half of the RAG pipeline (Arch §12.6, §21.3):
> 1. Create a knowledge base with embedding model, chunk size and overlap (FR-RAG-001, TC-RAG-001).
> 2. Parsers for PDF, DOCX, Markdown, text, code and HTML using unpdf, mammoth and readability — all local, all free (FR-RAG-002, TC-RAG-002).
> 3. Chunking by headings and paragraphs, code by function, roughly 500–800 tokens with 10–15% overlap.
> 4. Embeddings through the provider `embed()` port: Ollama locally, and the F14 **mock embedder in every test** (no paid embedding calls anywhere).
> 5. Ingestion runs as a queued job emitting `kb.ingest` progress events; a corrupt file fails with a reason and does not affect the other documents (FR-RAG-003, TC-RAG-003).
> 6. PII guardrails run on ingested text before chunks are stored (Arch §21.3) — call the F21 engine, do not write new checks.
> 7. Removing a document removes its chunks and vectors; the KB can be re-indexed (FR-RAG-009, TC-RAG-008).

**Done when** TC-RAG-001/002/003/008 green with the mock embedder, and a corrupt PDF in a batch of six leaves the other five ready.

---

### F30 — Hybrid search, retrieval node, context builder · **Mouli**

**Branch** `feat/f30-retrieval` · **Wave 15** · **Phase 10** · **Depends on** F27, F28
**FRs** FR-RAG-004..008, 010 **TCs** TC-RAG-004..007, 009, 010
**Read** FRS §3.15 (RAG-004..010) · Arch §12.6 (right half), §12.4
**I own** `packages/context/src/retrieval/**`, `packages/engine/src/context/**`, `apps/web/src/nodes/retrieval/**`
**Seam** reads chunks written by F29 through his published record type. Context guardrails come from F21 — call them.

**Prompt**
> Build the retrieval half and the context builder:
> 1. Hybrid search: vector search via sqlite-vec plus keyword search via FTS5, combined with rank fusion and an optional rerank hook. Both an exact rare term and a paraphrase must find the right chunk (FR-RAG-004, TC-RAG-004/005).
> 2. Attach knowledge bases to an agent; the incoming input becomes the query and retrieved chunks land in the envelope context with their chunk ids (FR-RAG-005/007, TC-RAG-006).
> 3. Retrieval node on the canvas returning structured chunks with text, score and source (FR-RAG-006, TC-RAG-007).
> 4. Test-search screen from the KB view showing results with scores (FR-RAG-008).
> 5. Context builder: fit retrieved content, summary and memory into `budgetTokens`, in the Arch §12.6 order, tagging everything untrusted before it reaches the prompt (BR-13).
> 6. Summaries of large upstream outputs are cached by content hash, so the same input never triggers a second summary call (FR-RAG-010, TC-RAG-009) — this replaces the trivial `Summariser` from F16.
> 7. A labelled question set measuring hit-rate@k, reported in the Deliverable (TC-RAG-010, OI-02 — propose a target, do not decide it).

**Done when** TC-RAG-004..007/009/010 green and the hit-rate@k figure is recorded with a DECISION NEEDED for OI-02.

---

### F31 — Agent memory · **Arhant**

**Branch** `feat/f31-memory` · **Wave 16** · **Phase 10** · **Depends on** F29, F30
**FRs** FR-MEM-001..004 **TCs** TC-MEM-001, 002
**Read** FRS §3.16 · Arch §12.8
**I own** `packages/engine/src/memory/**`, `apps/web/src/memory/**`
**Seam** the context builder (F30) reads memory through the interface you expose.

**Prompt**
> Implement agent memory per Arch §12.8:
> 1. Memory enabled per agent, off by default (FR-MEM-001).
> 2. An agent can save or delete memory entries through its structured output, with a defined memory-operation contract (FR-MEM-002).
> 3. Saved entries appear in the agent's next run's envelope context, inside the budget (FR-MEM-003, TC-MEM-001).
> 4. View, delete one, or clear all entries; deleted entries never reappear (FR-MEM-004, TC-MEM-002).
> 5. Respect the memory scopes in Arch §12.8 — short-term is the envelope (already built), long-term is per agent, knowledge is the KB, cache is TTL/LRU. Do not blur them.
> 6. Memory content is untrusted for prompt-assembly purposes and never bypasses guardrails.

**Done when** TC-MEM-001/002 green and a cleared memory produces an envelope with no memory section.
**Wave 16 closes Phase 10** — run the gate, tag `phase-10`.

---

### F32 — Skills and prompt library · **Mouli**

**Branch** `feat/f32-skills` · **Wave 16** · **Phase 11** · **Depends on** F29, F30
**FRs** FR-SKL-001..004, FR-PRM-006 **TCs** TC-SKL-001..003, TC-PRM-006
**Read** FRS §3.17, §3.23 (PRM-006) · Arch §12.2, §12.5
**I own** `packages/engine/src/skills/**`, `packages/engine/src/prompts/library/**`, `apps/web/src/library/**`
**Seam** skills slot into the F17 assembly order at the existing "skills" section. Do not change the order itself.

**Prompt**
> Implement skills and the prompt library:
> 1. Create and edit skills with name, description, instructions and tools (FR-SKL-001).
> 2. Attach and detach skills on an agent, listed on the node (FR-SKL-002, TC-SKL-001/003).
> 3. Skill instructions enter the prompt in a **fixed order**, so the same config always yields the same prompt (FR-SKL-003, TC-SKL-002).
> 4. Skills are versioned and each node run records the version used (FR-SKL-004).
> 5. Project prompt library: save a prompt, insert it into another agent in another workflow, text matching exactly (FR-PRM-006, TC-PRM-006).
> 6. The Library screen per Arch §33.2: Skills, Custom nodes, Tools, Templates, Prompts — build the Skills and Prompts tabs and leave the others as empty registered tabs for F33/F35.

**Done when** TC-SKL-001..003 and TC-PRM-006 green, and attaching then detaching a skill returns the prompt to byte-identical.

---

### F33 — Custom nodes (HTTP and script) · **Arhant**

**Branch** `feat/f33-custom-nodes` · **Wave 17** · **Phase 11** · **Depends on** F31, F32
**FRs** FR-CUS-001..007 **TCs** TC-CUS-001..007
**Read** FRS §3.18 + CUS rows in §8.6 · Arch §16 (custom nodes row), §22.1 · OI-03
**I own** `packages/engine/src/custom-nodes/**`, `apps/web/src/library/custom-nodes/**`
**Seam** F34 (Mouli) owns the sandbox. Script custom nodes **run inside his sandbox** — call `sandbox.run()` through the interface he publishes; do not write your own process isolation.

**Prompt**
> Implement custom nodes per OI-03 (both HTTP and script, scripts sandboxed):
> 1. Register an HTTP custom node from a manifest; it appears in the palette (FR-CUS-001, TC-CUS-001). Contract: envelope in, result out.
> 2. Register a script custom node from a manifest; JSON over stdin/stdout (FR-CUS-002).
> 3. Manifests are Zod-validated and errors name the offending field (FR-CUS-003, TC-CUS-002).
> 4. Custom nodes behave exactly like built-ins: connect, configure, run, retry, inspect, inside a mixed workflow (FR-CUS-004, TC-CUS-003).
> 5. Script nodes run through the F34 sandbox with time, memory and folder limits; exceeding a limit stops them (FR-CUS-005, TC-CUS-004/005).
> 6. Declared permissions are shown and must be approved before first use; an unapproved node cannot run (FR-CUS-006, BR-11, TC-CUS-006).
> 7. Test a custom node with sample input from the UI (FR-CUS-007, TC-CUS-007).
> Use a local HTTP test server as the fixture — no external services.

**Done when** TC-CUS-001..007 green and an unapproved script node is refused before executing a single line.

---

### F34 — Tool registry, code sandbox, tool loop · **Mouli**

**Branch** `feat/f34-tools-sandbox` · **Wave 17** · **Phase 11** · **Depends on** F31, F32
**FRs** FR-TOOL-001..004, 009, 010 **TCs** TC-TOOL-001..005, 010, 011
**Read** FRS §3.26 + TOOL rows in §8.6 · Arch §12.7 (tool loop), §16 · D13/OI-11
**I own** `packages/tools/src/registry/**`, `packages/tools/src/sandbox/**`, `packages/engine/src/tools/**`
**Seam** you publish `sandbox.run()` for F33 and `toolExecutor.call()` for F35. Guardrail checks come from F21/F22 — call them at the tool point.

**Prompt**
> Build the tool layer core:
> 1. Tool registry: name, description, input/output schemas, permissions (`network`, `fsPaths`, `destructive`), timeout. The registry lists every tool with its permissions (FR-TOOL-001, TC-TOOL-001).
> 2. Tools are enabled per agent; a model calling a tool that is not enabled is refused (FR-TOOL-002, TC-TOOL-002).
> 3. The tool loop inside one node executor (Arch §12.7): model → tool request → tool guardrail → execute → result → context guardrail → model, until a final answer or the tool-call limit (FR-TOOL-003, TC-TOOL-003). The limit is enforced by the F22 loop guardrail.
> 4. Code sandbox per D13: child process with time, memory and folder limits, using Docker when available. An infinite loop is killed at timeout; reading outside the sandbox folder is denied (FR-TOOL-004, TC-TOOL-004/005).
> 5. Every tool call is logged with arguments (secrets redacted), result summary, duration and verdicts, visible in the inspector (FR-TOOL-009, TC-TOOL-010).
> 6. Tool results return to the model **inside an untrusted block** (FR-TOOL-010, BR-13, TC-TOOL-011).
> Docker must be optional: every test passes with the child-process sandbox alone, because CI has no Docker.

**Done when** TC-TOOL-001..005/010/011 green with no Docker present, and a sandbox escape attempt is denied and logged.

---

### F35 — Web search, HTTP tool, MCP client · **Arhant**

**Branch** `feat/f35-search-mcp` · **Wave 18** · **Phase 11** · **Depends on** F33, F34
**FRs** FR-TOOL-005..008 **TCs** TC-TOOL-006..009
**Read** FRS §3.26 (TOOL-005..008) · Arch §16 · D14/OI-12, D16/OI-14
**I own** `packages/tools/src/search/**`, `packages/tools/src/http/**`, `packages/tools/src/mcp/**`, `packages/tools/src/fs/**`
**Seam** register every tool through F34's registry API. Do not modify the registry or the sandbox.

**Prompt**
> Implement the outward-facing tools:
> 1. Web search and fetch: **SearXNG self-hosted as the default** per D14 — free and keyless — with an optional user-keyed search API as an alternative. Fetch returns page text (FR-TOOL-005, TC-TOOL-006). Tests use a mocked search backend; a real SearXNG must never be required by `pnpm test`.
> 2. HTTP request tool restricted to an allow-list of domains; anything else is refused (FR-TOOL-006, TC-TOOL-007).
> 3. MCP client per D16: connect MCP servers, surface their tools in the registry with permissions, and make them callable by agents (FR-TOOL-007, TC-TOOL-008). Fixture: a local MCP test server.
> 4. File and Git tools confined to the project folder; a write outside it is refused, including via `../` and via absolute paths, with drive letters and separators normalised first (FR-TOOL-008, TC-TOOL-009).
> 5. Every tool declares its permissions honestly — a tool whose declared permissions do not match its behaviour is a defect; add a test per tool.

**Done when** TC-TOOL-006..009 green offline, and path-escape tests pass on Windows-style and POSIX-style paths.

---

### F36 — Tool guardrails and the Guardrail node · **Mouli**

**Branch** `feat/f36-guardrail-node` · **Wave 18** · **Phase 11** · **Depends on** F33, F34
**FRs** FR-GRD-005 (enforcement), FR-GRD-016 **TCs** TC-GRD-006, 007, 020, TC-NFR-008
**Read** FRS §3.24 (GRD-005/016) · Arch §13.4, §22.2
**I own** `packages/engine/src/guardrails/tool-point/**`, `apps/web/src/nodes/guardrail/**`
**Seam** uses F21's check definitions and F34's tool executor. Register at the tool point; do not rewrite either.

**Prompt**
> Wire tool guardrails and add the Guardrail node:
> 1. Enforce the tool guardrail point on every tool call: the tool must be enabled for the agent, arguments must validate, paths must be inside the project, domains must be on the allow-list (FR-GRD-005, TC-GRD-006/007).
> 2. Destructive actions ask for approval through F22 before executing (BR-14).
> 3. The prompt-injection end-to-end case: a document saying "delete all files" reaching an agent with file tools must not cause a destructive action without confirmation (TC-NFR-008, NFR-SEC-04). Build this as a full-stack test through ingestion, retrieval, prompt, tool call and guardrail.
> 4. Guardrail node on the canvas: placed between nodes, outputs sanitized data plus a verdict, with edges that branch on pass or block (FR-GRD-016, TC-GRD-020, P8).
> 5. Both branches of the Guardrail node must be exercised by tests.

**Done when** TC-GRD-006/007/020 and TC-NFR-008 green, and the injection corpus produces no destructive action.
**Wave 18 closes Phase 11** — run the gate, tag `phase-11`.

---

### F37 — Git workspace, file browser, code panel · **Arhant**

**Branch** `feat/f37-workspace` · **Wave 19** · **Phase 12** · **Depends on** F35, F36
**FRs** FR-GIT-001..004, 006, 008 **TCs** TC-GIT-002, 005
**Read** FRS §3.19 + GIT rows in §8.6 · Arch §15.1, §16
**I own** `packages/engine/src/workspace/**`, `apps/web/src/files/**`
**Seam** F38 (Mouli) owns replay and diffs, reading the commits you write. Your commit-message format is the seam — publish it in your first commit.

**Prompt**
> Build the git-backed workspace:
> 1. Every project folder is a git repository, initialised at project creation (FR-GIT-001).
> 2. A commit after each node that changes files, with run id, node id and iteration in the message (FR-GIT-002, TC-GIT-001) — define and document the exact message format.
> 3. File tree browser matching disk (FR-GIT-003) and a Monaco code panel that is **read-only while a run is active**, with the write API also refusing (FR-GIT-004, BR-09, TC-GIT-002).
> 4. "Open in VS Code" escape hatch for a file or folder (FR-GIT-006).
> 5. File access confined to the project folder: `../`, absolute paths and symlink escapes all refused, with drive letters and separators normalised first (FR-GIT-008, NFR-SEC-03, TC-GIT-005).
> Use simple-git. Fail with a clear message if the git binary is missing rather than silently skipping commits.

**Done when** TC-GIT-002 and TC-GIT-005 green on Windows and POSIX path styles, and the editor is provably read-only mid-run.

---

### F38 — Replay and diffs · **Mouli**

**Branch** `feat/f38-replay` · **Wave 19** · **Phase 12** · **Depends on** F35, F36
**FRs** FR-GIT-005, 007 **TCs** TC-GIT-003, 004
**Read** FRS §3.19 (GIT-005/007) · Arch §9.1, §25, ADR-009
**I own** `packages/engine/src/replay/**`, `apps/web/src/files/diff/**`
**Seam** reads F37's commits and the immutable run snapshots from F15. Read-only over both.

**Prompt**
> Implement replay and diffs:
> 1. Diff view between two commits showing the changes (FR-GIT-005, TC-GIT-003).
> 2. Replay a past run using its recorded snapshot, envelopes and commit, reproducing the same inputs and file state (FR-GIT-007, TC-GIT-004, ADR-009).
> 3. Missing data — a deleted commit, a missing artifact — produces a clear typed error naming what is missing, never a partial silent replay.
> 4. Replay must not re-call providers by default; it reuses recorded outputs. Re-executing against live providers is a separate explicit action.
> 5. A replay of a run containing a loop reproduces every iteration in order.

**Done when** TC-GIT-003/004 green and a replayed run's node outputs are byte-identical to the original.
**Wave 19 closes Phase 12** — run the gate, tag `phase-12`.

---

### F39 — ACE Bench: tasks, freezing, experiments · **Arhant**

**Branch** `feat/f39-bench-tasks` · **Wave 20** · **Phase 13** · **Depends on** F37, F38
**FRs** FR-BEN-001..004, 008 **TCs** TC-BEN-001, 002, 003, 007
**Read** FRS §3.20 + BEN rows in §8.6 · Arch §12.2 (bench service) · P10
**I own** `packages/engine/src/bench/tasks/**`, `bench/**`, `apps/web/src/bench/tasks/**`
**Seam** F40 (Mouli) owns judging and reporting, reading your frozen tasks and bench runs.

**Prompt**
> Build the governed benchmark's first half (P10: governed measurement):
> 1. Draft bench tasks with prompt, inputs and rubric, editable while draft (FR-BEN-001, TC-BEN-001 is the negative case).
> 2. Freeze a task: after freezing it cannot be changed, and its content hash is stored (FR-BEN-002, BR-06, TC-BEN-001).
> 3. Experiments with tasks, arms and a repetition count; the experiment lists every planned run — 2 tasks × 3 arms × 3 reps = 18 (FR-BEN-003, TC-BEN-002).
> 4. Each bench run records output, tokens, cost, time, models, workflow and prompt snapshots and build version (FR-BEN-004, TC-BEN-003).
> 5. Bench runs are stored separately and never appear in normal run history (FR-BEN-008, TC-BEN-007).
> 6. Bench runs force Fixed routing — refuse an arm with any other policy (FR-RTR-007, BR-16).
> 7. Frozen task hashes are recorded in a form the training pipeline can check later (BR-17).
> The win/partial/loss rules and OI-04's third arm are F40 — if the docs are silent on rule wording, post a DECISION NEEDED.

**Done when** TC-BEN-001/002/003/007 green and a frozen task rejects every edit path including direct repository writes.

---

### F40 — ACE Bench: blind export, scores, report · **Mouli**

**Branch** `feat/f40-bench-report` · **Wave 20** · **Phase 13** · **Depends on** F37, F38
**FRs** FR-BEN-005..007 **TCs** TC-BEN-004, 005, 006
**Read** FRS §3.20 (BEN-005..007) · Arch §12.2 · OI-04
**I own** `packages/engine/src/bench/judging/**`, `apps/web/src/bench/reports/**`
**Seam** reads F39's experiments and bench runs. Do not modify task freezing.

**Prompt**
> Build the judging half of ACE Bench:
> 1. Export anonymized outputs for blind judging: no arm names, no ids that link back to arms, stable shuffling with a recorded seed (FR-BEN-005, TC-BEN-004).
> 2. Import judge scores and link them to the correct runs via the export mapping (FR-BEN-006, TC-BEN-005).
> 3. The report applies win/partial/loss rules **pre-registered before the experiment starts**; editing rules after the start is refused (FR-BEN-007, BR-06, TC-BEN-006).
> 4. The report shows per-arm results, cost and latency alongside quality, and states the repetition count and the rules used.
> 5. OI-04 (third arm and rule wording): post a DECISION NEEDED with a recommendation; do not invent rules.

**Done when** TC-BEN-004/005/006 green, and an attempt to edit rules after start is refused at both the API and UI level.
**Wave 20 closes Phase 13** — run the gate, tag `phase-13`.

---

### F41 — Observability: Langfuse, Sentry, usage screen · **Arhant**

**Branch** `feat/f41-observability` · **Wave 21** · **Phase 15** · **Depends on** F39, F40
**FRs** FR-OBS-004..006 **TCs** TC-OBS-004, 005, 006
**Read** FRS §3.27 (OBS-004..006) · Arch §26
**I own** `packages/engine/src/observability/**`, `apps/web/src/usage/**`
**Seam** reads usage records from F18. Do not change the metering itself.

**Prompt**
> Complete the observability layer:
> 1. Usage screen: spend and tokens by provider, model and day, with charts that match the stored data exactly (FR-OBS-004, TC-OBS-004).
> 2. Optional LLM trace export to Langfuse, **self-hosted locally** — free, opt-in, off by default (FR-OBS-005, TC-OBS-005). Prompt versions and outputs go with the trace.
> 3. Optional Sentry error reporting, **off by default**, with a test asserting no outbound request with default settings (FR-OBS-006, TC-OBS-006, NFR-PRIV-01).
> 4. The key metrics from Arch §26: runs started/completed/halted, node failures by kind, guardrail verdicts by type, provider latency and error rate, tokens and cost, stream latency, ingestion duration.
> 5. A network-capture test proving that with telemetry off, only the chosen provider hosts are contacted (TC-NFR-012).

**Done when** TC-OBS-004/005/006 and TC-NFR-012 green, and a default install makes zero outbound calls beyond configured providers.

---

### F42 — E2E suites and fixtures · **Mouli**

**Branch** `feat/f42-e2e` · **Wave 21** · **Phase 14** · **Depends on** F39, F40
**FRs** all Must FRs (coverage, not new behaviour) **TCs** every remaining `P`-type TC not yet automated
**Read** FRS §8.1–8.4, §8.3 (fixtures) · Arch §31
**I own** `e2e/**`, `packages/*/src/**/__fixtures__/**`, `docs/test-plan.md`
**Seam** F43 (Arhant) owns performance/recovery/security suites. You own functional E2E and fixtures. **Neither of you changes product code** — a failing test that reveals a defect becomes a defect-log entry and a fix PR owned by whoever wrote that feature.

**Prompt**
> Phase 14, part one — functional coverage (FRS §8.1: this is not feature work):
> 1. Build every fixture from FRS §8.3: fixture workflows (linear, parallel, loop, multimodal, RAG with 5 documents, custom HTTP node), tool fixtures (local HTTP server, mocked search, local MCP test server), and fixture files (PDF, DOCX, MD, PNG, MP3, MP4, a corrupt PDF, an oversized file).
> 2. Playwright E2E for every user journey in FRS §7 (UC-01..UC-19), each named by its UC id.
> 3. Audit the FRS §8.6 test-case tables and automate every positive and negative case not yet covered. Produce a coverage matrix: TC id → test file → status, and list every gap explicitly.
> 4. Bring coverage to the NFR-MAIN-02 targets: ≥80% engine, ≥60% frontend. Report the real figures.
> 5. Cross-browser matrix on Chrome, Edge and Firefox (TC-NFR-011).
> 6. Write `docs/test-plan.md` and open `docs/defect-log.md` with the FRS §8.5 severity scale.
> If a test reveals a defect, log it — do not fix product code in this branch.

**Done when** the coverage matrix is complete with no unexplained gaps, coverage targets met, browser matrix green, and the defect log lists every finding with a severity.

---

### F43 — Performance, recovery and security suites · **Arhant**

**Branch** `feat/f43-nfr-suites` · **Wave 22** · **Phase 14** · **Depends on** F41, F42
**FRs** NFR-* **TCs** TC-NFR-001..012, 015, 016
**Read** FRS §4, §8.2 (performance/security/recovery rows), §8.6 non-functional table · Arch §24, §25, §22
**I own** `e2e/nfr/**`, `scripts/perf/**`, `docs/performance-report.md`, `docs/security-review.md`
**Seam** F42 owns functional E2E. Do not edit his specs.

**Prompt**
> Phase 14, part two — non-functional verification:
> 1. Performance: TC-NFR-001 (200-node ≈60 fps), 002 (dispatch <50 ms), 003 (stream <200 ms), 004 (engine start <3 s, graph load <1 s), 005 (20 parallel node runs). Record real numbers in `docs/performance-report.md`.
> 2. Recovery by scripted fault injection: kill mid-write (TC-NFR-006), migration backup (TC-NFR-007), engine crash mid-run, client disconnect, provider outage (Arch §25).
> 3. Security: local-only binding, token, origin, path traversal, sandbox escape, secrets in logs and exports (TC-SYS-008, TC-GIT-005, TC-TOOL-005). Walk the Arch §22.2 STRIDE table and write one test per row. Dependency audit with no high or critical findings (TC-NFR-009).
> 4. Accessibility: keyboard-only walkthrough and WCAG AA contrast (TC-NFR-010).
> 5. Portability: the engine test suite must pass against both local adapters and fake cloud adapters (TC-NFR-015, NFR-PORT-01). Old workflow format import (TC-NFR-016).
> 6. Write `docs/security-review.md` with findings, severity and status.
> Log defects; do not fix product code here.

**Done when** every TC-NFR case has a real measurement or a written justification, both reports are committed, and no high or critical security finding is open.

---

### F44 — Guardrail corpora, local moderation, hardening · **Mouli**

**Branch** `feat/f44-hardening` · **Wave 22** · **Phase 15** · **Depends on** F41, F42
**FRs** FR-GRD-017, NFR-SAFE-01, NFR-SAFE-02 **TCs** TC-GRD-021, TC-NFR-013, TC-NFR-014
**Read** FRS §3.24 (GRD-017), §4 (SAFE) · Arch §13.2, §22 · OI-16
**I own** `packages/guardrails/src/classifier/**`, `packages/guardrails/corpora/**`
**Seam** extends F21's engine through `registerCheck()`. Do not restructure the engine.

**Prompt**
> Harden the safety layer:
> 1. Build the four guardrail corpora from FRS §8.3: known injection prompts, documents with hidden instructions, texts with PII and fake API keys, and a clean control set. Store them in `packages/guardrails/corpora/` with provenance notes.
> 2. Local moderation per FR-GRD-017 using **Llama Guard via Ollama — free and local**, registered as an optional check. The rule-pack fallback must make **every test pass with Ollama absent**, because CI has none (TC-GRD-021 runs only when Ollama is present and is skipped otherwise, never failed).
> 3. Measure NFR-SAFE-01: rule-pack checks under 300 ms per node over 100 nodes (TC-NFR-013).
> 4. Measure NFR-SAFE-02: ≥95% of injection and leak cases caught, ≤5% false positives on the clean corpus (TC-NFR-014). Report the real numbers and post a DECISION NEEDED for OI-16 if the targets are not met — do not tune the corpus to pass.
> 5. Complete the Arch §22.1 controls review and record anything outstanding in `docs/security-review.md`.

**Done when** TC-NFR-013/014 measured and reported, `pnpm test` green with Ollama stopped, and the corpora are committed with provenance.
**Wave 22 closes Phases 14 and 15** — run FRS §8.4 exit criteria, tag `phase-14` and `phase-15`.

---

### F45 — Desktop (Electron) · **Arhant**

**Branch** `feat/f45-desktop` · **Wave 23** · **Phase 16** · **Depends on** F43, F44
**FRs** FR-DSK-001..006 **TCs** TC-DSK-001..005
**Read** FRS §3.21 + DSK rows in §8.6 · Arch §10.2, §18.1 · OI-05
**I own** `apps/desktop/**`, `.github/workflows/release-*.yml` (Mouli reviews CI changes)
**Seam** the SPA is unchanged — if you need a change in `apps/web`, request it from Mouli in the PR rather than editing it.

**Prompt**
> Package ACE as a desktop app:
> 1. Electron shell with a strict two-process split: the main process starts the engine and passes the session token to the renderer through a preload script; the renderer holds no truth (FR-DSK-002, TC-DSK-002, P2).
> 2. Installers for Windows, macOS and Linux via electron-builder (NSIS, dmg, AppImage/deb) (FR-DSK-001, TC-DSK-001). Signing is OI-05 — build unsigned for development and record the certificate requirement as a DECISION NEEDED with cost implications.
> 3. Secrets migrate from web storage to OS secure storage (safeStorage/keychain); existing providers keep working (FR-DSK-003, TC-DSK-003). Re-run the secrets-in-logs check afterwards.
> 4. Native file dialogs, drag files in from the desktop, tray, deep links (FR-DSK-004).
> 5. Auto-update via electron-updater and GitHub Releases (FR-DSK-005, TC-DSK-004).
> 6. Feature parity: the full E2E suite passes **inside Electron** (FR-DSK-006, TC-DSK-005).
> 7. Native modules (better-sqlite3, sqlite-vec, keychain) rebuilt against the Electron ABI per platform in CI (`electron-builder install-app-deps`), marked external in the bundler.

**Done when** TC-DSK-001..005 green, the E2E suite passes inside Electron on your OS and in CI for the others.
**Wave 23 closes Phase 16** — tag `phase-16` once both F45 and F46 merge.

---

### F46 — CLI, TypeScript SDK, OpenAPI · **Mouli**

**Branch** `feat/f46-cli-sdk` · **Wave 23** · **Phase 17** · **Depends on** F43, F44
**FRs** FR-CLI-001..007 **TCs** TC-CLI-001..005
**Read** FRS §3.28 + CLI rows in §8.6 · Arch §10.4, §10.5, §20.1
**I own** `apps/cli/**`, `packages/sdk/**` (except `src/events/**`, which F06 owns — extend it only through its exported API)
**Seam** none with F45; different apps entirely.

**Prompt**
> Build the automation surface:
> 1. `ace connect <url>` / `ace login` connecting to a local engine and showing status (FR-CLI-001).
> 2. `ace run <workflow> --input <file>` streaming progress, exit code 0 on `COMPLETE` and non-zero on `HALTED`/`BLOCKED` (FR-CLI-002, TC-CLI-001/002).
> 3. `ace runs list` / `ace runs show <id>` matching the UI's data (FR-CLI-003).
> 4. `ace export` / `ace import` with a round trip that preserves the workflow exactly (FR-CLI-004, TC-CLI-003).
> 5. `ace bench run <experiment>` producing a report from CI (FR-CLI-005).
> 6. TypeScript SDK **generated from `packages/contracts`** with typed methods per endpoint plus the event-stream helper from F06; ship a runnable example script (FR-CLI-006, TC-CLI-004).
> 7. OpenAPI document generated from the Zod contracts, validating and matching the real routes (FR-CLI-007, TC-CLI-005).
> The SDK must never hand-write a type that contracts already defines.

**Done when** TC-CLI-001..005 green, the example script runs a workflow end to end on the mock provider, and the OpenAPI document validates.

---

### F47 — Onboarding and templates · **Arhant**

**Branch** `feat/f47-onboarding` · **Wave 24** · **Phase 17** · **Depends on** F45, F46
**FRs** FR-ONB-001..003 **TCs** TC-ONB-001, 002
**Read** FRS §3.22 + ONB rows in §8.6 · Arch §33.1 (journey steps 1–3)
**I own** `apps/web/src/onboarding/**`, `packages/engine/src/templates/**`
**Seam** F48 (Mouli) owns responsive views and docs. You own first-run flow and templates.

**Prompt**
> Build first-run onboarding:
> 1. First launch walks the user through: add a provider (API key **or one-click Ollama**, which is free) → ACE tests it and lists models → choose a template → first run. A new user must complete a run without reading documentation (FR-ONB-001, TC-ONB-001).
> 2. Four templates: linear chain, Review→Fix, parallel research + merge, RAG Q&A. **Every template must run end to end on the mock provider** (FR-ONB-002, TC-ONB-002).
> 3. Help links from each screen to the relevant documentation (FR-ONB-003).
> 4. Onboarding must be resumable and skippable, and must never create a project the user did not ask for.
> 5. The Ollama path must be the visibly zero-cost option, so a user with no API keys still reaches a first successful run.

**Done when** TC-ONB-001/002 green, and a fresh profile with no API keys reaches a completed run using Ollama or the mock provider alone.

---

### F48 — Responsive views, approvals on mobile, docs · **Mouli**

**Branch** `feat/f48-responsive-docs` · **Wave 24** · **Phase 17** · **Depends on** F45, F46
**FRs** FR-MOB-001..003 **TCs** TC-MOB-001, 002
**Read** FRS §3.29 + MOB rows in §8.6 · Arch §10.3
**I own** `apps/web/src/responsive/**`, `docs/user-guide/**`, `README.md`
**Seam** uses the approval card from F22 as-is. FR-MOB-004 (native app) is Phase 21 and out of scope.

**Prompt**
> Finish the launch surface:
> 1. Runs, run detail, outputs and chat usable at 380 px with no horizontal scrolling (FR-MOB-001, TC-MOB-001).
> 2. Guardrail approvals answerable from a phone layout; approve continues the node (FR-MOB-002, TC-MOB-002).
> 3. The canvas renders **read-only** on mobile; workflow building is not attempted there (FR-MOB-003).
> 4. User documentation: getting started, providers (including the free local route), building a workflow, guardrails, knowledge bases, tools, bench, CLI, troubleshooting. Every help link from F47 must resolve.
> 5. `README.md` with a from-clone-to-first-run path that needs no paid service.
> 6. Do not build the native mobile app — FR-MOB-004 is Phase 21, explicitly out of v1 scope.

**Done when** TC-MOB-001/002 green at 380 px, every help link resolves, and a reader can follow the README from clone to a completed mock run.
**Wave 24 closes Phase 17** — run the gate, tag `phase-17`.

---

### F49 — UAT and release gate · **Both** (Mouli drives, Arhant co-signs)

**Branch** `feat/f49-uat` · **Wave 25** · **Phase 14 exit** · **Depends on** F47, F48
**FRs** — **TCs** FRS §8.7 checklist (15 items), §8.8 deliverables
**Read** FRS §8.4, §8.5, §8.7, §8.8
**I own** `docs/uat/**`, `docs/test-summary.md`, `docs/defect-log.md`
**Seam** this one is done **by hand, by humans**. Split the 15 UAT items alternately: Mouli takes 1, 3, 5, 7, 9, 11, 13, 15; Arhant takes 2, 4, 6, 8, 10, 12, 14. Each records pass/fail with notes and signs their half.

**Checklist (FRS §8.7)** — set up a provider and a local model · build and run a 3-agent workflow · recover from a failed node · build a Review→Fix loop and a parallel workflow · run an image workflow · chat with an agent · use a knowledge base and see sources · add a custom node · replay a past run · complete a small benchmark · set a guardrail policy and approve/reject a risky action · give an agent search and a sandbox · configure a fallback model · run a workflow from the CLI · check a run's trace and cost.

**Prompt (for the Claude session that compiles the results)**
> Compile the Phase 14 exit package from the recorded UAT results and the existing reports:
> 1. `docs/test-summary.md` per FRS §8.8: test plan reference, coverage figures, results by level, defect log summary by severity, performance report reference, security review reference, UAT sign-off.
> 2. Verify the FRS §8.4 exit criteria explicitly: 100% of Must test cases passing, ≥95% of Should test cases passing, no open critical or high defects, coverage and performance targets met. State pass or fail per criterion with evidence.
> 3. List every deferred item (Could-tier, Later-tier, open OIs) so the v1 scope boundary is written down.
> Do not mark a criterion met without evidence in the repo.

**Done when** all 15 UAT items pass with both signatures, every §8.4 exit criterion is evidenced, and `v1.0.0` is tagged.

---

## 8. PR review checklist (the reviewer runs this — never rubber-stamp)

There are **two** checks on every feature, and they are not the same thing. This one is **before merge**: fast, diff-focused, 20 minutes, aimed at scope, drift and obvious defects. The **cross-verification in §3.6** is *after* merge: a clean clone, the real gate, adversarial cases, judged against the FRS text. Passing review does not make a feature `VERIFIED`, and a feature that fails verification goes to the defect log rather than being un-merged.

1. **Coverage table** — every FR of the feature present with its TC ids; nothing from a later feature.
2. **Run it yourself** — `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm test:e2e` where applicable. If `pnpm test` asks for an API key, that is a defect, not a configuration issue.
3. **Scope** — `git diff --stat` against the feature's `I own` list. A new folder for another feature's module is drift: ask for a revert.
4. **Enums** — grep for `"Completed"`, `"complete"`, `"Halted"`, `"HALT"` string literals outside `packages/contracts`.
5. **Dependency rules** — grep `node:` / `from "fs"` under `apps/web`, and `window.` / `document.` under `packages/engine`.
6. **Secrets** — for provider, log, export and keychain features, grep the log folder and an exported workflow for the key.
7. **Adversarial pass** — in a fresh session: *"Spawn a subagent. Read docs/ACE-FRS.md §X and the module's rows in §8.6, plus docs/ARCHITECTURE.md §Y. Review this diff against each FR id for: requirements silently narrowed, state transitions not in Arch §19, envelopes carrying chat history instead of bounded context, and tests that pass without exercising the behaviour. Report findings by FR id."*
8. **DECISIONS.md** — every decision from the session is appended, and any FR-narrowing decision names the FR id.

---

## 9. Handoff log (append a paragraph when you close a wave or split a session)

Format: `YYYY-MM-DD · <name> · <F-id> · done / green TCs / last commit / what's next / anything the other person must know before pulling`

```
2026-09-18 · Mouli · F00 · monorepo, CI, FILE-OWNERSHIP.md and defect-log.md on main, tag phase-0.
             Green: TC-PRV-010. Last commit <sha>. Next: Arhant verifies F00 on a clean clone, then
             Wave 1 — Arhant F01, Mouli F02. Barrels are pre-wired: fill your placeholder file only,
             never add an export line.

2026-09-22 · Arhant · F09 verification · VERIFIED. Clean clone green, done-when gate reproduced,
             TC-CON-001..006 all fail correctly when the behaviour is broken. Two low defects logged
             (D-003 edge tooltip truncation, D-004 refusal message wording) — agreed to carry to
             Phase 14. Report in docs/verification/F09-verification.md. Wave 5 closed, phase-3 tagged.
```

---

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| `git pull --ff-only` fails on `main` | You committed directly to `main`. `git branch backup-$(date +%s)`, `git reset --hard origin/main`, then cherry-pick your commit onto a feature branch. |
| Rebase conflict in `pnpm-lock.yaml` | `git checkout --theirs pnpm-lock.yaml && pnpm install && git add pnpm-lock.yaml && git rebase --continue`. Never hand-edit it. |
| Rebase conflict in a barrel `index.ts` | Should be impossible — F00 pre-wired every export. If it happens, the file-ownership map is wrong: fix `docs/FILE-OWNERSHIP.md` in the same PR and note it in the handoff log. |
| Conflict in `DECISIONS.md` | Both appended at once. Keep **both** rows, renumber the later one, push within the minute. |
| Claude drifts into a later feature | "Stop. That module belongs to F<n> per docs/prompt.md. Revert it (`git diff`, then remove) and continue with this feature only." If the drift revealed a real gap, record it in `DECISIONS.md`. |
| Verification finds a critical or high defect | Log it, set the row back from `MERGED` to `MERGED — verification failed`, the **builder** fixes it on a `fix/d-0nn` branch, you re-verify. The wave stays open. Do not start your next feature, and do not fix it yourself. |
| You and your partner disagree on whether a finding is a defect | It goes in the log as `disputed`, and you settle it against the FRS acceptance criteria — not against what either of you intended. If the FRS is genuinely silent, that is a DECISION NEEDED, not a defect. |
| Verification is taking more than half a session | That is itself a finding: the feature is too large, under-tested, or unclear. Say so in the handoff log and consider splitting the equivalent feature later in the pack. |
| Context too long | `/compact` with: "keep the FR/TC coverage table, the list of green TCs and open DECISION NEEDED items". If still too long, end with a §9 handoff paragraph and resume in a fresh session with preamble + that paragraph. |
| Tests need an API key | Defect. Move it to `pnpm test:providers` (tagged, nightly) and cover the same behaviour with a mock-provider script, including simulated errors and delays. |
| Claude renames a state | The enums live once in `packages/contracts`. Ask for the unit test asserting exact literals and reject the feature until the variants are gone. |
| Windows path problems | Short repo path without spaces (`D:\ace`), `core.longpaths true`, `.gitattributes` with `* text=auto eol=lf`, `path.join`/`pathToFileURL` in code, and normalise drive letters and separators in path-confinement tests (FR-GRD-005, FR-GIT-008, TC-NFR-008). |
| Electron native module errors | `electron-builder install-app-deps` in `apps/desktop` after every Electron or module upgrade; mark natives external in the bundler; build installers per platform in CI. |
