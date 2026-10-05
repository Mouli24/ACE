# Round 5 verification report

Both suites run with `pnpm test:acceptance`. That means:

- a real engine on a temp database, using the mock provider;
- no env vars and no keys;
- the real production web build behind `vite preview`.

Both suites stay in CI as regression tests (CLAUDE.md §6.2).

**Read this before the verdicts.**

- **Who built what.** Round 5 was built by both developers. Arhant wrote C5 (#31) and A5. Mouli wrote M5 (#32), which merged first, with her round 4 web fixes (#33) and the CI split (#34).
- **Who wrote the cross-tests.** Arhant wrote both files, as he did in round 4 and as #32 lists. Both were written from §2 and §7 of `docs/team-prompts/05-round-5-knowledge-memory-onboarding.md` before the implementation was read (§6.3, D258):
  - The §7.2 file was written in a worktree cut from M5's branch, which contained no A5 code. The writer was not allowed to open `packages/{engine,context,storage-local,providers,guardrails}` or the A5 branch.
  - The §7.1 file opened `apps/web/src` only to resolve locators. It never decided expected behaviour from the code, and never read Mouli's own e2e specs.
- **How failures were handled.** Every failure against the real code was classified:
  - A test that misread the spec was corrected under a recorded ruling (D255, D258), with the reason beside the fix.
  - An engine defect was fixed test-first on the A5 branch, before A5's PR.
  - Neither suite has an `it.fails` or `test.fail()` for round 5.

## Gates as measured — 2026-10-05

A5 = `round-5/arhant-knowledge-memory-usage`, rebased on `main` 3384606 (M5 merged). The cross-tests ran on a local integration of that branch and the two cross-test files.

```
pnpm build / typecheck / lint   ok
pnpm -r test             contracts 1078 · sdk 134 · engine 1508 · ui 212 · context 52 · guardrails 357 ·
                         providers 349 (+3 todo) · storage-local 296 · web 718 · tools 154 (+1 skipped) ·
                         server 151 — all passed
pnpm -r test:coverage    stmts / branch / funcs / lines
  contracts              100   / 98.41 / 100   / 100
  engine                 93.43 / 86.89 / 94.65 / 95.24
  context                98.72 / 89.8  / 100   / 99.71
  guardrails             97.24 / 93.95 / 100   / 99.13
  providers              95.54 / 86.11 / 96.53 / 96.97
  storage-local          98.47 / 92.73 / 99.26 / 99.16   (solo run — see below)
  tools                  95.53 / 85.29 / 94.85 / 97.04   (solo run — see below)
  server                 94.09 / 83.33 / 88.63 / 96.61
  sdk                    96.31 / 88    / 96.81 / 97.02
  ui                     98.15 / 89.53 / 97.7  / 98.59
  web                    unchanged by A5 (#32: 88.21 / 76.32 / 88.21 / 90.73)
acceptance, vitest       6 files, 183 passed            (rounds 1–5 + harness; round 5 §7.2: 40/40) — 153 s
acceptance, Playwright   93 passed, 2 skipped — 5.5 min (round 5 §7.1: 23/23, including the §1 demo walk;
                          skipped = round 3's two fixme tests, D-039; round 3's TC-ERR-002 provider-name
                          test is its own deliberate test.fail(), unchanged)
```

In the whole-workspace parallel coverage run on this Windows machine, three tests timed out under load. Each passes alone:

- `packages/tools`: the known D-088 sandbox timeouts;
- one `apps/web` Guardrails page test (11/11 alone, with coverage);
- storage-local's 5,001-row prune test, which now has a 30 s budget (aa38b03).

The storage-local and tools figures above come from their solo runs.

## §7.2 — the A5 cross-test (`mouli-tests-arhant.test.ts`)

**RED, against M5's branch, before A5 existed:** 30 of 40 tests failed and 8 were skipped. Every failure was a round 5 route answering 404, a missing mock model, or pre-flight still raising `not_supported_yet` for `retrieval`.

**First run against A5:** 34 of 40 passed. The six failures split three ways.

Two were engine defects, both fixed on A5 with a RED test first:

- **TC-OBS-007:** `/metrics/health` counted a BLOCKED downstream node as a node failure (D255).
- **TC-RAG-007:** the Retrieval node's run did not record what it read in `envelope.context.retrieved` (D255).

One was a missing harness lever. The engine accepted a mock adapter but did not expose it. `RunningEngine.mockProvider` now gives TC-RAG-009 the call log §4 item 8 names.

Three were the test's own misreadings:

- It opened the sqlite-vec virtual table with a plain driver.
- Its trace scenario triggered no check, and D114 stores only triggered checks.
- Its reading of which envelope carries the Retrieval node's hits was wrong; this was ruled in D255.

**Now:** 40/40.

| §7.2 row           | Result                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-RAG-001/002     | ✅ six types `ready` with chunks; base counts; each type searchable with a resolvable `source`                                                                                                                                                                                                                                                                               |
| TC-RAG-003         | ✅ the corrupt PDF `failed` with a human reason; its five siblings `ready`; `kb.ingest` stages in order with monotonic progress                                                                                                                                                                                                                                              |
| TC-RAG-004/005     | ✅ "zephyrine-protocol-7" in the top 3 through the keyword arm (keyword-only ranks it first); the paraphrase in the top 3 with `via: 'vector'`, and keyword-only does not find it                                                                                                                                                                                            |
| TC-RAG-006/007     | ✅ The implicit run's `sources` equal its `context.retrieved` (untrusted) and the answer cites one of them. The Retrieval node outputs `{ hits }` with scores equal to its `sources`, and its own run records them in `context.retrieved`; this was **found missing and fixed**. The downstream agent reads the hits with scores. A deleted base is `missing_knowledge_base` |
| TC-RAG-009         | ✅ the same `context.summary` in both runs, one new `summary_cache` row, **exactly one** summarisation call in `mockProvider.calls()`                                                                                                                                                                                                                                        |
| TC-RAG-010         | ✅ hit-rate@5 **1.000 (24/24)**, asserted ≥ the OI-02 floor D253 records                                                                                                                                                                                                                                                                                                     |
| TC-GRD-005         | ✅ the poisoned chunk is retrieved, untrusted and sanitised; the answer has no canary and no system text and still cites; the stored prompt holds the chunk after the untrusted label with no `<!--` and no payload; the verdict lists the stripped types and never the payload                                                                                              |
| Context budget     | ✅ 4 bases × k=5 = 20 chunks; envelope ≤ 4,000 estimated tokens; retrieved ≤ 50 %; `droppedSources` recorded and disjoint from the kept chunks; every kept chunk scores ≥ every dropped one                                                                                                                                                                                  |
| TC-MEM-001/002     | ✅ run 1 saves (`memoryOps`, `memory.updated`, `__memory` stripped); run 2's envelope holds the fact (untrusted, `lastUsedAt` set); after clear there is no memory section, and deleted entries never return                                                                                                                                                                 |
| PII on ingest      | ✅ a document verdict at `context` (`redact`, `email` among the types, no values); the search hit and every ordinary table matching `kb`/`chunk` hold none of the email, phone or IBAN                                                                                                                                                                                       |
| TC-OBS-001/002/004 | ✅ trace `seq`s = the persisted events', each kind per D234, with node runs, a tool call, a verdict and run events; run totals = Σ node runs, and the completion `usage.updated` carries `dayTotals`; `/usage` by provider and day = a manual aggregation, cell by cell                                                                                                      |
| TC-OBS-007         | ✅ runs by outcome, failures by kind (**BLOCKED counted as a failure — found and fixed**), verdicts by type and provider p50 ≤ p95 all move by exactly what was run                                                                                                                                                                                                          |
| TC-SYS-014         | ✅ export → import into a second engine on a clean data dir → identical projects, workflows, runs, artifacts and settings; a deep scan of the zip (nested archives included) finds no key, no session token and no key prefix                                                                                                                                                |
| TC-ONB-002         | ✅ the four templates, in `TEMPLATE_IDS` order, each instantiate onto a Mock provider and run to COMPLETE; rag-qa's seeded document reaches `ready`                                                                                                                                                                                                                          |
| NFR-PRIV-01        | ✅ `net.Socket.prototype.connect` and `dns.lookup` are wrapped before a dedicated engine starts; a full KB ingest plus a run makes only loopback connections and no non-IP lookup; `telemetryEnabled` stays false and a PATCH to true is a 400                                                                                                                               |

**Manual pass (§7.2).**

- **Clean-clone `pnpm test` with no network:** the gates above have zero env vars, and the A5 suite's own no-network test enforces this at socket level. A literal fresh clone with the network cable out has not been done.
- **100 MB document rejected:** covered by round 4's upload cap (`413` over `maxUploadMb`). It was not re-run by hand with a 100 MB PDF.
- **Reindex a five-document base:** automated (`reindex replaces, never duplicates`; the TC-RAG-008 delete). The by-hand check that chunk ids change while sources still resolve has not been done.
- **Kill the engine mid-ingestion:** automated by F7's recovery test. Interrupted documents are reset to `pending` and re-queued at start, never left `parsing`. It has not been done with a real `kill -9`.

## §7.1 — the M5 cross-test (`arhant-tests-mouli.e2e.ts`)

**Against M5's branch** (round 4's engine): 6 of 23 passed. Those were TC-CAN-007/008/010, TC-MOB-002, FR-MOB-003 and TC-SYS-006. Every other test stopped on a missing A5 route or mock model.

**First run against A5:** 16 of 23 passed. All seven failures were test technique, not product:

- **Template choice.** The writer picked a template by `.check()` on an `sr-only` radio that its card label covers.
- **Knowledge-base checkbox.** It ticked the engine-controlled checkbox with `.check()`, which demands an instant state change.

Both now click the way a person does, then wait for the checked state.

**Now:** 23/23, including the §1 demo walk.

| §7.1 row                       | Result                                                                                                                                                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ONB-001                     | ✅ clean data dir → onboarding → Mock provider in one click → RAG Q&A → the run completes, with no key and no docs opened                                                                                                        |
| TC-ONB-002                     | ✅ each of the four templates instantiated from the wizard reaches COMPLETE                                                                                                                                                      |
| TC-RAG-001/002/003             | ✅ a KB created on the Knowledge screen; the five fixtures plus the corrupt PDF → five `ready` with progress, one `failed` with a readable reason, siblings unaffected                                                           |
| FR-RAG-008 (D238)              | ✅ Test search: "zephyrine-protocol-7" and a paraphrase return the right chunk with scores, sources and the match highlighted                                                                                                    |
| TC-RAG-006/007                 | ✅ KB attached in the Agent config → run → the inspector's Sources equal `GET /node-runs/:id`, and a source opens its document; the Retrieval node path shows the same                                                           |
| TC-RAG-008 (FRS meaning, D238) | ✅ deleting `handbook.md` → its content is no longer found, on screen or through the API                                                                                                                                         |
| TC-MEM-002                     | ✅ `memory.json` run twice → the Memory tab shows the entry live; delete → the next envelope has no memory section                                                                                                               |
| TC-OBS-001                     | ✅ the run detail Trace lists `GET /runs/:id/trace` in order                                                                                                                                                                     |
| TC-OBS-004                     | ✅ the usage table equals `GET /usage` for the same range and grouping, cell by cell                                                                                                                                             |
| TC-CAN-007/008/010             | ✅ Auto-arrange leaves no overlaps; ten edits undone and redone leave the graph equal to the server's; Ctrl+A, Ctrl+D, Delete, Ctrl+Z/Y and F all work                                                                           |
| TC-MOB-001/002, FR-MOB-003     | ✅ at 380 px the runs list, run detail, outputs, trace and chat have no horizontal scroll; an approval is answered; the Canvas is read-only with the banner                                                                      |
| TC-SYS-006                     | ✅ concurrency 5 → restart the engine → reload → still 5                                                                                                                                                                         |
| FR-SYS-012                     | ✅ Export → a clean data dir → Import → the same projects, runs and settings                                                                                                                                                     |
| **§1 demo, through the UI**    | ✅ **walked end to end in the browser against the real engine**: onboarding → knowledge → test search → attached KB with sources → poisoned document → usage → trace → canvas tools → 380 px → settings restart → backup restore |

**Manual pass (§7.1).** None of these has been done by a person:

- a 300-page PDF;
- 50 documents in one base;
- onboarding with a local Ollama;
- 30 days of usage data;
- a contrast check in both themes, beyond M5's own automated contrast test;
- a screen reader on the wizard.

## Findings

**Logged in the defect log, because they live in code merged in earlier rounds:**

- **D-090 (Medium, A1 `apps/server`, fixed on A5).** The engine's shutdown hung while a browser held a preconnected socket or a half-sent request. It took 6.9 s to 180 s in the §7.1 run, which would have broken TC-SYS-006's restart and FR-SYS-012's restore for a user.
- **D-091 (Low, M5, open, Mouli's).** At 380 px the Inspector says "Start a run to inspect it." for a node whose run finished before the page loaded.

**Found and fixed on the A5 branch before it merged.** These are work in progress, so they are not defect-log rows. They are recorded here because they came from the cross-tests and the whole-branch review:

- **From the cross-tests:**
  - health counted a BLOCKED node as a failure;
  - the Retrieval node's run did not record its read;
  - the engine did not expose its mock adapter.
- **From the whole-branch review:**
  - **(Critical)** a knowledge base's source file was swept after 7 days, and a reindex then wiped the base;
  - tool results, ingested text and the summariser's input reached a model or the database unguarded or unmasked;
  - a provider could be removed from under a base's embedder;
  - a backup import could race a starting run.

**A note for Mouli, not a defect:** the web app's MSW mock (`apps/web/src/mocks/observability.ts`) still counts BLOCKED nodes as failures, unlike the engine now.

**Decisions recorded:** D244–D258.

## What is not done — named plainly

- **Round 4 is not tagged.** D-083 (High, A4: `python`/`shell` sandbox code unconfined without Docker) is still a DECISION NEEDED. D-077 and D-064 also await decisions. CLAUDE.md §5 says round 5 is not tagged before round 4.
- **The §1 demo was walked by Playwright, not by a person.** The round file asks for the walk from a fresh profile and a clean data dir. The automated walk does exactly that, but the human walk is still owed.
- **Carried from A5 (D258), none blocking a §7.2 row or the demo:**
  - a summary made for a control re-run, or for a node that never ran, is not counted in `/usage`;
  - a large document reports no progress between embedding batches and is not retried on a 429;
  - deleting a project or a node leaves its bases or its memory rows;
  - a guard that throws, rather than refuses, on a tool result leaves that call unlogged;
  - a PEM key masked inside an ingested document shifts the line-range sources after it.
- **Open defects:** D-091 (Low, web); round 4's list stands as in its report.

## Round 5 gate — NOT closed (2026-10-05)

- [x] C5 (#31) and M5 (#32) merged. [ ] A5 merged — its PR is open.
- [x] `pnpm test:acceptance` green for rounds 1–5 on A5 + `main` (locally; CI pending the PRs).
- [x] REPORT.md written; hit-rate@5 and the OI-02 decision recorded (D253).
- [ ] No open critical/high — round 5 has none of its own, but **round 4's D-083 is open and round 4 is untagged.**
- [~] §1 demo walked from a clean data dir — by the browser suite end to end; a human walk is still owed.
- [x] `docs/DECISIONS.md`: OI-02 target (D253), mock model additions (D251), context-guardrail defaults (D246, D247, D256), memory contract (D252, D257).
- [ ] `CLAUDE.md` §9 rows C5/A5/M5 → VERIFIED, §9.1 round 5 row, `git tag round-5` — after A5 merges, the cross-tests land, and round 4 is tagged.
