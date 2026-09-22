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
