# Round 2 verification report

Both suites run with `pnpm test:acceptance` (real engine on a temp database, mock provider, real
production web build) and stay in CI as regression.

```
$ pnpm test:acceptance
 Test Files  3 passed (3)          # helpers/harness + round-1 and round-2 vitest suites
      Tests  56 passed (56)
 25 passed (2.1m)                  # round-1 and round-2 Playwright suites, 1 flaky (D-012)
```

Both round-2 files are in and green. The `it.fails` markers that stood in for D-025 and D-027 are
gone: #17 and #18 fixed both defects, and #18 removed the markers in the same change — which is what
they were for. The one flaky test is round 1's `NFR-USE-02` keyboard path (D-012), unchanged by this
round.

## Mouli → Arhant (A2)

Verdict: **VERIFIED** · Date 2026-09-25 · Commit tested `88f06ba` (`main`, after #17 and #18)

Re-run after the fixes: **23 passed, nothing expected-fail**. The first pass, on `8d01799`, was 20
passed + 3 expected-fail and is kept in the findings below, because what those three caught is the
reason this row can say VERIFIED now.

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

Verdict: **VERIFIED** · Date 2026-09-25 · Commit tested `88f06ba`

Automated — `tests/acceptance/round-2/arhant-tests-mouli.e2e.ts`, 13 scenarios in Playwright driving
the production web build against the real engine (temp database, mock provider). **13 passed in
1.4 min, no retries.**

| Scenario (§7.1)                                                                                                                                       | Result |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| TC-PRV-001/002 mock addable with no key; `openai` with a fake key → "key set: yes", key in neither the DOM nor any provider response                  | ok     |
| TC-PRV-003/004 `apiKey: bad` → AUTH_FAILED with a message; unreachable `baseUrl` → UNREACHABLE                                                        | ok     |
| TC-PRV-005 key rotated and checked through the API while the page is open → chip changes, no reload                                                   | ok     |
| TC-PRV-006 remove an in-use provider → the 409 names the node → the node shows "provider missing"                                                     | ok     |
| TC-NODE-003/004 agent taking text+image → `mock-text` disabled "no image input", `mock-vision` chosen → chip follows and the engine agrees            | ok     |
| TC-NODE-008 edit instructions during a `mock-slow` run → notice shown, that run's prompt unchanged, the next run's prompt has the new text            | ok     |
| TC-NODE-010 empty Input node → dialog → the typed text lands in the run's `inputs`, the graph is not edited behind the user                           | ok     |
| TC-EXE-007/008/014 `mock-slow`: text grows while RUNNING, ring labelled per state, the agent's edge animates, Output shows the engine's `finalOutput` | ok     |
| TC-RTR-004 `mock-503` primary + fallback → card reads "used: … (fallback)" and matches `modelUsed`                                                    | ok     |
| TC-EXE-003 agent with no model → BLOCKED panel names the node, zero node runs, "show node" selects it                                                 | ok     |
| TC-EXE-009 / TC-PRM-005 inspector fields match the node run; **View prompt is byte-equal to `GET /node-runs/:id` `prompt.text`**                      | ok     |
| TC-EXE-011 three runs → rows in the engine's order, each carrying its own totals                                                                      | ok     |
| TC-EXE-013 the WebSocket is cut mid-run → the run still finishes and every card's final state equals `GET /runs/:id/node-runs`                        | ok     |

Two things worth naming about how this suite is written:

- Every "is it really so?" assertion goes to the engine over REST. The UI is the thing under test, so
  it cannot also be the source of truth — the prompt drawer is compared with `GET /node-runs/:id`, the
  overlay's final states with `GET /runs/:id/node-runs`, the chosen model with the stored graph.
- Two scenarios select the node **before** Start rather than during the run. A card grows once it
  carries streamed text, and a grown card can slide under its neighbour at fit-to-view zoom; clicking
  it then fails for a layout reason and looks like a selection bug. The earlier version of this file
  was flaky for exactly that, twice.

**Authorship, stated plainly:** §7.1 assigns this file to Arhant. It was written by Mouli on the
repository owner's instruction to close the round 2 gate (D67), the same arrangement as round 1's D32.
A self-written cross-test is weaker than a partner's by construction — nobody catches their own blind
spot — so it is worth Arhant reading it, and the two M2 defects that a partner's eye did catch
(D-027's wrong cause, TC-EXE-013 being weaker than its name) are the evidence for why.

### TC-NFR numbers (gate item), measured on this machine

```
TC-NFR-002  102 nodes dispatched in 38 ms  = 0.37 ms per node          (limit 50 ms)
TC-NFR-003  first node.token 62.2 ms after the adapter yielded          (limit 200 ms)
TC-NFR-005  22 node runs at concurrency 20 in 4 ms, no errors
TC-NFR-001  200-node fixture: 58.7 fps wheel, 56.8 fps drag             (target ≈60)
TC-NFR-004  paint within 200 ms of a frame — component test, sub-ms
```

### §1 demo script

Walked twice: through the **UI** by `tests/acceptance/round-2/demo-script.e2e.ts` (one test, every
step in order, against the real engine — **1 passed in 59.3 s**), and through the **API** by a script
whose output is pasted below. Round 1 settled why it is automated rather than narrated (D41): a pass
performed once and written up is a claim the next person cannot re-check.

```
 1. ok  add provider "Mock" — keySet: false
 2. ok  Test → CONNECTED — 0 ms
 3. ok  models listed — 15 models
 4. ok  Start → the run is recorded and already going — 201 RUNNING
 5. ok  run COMPLETE
 6. ok  Output node carries the final result — 278 chars
 7. ok  inspector data — 95↓ 40↑ $0.000175 · mock-text · prompt ee7bead8676f
 8. ok  fallback walked — used: mock-text (fallback)
 9. ok  contract violation is its own failure — CONTRACT_VIOLATION · kind agent · run HALTED
10. ok  a reload mid-run can rebuild the states — 5 node.state events persisted for replay
11. ok  the slow run finishes — 3141 ms
```

**The walk earned its keep on the last line.** "Reload during a slow run → states and text still
correct" had never been exercised: my TC-EXE-013 and the §7.1 row both _cut the socket_ and let it
reconnect, which is not the same as reloading the page. Reloading left the Canvas blank — every card
back to IDLE while the engine held the real states — because the overlay lives in memory and a fresh
page seeds the socket's `lastSeq` from `hello`, so `resume` replays nothing from before the load.
Fixed as **D-028** (`useAdoptActiveRun` rebuilds the overlay from `GET /runs/:id` and
`/runs/:id/node-runs`). One honest limit, asserted where it matters: the text streamed before a
reload is gone for good, because `node.token` is transient by contract (§2.4).

### A real provider: local Ollama

The gate asks for one run against a real provider or Ollama. Done with a local Ollama rather than a
cloud key — no secret in anyone's shell, repeatable on any machine, and it exercises the
`openai_compatible` path that Ollama and LM Studio share (D70).

```
ollama serve · smollm2:135m (271 MB)

GET  /providers/detect                → { ollama: { detected: true, baseUrl: …:11434 } }
POST /providers        type: ollama    → created
POST /providers/:id/check              → CONNECTED in 4 ms
POST /providers/:id/refresh-models     → ['smollm2:135m']
POST /workflows/:id/runs               → 201 RUNNING
GET  /runs/:id                         → COMPLETE in 53 425 ms
                                          totals 217 in / 654 out, costUsd 0
node run                               → COMPLETED · model smollm2:135m · prompt ee7bead8676f
final output                           → real generated prose, 200+ chars
```

`costUsd: 0` is correct rather than missing: a local model has no price table, and FR-OBS-003 stamps
the version in force — there is none to stamp. The prompt version is the same `ee7bead8676f` the mock
run produced, which is the point of TC-PRM-001: the prompt depends on the config, not on who answers.

**What is still a human act:** the two of us looking at this together and judging whether it _looks_
right. The steps are now re-checkable by anyone in 60 seconds; the judgement is not automatable and is
not claimed here.
