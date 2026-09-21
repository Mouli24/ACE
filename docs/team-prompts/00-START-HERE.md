# 00 — START HERE: the exact order to give prompts to Claude

Read this before opening any other file. It answers one question: **what do I paste, into which session, in what order, and who does it.**

---

## 1. First, the decision: use ONE pack

`D:\ace docs\` contains three overlapping packs. They describe the same product but with **incompatible process rules** (different `CLAUDE.md`, different branch names, different ownership models). Mixing them causes exactly the merge mismatch you are trying to avoid.

| Pack | What it is | State | Verdict |
|---|---|---|---|
| `build-prompts/` | **Solo** build, one Claude session per FRS phase (0–17) | **Incomplete** — `01-KICKOFF-PROMPT.md` and `00-README.md` reference 18 files (`phase-00-foundations.md` … `phase-17-launch.md`) and **none of them exist**. Only the kickoff, README, CLAUDE.md and the post-v1 outline were written. | ❌ Do not start. It breaks at session 2. |
| `prompt.md` + `HOW-TO-USE.md` | **Two-person** build, 49 features (F00–F49) in 25 waves | Complete, but very fine-grained: 50 sessions, ownership re-assigned per wave, and its `CLAUDE.md` is described but never written | ⚠️ Usable, but heavier and its root `CLAUDE.md` is missing |
| `team-prompts/` ← **this folder** | **Two-person** build, 5 rounds, permanent path ownership | Complete: `CLAUDE.md` + 5 round files, every prompt written out, cross-testing defined per round | ✅ **Use this one** |

**Decision: use `team-prompts/`.** Move `build-prompts/` and `prompt.md` out of the repo (keep them in `D:\ace docs\` as reference, do not copy them into `docs/`). Two `CLAUDE.md` files in one repo is the single fastest way to make the two of you build to different rules.

> Salvage note: `build-prompts/01-KICKOFF-PROMPT.md` has a good Phase 0 checklist (D1–D17 derivations, ADR list, CI shape). That material is already folded into **Round 1 §3 (Step 0)** of this pack. You do not need to paste the kickoff prompt at all.

---

## 2. Setup — done once, by Arhant, with no Claude session

```bash
mkdir D:\ace && cd D:\ace && git init          # short path, no spaces (Windows long-path issues)
mkdir docs
copy "D:\ace docs\ACE-PRD.md"        docs\
copy "D:\ace docs\ACE-FRS.md"        docs\
copy "D:\ace docs\ARCHITECTURE.md"   docs\
xcopy "D:\ace docs\team-prompts"     docs\team-prompts\ /E /I
copy  "D:\ace docs\team-prompts\CLAUDE.md"  CLAUDE.md     # repo ROOT — this is the one Claude loads
git add -A && git commit -m "docs: ACE specs and team prompt pack"
git remote add origin <your repo> && git push -u origin main
```

Then Mouli clones. **Both read `CLAUDE.md` end to end before the first session** — especially §3 (ownership) and §5 (round process). `docs/DECISIONS.md` and `docs/defect-log.md` do not exist yet; Arhant creates them in Round 1 Step 0.

There is **no kickoff prompt session**. Round 1 Step 0 is the kickoff.

---

## 3. The two reusable prompts

Two blocks are used in every round. Both live in the Round 1 file; nothing equivalent exists in the other round files, so keep Round 1 open.

| Block | Where | Used for |
|---|---|---|
| **Session preamble** | `01-round-1-skeleton.md` **§6** | Pasted *first* in every build session, every round. Followed by the feature prompt. |
| **Verification prompt** | `01-round-1-skeleton.md` **§8.3** | Pasted in every cross-testing session, every round. Substitute the feature id (`A2`/`M2`…) and the round file. |

---

## 4. The sequence — per round, in order

Each round is **5 required Claude sessions**. Sessions marked ║ run at the same time, one on each machine.

| # | Who | Claude session | What to paste | Blocks on |
|---|---|---|---|---|
| **S1** | Arhant | Contract | preamble (R1 §6) + `Implement Step 0 of docs/team-prompts/0N-<file>.md §3, building exactly the contract in §2 of that file.` | — |
| **R** | Mouli | *no session* — PR review | Read the contract PR against §2 of the round file, line by line. Approve → merge. | S1 |
| **S2** ║ | Arhant | Build A-feature | preamble (R1 §6) + the **whole fenced prompt in §4** of the round file | contract merged |
| **S3** ║ | Mouli | Build M-feature | preamble (R1 §6) + the **whole fenced prompt in §5** of the round file | contract merged |
| **R** | both | *no session* — PR review | Each reviews the other's PR per `CLAUDE.md` §6.1 (20 min). Merge with "Rebase and merge"; second to merge rebases first. | S2, S3 |
| **S4** ║ | Arhant | Verify M-feature | verification prompt (R1 §8.3) with `M<N>`, then work the scenario table in **§7.1** (§8.1 in Round 1) | both merged |
| **S5** ║ | Mouli | Verify A-feature | verification prompt (R1 §8.3) with `A<N>`, then work the scenario table in **§7.2** (§8.2 in Round 1) | both merged |
| **F** | owner | Fix sessions, as needed | preamble + `Fix defect D-0NN in docs/defect-log.md. Write the failing regression test TC-<MODULE>-R<nn> first.` | a finding |
| **G** | both | *no session* — gate | Tick every line of the round's **§8** (§9 in Round 1), update `CLAUDE.md` §9, `git tag round-N` | verification passed |

**Nobody opens the next round file until the tag exists.** Waiting is correct: review, verify, close defects.

---

## 5. The full ordered list — 25 sessions

| Round | File | S1 contract (A) | S2 build (A) ║ S3 build (M) | S4 verify (A→M) ║ S5 verify (M→A) | Tag |
|---|---|---|---|---|---|
| 1 | `01-round-1-skeleton.md` | §3 Step 0 — workspace, contracts, CI, DECISIONS.md, defect-log.md | §4 engine skeleton ║ §5 web shell + Canvas + SDK | §8.1 ║ §8.2 | `round-1` |
| 2 | `02-round-2-providers-execution.md` | §3 | §4 providers, catalog, router, run engine ║ §5 providers UI + live run UI | §7.1 ║ §7.2 | `round-2` |
| 3 | `03-round-3-control-guardrails-loops.md` | §3 | §4 controls, errors, guardrails, parallel, loops ║ §5 controls, approvals, policy UI | §7.1 ║ §7.2 | `round-3` |
| 4 | `04-round-4-multimodal-chat-tools.md` | §3 | §4 artifacts, tools, chat service ║ §5 uploads, renderers, chat, tools UI | §7.1 ║ §7.2 | `round-4` |
| 5 | `05-round-5-knowledge-memory-onboarding.md` | §3 | §4 knowledge, memory, usage, templates ║ §5 knowledge, usage, onboarding, responsive | §7.1 ║ §7.2 | `round-5` |

25 required sessions, plus fix sessions. Round 5 §10 lists Rounds 6–11 to write in the same shape when you get there.

---

## 6. How to open a session (both, every time)

```bash
git checkout main && git pull --ff-only origin main
pnpm install && pnpm typecheck && pnpm test        # main must be green BEFORE you branch
git checkout -b round-2/arhant-providers-execution  # branch name is in the round file's §4/§5 header
```
Then in the terminal:
```
/clear
claude --permission-mode plan          # or Shift+Tab until it says plan mode
<paste preamble>
<paste the feature prompt>
```
Claude presents a plan with an FR/TC coverage table. **Check three things before approving:** every FR of the feature is in the table · nothing from a later round appears · every file it intends to touch is inside your `CLAUDE.md` §3 paths. Then approve, let it build with TDD, and demand the real `pnpm test` output — not a summary.

One feature per session. If it does not fit, end with a handoff paragraph (what is done, which TCs are green, last SHA, what is next) and resume in a fresh session with preamble + that paragraph.

---

## 7. Answering the four options directly

1. **`01-KICKOFF-PROMPT.md` first?** No. It belongs to the incomplete solo pack and its 18 phase files do not exist. Its useful content is already in Round 1 §3.
2. **"All the 1, 2, 3, 4 prompts"?** Only if you mean **this folder's** `01`…`05`, and only in the per-round order in §4 above — never all at once, and never both people pasting the same file's §4. Each round file holds **three** prompts (§3 contract, §4 Arhant, §5 Mouli) for **three different sessions**.
3. **Team prompts?** Yes — this pack, in the §4/§5 sequence. This is the answer.
4. **Any other way?** The only variant worth considering: if a round is too big for one session, split it along the module boundaries the round file already names (e.g. Round 4 §4 into artifacts+multimodal, then tools, then chat) and keep the same ownership and the same cross-testing gate. Never split by "Arhant does the first half of Mouli's feature".
