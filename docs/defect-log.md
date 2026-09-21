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
| | | | | | | _no defects logged yet_ | | | | |
