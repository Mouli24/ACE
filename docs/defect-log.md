# ACE — Defect Log

Every bug found **after a feature merges** — in partner cross-testing (CLAUDE.md §6.2), in a later
round, or in use. Bugs found while a feature is still on its own branch are just work in progress
and do not belong here.

**Rules (CLAUDE.md §3.3, §6.2)**

- Append rows; never edit someone else's row.
- The **tester files** the defect; the **owner of the feature fixes it**. The tester never fixes the
  other person's code — they re-run their test after the fix lands and set the row to `CLOSED`.
- Fixes go on `round-N/fix-<owner>-<n>` and reference the defect id in the commit message.
- **Critical and high block the round.** Medium and low may be carried into the next round with a
  note in that round's `REPORT.md`.
- Ids are sequential across the whole build: `D-001`, `D-002`, … (not per round).

## Severity (FRS §8.5)

| Severity | Meaning | Example |
|---|---|---|
| Critical | Data loss, security hole, app unusable | Secret written to logs |
| High | Main feature broken, no workaround | Runs never complete |
| Medium | Feature broken with workaround | Undo misses one action type |
| Low | Cosmetic | Misaligned icon |

## Defects

| ID | Round | Severity | Feature | Found by | Owner | Description | FR / TC | Status | Fix SHA | Date closed |
|---|---|---|---|---|---|---|---|---|---|---|
| D-001 | 1 | High | A1 engine skeleton / C1 contracts | Mouli | Arhant | `update_node` with a partial `config` patch resets every defaulted sibling field. `nodeConfigPatchSchema(kind)` is `AgentConfigSchema.partial()`, and Zod 4 still applies `.default()` to absent keys, so `parse({ contextPolicy: { budgetTokens: 8000 } })` returns `routing`, `execution`, `tools`, `knowledgeBaseIds`, `memory`, `skillIds` at their defaults; `packages/engine/src/graph/index.ts` (`case 'update_node'`) then spreads that over `current.config`, silently reverting e.g. `execution.temperature` to 0.7. Repro: `POST /workflows/:id/graph-ops` with `update_node { config: { execution: { temperature: 0.3, … } } }`, then `update_node { config: { contextPolicy: { budgetTokens: 8000 } } }` → `GET /workflows/:id` shows temperature 0.7. Expected per §2.6 (`Partial<NodeConfig>`, shallow): untouched keys keep their values. Workaround in M1: the config panel always sends the whole config. | FR-NODE-003, FR-WF-004, TC-NODE-002, R1 §2.6 | CLOSED | 3c610e5 | 2026-09-23 | Fix: the per-kind patch schema is now derived from the config schema by stripping `.default()` and making every key optional, so a patch carries only what it was given; the request-level union is fixed the same way, since the engine parses its output. `graph/index.ts` was already doing the shallow merge §2.6 asks for and is unchanged. Shallow still means shallow: a patch that names `execution` replaces that whole object. Mouli — the M1 workaround (always send the whole config) can go, and a partial top-level patch is now safe. |
| D-002 | 1 | High | A1 engine skeleton | Arhant | Arhant | The engine never sends CORS headers, so no browser can reach it and the whole web app is dead against the real engine (every page shows "Could not reach the engine: Failed to fetch"). `createEngineApp` has `originGuard`, which decides whether a request may come *in*, but nothing emits `Access-Control-Allow-Origin`, which is what lets the browser hand the answer *back* to the page. Two independent failures: (1) a CORS preflight carries no `Authorization` header by spec, and `authGuard` is mounted on `*`, so every `OPTIONS` got 401 before reaching a route; (2) even an authorised 200 carried no allow-origin header, so the browser discarded a perfectly good response. Fixing either alone is not enough. Repro: `pnpm dev`, open the printed `?token=` URL — console shows `blocked by CORS policy` for `/api/v1/settings` and `/api/v1/projects`; `curl` hides it because it sends no `Origin` and does not enforce CORS. Note `settings.allowedOrigins` already contained `http://localhost:5173`, so the allow-list looked correct while the browser half was missing. Not caught by tests: `test:e2e` runs against MSW mocks with no engine, and the gateway tests drive Hono in-process via `app.request(...)`, so no real cross-origin call is ever made. Fixed by a `corsLayer` mounted ahead of `originGuard`, reading the same `settings.allowedOrigins` + `selfOrigins` so the two can never disagree. | FR-SYS-003, TC-SYS-004, R1 §2.7, §2.8 | CLOSED | 3b7ae50 | 2026-09-23 |
| D-003 | 1 | High | M1 web shell / Canvas | Arhant (cross-test §8.1) | Mouli | Nodes added from the palette stacked 12 px apart (`jitter = nodes.length * 12`), so the card underneath had its ports covered and could not be connected by mouse or keyboard. Repro: open a workflow, click Input then Agent in the palette, try to drag from the Input's `text` output — the handle is behind the Agent card. Fixed by placing each new node in the first free slot of the visible area (`apps/web/src/canvas/placement.ts`) | FR-CAN-002, NFR-USE-01, TC-CON-001 | CLOSED | f1959e0 | 2026-09-23 |
| D-004 | 1 | High | M1 web shell / Canvas | Arhant (cross-test §8.1) | Mouli | The Canvas pane measured 0 px high: `h-full` (a percentage height) inside a flex-sized `react-resizable-panels` panel collapses, so fit-to-view, the minimap and viewport culling all operated on a zero-size area and the Fit control was unclickable. Repro: open a workflow, read `document.querySelector('[data-testid=canvas]').getBoundingClientRect().height` → 0. Fixed by filling the pane absolutely inside a positioned panel | FR-CAN-007, FR-CAN-001, NFR-USE-01 | CLOSED | f1959e0 | 2026-09-23 |
| D-005 | 1 | Medium | M1 web shell / Canvas | Arhant (cross-test §8.1) | Mouli | A duplicated node landed 40 px over its original and covered it; FR-CAN-006 asks for an offset copy, not one that hides the source. Fixed by placing copies in the first free slot | FR-CAN-006, TC-CAN-005 | CLOSED | f1959e0 | 2026-09-23 |
| D-006 | 1 | Medium | M1 web shell / Canvas | Arhant (cross-test §8.1) | Mouli | A palette button handled `Enter` itself *and* fired the native button click, so a keyboard add created two nodes. Fixed by leaving activation to the native button | NFR-USE-02 | CLOSED | f1959e0 | 2026-09-23 |
| D-007 | 1 | Medium | A1 engine skeleton | Mouli (cross-test §8.2) | Arhant | A graph op naming a node, edge or port the workflow does not have answered 404 `not_found`; §2.6 says any invalid op is 400 `validation_failed`, and a 404 on `graph-ops` cannot be told apart from "this workflow is gone", which tells a client to stop retrying. Repro: `POST /workflows/:id/graph-ops` with `move_node` for an unknown nodeId → 404. Fixed in `packages/engine/src/graph/index.ts` | R1 §2.6, TC-NFR-006 | CLOSED | f1959e0 | 2026-09-23 |
| D-008 | 1 | High | A1 acceptance harness | Mouli (cross-test §8.2) | Arhant | The harness never allowed the web preview origin `http://127.0.0.1:47471` (D27), so every request from the page under Playwright would have been 403 with no allow-origin header; additionally `vite preview` binds `::1` only, so Playwright's `127.0.0.1` poll never connected and the suite could not start. Fixed by adding the preview origin through `PATCH /settings` at start-up and pinning `--host 127.0.0.1` | FR-SYS-003, D27, §8.1 | CLOSED | f1959e0 | 2026-09-23 |
