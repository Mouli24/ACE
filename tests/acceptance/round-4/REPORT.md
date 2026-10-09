# Round 4 verification report

Both suites run with `pnpm test:acceptance`: a real engine on a temp database, the mock provider,
no env vars and no keys, plus the real production web build behind `vite preview`. They stay in CI
as regression (CLAUDE.md §6.2).

**Read this before the verdicts.**
- Round 4 was built by Mouli: C4 (#23), A4 (#24) and M4 (#29), under D94.
- Arhant came back for the round-4 gate and wrote both cross-test files.
- So unlike round 3, every feature here was checked by someone other than its builder.
- Both files were written from §2 and §7 of `docs/team-prompts/04-round-4-multimodal-chat-tools.md`
  and committed before the implementation was read (§6.3):
  - §7.2: fce19f4
  - §7.1: ae85d23
- Every failure was then classified. A test that misread the spec was fixed, with the reason written
  beside the fix. A real defect was kept as written, marked `it.fails` / `test.fail()` with its
  `D-0nn`, and logged.
- The engine-side defects were fixed on `round-4/fix-arhant-1`, each one test-first, and their
  markers were lifted.
- What remains marked is Mouli's web code (§3.4: the owner fixes) or waits on a decision.

## Gates as measured — 2026-09-30, `round-4/fix-arhant-1` on `main` 2db8672

```
pnpm lint                ok
pnpm typecheck           ok
pnpm test                contracts 949 · sdk 102 · ui 101 · engine 1103 · guardrails 332 ·
                         providers 284 (+3 todo) · storage-local 196 · web 533 · tools 154 (+1 skipped) ·
                         server 94 — all passed
pnpm -r test:coverage    stmts / branch / funcs / lines
  contracts              100   / 98.27 / 100   / 100
  engine                 90.23 / 82.76 / 92.61 / 92.24
  guardrails             96.94 / 93.99 / 100   / 99.22
  providers              95.48 / 85.96 / 95.71 / 96.46
  storage-local          98.6  / 92.11 / 98.69 / 99.25
  tools                  95.53 / 85.29 / 94.85 / 97.04
  server                 94.6  / 84.69 / 87.32 / 97.3
  sdk                    95.72 / 86.89 / 96.06 / 96.56
  ui                     97.64 / 87.83 / 96    / 97.81
  web                    82.67 / 71.46 / 82.28 / 85.32
pnpm build               ok
acceptance, vitest       5 files, 143 passed        (rounds 1–4; round 4: 48/48)
acceptance, Playwright   69 passed, 1 flaky, 2 skipped — 3.7 min
                         (round 4: 25 pass + 4 test.fail(); flaky = round-1 NFR-USE-02, the
                          known D-012; skipped = round-3's two fixme tests, D-039)
```

Two things to know about how these numbers were taken.

1. **Coverage was run serially.** On this Windows machine, `pnpm -r test:coverage` at the default
   concurrency timed out two provider tests at 5 s: `fixtures-round-3` and `http-adapters`. This
   branch leaves both files untouched, and both passed twice when run alone. The figures above are
   from `--workspace-concurrency=1`.
2. **The full run first failed once in `packages/tools`, with Windows EPERM.** A timed-out sandbox
   child was still holding its temp folder while the test deleted it. The runner must settle within
   timeoutMs + 500 ms (§7.2), so this is a test-cleanup race. Fixed by f5c7d93 and its follow-up:
   the cleanups now retry for up to about 5 s. No assertion changed.

## §7.2 — the A4 cross-test (`mouli-tests-arhant.test.ts`)

Phase 1 had 9 of 47 red. Two were test errors: both drafts put a key into stored input, which BR-07
rightly refuses. Seven were engine defects. After the fixes the file has 48 tests, all passing, and
no `it.fails` is left.

| §7.2 row | Result |
|---|---|
| TC-MM-001/002/003/008 | ✅ 413 over the cap, 415 for a disallowed type, dedupe, all seven types, download hash, ETag and Range. The `?token=` URL was 401 → **D-066**, fixed |
| TC-MM-004 (+009) | ✅ no `bytes`/`base64` in any envelope, event or frame; the vision flow works |
| TC-MM-005 | ✅ PNG into `mock-text` → BLOCKED `incompatible_model`, zero calls |
| TC-TOOL-002 | ✅ `tool_allowed` block, ToolCall `blocked`, GUARDRAIL_VIOLATION |
| TC-TOOL-003 | ✅ search → fetch → answer. It could not finish offline → **D-067**, fixed |
| TC-TOOL-004/005 | ✅ timeout within timeoutMs + 500 ms; escape denied **and** logged. There was no mock to drive the tool → **D-068**, fixed, and that exposed a real JS escape (fixed, D227) |
| TC-TOOL-007 / TC-GRD-007 | ✅ allow-listed host 200; a host not on the list blocked with 0 requests |
| TC-TOOL-008 | ✅ MCP stdio server tools callable. A removed server's tool never gave `tool_not_registered` → **D-069**, fixed |
| TC-TOOL-009/010/011, TC-PRM-002 | ✅ redacted args, summary ≤ 500, duration, verdicts, the untrusted tool-result label |
| TC-GRD-006 | ✅ `sandbox_delete {path:'../../x'}` blocked, nothing deleted outside |
| TC-GRD-008 / TC-NFR-008 | ✅ WAITING → Reject → GUARDRAIL_VIOLATION, `notes.txt` kept; Approve on a new run → deleted inside the sandbox; `injection-delete.json` deletes nothing unapproved |
| TC-GRD-014 | ✅ exactly 5 calls, then RUN_FAILED `agent`; a policy `max_tool_calls` 3 lowers it |
| TC-CHAT-003/004/005/006/008, TC-GRD-022 | ✅ post + run, French, runs byte-identical, tokens before `chat.message`, 422 with verdicts |
| Retention | ✅ unreferenced artifact swept after 8 days; referenced one survives. The sweep never ran → **D-070**, fixed |
| §1 demo, API path | ✅ |

**Manual pass (§7.2).**
- A clean-clone `pnpm test` with no Docker is green (above).
- The Docker variant cannot be run: no Docker runner exists and `dockerSandbox` is read by nothing (**D-083**).
- A real SearXNG was not tried; `searxngUrl` is ignored anyway (**D-084**).

## §7.1 — the M4 cross-test (`arhant-tests-mouli.e2e.ts`)

Phase 1 had 11 of 21 red. Six were test errors: a selector, Markdown line-joining, JSON args, and
the issue count. The rest were defects. The file now has 29 tests: 25 pass and 4 are `test.fail()`.
Three consecutive round-4 runs gave identical results, with no flakes.

| §7.1 row | Result |
|---|---|
| TC-MM-007/002, TC-MM-001 | ✅ drop onto Input, dedupe, 413 refused inline naming the limit |
| TC-MM-003 via UI | ✅ ZIP on Windows. It was refused as `unsupported_type` → **D-075**, fixed |
| TC-MM-006/008 renderers | ✅ Markdown, JSON, code, image, players, file card. Media never loaded (401) → **D-066**; then the bytes were zero-filled → **D-082**; both fixed. The card has no hash → **D-076** ⏳ web |
| TC-MM-009, TC-MM-005 | ✅ |
| TC-CHAT-001/002 | ✅ six styles (the `system` type was missing → **D-073**, fixed), filters, full page with URL filters. The link to the full page never renders → **D-072** ⏳ web. Only 100 messages after a reload → **D-071 (High)** ⏳ web |
| TC-CHAT-003/004/005/006/007, TC-GRD-022 | ✅ |
| TC-TOOL-001/002/007/010, TC-PRM-002 | ✅ registry, badges, enablement, MCP add/remove, Tool-calls tab, destructive preview, untrusted highlight |
| TC-GRD-008 after a reload | the WAITING node loses its approval card → **D-074** ⏳ web (the top-bar badge still works) |
| **§1 demo, through the UI** | ✅ **walked end to end in the browser against the real engine**: upload → vision → renderers → tool calls → destructive approval → blocked HTTP → MCP → timeline (six styles, filter by node) → chat → refusal |

**Manual pass (§7.1)**, automated where it could be:
- **Range and seeking:** the engine answers 206 at the start, at 10 MB and at the tail. Chromium decodes and plays `mock-media`'s image, audio and video. Real long-video playback still needs a human.
- **5,000-message timeline:** blocked by D-071. Only 100 rows render; scrolling those was smooth (p95 frame 16.8 ms).
- **Two chat threads:** ✅ each shows only its own messages.
- **Reload mid-stream:** ✅ the full reply shows and no spinner is left stuck.
- **Screen reader on message types:** the labels are `aria-label`s on plain `div`s and likely are not announced (**D-086**). This needs a human with a real screen reader.

## Findings

The defect log has the full text of each (D-054, D-061 – D-086). Grouped:

**Security.**
- **D-054 (High, fixed).** Stop while a node was WAITING hung the drive, and a later Approve resurrected the STOPPED node. On `destructive.json` that **ran `sandbox_delete` and deleted `notes.txt` on a stopped run**.
- **D-061 (High, fixed).** The same resurrection path survived a crash and restart.
- **D-068 (fixed).** Sandboxed JavaScript read a file outside its folder and returned it.
- **D-083 (High, open).** Python and shell sandbox runs are still unconfined without Docker.

**The web UI could not show media at all.** D-066 (High) and D-082, both fixed.

**Engine correctness, all fixed.**
- D-062: a tool approval held the provider slot, and the timeout covered the whole loop instead of each turn.
- D-063: a stop could be overwritten by COMPLETED.
- D-067, D-069, D-070, D-073, D-079: the fixes above.
- D-075: contracts, the ZIP MIME alias.

**Decisions recorded:** D221 – D228.

## What is not done — named plainly

- **D-071 (High, web, Mouli):** the timeline never pages past the first 100 messages. It blocks the tag.
- **D-083 (High, A4, DECISION NEEDED):** `python` and `shell` code in `code_sandbox` can read any file the engine can when Docker is absent, and D13's Docker runner was never built. It blocks the tag. The options are in the defect row: a Docker runner plus refusing python/shell without it, best-effort confinement, or JavaScript-only until then.
- **D-077 (DECISION NEEDED):** a chat reply blocked at the output point has already been streamed as `chat.token`.
- **D-064 (contract):** a tool call cut off by a stop has no `ToolCallStatus`, so it goes unlogged.
- **Medium web defects (Mouli):** D-072 and D-074. **Low:** D-076, D-080, D-086.
- **Low engine defects:** D-065, D-078, D-081, D-084, D-085; plus D-055 – D-057 from round 3.
- **The §1 demo** was walked by Playwright, not yet by a person, and the round file asks that it be walked with the local MCP test server connected. The Playwright walk does that, but a human walk is still owed.
- **OI confirmations:** the OI-03/11/12/14 confirmations §8 expects in `docs/DECISIONS.md` are not written.

## Round 4 gate — NOT closed (2026-09-30)

- [x] C4, A4, M4 merged. [ ] CI green with this branch merged — pending its PR.
- [x] `pnpm test:acceptance` green for rounds 1–4 on `round-4/fix-arhant-1`, with the four web markers above.
- [ ] No open critical/high — **D-071 and D-083 are open.**
- [x] Sandbox escape and injection tests recorded: TC-TOOL-005, TC-GRD-006, TC-NFR-008, D-068.
- [~] §1 demo walked — by the browser suite end to end; a human walk is still owed.
- [~] `docs/DECISIONS.md`: D221 – D228 written; OI confirmations not yet.
- [ ] `CLAUDE.md` §9 rows → VERIFIED, §9.1 row, `git tag round-4` — after D-071 and D-083.

## Round 4 gate — CLOSED (2026-10-09, Mouli, on `round-4/fix-arhant-2`)

What changed since the 2026-09-30 entry:

- **D-083 closed by D288** (the owner's choice, option C): `code_sandbox` refuses `python` and `shell` as `unavailable` before anything spawns, and says to use JavaScript; JavaScript stays confined by Node's permission model (D227). Tests: `packages/tools/src/builtins/code-sandbox.test.ts` › "D-083 …", written red first. A Docker runner (D13) is still unbuilt and goes to rounds 6+.
- **D-071 closed** in PR #33 (earlier).
- Gates on this branch, rebased on `main` 2a3634d:
- `pnpm typecheck` 0 · `pnpm lint` 0/0 · `pnpm test` green with zero env vars — contracts 1095 · sdk 135 · ui 316 · engine 1561 · guardrails 357 · context 52 · providers 437 (+1 skip, 3 todo) · storage-local 301 · tools 190 (+1 skip) · web 868 · server 158. One providers flake on the first full run, D-092 (Low, Windows `EPERM` on a temp-folder cleanup), green on re-run.
- `pnpm test:acceptance` for rounds 1–5: vitest **180 passed + 1 todo**; Playwright **92 passed, 0 failed**, 1 flaky (round 1 NFR-USE-02, D-012), 2 skipped (D-039) — 4.3 min, including the round 4 and round 5 §1 demo walks against the real engine.

- [x] C4, A4, M4 merged. [x] `pnpm test:acceptance` green, rounds 1–4. [x] No open critical/high.
- [~] §1 demo walked by the browser suite end to end, with the local MCP test server; **no human walk is claimed** (§6.3).
- Carried, none blocking: D-077 (Medium, DECISION NEEDED — a blocked chat reply is streamed first), D-064 (Low, no `ToolCallStatus` for a stop), D-058, D-059, D-060, D-031, D-072/D-074/D-076/D-080/D-086 as listed above; the OI-03/11/12/14 confirmations are still not written.
