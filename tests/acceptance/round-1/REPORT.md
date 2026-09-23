# Round 1 verification report

Both suites run with `pnpm test:acceptance` (real engine on a temp database, mock provider, real
production web build) and stay in CI as regression.

```
$ pnpm test:acceptance
 Test Files  2 passed (2)          # helpers/harness.test.ts + round-1/mouli-tests-arhant.test.ts
      Tests  33 passed (33)
 Running 13 tests using 1 worker   # round-1/arhant-tests-mouli.e2e.ts
  13 passed (1.4m)
```

## Arhant → Mouli (M1)

Verdict: **VERIFIED** · Date 2026-09-23 · Commit tested `f1959e0` (branch `round-1/cross-tests`)

Automated — `tests/acceptance/round-1/arhant-tests-mouli.e2e.ts`, 13 tests, all green (NFR-USE-02 is
flaky and has needed its one retry — D-012):

| Scenario (§8.1)                                                                   | Result |
| --------------------------------------------------------------------------------- | ------ |
| TC-CAN-003 move a node, reload → same position from the server                    | ok     |
| TC-WF-004 add a node, reload → still present                                      | ok     |
| TC-WF-005 two browser contexts, stale one recovers, no lost node                  | ok     |
| TC-CON-002 text output → image-only input refused, reason visible                 | ok     |
| TC-CON-003 A→B then B→A refused, reason visible                                   | ok     |
| TC-CON-006 second edge into a `multi:false` port refused                          | ok     |
| TC-NODE-002 fill every Agent field, reload → every value persisted                | ok     |
| TC-NODE-006 temperature 5 → inline error, engine version unchanged                | ok     |
| TC-CAN-009 slow link → loading state, then the whole graph at once                | ok     |
| TC-CAN-004/005 delete → no dangling edges; duplicate → independent copy           | ok     |
| TC-PRJ-004 open project B, close the tab, reopen → project B                      | ok     |
| FR-WF-007/008 export from the UI → import → identical node/edge count and configs | ok     |
| NFR-USE-02 keyboard only: add, connect, delete                                    | ok     |

Manual pass (§8.1 asks for ten minutes of abuse) — **done**, and automated rather than described:

- done earlier: the 200-node fixture (`?fixture=200`) pans and zooms at 56–58 fps, measured on every
  run by TC-NFR-001, which prints drag and wheel means; several interactive passes through the
  Canvas in a real browser while diagnosing the findings below, including fit-to-view, the minimap,
  selection, duplicate, delete and config-panel edits against the real engine.
- done 2026-09-23, commit tested `126de3d`: the four items previously recorded here as **not done**
  are now `tests/acceptance/round-1/manual-pass.e2e.ts`, run with
  `pnpm test:manual-pass` — a real browser against a real engine and the production build. They are
  written down rather than performed once so the next person gets the same answer:

```
$ pnpm test:manual-pass
Running 5 tests using 1 worker
  ✓  1 §8.1 abuse — every pane dragged to its minimum, the Canvas stays usable (4.8s)
  ✓  2 §8.1 abuse — 3,000 characters pasted into Instructions reach the engine intact (1.5s)
  ✓  3 §8.1 abuse — the engine is killed mid-drag; the app recovers when it comes back (7.5s)
  ✓  4 §8.1 abuse — browser zoom at 50 % (1.6s)
  ✓  5 §8.1 abuse — browser zoom at 200 % (1.7s)
  5 passed (1.2m)
```

| §8.1 abuse item                     | What was actually driven                                                                                                                                        | Result                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Pane resize to the minimum          | Every `react-resizable-panels` handle dragged ±2000 px against both stops, three times each; the Canvas re-measured after every drag                            | ok — Canvas never returns to 0 px (the D-004 symptom), fit-to-view still works    |
| 3,000-character paste               | `keyboard.insertText` of exactly 3,000 characters into Instructions, then read back from `GET /workflows/:id`                                                    | ok — all 3,000 stored, no truncation, page survives a reload                      |
| Kill the engine mid-drag, restart   | `taskkill /F` with the mouse still down, the drag finished against a dead engine, then the engine restarted on the same data directory                           | ok — no white screen, `db:'ok'` on restart, graph intact, edits accepted again    |
| Browser zoom 50 % and 200 %         | `document.documentElement.style.zoom`, then Canvas measured, palette used to add a card, fit-to-view, horizontal-overflow probe                                  | ok at both — Canvas measurable, exactly one card added, no horizontal page scroll |

That third row found **D-009**: while the engine is down, or after it restarts with a fresh session
token, the workflow screen renders every failure as "Workflow not found.", including a 401. The
workflow is not gone, and the "Back to the project" link it offers fails the same way. Logged
against M1 in `docs/defect-log.md`; not fixed here (§6.2 — the tester does not fix the other's
code).

Findings, all fixed on this branch and re-verified:

| #   | What                                                                                                                                                                                 | Where                                                          | Severity |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | -------- |
| 1   | Nodes added from the palette stacked 12 px apart, so the card underneath had its ports covered and was unusable by mouse or keyboard                                                 | `apps/web/src/canvas/placement.ts` (new)                       | High     |
| 2   | The Canvas pane measured **0 px high** — a percentage height inside a flex-sized panel collapses — so fit-to-view, the minimap and viewport culling all worked from a zero-size area | `apps/web/src/workflows/WorkflowPage.tsx`, `canvas/Canvas.tsx` | High     |
| 3   | A duplicate landed 40 px over its original and covered it (FR-CAN-006 asks for an offset, not an overlap)                                                                            | `apps/web/src/canvas/duplicate.ts`                             | Medium   |
| 4   | A palette button handled `Enter` _and_ fired the native click, so a keyboard add created two nodes                                                                                   | `apps/web/src/canvas/Palette.tsx`                              | Medium   |
| 5   | Viewport culling left off-screen nodes unmeasured, so `fitView` could not bring them back                                                                                            | `apps/web/src/canvas/Canvas.tsx`                               | Medium   |

## Mouli → Arhant (A1)

Verdict: **VERIFIED** · Date 2026-09-23 · Commit tested `f1959e0`

Automated — `tests/acceptance/round-1/mouli-tests-arhant.test.ts`, 26 tests over HTTP and WebSocket
through `@ace/sdk`, all green:

| Scenario (§8.2)                                                                                                                                  | Result |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| TC-SYS-002 no token → 401 in the FR-SYS-006 shape; wrong token → 401; `/health` behind the token                                                 | ok     |
| TC-SYS-003 `Origin: https://evil.example` → 403 `forbidden_origin`; allow-listed origin passes                                                   | ok     |
| TC-SYS-004/005 `GET /health` → `{ status:'ok', version, db:'ok' }`                                                                               | ok     |
| TC-SYS-007 400, 401, 404, 409 all match `ApiError`                                                                                               | ok     |
| TC-WF-005 stale `baseVersion` → 409 with `details.currentVersion`, nothing applied                                                               | ok     |
| TC-WF-006 unconnected input + no Output node → issues with severity, code, message, nodeId                                                       | ok     |
| TC-WF-007 export validates against `WorkflowExport`, deep scan finds no key-shaped field                                                         | ok     |
| TC-WF-008 `formatVersion: 99` → 400 `unsupported_format_version`, no workflow created                                                            | ok     |
| TC-CON-003 plain edge closing a cycle → 400, version unchanged                                                                                   | ok     |
| TC-CON-005/006 fan-out to three inputs; second edge into a single input → 400                                                                    | ok     |
| TC-NODE-006 `execution.temperature: 5` → 400, nothing saved                                                                                      | ok     |
| TC-NFR-006 20 ops with op 15 invalid → 400, none applied, version unchanged                                                                      | ok     |
| FR-EXE-014 subscribe, disconnect, 10 edits, reconnect with `resume { afterSeq }` → exactly 10 `workflow.updated` frames, in order, no duplicates | ok     |
| FR-PRJ-003 unwritable folder → 400 `invalid_path` naming the path                                                                                | ok     |
| FR-SYS-007 the session token appears in no file under the data directory (bar `session-token` itself)                                            | ok     |
| D-001 regression: a patch touching one config field leaves its siblings alone                                                                    | ok     |
| D-002 regression: allow-origin header present, preflight answered without a token, foreign origin still 403                                      | ok     |

Manual pass (§8.2) — **done** 2026-09-23, commit tested `126de3d`:

**1. Clean clone.** `git clone` of `main` into an empty directory, then
`pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build` with no `ACE_*` or
`VITE_ACE_*` variable set. Every step exit 0; 701 unit tests pass (contracts 276 · web 127 ·
engine 128 · storage 68 · server 40 · ui 39 · sdk 23).

**2. `curl` from another device on the LAN → refused.** The engine binds `127.0.0.1` and only
`127.0.0.1` (`BIND_HOST` in `apps/server/src/server.ts`), so a LAN device is refused at the socket,
before auth. Verified against this machine's own LAN addresses, which is what another device would
dial:

```
$ netstat -ano | grep :47490
  TCP    127.0.0.1:47490    0.0.0.0:0    LISTENING    21920      # not 0.0.0.0, not the LAN address

$ curl -H "Authorization: Bearer $TOKEN" http://10.20.17.211:47490/api/v1/health
curl: (7) Failed to connect to 10.20.17.211:47490 after 2042 ms: Could not connect to server
$ curl http://192.168.56.1:47490/api/v1/health
curl: (7) Failed to connect to 192.168.56.1:47490 after 2034 ms: Could not connect to server

$ curl -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" http://127.0.0.1:47490/api/v1/health
200
$ curl http://127.0.0.1:47490/api/v1/health
{"error":{"kind":"auth","code":"unauthorized","message":"A valid session token is required.","retryable":false}}
$ curl -H "Authorization: Bearer $TOKEN" -H "Origin: https://evil.example" http://127.0.0.1:47490/api/v1/projects
{"error":{"kind":"auth","code":"forbidden_origin","message":"Origin \"https://evil.example\" is not on the allow-list.","details":{"origin":"https://evil.example"},"retryable":false}}
```

Stated precisely, because it is the one item not run from a second machine: what is verified is that
the listener is not on any LAN interface, so no device on the network can open a socket to it. A
second physical device would add only the confirmation that nothing else on this host re-exposes the
port.

**3. `kill -9` during a burst of 200 graph-ops → restart.** `tests/acceptance/helpers/crash-check.ts`
(`taskkill /F` is Windows' SIGKILL: immediate, no flush, no shutdown hook). Each batch is three ops
— `add_node`, `add_node`, `add_edge` — so the invariants below can only hold if a batch landed whole
or not at all:

```
[phase-1] engine up  pid=17496  http://127.0.0.1:47491
[phase-1] SIGKILL (taskkill /F) at confirmed version 60, mid-burst
[phase-1] client stopped: fetch failed at op 76
[phase-1] last version the client saw confirmed: 76
[phase-2] ace.sqlite on disk: 225280 bytes
[phase-2] GET /health -> {"status":"ok","version":"0.1.0","db":"ok"}

version 76 · nodes 152 (= 2 x version) · edges 76 (= version) · dangling edges 0

PASS  DB reopened after SIGKILL
PASS  batches are whole: nodes === 2 x version
PASS  batches are whole: edges === version
PASS  no dangling edge endpoints
PASS  no committed work lost (version >= client-confirmed)
PASS  no phantom commits (version <= client-confirmed + 1 in-flight)
PASS  the recovered graph still accepts writes (HTTP 200)
```

Atomicity of a mixed batch on the happy path stays covered automatically by TC-NFR-006.

Findings:

| #   | What                                                                                                                                                                                                                                 | Where                                                | Severity                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | ----------------------------- |
| 1   | An op naming a node, edge or port the workflow does not have answered **404 `not_found`**; §2.6 says any invalid op is a 400 `validation_failed`, and a 404 on `graph-ops` is indistinguishable from "this workflow is gone"         | `packages/engine/src/graph/index.ts`                 | Medium — fixed on this branch |
| 2   | The acceptance harness never allowed the preview origin `http://127.0.0.1:47471` (D27), so every request from the page would have been a 403; `vite preview` also binds `::1` only, so Playwright's `127.0.0.1` poll never connected | `tests/acceptance/helpers/*`, `playwright.config.ts` | High — fixed on this branch   |

Defects D-001 and D-002 were re-tested after Arhant's fixes and are closed in `docs/defect-log.md`;
both now have a permanent regression test in the suite above.

> Note on ownership: `CLAUDE.md` §3.4 assigns `tests/acceptance/round-1/arhant-tests-mouli.e2e.ts`,
> the harness and `packages/engine` to Arhant, and §6.2 says the tester never fixes the other's
> code. Mouli wrote and fixed them here on a one-off instruction from the repository owner to close
> the Round 1 gate; Arhant should still review this branch, and the normal split resumes in Round 2.

## Arhant's review of PR #9 (2026-09-23)

D32 asked for this: PR #9 crossed the ownership map, so Arhant reviews it as a PR against his own
paths. The two fixes in it are right — D-007 (`unknownRef`, 400 `validation_failed` instead of 404)
matches §2.6 and D28, and the harness fix for D-008 (preview origin through `PATCH /settings`,
`vite preview --host 127.0.0.1`) configures the engine the way a user would rather than reaching
into its database. Three things came out of the review:

| #   | What                                                                                                                                                                                                                                                                | Where                                    | Severity                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------- |
| 1   | **`pnpm test:acceptance` could not fail on an e2e failure.** `\|\|` in `test:acceptance:e2e` bound to the whole `&&` chain, so a real Playwright failure printed "SKIPPED: apps/web does not exist yet" and exited 0. "Cross-tests green" was never an enforced signal | `package.json`                           | **High** — D-011, fixed here       |
| 2   | `packages/engine/src/graph/index.ts` came back reformatted to Prettier's defaults, the only file of 31 under `packages/engine/src` not in the shared style; the root has no Prettier config, so `format:check` calls the drifted file correct                        | `packages/engine/src/graph/index.ts`     | Low — D-010, fixed here            |
| 3   | `NFR-USE-02` (keyboard-only add/connect/delete) failed once and passed on retry #1 in the `main` run; `retries: 1` arrived in PR #9, so the suite still reports green                                                                                                | `arhant-tests-mouli.e2e.ts`              | Low — D-012, open, does not block  |

Finding 1 was verified the way it should be — a deliberately broken selector, `pnpm test:acceptance:e2e`
→ `10 failed, 3 passed`, **exit 1** (before the fix the same run exits 0); selector restored,
`pnpm test:acceptance` → 33 passed + 13 passed, exit 0.

Because of finding 3, the "no retries" in the run at the top of this report is true of that run, not
of every run.

Not in scope here, but it will bite the next merge: `docs/DECISIONS.md` uses **D30, D31 and D32 for
different decisions** on `main` and on `round-2/contracts` — ids are allocated per branch with
nothing to serialise them. D42 records the resolution (`main` keeps its numbers, the round 2 block
renumbers from D43 when it rebases).

## Decisions recorded from this verification (`docs/DECISIONS.md`)

| ID  | What                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------- |
| D28 | An op naming an unknown node, edge or port is a 400 `validation_failed`, not a 404                                   |
| D29 | The acceptance harness allows the preview origin through `PATCH /settings`, and pins `vite preview --host 127.0.0.1` |
| D30 | Viewport-only rendering is off — a deviation from §5 item 6, with the A/B measurement that justifies it              |
| D31 | New and duplicated nodes go to the first free slot in view, not to a fixed offset                                    |
| D32 | Why this branch crosses the ownership map, and that it is not a precedent                                            |
| D41 | The §8 manual passes are automated (`pnpm test:manual-pass`), not narrated; clean clone and LAN curl stay manual    |
| D42 | Decision ids D30-D32 collide between `main` and `round-2/contracts`; `main` keeps them, round 2 renumbers from D43  |
