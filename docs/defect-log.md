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
| D-001 | 1 | High | A1 engine skeleton / C1 contracts | Mouli | Arhant | `update_node` with a partial `config` patch resets every defaulted sibling field. `nodeConfigPatchSchema(kind)` is `AgentConfigSchema.partial()`, and Zod 4 still applies `.default()` to absent keys, so `parse({ contextPolicy: { budgetTokens: 8000 } })` returns `routing`, `execution`, `tools`, `knowledgeBaseIds`, `memory`, `skillIds` at their defaults; `packages/engine/src/graph/index.ts` (`case 'update_node'`) then spreads that over `current.config`, silently reverting e.g. `execution.temperature` to 0.7. Repro: `POST /workflows/:id/graph-ops` with `update_node { config: { execution: { temperature: 0.3, … } } }`, then `update_node { config: { contextPolicy: { budgetTokens: 8000 } } }` → `GET /workflows/:id` shows temperature 0.7. Expected per §2.6 (`Partial<NodeConfig>`, shallow): untouched keys keep their values. Workaround in M1: the config panel always sends the whole config. | FR-NODE-003, FR-WF-004, TC-NODE-002, R1 §2.6 | OPEN | | |
| D-002 | 1 | High | A1 engine skeleton | Arhant | Arhant | The engine never sends CORS headers, so no browser can reach it and the whole web app is dead against the real engine (every page shows "Could not reach the engine: Failed to fetch"). `createEngineApp` has `originGuard`, which decides whether a request may come *in*, but nothing emits `Access-Control-Allow-Origin`, which is what lets the browser hand the answer *back* to the page. Two independent failures: (1) a CORS preflight carries no `Authorization` header by spec, and `authGuard` is mounted on `*`, so every `OPTIONS` got 401 before reaching a route; (2) even an authorised 200 carried no allow-origin header, so the browser discarded a perfectly good response. Fixing either alone is not enough. Repro: `pnpm dev`, open the printed `?token=` URL — console shows `blocked by CORS policy` for `/api/v1/settings` and `/api/v1/projects`; `curl` hides it because it sends no `Origin` and does not enforce CORS. Note `settings.allowedOrigins` already contained `http://localhost:5173`, so the allow-list looked correct while the browser half was missing. Not caught by tests: `test:e2e` runs against MSW mocks with no engine, and the gateway tests drive Hono in-process via `app.request(...)`, so no real cross-origin call is ever made. Fixed by a `corsLayer` mounted ahead of `originGuard`, reading the same `settings.allowedOrigins` + `selfOrigins` so the two can never disagree. | FR-SYS-003, TC-SYS-004, R1 §2.7, §2.8 | OPEN | | |
