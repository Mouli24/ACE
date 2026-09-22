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

Automated — `tests/acceptance/round-1/arhant-tests-mouli.e2e.ts`, 13 tests, all green, no retries:

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

Manual pass (§8.1 asks for ten minutes of abuse) — **partly done**, honestly recorded:

- done: the 200-node fixture (`?fixture=200`) pans and zooms at 56–58 fps, measured on every run by
  TC-NFR-001, which prints drag and wheel means; several interactive passes through the Canvas in a
  real browser while diagnosing the findings below, including fit-to-view, the minimap, selection,
  duplicate, delete and config-panel edits against the real engine.
- **not done**: pane resize to the minimum, a 3,000-character paste into Instructions, killing the
  engine mid-drag and verifying recovery, browser zoom at 50 % and 200 %. These are still open for
  whoever runs the manual pass; nothing here claims them as verified.

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

Manual pass (§8.2) — **partly done**, honestly recorded:

- done: `pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build` with no env vars,
  all green, in this working tree (not a fresh clone); atomicity of a mixed batch is covered
  automatically by TC-NFR-006.
- **not done**: a genuinely clean clone, `curl` from another device on the LAN, and `kill -9`
  during a burst of 200 graph-ops followed by a restart. Still open for the manual pass.

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
