# Round 2 verification report

Both suites run with `pnpm test:acceptance` (real engine on a temp database, mock provider, real
production web build) and stay in CI as regression.

```
$ pnpm exec vitest run --config tests/acceptance/vitest.config.ts
 Test Files  3 passed (3)
      Tests  53 passed | 3 expected fail (56)   # 20 passed | 3 expected fail in round-2
```

The three "expected fail" checks are the two open **High** defects below, not flakes. They are marked
`it.fails` rather than skipped: the assertions keep running on every CI, they stay green only while
the defect is real, and the moment it is fixed they turn red with "expected test to fail" — which is
the reminder to unmark them. A skip would have quietly outlived the bug. Everything else in §7.2
passes against the engine as merged.

## Mouli → Arhant (A2)

Verdict: **MERGED — verification incomplete (D-025, D-027)** · Date 2026-09-25 · Commit tested
`8d01799` (`main`, A2 merged) with M2 rebased on top.

Automated — `tests/acceptance/round-2/mouli-tests-arhant.test.ts`, 23 checks over HTTP + WS through
`@ace/sdk`, folding the frames with the same `RunEventBuffer` the web app uses:

| Scenario (§7.2)                                                                                                                 | Result                  |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| TC-PRV-002 key stored, `keySet` returned, key absent from body, DB file and every log                                           | ok                      |
| TC-PRV-003/004 `apiKey: bad` → AUTH_FAILED, `ratelimited` → RATE_LIMITED                                                        | **expected fail** D-025 |
| TC-PRV-003/004 unreachable `baseUrl` → UNREACHABLE; healthy mock → CONNECTED                                                    | ok                      |
| TC-PRV-009 provider limited to 2, five `mock-slow` agents → never more than 2 in flight                                         | **expected fail** D-027 |
| TC-MOD-001/002 mock models discovered; manifest-only provider lists `source: manifest`                                          | ok                      |
| TC-MOD-003 filters narrow by data type and availability                                                                         | ok                      |
| D64 `GET /providers` answers `{ items }`                                                                                        | ok                      |
| TC-EXE-001 `linear-mock.json` → COMPLETE, Output's final text equals the agent's output                                         | ok                      |
| TC-EXE-002 node deleted mid-run still executes; snapshot keeps it, live graph loses it                                          | ok                      |
| TC-EXE-003 unreachable provider → BLOCKED, zero node runs, zero tokens                                                          | ok                      |
| TC-NODE-007 agent with no model → BLOCKED, the issue names the node                                                             | ok                      |
| TC-EXE-005 `contract-violation.json` → FAILED `CONTRACT_VIOLATION`, kind `agent`, HALTED                                        | ok                      |
| TC-EXE-006 `budget.json` → every envelope ≤ its `budgetTokens`, summary present, trust set                                      | ok                      |
| TC-RTR-002 fallback walked → COMPLETED with `viaFallback: true`                                                                 | ok                      |
| TC-RTR-003 whole chain 503 → FAILED `RUN_FAILED`, kind `provider`, run HALTED                                                   | ok                      |
| TC-EXE-010 Output's agent cannot answer → HALTED, no `finalOutput`                                                              | ok                      |
| TC-EXE-011 three runs → history newest first with status, duration and totals                                                   | ok                      |
| TC-EXE-013 drop the socket mid-run, `resume { afterSeq }` → no gap, no duplicate seq, the fold equals `GET /runs/:id/node-runs` | ok                      |
| TC-EXE-008 subscribe _after_ the 201 → tokens still arrive; `node.token` carries no `seq`                                       | ok (trim, D-026)        |
| TC-PRM-001 two runs, same config → `prompt.text` byte-identical, `prompt.version` equal, no key in it                           | ok                      |
| TC-OBS-002 run totals = Σ node runs, `priceTableVersion` recorded                                                               | ok                      |
| TC-OBS-003 catalogue refreshed → the recorded run's totals and node runs unchanged                                              | ok                      |
| TC-SYS-008 key absent from the data directory after a keyed run                                                                 | ok                      |

Two of §7.2's rows are **not covered here and are honest gaps**, not silent omissions:

- **TC-SYS-009/010** (SIGTERM → HALTED `shutdown`; SIGKILL → restart → HALTED `crash`, nodes
  STOPPED). The acceptance harness starts one engine for the whole suite in `global-setup.ts`, so a
  spec that kills it takes every other spec with it. Arhant covers both in `apps/server` against a
  real subprocess (`server.test.ts`, `cli.test.ts`), and round 1 put the `kill -9` case in
  `helpers/crash-check.ts`. Worth folding into that helper for round 3 rather than faking it here.
- **The §1 demo script walked by both of us**, and one run against a real provider or Ollama. Manual
  by nature; the gate asks for it and it is still to do.

### Findings

| ID    | Severity | What                                                                                                                                               | State |
| ----- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| D-024 | Medium   | Adding a provider does not discover its models; the catalogue is empty until `refresh-models`                                                      | OPEN  |
| D-025 | High     | The mock adapter is shared and never sees its provider row, so §2.6's `apiKey: 'bad'` / `'ratelimited'` behaviours are unreachable through the API | OPEN  |
| D-026 | Low      | Concatenated `node.token` deltas carry a trailing space the stored `output` does not                                                               | OPEN  |
| D-027 | High     | `runGated` is declared and wired but never called, so FR-PRV-009's concurrency limit is unenforced in the run path                                 | OPEN  |

D-025 and D-027 are **High and block the round** (CLAUDE.md §6.2). Both have an exact location and a
small fix, and both are the kind of thing only an outside-in test finds: the adapter's own unit test
proves `apiKey: 'bad'` → AUTH_FAILED, and the semaphore's proves the gate holds a third caller back —
what neither asserts is that the wired engine uses them. D-025 also blocks a scenario in Arhant's own
§7.1 list ("mock provider with `apiKey: bad` → Test → AUTH_FAILED with message" through my UI).

### What was verified beyond the table

- **D65 measured, not taken on trust.** `POST /workflows/:id/runs` against `slow.json` answers
  `201 RUNNING` in **17 ms** (it awaited the whole run before the fix: 3303 ms, `COMPLETE`), and a
  client that subscribes after that response receives 49 `node.token` frames, 4 `node.state`,
  `node.output`, `edge.transfer`, `usage.updated` and `run.completed`. That is what makes the live
  overlay possible at all.
- **Key safety, at the filesystem.** After a run with a keyed provider, every file under the data
  directory — SQLite database, WAL, every log — is read and searched for the key. Absent.
- **Immutability, by comparison rather than by claim.** TC-OBS-003 re-reads the run and its node runs
  after a catalogue refresh and asserts `toEqual` against what was recorded before it.

## Arhant → Mouli (M2)

_Arhant's section — `tests/acceptance/round-2/arhant-tests-mouli.e2e.ts` and the §7.1 manual pass._

Verdict: _pending_

Note for that suite, from this side: the §7.1 row "mock provider with `apiKey: bad` → Test →
AUTH_FAILED" cannot pass until **D-025** is fixed — the UI renders whatever `POST /check` returns, and
the engine currently returns CONNECTED for that provider.
