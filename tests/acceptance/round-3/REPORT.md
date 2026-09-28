# Round 3 verification report

Both suites run with `pnpm test:acceptance` — a real engine on a temp database, the mock provider, no
env vars and no keys, plus the real production web build behind `vite preview` — and stay in CI as
regression (CLAUDE.md §6.2).

**Read this before the verdicts.** There has been one developer on ACE since round 3 (D94), so the
two sections below were written by the same person, and CLAUDE.md §6.3 is what this report holds
itself to rather than ticking the boxes as if two people had. What that recovers: both files were
written from §2 and §7 of `docs/team-prompts/03-round-3-control-guardrails-loops.md` **before** the
implementation, and every "is it really so?" question is asked of the **engine** over REST rather
than of the page it came from — `run.allowedActions` is compared with the buttons the toolbar
rendered, never with a table typed into the test. What it does not recover: a second pair of eyes on
a design decision. Nothing else does either, and round 2 is the evidence — a partner's review there
corrected a wrong diagnosis of D-027 and caught TC-EXE-013 asserting less than its name claimed
(D67). Every gate line below that cannot honestly be ticked says so, and says why.

## Gates as measured — 2026-09-26

`pnpm test:acceptance` is two commands joined by `&&`, and the first is red, so **it never reaches
the Playwright half**. Both halves are therefore reported as they were actually run.

```
$ pnpm test:acceptance
> vitest run --config tests/acceptance/vitest.config.ts && pnpm test:acceptance:e2e

 ❯ round-3/mouli-tests-arhant.test.ts (39 tests | 4 failed) 106103ms
   ❯ TC-GRD-008/009 an ask_user check waits for a person (2)
     × approve: the node continues and the decision is logged with its time 30064ms
     × reject: the node fails GUARDRAIL_VIOLATION, not CONTRACT_VIOLATION 30042ms
   ❯ TC-PAR-002 merge "all" waits for every connected input (1)
     × runs its branches at once and merges them in input-port order 3179ms
   ❯ TC-PAR-003 merge "any" takes the first arrival and records the rest (1)
     × starts on the fast branch, and the slow branch still completes without feeding the merge 50ms

 Test Files  1 failed | 3 passed (4)
      Tests  4 failed | 91 passed (95)
   Duration  151.13s
 ELIFECYCLE  Command failed with exit code 1.
```

```
$ npx playwright test --config tests/acceptance/playwright.config.ts round-3 --retries=0
  ok  1 … TC-CTL-006: in every reachable run state only the engine's allowed actions are enabled
  ok  2 … TC-CTL-001 + TC-CTL-002: Pause during mock-slow keeps the next node from starting, Resume finishes the run
  ok  3 … TC-CTL-003 + TC-CTL-004: Stop halts the run "stopped by you", and Restart shows a new run id
  ok  4 … TC-ERR-002: an auth failure names the node, the kind, the message, the provider, the state, Retry and the next step
  x   5 … TC-ERR-002: the error card names the provider that refused the key      (expected fail — the engine records no error.providerId)
  ok  6 … TC-ERR-007: the node after a failure is BLOCKED, not failed
  ok  7 … TC-ERR-008: a stopped node is not counted among the run's failures
  ok  8 … TC-GRD-008: an ask_user guardrail puts the node in WAITING with a card, and Approve continues it
  ok  9 … TC-GRD-009: Reject fails the node GUARDRAIL_VIOLATION, shown apart from CONTRACT_VIOLATION
  ok 10 … TC-MOB-002: at 380 px the approval card is usable and Approve continues the node
  ok 11 … TC-GRD-001 + TC-GRD-016: a policy using all five actions saves as version 2, and the Test panel lists the verdict
  ok 12 … TC-GRD-002: the project default warns on PII, an agent override blocks, and the inspector names the override
  ok 13 … TC-GRD-018 + TC-GRD-019: a redaction names the type removed, and the value is nowhere on the Canvas
  ok 14 … TC-CON-007: the loop editor refuses 0 and 51 inline, and 3 is accepted and persisted
  ok 15 … TC-PAR-006: the iteration selector lists every iteration of a Review→Fix loop with distinct outputs
  ok 16 … TC-GRD-012 via UI: a run over the project cap halts "budget exceeded: $x > $0.01 cap"
  16 passed (1.8m)
```

```
$ pnpm --filter @ace/acceptance exec eslint .
round-3/mouli-tests-arhant.test.ts
   75:7   error  'PLACEHOLDER_PROJECT' is assigned a value but never used
  519:10  error  'peakOverlap' is defined but never used
  543:10  error  'overlapMs' is defined but never used
✖ 3 problems (3 errors, 0 warnings)
```

```
$ pnpm --filter @ace/acceptance exec tsc --noEmit
(no output — but see "The typecheck gap" below: this command never looks at round-2 or round-3)
```

### The typecheck gap — a finding in its own right

`tests/acceptance/tsconfig.json` has `"include": ["helpers", "round-1", "*.ts"]`. **Round 2 and
round 3 are not in it**, so `pnpm --filter @ace/acceptance exec tsc --noEmit` — and the workspace
`pnpm typecheck` with it — has never typechecked a single line of either round's cross-tests. They
are compiled only by the runners, and Vitest and Playwright transpile per file without checking
types across them.

This was not theoretical. Checking `round-3/arhant-tests-mouli.e2e.ts` explicitly, against a copy of
that tsconfig with `round-3` added to `include`, found two real errors the workspace command called
clean:

```
round-3/arhant-tests-mouli.e2e.ts(538,22): error TS2339: Property 'snapshotVersion' does not exist on type Run
round-3/arhant-tests-mouli.e2e.ts(538,51): error TS2339: Property 'snapshotVersion' does not exist on type Run
```

Both are fixed (`Run.snapshot.version`, and `RunSummary` is now read as the narrower thing it is: it
carries no `allowedActions`, no `snapshot` and no `restartedFromRunId`, so anything beyond a status
goes through `GET /runs/:id`). The **gap itself is not fixed**: `tsconfig.json` is Arhant's under
§3.1 and outside the two files this session was allowed to touch. Adding `"round-2"` and `"round-3"`
to `include` is the whole change, and until it lands a type error in either cross-test suite reaches
`main` silently.

## Arhant → Mouli (M3)

Verdict: **VERIFIED by the §7.1 cross-test**, with one carried finding whose cause is A3's and not
M3's · Date 2026-09-26 · `tests/acceptance/round-3/arhant-tests-mouli.e2e.ts`, 16 Playwright tests
against the real engine and the production build: 15 green, 1 expected-fail, 1.8 min, no retries.

What that verdict covers and what it does not: it covers every row of §7.1's table, driven through the
real UI against the real engine. It does **not** stand in for M3's own gates — §7.1's manual pass is
not walked (below), and M3's own `pnpm test:e2e` could not be read in this worktree because the run
attached to another session's dev server (below). So this is "the seam holds", not "the round is
green".

§7.1 assigns this file to Arhant. He stopped after round 2, so it is written by the one developer
left — the round 2 precedent is D67, and it carries the same cost, stated above.

| §7.1 row                                                                                           | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TC-CTL-006** — only the allowed buttons are enabled, compared with `run.allowedActions`          | **ok.** Five states reached for real: RUNNING and PAUSED live on the Canvas, then HALTED, COMPLETE and BLOCKED on `/runs/:id`. In each, the button set is read off the DOM (`data-allowed`, `isEnabled`) and compared with what `GET /runs/:id` answered. No action list is written in the test — the actions are read from the buttons' own `data-testid`s, so a control added to the contract cannot be silently skipped. PREFLIGHT is **not** covered and is not faked: `POST /runs` already answers past it (D65)                                                                                                                                                                                                                                                                                                                     |
| **TC-CTL-001..004** through the UI                                                                 | **ok.** Pause during `mock-slow` → the run is PAUSED and the _next_ node never gets a node run at all (asserted against `GET /runs/:id/node-runs`, not against a card); Resume → COMPLETE; Stop → confirm dialog → HALTED with `haltReason: 'stopped'` and the screen reading "Run halted — stopped by you"; Restart → a second run whose record carries `restartedFromRunId`, the same `snapshot.version` and the same `inputs`, and the browser is taken to `/runs/<new id>`                                                                                                                                                                                                                                                                                                                                                            |
| **TC-ERR-002** — node, kind `auth`, message, provider, state, Retry, "update the provider key"     | **ok except the provider.** Node name, `data-kind="auth"`, the engine's own `error.message`, the `failed` status-ring label, an enabled Retry and the exact next step "Update the provider key in Providers." all pass. The **provider is missing**, and the cause is the engine's: `executor.ts` calls `classifyError(error)` with no context although `ClassifyContext.providerId` exists for exactly this and says so in its own comment, so `error.providerId` is never recorded and `ErrorCard` has nothing to render. Kept as a `test.fail()` test so it stays visible and turns green by itself when the executor passes the context                                                                                                                                                                                               |
| **TC-ERR-007/008** — downstream BLOCKED not failed; a stopped node is not a failure                | **ok.** The downstream node run is `BLOCKED` with `failureReason: 'BLOCKED'` and `error.kind: 'workflow'`; its card is locked, greyed, names the node that blocked it and renders no failure note; the Errors tab lists it under "blocked · never reached" and gives it no error card. For the stop case every chip of `run-summary` is compared with the engine's own count of that state — `0 failed`, `1 stopped`                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **TC-GRD-008/009** — WAITING ring + approval card; Approve continues; Reject → GUARDRAIL_VIOLATION | **ok.** The card's `data-point`, `data-check` and reason are compared with the `ApprovalRequest` the engine published at `GET /runs/:id/approvals`; Approve → COMPLETE, `approvals[0].decidedAt` set, the decision shown in the inspector; a fresh run → Reject → `failureReason: 'GUARDRAIL_VIOLATION'`, `error.kind: 'guardrail'`, shown as GUARDRAIL_VIOLATION on the card and in the inspector and never as CONTRACT_VIOLATION                                                                                                                                                                                                                                                                                                                                                                                                        |
| **TC-GRD-001/016** — all five actions, save → version 2; Test panel lists the verdict              | **ok.** The five actions are set on five real checks _of the policy the engine answered with_; the option list is asserted to be exactly `pass · warn · redact · ask user · block` (the enum stays `ask_user`); saving reports "saved as version 2" and `GET /guardrail-policies/:id` agrees check by check. The Test panel's verdicts are compared with a direct `POST /guardrail-policies/:id/test` — same count, and the `prompt_injection` row carries the action the engine returned                                                                                                                                                                                                                                                                                                                                                 |
| **TC-GRD-002** — project default warns, agent override blocks, inspector shows the override        | **ok.** The default policy's input `pii` check really is `warn` (D10) and the run completes with a `warn` verdict and the default policy's id on the node run; the override — shown by the config panel's own picker as "`<name>` · version `<n>`" — blocks the same content into `GUARDRAIL_VIOLATION`, and the inspector names the override's id tail and its version                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **TC-GRD-018/019** — redact: the type removed, and the value nowhere in the DOM                    | **ok, with the scope stated.** `pii-ask.policy.json` is reused with its one check turned to `redact`, the address is typed into the run-input dialog so the Input card carries none, and the verdict reads "removed email" / "types removed: email" / "the values are not recorded" while `JSON.stringify(verdict)` contains no address. The whole-document sweep is taken with the inspector closed, and the node's recorded output, the verdict list and the Output node's result are each swept. The **inspector's Inputs section is excluded on purpose**: it renders the envelope the operator's own text arrived in, which is a view of what the person typed, not a leak of a redacted value. The prompt drawer is not swept either — `prompt.redactedText` removes secrets, not PII, so an input-borne address is in it by design |
| **TC-CON-007** — 0 and 51 refused inline, 3 accepted and persisted                                 | **ok.** The value is moved to 12 first so "0 changed nothing" cannot pass by accident; 0 and 51 each show the contract's own sentence, set `aria-invalid`, and leave the engine's edge at 12; 3 commits, and survives a reload because it is the engine that holds it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **TC-PAR-006** — three iterations with distinct outputs                                            | **ok.** `[1, 2, 3]` comes from the engine's node runs, each row of the selector is visible and its preview differs from the others, and the Output section follows the picked iteration's own record                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **TC-MOB-002** — 380 px: the approval card usable, Approve continues                               | **ok, through the badge.** The Canvas-anchored card exists at 380 px but is positioned in _flow_ coordinates, so at phone width the node it belongs to is off to the right — that is what panning and Fit to view are for, not a defect. The path that must work at 380 px is the viewport-anchored one: the top bar's badge (`aria-label "1 approval waiting"`) opens the same card, it and both its buttons sit wholly inside 380 px, and Approve carries the node to COMPLETE                                                                                                                                                                                                                                                                                                                                                          |
| **Budget** — HALTED "budget exceeded: $x > $0.01 cap"                                              | **ok.** `budget-cap.project.json` is PATCHed onto the project and read back before the run; the run halts `budget_exceeded` with `budgetHalt.scope: 'run'` and `capUsd: 0.01`; the screen reads `budget exceeded: $… > $0.01 cap` and the next step names the project's max cost per run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

**§7.1's manual pass is not done.** Approve from a second tab while the first shows the card ·
pause/resume 20× fast · reload while WAITING · the policy editor with 30 checks · screen-reader
labels on the approval buttons. Only the last of those has any automated cover here (the card's
`aria-label` and both buttons' accessible names are asserted at 380 px). The other four are still to
walk, and the reload-while-WAITING one is the one to walk first: round 2's D-028 was exactly a reload
mid-run, and it was found by the demo walk because neither cross-test reloaded the page.

## Mouli → Arhant (A3)

Verdict: **NOT VERIFIED — four checks are still red** · Date 2026-09-26 ·
`tests/acceptance/round-3/mouli-tests-arhant.test.ts`, 39 checks over HTTP + WebSocket through
`@ace/sdk`, folding frames with the same `RunEventBuffer` the web app uses and parsing every response
with its own contract schema, so the seam itself is part of the assertion: **35 green, 4 red**.

That file was written from §2 and §7.2 before A3 existed — 36 of its 39 checks were red on the day it
landed, and those failures were the to-build list (D94, CLAUDE.md §6.3). Thirty-five of the thirty-nine
are green now. The four that are not:

| Red check                                                                                               | What it says                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-GRD-008/009 › `approve: the node continues and the decision is logged with its time`                 | `Error: timed out after 30000ms waiting for the approval request` — the run never raised one at `GET /runs/:id/approvals`                                                                                               |
| TC-GRD-008/009 › `reject: the node fails GUARDRAIL_VIOLATION, not CONTRACT_VIOLATION`                   | the same timeout, same cause                                                                                                                                                                                            |
| TC-PAR-002 › `runs its branches at once and merges them in input-port order`                            | `expected [ …3 items ] to have a length of 2` — the test counts branch node runs by `modelUsed.modelId` in `['mock-slow','mock-json']` and three node runs match, so the filter is picking up a node it did not mean to |
| TC-PAR-003 › `starts on the fast branch, and the slow branch still completes without feeding the merge` | `expected 'BLOCKED' to be 'COMPLETE'` — the run was refused at pre-flight                                                                                                                                               |

One observation that belongs to whoever fixes the first two, because a second suite is the only place
it could have come from: **the same approve-and-reject behaviour is green through the UI**. §7.1's
`TC-GRD-008` and `TC-GRD-009` drive the identical engine — `pii-ask.json` plus its
`pii-ask.policy.json` sidecar, the placeholder rewritten to the created policy's id — and the engine
raises the request, `GET /runs/:id/approvals` returns it, Approve carries the node to COMPLETE with
`approvals[0].decidedAt` set, and Reject fails it `GUARDRAIL_VIOLATION`. So the engine's approval path
works, and the §7.2 timeout is very likely in that suite's own setup rather than in A3. It is not
this report's job to fix it, and it is not fixed here.

The remaining two are the merge rows, and their history is worth keeping: `parallel-merge-*.json` had
already cost the round one fixture fix (`a40b386` — the Writer read `json` on a text-only model, so
pre-flight refused the whole graph). A `BLOCKED` run in TC-PAR-003 says a pre-flight refusal is still
there for the `any` variant.

**§7.2's manual pass is not done either**: the clean-clone `pnpm test`, SIGTERM while WAITING → run
HALTED `shutdown` → the approval endpoint answering 409 on restart, and 50 pause/resume calls in
parallel. The clean-clone part is partly covered — `pnpm test` below is green with zero env vars, but
in this worktree, not in a fresh clone.

## The two measured numbers the round gate asks for

**Stop latency (TC-CTL-003, budget 2 s): 24 ms.** Re-measured today rather than carried over:

```
$ npx vitest run --config tests/acceptance/vitest.config.ts -t "TC-CTL-003 stop closes the stream inside two seconds"
TC-CTL-003 last node.token arrived 24 ms after the stop call
      Tests  1 passed | 94 skipped (95)
```

**Guardrail overhead (TC-NFR-013, budget 300 ms/node): the committed suite prints `0.0 ms/node`, and
that figure is vacuous.** This is a finding, not a pass:

```
$ npx vitest run --config tests/acceptance/vitest.config.ts -t "TC-NFR-013 the rule packs cost less than 300 ms a node"
TC-NFR-013 guardrail overhead 0.0 ms/node (default policy 0.0 ms vs no checks 0.0 ms, 100 nodes each)
 ✓ … 8412ms
```

Both averages are 0.0 because the test averages `NodeRun.durationMs`, and **the engine never writes
it**. Every `durationMs` the engine computes is for a _run_
(`runs/index.ts`, `runs/lifecycle.ts`, `runs/control/service.ts`); the node-run finish path
(`runs/index.ts` ~line 656) writes `status`, `output`, `usage` and `endedAt` and no duration, and the
only node-run `durationMs` in the codebase is a literal `0`. The column exists in
`storage-local/src/schema.ts` and the field is optional in the contract, so nothing fails — the number
is simply `undefined` for every node run, `?? 0` turns it into zero, and `0 - 0 < 300` passes. The
assertion in that test cannot fail for any implementation.

A real figure, measured today through the same public API (two 100-node fan-outs against one temp
engine, default policy versus a policy with no checks, in a throwaway script that is not committed):

```
default policy: 100 agent node runs · mean span (endedAt-startedAt) 1339.19 ms · mean NodeRun.durationMs 0.00 ms · run.durationMs 7473 ms
empty policy  : 100 agent node runs · mean span (endedAt-startedAt)  879.07 ms · mean NodeRun.durationMs 0.00 ms · run.durationMs 4845 ms
TC-NFR-013 overhead from real spans: 460.12 ms/node (wall clock 26.28 ms/node)
```

The number to record is the wall-clock one: **26.3 ms/node**, against a 300 ms budget — the whole run
took 7473 ms with the default policy and 4845 ms without any checks, over 100 nodes. The per-node
span difference (460 ms) is **not** the overhead: at 20 concurrent node runs a node's own
`startedAt..endedAt` stretches with contention, so it measures the machine and not the rule packs.
The gate line "TC-NFR-013 figure recorded" is therefore recorded **here**, from a measurement outside
the suite, and cannot yet be read off CI — the committed test needs to derive its averages from
`endedAt - startedAt` (both are recorded) or the engine needs to write `NodeRun.durationMs`. The
second is the better fix: the inspector has a "duration" row for a node run and it shows `—` for
every node in every run today.

## `pnpm test` — the whole workspace, zero env vars

```
$ pnpm test
packages/contracts      728 passed (17 files)
packages/engine         800 passed (39 files)
packages/providers      226 passed | 3 todo (7 files)
packages/guardrails     169 passed (9 files)
packages/storage-local  148 passed (7 files)
apps/web                407 passed (51 files)
apps/server              48 passed (3 files)
packages/sdk             74 passed (6 files)
packages/ui              74 passed (5 files)
                      ───────────────────────
                       2674 passed | 3 todo
```

```
$ pnpm test:e2e            # apps/web Playwright against MSW
Running 82 tests using 1 worker
  28 passed | 54 failed (3.5m)    <- NOT a signal about M3; see the note below
```

That run is **void**, and the reason is worth keeping: `apps/web/playwright.config.ts` sets
`reuseExistingServer: !process.env['CI']`, so it attached to whatever was already listening on
127.0.0.1:5174 — another session's dev server, in another worktree — and every failure reads
`page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:5174/projects` once that server went
away. The test **count** (82) is real; the pass/fail from this worktree is not. Two concurrent
sessions on this repository will poison each other's `pnpm test:e2e`, which is worth knowing before
reading a red web e2e run as a defect.

## Findings

Round 3's two features were still on their branches while most of this was found, so by the
`docs/defect-log.md` rule ("bugs found while a feature is still on its own branch are just work in
progress") the first five below have no defect-log row: they are branch commits. The last four are new
in this session and **do** need rows — this session was allowed to write two files and
`docs/defect-log.md` is not one of them, so their ids are _proposed_, not appended.

| #   | Severity | Area                                       | Found by               | What                                                                                                                                                                                                                                                                                                                                                 | State                                                                            |
| --- | -------- | ------------------------------------------ | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | —        | the §7.2 cross-test itself                 | writing §7.2           | The suite rewrote round **2**'s placeholder (`01M3R2…PV`) instead of round 3's (`01M3R3…PV`), so every fixture agent pointed at a provider row that does not exist. Each run was BLOCKED at pre-flight with no node run to inspect, and **11 checks failed in about thirty milliseconds for one reason**. The cross-test's own bug, not the engine's | fixed `5738d0f`                                                                  |
| 2   | High     | A3 · `storage-local`                       | §7.2                   | The `runs` table had none of round 3's four control columns. The engine wrote `allowedActions`, `pausedAt`, `restartedFromRunId` and `budgetHalt`; storage dropped all four silently, so `allowedActions` never reached a client and FR-CTL-006 was unobservable from outside                                                                        | fixed `55c1c72`, recorded D170–D171 (`588c845`)                                  |
| 3   | High     | A3 · gateway                               | §7.2                   | `PATCH /projects/:id` read only `name`. The per-run cost cap could not be set **at all** through the API, so `budget-cap.project.json` was unusable and FR-GRD-008's run-scope cap was unreachable                                                                                                                                                   | fixed `e129b26`                                                                  |
| 4   | Medium   | A3 · fixtures                              | §7.2                   | `parallel-merge-*.json`'s Writer declared a `json` read on a text-only model, so pre-flight refused the whole graph before the scenario could run                                                                                                                                                                                                    | fixed `a40b386`; TC-PAR-003 still BLOCKED, so the `any` variant is not clear yet |
| 5   | High     | M3 · canvas                                | §7.1 (written last)    | A loop edge was **unreachable in the browser**: `isValidConnection` refused the backward drag while every component test for the loop editor passed. This is CLAUDE.md §6.3's example of why a green unit suite is evidence that the units work, not that the feature exists                                                                         | fixed on M3's branch                                                             |
| 6   | Low      | A2 · `apps/server`                         | R3 `pnpm test`         | D-030 — "answers POST /runs while the run is still going (D65)" asserts `< 1000 ms` and is timing-flaky when all packages run in parallel                                                                                                                                                                                                            | OPEN (logged on M3's branch)                                                     |
| 7   | Medium   | C3 · contract                              | R3 web e2e             | D-031 — an Agent's guardrail policy override cannot be cleared back to the project default: no `graph-ops` patch can remove a key from a node config, because `update_node` merges. Needs `AgentConfig.guardrailPolicyId` to accept `null`, as D72 did for the budget caps. Issue #21                                                                | OPEN (logged on M3's branch)                                                     |
| 8   | Medium   | A3 · `packages/engine`                     | **§7.1, this session** | `error.providerId` is never recorded, so FR-ERR-002's _provider_ cannot appear on an error card. `executor.ts` calls `classifyError(error)` with no context while `ClassifyContext.providerId` exists for precisely this — the chosen model's `providerId` is in scope on the line above. One line fixes it for every adapter                        | OPEN · proposed **D-032** · a `test.fail()` test guards it                       |
| 9   | Medium   | A3 · `packages/engine`                     | **this session**       | `NodeRun.durationMs` is never written. The column exists, the contract field exists and the inspector has a row for it — it shows `—` for every node in every run — and TC-NFR-013's figure, which averages that field, is `0.0 ms/node` for any implementation                                                                                      | OPEN · proposed **D-033**                                                        |
| 10  | Low      | tooling · `tests/acceptance/tsconfig.json` | **this session**       | `include` omits `round-2` and `round-3`, so neither round's cross-test is ever typechecked by `pnpm typecheck`. Two real type errors in the new §7.1 file were invisible to the workspace command                                                                                                                                                    | OPEN · proposed **D-034**                                                        |
| 11  | Low      | the §7.2 cross-test itself                 | **this session**       | `pnpm --filter @ace/acceptance exec eslint .` is red: three unused bindings in `round-3/mouli-tests-arhant.test.ts` (`PLACEHOLDER_PROJECT`, `peakOverlap`, `overlapMs`). Noted so it is not lost while that file is being worked on                                                                                                                  | OPEN                                                                             |

Of those, **four were the cross-test's own doing** in the useful sense — they exist only because
something drove the real thing end to end: #1 (the suite's own placeholder bug, which masked
everything behind it), #2, #3 and #4 were all found by §7.2 rather than by any unit suite, and #5 was
found by §7.1 precisely because it was written last and ran a browser. #8, #9 and #10 come from this
session's §7.1 work, and #9 is the one worth a second look: a passing test whose assertion cannot fail.

## What is not done — named plainly

- **§7.2 is red: four checks.** The two approval checks time out waiting for an approval request the
  engine does raise (§7.1 proves that path green through the UI, so the fault is very likely in that
  suite's setup); TC-PAR-002 counts three branch node runs where it expects two; TC-PAR-003's run is
  refused at pre-flight. Another session is on those four; they are not fixed here, and the A3 verdict
  is NOT VERIFIED until they are.
- **`pnpm test:acceptance` does not run its Playwright half.** The two commands are joined by `&&` and
  the Vitest half exits 1, so the e2e suite never starts under that script. The §7.1 numbers above come
  from running Playwright directly. The gate line "`pnpm test:acceptance` green for rounds 1–3" cannot
  be ticked.
- **`eslint .` on the acceptance package is red** (three unused bindings in the §7.2 file).
- **The typecheck gap is reported, not closed** — `tsconfig.json` is outside the two files this session
  could write.
- **The round 3 §1 demo script has not been walked against the real engine.** `apps/web/e2e/demo-round3.spec.ts`
  walks it against MSW, which is not the same thing; round 2 made that point expensively (D-028 was
  found by the real walk and by nothing else). CLAUDE.md §6.3 says this line is "walked once and
  recorded with what was seen" for one developer — it has not been walked.
- **Both manual passes are outstanding.** §7.1: approve from a second tab, pause/resume 20× fast,
  reload while WAITING, a policy editor with 30 checks (only the screen-reader labels have automated
  cover). §7.2: clean-clone `pnpm test`, SIGTERM while WAITING → `shutdown` → 409 on the approval
  endpoint after a restart, 50 parallel pause/resume calls.
- **Coverage was not re-measured** this session, so the 80 % / 60 % thresholds (NFR-MAIN-02) are
  unverified for round 3.
- **The two features are not on `main`, and not on one branch.** A3 is `round-3/arhant-control-guardrails-loops`
  and M3 is `round-3/mouli-control-guardrails-ui`; neither contains the other. The §7.1 suite needs
  both, so it was run with M3's `apps/web`, `packages/ui` and `packages/sdk` checked out into an A3
  worktree — a real engine and a real production build of the real UI, but an integration that exists
  nowhere in the history yet. **The 16 green tests should be re-run once both branches are merged**,
  and until then they are evidence about the seam rather than about `main`.
- **`docs/DECISIONS.md`, `docs/defect-log.md` and CLAUDE.md §9 are not updated** by this session:
  findings #8–#11 need defect-log rows (proposed D-032..D-034), and the §9 C3/A3/M3 rows and the §9.1
  round 3 row are still empty. Nothing is tagged.

---

## Round 3 gate — closed 2026-09-29 (single developer, §6.3)

Everything the section above listed as "not done" is resolved here, or recorded as what one developer cannot tick.

**All three features merged to `main` and cross-verified.** C3 `59ad530` (#20), A3 `aa6a6e2` (#25), M3 `1d08b6d` (#22). The tag `round-3` sits on the gate commit.

**Both cross-test files run green against integrated `main`** — no longer against a hand-assembled worktree seam:
- §7.2 `mouli-tests-arhant.test.ts` — **39/39** over HTTP + WS through `@ace/sdk` (real engine, temp DB, mock provider).
- §7.1 `arhant-tests-mouli.e2e.ts` — **16/16** in Playwright driving the real UI against the real engine and a production build. Re-run on `main` on 2026-09-29 (1.7 m); the "re-run once both branches are merged" caveat above is now discharged.

**Closing the gate found two defects in the merged work, both mine, both fixed on PR #27:**
- **D-036 (High, fixed):** A3's control/guardrail/approval wiring reached `apps/server` only through this acceptance suite, which runs *outside* the package, so `apps/server`'s own coverage fell to 55.4 % branches / 78.3 % functions and `main` went red on the *Coverage thresholds* CI step the moment M3 merged. Fixed by a `guardrailInputFor` unit block and a Round-3 server-wiring block (approve / reject / restart) → **95.3 stmts / 83.1 branches / 87.0 funcs**, exit 0. Not a lowered threshold (§7).
- **D-038 (Medium, fixed):** round 3 roughly doubled both the e2e and the acceptance suites, so the single `verify` job overran its 20-minute cap mid-acceptance with every test still passing — raised to 30.

**Also brought to `main` this session:** this §7.1 file and this REPORT (committed to A3's branch after the #25 merge point, so they had never reached `main`), and the D-034 typecheck-include fix (`round-2`/`round-3` were not being typechecked by `pnpm typecheck`; the `DOM` lib is declared for the `page.evaluate` bodies).

**Carried, none blocking:** D-037 (Low — `loops.spec.ts:153` flaky on `dragConnect` timing, 4/4 green isolated), D-031/#21 (an Agent's policy override cannot be cleared to the project default — needs `guardrailPolicyId` nullable in C4's follow-up, kept red by a `test.fail()`), D-030 (Low, Arhant's, flaky 1 s assertion).

**What a single developer cannot tick, and is not claimed (§6.3):** the §1 demo script walked by two people judging the screen together — every step is exercised by the automated demo/acceptance walk, but "by both" a suite cannot stand in for. §7.1's file was written by Mouli (D67), so it still wants a second reviewer's eye if one returns. The heavier manual passes (approve from a second tab, 20× fast pause/resume, reload while WAITING, a 30-check policy editor; clean-clone `pnpm test`, SIGTERM while WAITING) are covered in substance by the automated suites but were not walked by hand.
