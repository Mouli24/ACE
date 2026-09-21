# ACE — Defect Log

Every bug found **after a feature's PR merges** gets a row here — during cross-verification (`prompt.md` §3.6), while building a later feature, at a phase gate, or in Phase 14 testing.

Bugs found and fixed **inside your own session, before your PR merges**, do not go here. They go in that PR's Deliverable report under "Defects found in-session", with a failing test written first and a separate `fix(fNN):` commit.

---

## Rules

1. **The finder logs; the owner fixes.** The owner is whoever built the feature that introduced the bug — not whoever found it. The finder writes the row and moves on. Only exception: a genuine one-line fix in a file you already own in the current wave.
2. **Every fix ships a regression test**, named `TC-<MODULE>-R<nn>` (e.g. `TC-GRD-R01`), written to fail before the fix and pass after. The test ID goes in the row. A fix without a test will be re-broken.
3. **Fix branches:** `fix/d-0nn-<slug>`, e.g. `fix/d-007-redaction-value`. Reviewed like any other PR. Commit prefix `fix(d-007):`.
4. **Critical and high block the current wave from closing.** Medium and low may be deferred to Phase 14, but only by agreement from both developers, recorded in the row's Notes and in the `prompt.md` §9 handoff log.
5. **Judge against the FRS text**, not against intent or against the shipped tests. If the FRS is genuinely silent on the behaviour, it is not a defect — it is a `DECISION NEEDED`, and it goes to `DECISIONS.md` instead. If it turns out to be both, log both and cross-reference them.
6. **Append-only for rows.** Never delete one. Update Status, Fix commit and Notes as the defect moves; everything else stays as it was first written.
7. **Mirror open critical/high/medium defects** in `prompt.md` §6.1 so your partner sees them on `git pull`. Remove them from there when closed; they stay here forever.
8. **Pull → edit → commit → push inside one minute.** Commit message: `docs(defects): log D-007` / `docs(defects): close D-007`.

---

## Severity (FRS §8.5)

| Severity | Meaning | Example | Blocks wave? |
|---|---|---|---|
| **critical** | Data loss, security hole, or app unusable | Secret written to logs; path traversal escapes the project; engine reachable from the LAN | Yes |
| **high** | Main feature broken, no workaround | Runs never reach `COMPLETE`; retry creates no new attempt; approval card never appears | Yes |
| **medium** | Feature broken but a workaround exists | Undo misses one action type; filter ignores one message type | No — defer by agreement |
| **low** | Cosmetic or wording | Misaligned icon; truncated tooltip; unclear error text that still names the problem | No — defer by agreement |

When unsure between two levels, pick the higher one. Downgrading later is cheap; a missed critical is not.

---

## Status values

| Status | Meaning |
|---|---|
| `open` | Logged, not yet picked up |
| `in progress` | Owner is working on the fix branch |
| `in review` | Fix PR open; the **finder** reviews it |
| `fixed` | Fix merged, regression test green |
| `verified` | The **finder** re-tested it on a clean clone and confirms it's gone. Only now is the defect finished. |
| `deferred` | Medium/low, carried to Phase 14 by agreement — reason in Notes |
| `disputed` | Owner and finder disagree it's a defect; settle against the FRS text, or raise a DECISION NEEDED |
| `won't fix` | Agreed not a defect, or out of v1 scope — reason and decision ID in Notes |
| `duplicate` | Same root cause as another row — `duplicate of D-0nn` in Notes |

Lifecycle: `open → in progress → in review → fixed → verified`. The finder closes the loop, same as cross-verification — the builder never marks their own fix verified.

---

## Summary

Update the counts whenever a row changes status.

| | critical | high | medium | low | total |
|---|---|---|---|---|---|
| Open (open / in progress / in review / fixed) | 0 | 0 | 0 | 0 | 0 |
| Deferred to Phase 14 | 0 | 0 | 0 | 0 | 0 |
| Verified closed | 0 | 0 | 0 | 0 | 0 |

**Wave blocked right now?** No

---

## Defects

Newest at the bottom. IDs are sequential and never reused.

| ID | Sev | Feature | FR / TC violated | Summary | Found by (context) | Found | Owner | Status | Fix branch / commit | Regression test | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | | |

---

## Detail entries

One block per defect, same ID as the table row. The table is for scanning; this is for reproducing. Add the block when you log the defect, and fill in Root cause and Fix when it's fixed.

<!--
Copy this template for each new defect. Delete the example below when you log D-001.

### D-0nn — <one-line summary>

- **Severity:** critical | high | medium | low
- **Feature:** F<nn> <name>   **Owner:** <name>   **Found by:** <name>, while <verifying F<nn> / building F<nn> / phase gate / Phase 14>
- **Violates:** FR-XXX-nnn — "<the acceptance criterion, quoted from the FRS>"
- **Found on:** commit <sha>, <OS>, <browser if UI>

**Steps to reproduce**
1.
2.
3.

**Expected** (per the FRS):
**Actual:**
**Evidence:** test output, log excerpt, or screenshot path under docs/verification/

**Root cause** (owner fills in):
**Fix** (owner fills in): PR #__, commit ____, regression test TC-XXX-Rnn
**Verified** (finder fills in): <date>, clean clone at commit ____, <how re-tested>
-->

### Example — delete when logging D-001

### D-000 — Redaction verdict stores the redacted value

- **Severity:** critical
- **Feature:** F21 Guardrail engine   **Owner:** Arhant   **Found by:** Mouli, while verifying F21
- **Violates:** FR-GRD-014 — "Redaction records what type was removed, never the value"
- **Found on:** commit `a1b2c3d`, Windows 11

**Steps to reproduce**
1. Create a policy with the PII check set to `redact`.
2. Run a single agent node on the mock provider with input `contact me at test@example.com`.
3. Open the node run in the inspector, then query `guardrail_verdicts` for that node run.

**Expected:** inspector shows "email redacted"; the verdict row stores type `email` and no value.
**Actual:** inspector is correct, but the verdict row's `details` column contains `test@example.com`.
**Evidence:** `docs/verification/F21-verification.md` §Findings 1

**Root cause:** verdict builder spread the raw match object into `details`.
**Fix:** PR #41, commit `e4f5a6b`, regression test `TC-GRD-R01` asserts no verdict row contains the matched text for any redaction.
**Verified:** 2026-11-02, clean clone at `e4f5a6b`, re-ran steps 1–3 plus a DB grep for the email.

---

## Phase 14 exit check

FRS §8.4 requires **no open critical or high defects** at release. Before tagging `phase-14`, confirm and sign:

- [ ] Summary table shows 0 critical and 0 high in any status other than `verified`, `won't fix` or `duplicate`
- [ ] Every `deferred` row has an agreed reason and is either fixed or explicitly accepted into the v1 release notes
- [ ] Every `fixed` row has been moved to `verified` by its finder
- [ ] Every closed row has a regression test ID, and that test is in the coverage matrix

| Checked by | Date | Open critical | Open high | Deferred accepted into release |
|---|---|---|---|---|
| Mouli | | | | |
| Arhant | | | | |
