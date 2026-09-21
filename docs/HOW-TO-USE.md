# ACE — How to use the prompt pack

A working guide for **Mouli** and **Arhant**. `docs/prompt.md` is *what* to build and in what order. This file is *how to actually run it* without wasting sessions or standing on each other's feet.

Read it once each, fully, before Wave 1. Then keep §10 open while you work.

---

## 1. The mental model

Four kinds of document, and they are not equal:

| Document | Authority | Who changes it |
|---|---|---|
| `ACE-PRD.md`, `ACE-FRS.md`, `ARCHITECTURE.md` | **Source of truth.** If code disagrees with these, the code is wrong. | Nobody, mid-build. A change here needs a DECISION first. |
| `DECISIONS.md` | The **amendment log** to the three above. Append-only. Survives `/clear`. | Both, one row at a time. |
| `prompt.md` | The **plan**: what to build, who builds it, in what order, and the live status board. | Both, status rows only. |
| `defect-log.md` | What broke, who owns the fix, is it fixed. | Both. |

Claude has no memory between sessions. `DECISIONS.md` and `prompt.md` **are** its memory. If something isn't written in one of them, it did not happen — the next session will happily contradict it.

The single most important consequence: **never resolve an ambiguity verbally.** If you answer a question in chat and don't append it to `DECISIONS.md`, you will answer the same question differently in three weeks and won't notice.

---

## 2. Your day, step by step

### Start of the day (every day, both of you)

```bash
git checkout main && git pull --ff-only origin main
pnpm install
pnpm typecheck && pnpm test
```

Then open `docs/prompt.md` §6 and read: your partner's rows, the open-defect table, and §9's last handoff paragraph. That's your standup — you should never have to ask "what did you do yesterday".

### Picking your feature

Take the first `TODO` row in your column whose `Depends on` are all `MERGED` **and** whose wave is the current wave. Flip it to `IN PROGRESS`, push that one-line commit, then branch.

Do not start the next wave early, even if you're idle. Being idle is the correct state while you wait — use it to review, or to do the wave's chores. Starting early is how you spend an afternoon resolving a rebase.

### The session itself

One feature, one fresh session:

1. `/clear`
2. `claude --permission-mode plan` (or Shift+Tab until it says plan mode)
3. Paste §5.1 preamble from `prompt.md`, then the feature's **Prompt** block verbatim
4. Read the plan properly (§3 below), approve or push back
5. Let it implement, watching the Bash prompts
6. Verify the **Done when** gate yourself
7. Finish ritual, PR, status row

### After merge

Flip the row to `MERGED` with the SHA. If you're the second of the wave to merge, you own the wave chores: run the phase gate if the wave closes a phase, tag it, write the §9 handoff paragraph.

### Then verify your partner's feature — before you build anything else

This is a hard gate (`prompt.md` §3.6), not a nicety. The builder is the worst tester of their own work: they know which paths they exercised and unconsciously skip the ones they didn't. So Mouli verifies every Arhant feature and Arhant verifies every Mouli feature, and the wave only closes when both rows read `VERIFIED`.

Fresh session, paste `prompt.md` §5.3, then do the manual half yourself:

- **Clean clone** into a new folder — not your working copy. `pnpm install && pnpm typecheck && pnpm lint && pnpm test`. This catches missing files, unlisted dependencies and "works on my machine".
- **Reproduce the `Done when` gate** literally, including opening the UI where it says to. You're not re-reading his report.
- **Prove the tests bite.** Take the two most important, comment out a line of implementation, confirm red, restore.
- **Judge against the FRS text**, not against his tests. Tests get narrowed to match an implementation; acceptance criteria don't.
- **Ten minutes of deliberate abuse** — empty input, huge input, wrong type, cancel halfway, reload at the worst moment, two operations at once.
- **Exercise the seam.** If his feature published an interface you'll depend on, write a throwaway consumer now, not when you're mid-feature and blocked.

Outcome is one of two, always written down: set the row to `VERIFIED` with `verified by <name>, <date>`, or log every finding in `defect-log.md`, leave the row `MERGED — verification failed`, and tell him. **He fixes it**, you re-verify. Critical and high block the wave; medium and low can be carried to Phase 14 by agreement, recorded in the handoff log.

Budget 30–45 minutes. Longer for F15/F16, F21/F22, F34/F36. If it's eating half a session, that's a finding in itself — say so.

---

## 3. Reading the plan before you approve

This is the highest-leverage two minutes in the whole workflow. A bad plan approved costs you the session; a bad plan caught costs you thirty seconds.

**Approve only if all of these hold:**

- The **FR/TC coverage table is complete** — every FR ID listed in the feature block appears, with its TC IDs and the test file each will live in. Missing rows mean it will quietly skip them.
- **Nothing from a later feature appears.** Grep the plan for module names that belong to a later block. This is the most common failure.
- The tests are named by **TC ID**, not by prose description.
- The files it intends to create are **all inside the `I own` list**. One stray path is a red flag for the whole plan.
- It says what it will do about the **seam** — using your partner's interface, not rebuilding it.
- If the docs are ambiguous, it posted a **DECISION NEEDED** instead of picking. If a feature has a known open OI (they're listed in FRS §11) and the plan didn't mention it, ask why.

**Push back like this, not vaguely:**

> The plan skips FR-GRD-014 and TC-GRD-018. Add them to the coverage table and tell me which test file covers the "redaction records type, never value" case before we proceed.

> `packages/guardrails/**` is not in my I-own list for this feature — that's F21, Arhant's. Redo the plan using the registerCheck API instead of editing the engine.

Vague pushback ("this doesn't look right") gets you a reshuffled plan with the same holes.

---

## 4. Writing and adapting prompts

The blocks in `prompt.md` are complete. You will still need to add to them mid-session. Rules for that:

**Do add:**
- Concrete constraints that came from a DECISION: *"D19 says Transform node ships template and JSON-extract only — drop join."*
- Corrections when Claude misreads a spec section: quote the FR ID and the line.
- The interface signature your partner published, pasted verbatim, when the seam feature isn't merged yet.

**Never add:**
- "Also while you're in there, could you…" — that's scope creep and it's how a feature branch grows into a conflict.
- A fix for something you noticed in another feature's code. Log it as a defect instead.
- "Skip the tests for now, we'll add them later." You will not.

**Principles that make prompts land:**

1. **Name the FR ID, always.** "Make the error clearer" gets you a rewrite. "FR-ERR-002 requires the error view to show provider and state; it shows neither" gets you the fix.
2. **State the negative.** What it must *not* do is more useful than what it must. "Do not implement the loop scheduler — that's F24" saves more than any positive instruction.
3. **Give it the failing case.** "TC-EXE-006: upstream output 50k tokens, budget 4k, envelope must be ≤4k" is a spec. "Handle large inputs" is a wish.
4. **One question at a time.** Batched questions get batched, shallow answers.
5. **Ask for evidence, not summaries.** "Paste the real `pnpm test` output" — a transcript saying "all 47 tests pass" is not evidence, and it is sometimes wrong.

---

## 5. Red flags — stop the session when you see these

| Signal | What's happening | What to say |
|---|---|---|
| A new folder for a module you don't recognise | Drift into a later feature | "Stop. That belongs to F<n>. `git diff`, remove it, continue with this feature only." |
| A test that passes on the first run, before the code exists | It wrote a test that asserts nothing | "That test passes without the implementation. Make it fail first, show me the failure, then implement." |
| `COMPLETE` on a node, or `Completed` on a run | Enum drift | "Node states are COMPLETED; run states are COMPLETE. Import from packages/contracts, don't write literals." |
| A test needing an env var or a key | Paid/real dependency creeping into CI | "`pnpm test` must pass with zero env vars. Move it to test:providers and cover the behaviour with the mock." |
| It "decided" something the docs don't cover | It guessed | "Revert that. Post a DECISION NEEDED block instead." |
| It edits a barrel `index.ts` | Ownership map is wrong, or it's drifting | Check `FILE-OWNERSHIP.md`. Usually it's drifting. |
| Long silence then a huge diff | It batched work without checkpoints | Ask for the diff broken into the commits it should have made, and review each. |
| "I've simplified this for now" | Requirement silently narrowed | "Which FR did that narrow? Either implement it fully or post a DECISION NEEDED naming the FR ID." |

The last one is the subtle one. Silent narrowing is the main way a spec-driven build rots — it passes review because the tests were narrowed to match.

---

## 6. Reviewing your partner's PR

Two distinct checks, easy to confuse: **review** is before merge — fast, diff-focused, twenty minutes, hunting scope drift and obvious defects. **Verification** (§2, `prompt.md` §3.6) is after merge — clean clone, real gate, adversarial cases, judged against the FRS. Passing review doesn't make a feature `VERIFIED`, and a feature that fails verification goes to the defect log rather than being un-merged.

This section is the review. You are not being polite here — the alternating order exists precisely so that nothing merges unread.

Twenty minutes, in this order:

1. **Coverage table** in the Deliverable report — every FR present, nothing from later features.
2. **Run it locally.** Check out the branch, `pnpm install && pnpm typecheck && pnpm lint && pnpm test`. If it doesn't pass on your machine, it doesn't pass.
3. **`git diff --stat`** against the `I own` list. Anything outside is a conversation, not a merge.
4. **Grep checks** (30 seconds):
   ```bash
   rg '"Completed"|"complete"|"Halted"|"HALT"' --glob '!packages/contracts/**'
   rg 'from "(fs|path|os)"|node:' apps/web/src
   rg 'window\.|document\.' packages/engine/src
   ```
5. **One adversarial pass** in a fresh Claude session — the prompt is in `prompt.md` §8.7. Worth it on any feature touching the engine, guardrails or execution.
6. **Read two tests properly.** Pick the two that matter most and check they'd actually fail if the behaviour broke. Comment out a line of implementation and see.

Approve, or leave specific comments with FR IDs. "Looks good" on a 2,000-line diff means you didn't read it, and the phase gate will find out for both of you.

---

## 7. Bugs — where they get tracked

`docs/defect-log.md` is created in F00 and exists from day one. Every defect found after a feature merges — most of them will come out of verification — gets a row:

```
| ID | Severity | Feature | FR / TC | What's wrong | Found by | Owner | Branch | Status |
| D-007 | high | F21 | FR-GRD-014 / TC-GRD-018 | redaction verdict stores the value | Arhant (in F30) | Arhant | fix/d-007 | open |
```

Three rules:

1. **The owner of the feature that introduced the bug fixes it** — not whoever found it. The finder logs it and carries on. Exception: a one-liner in a file you already own in the current wave.
2. **Every fix ships a regression test**, named `TC-<MODULE>-R<nn>`, added to the coverage matrix. A fix without a test will be re-broken.
3. **Critical and high block the wave from closing.** Medium and low can ride to Phase 14.

Bugs you find and fix *inside* your own session, before the PR merges, don't need a log row — but they do need a failing test first, a separate `fix(f16):` commit, and a "defects found in-session" line in the Deliverable report so the reviewer knows to look.

Severity scale is FRS §8.5: critical = data loss or security hole; high = main feature broken with no workaround; medium = workaround exists; low = cosmetic.

---

## 8. Who tells whom what — the four channels

Use the right one. Anything said only in a chat message is lost.

| Channel | For | Cadence |
|---|---|---|
| `prompt.md` §6 Status Board | Feature status, defect list. **This is the "he needs to know" channel.** | Immediately on any status change |
| `prompt.md` §9 Handoff log | Wave closures, split sessions, anything the other must know before pulling | End of each wave, or when you split a feature across sessions |
| `DECISIONS.md` | Every answered DECISION NEEDED, every spec amendment | Same session as the decision, always |
| PR description | Published interface signatures, coverage table, the Deliverable report | Per PR |
| Chat / call | Everything else — and then write the outcome into one of the four above | As needed |

**The interface-publishing habit** is worth calling out. When your feature declares a seam interface (F03's ports, F06's EventBus, F11's ProviderAdapter, F15's NodeExecutor, F21's registerCheck, F34's sandbox), push it in your **first commit** and paste the signatures in the PR description immediately. Your partner then codes against it with a fake while you're still implementing. Without that, half of each wave is spent waiting.

---

## 9. Mistakes that will cost you a day

Ranked by how likely they are to actually happen:

1. **Starting the next wave before both PRs merge and both are verified.** Every real conflict in a two-person repo comes from here, and an unverified feature becomes four features' worth of debugging later.
2. **Fixing a bug in your partner's file because it's faster.** It isn't — you'll conflict, and he'll re-break it not knowing.
3. **Running two features in one session.** Context bleeds, the second feature inherits the first's assumptions, and neither Deliverable report is trustworthy.
4. **Approving a plan without checking the coverage table.** Costs the whole session.
5. **Answering a DECISION NEEDED in chat and not appending it.** Costs you the same argument twice, weeks apart.
6. **Letting a test require a key.** It'll pass locally for one of you and break CI forever.
7. **`git merge main` into a feature branch instead of rebasing.** Makes the history unreadable and the rebase-and-merge impossible.
8. **Editing a barrel `index.ts`.** F00 pre-wired them precisely so you never have to.
9. **Accepting "all tests pass" from the transcript.** Run it yourself. Every time.
10. **Skipping the handoff paragraph** when a session runs long and you split it. The resumed session then rebuilds what's already there.

---

## 10. Quick reference — keep this open

**Start a feature**
```bash
git checkout main && git pull --ff-only origin main
pnpm install && pnpm typecheck && pnpm test
git checkout -b feat/f16-node-executor
```

**During**
```bash
git fetch origin && git rebase origin/main     # never `git merge main`
pnpm typecheck && pnpm lint && pnpm test
git push --force-with-lease
```

**Finish**
```bash
git fetch origin && git rebase origin/main
pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e
git push --force-with-lease
gh pr create --title "feat(f16): node executor and envelope engine"
```

**Status row (only direct push to main)**
```bash
git checkout main && git pull --ff-only origin main
# edit the one row in docs/prompt.md
git commit -am "docs(prompt): F16 merged" && git push origin main
```

**Phase gate (second merger of the wave that closes a phase)**
```bash
git checkout main && git pull --ff-only origin main
pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e
git tag phase-5 && git push origin phase-5
```

**Session open**
```
/clear → claude --permission-mode plan → paste prompt.md §5.1 preamble → paste feature Prompt block
```

**Enum cheat sheet** (literals live once, in `packages/contracts`)
- Node: `IDLE READY RUNNING WAITING COMPLETED PAUSED STOPPED BLOCKED FAILED`
- Run: `PREFLIGHT RUNNING PAUSED COMPLETE BLOCKED HALTED`
- Failure: `RUN_FAILED CONTRACT_VIOLATION GUARDRAIL_VIOLATION BLOCKED`
- Provider: `UNKNOWN CHECKING CONNECTED AUTH_FAILED UNREACHABLE RATE_LIMITED`
- Error kinds: `user_cancelled agent provider auth network invalid_config workflow guardrail`

**The five non-negotiables**
1. `pnpm test` passes with zero environment variables and no paid service.
2. Only files in your `I own` list.
3. Never guess — DECISION NEEDED, then `DECISIONS.md`.
4. You verify your partner's feature before you start your next one.
5. Both wave features merge **and** read `VERIFIED` before either of you moves on.

---

## 11. If something goes wrong

| Situation | Do this |
|---|---|
| `git pull --ff-only` fails on main | You committed to main. `git branch backup-$(date +%s)`, `git reset --hard origin/main`, cherry-pick onto a feature branch. |
| Session context is full mid-feature | `/compact` keeping "the FR/TC coverage table, green TCs, open DECISION NEEDED items". If still stuck, write a handoff paragraph and resume fresh with preamble + paragraph. |
| Feature is bigger than one session | Split by FRS module along the lines already in the feature block. End with a handoff paragraph naming what's done, which TCs are green, the last commit SHA, and what's next. |
| You disagree with your partner on a design point | Neither of you decides in chat. Write it as a DECISION NEEDED block, both answer, append to `DECISIONS.md`. The doc is the tiebreaker; if the docs are silent, that's exactly what the log is for. |
| A phase gate fails | The phase isn't done. Don't tag it. Log the defects, assign owners by feature, fix, re-run the gate. A tag on a red gate is worse than no tag. |
| You're blocked waiting on your partner | Review his open PR, run the wave chores, write the handoff paragraph, extend the defect log. Don't start the next wave. |
