# Domain falsification test

You run this with a tester who did not build Domain. The tester gets five minutes and Domain only: no Track, no logs, no database, no engine API. Each question either has its answer on the screen or it doesn't. A question the tester can't answer, or answers wrongly, means an event is missing or the projection has a gap, and it gets fixed before the visual pass.

## Before the tester arrives (you, about 15 minutes)

1. **Build a real run.** Use a real provider (Claude Code is the one with reported usage and cost) and a workflow that exercises all five questions:
   - Three agents in a chain, e.g. Writer → Reviewer → Editor, ending in an Output node. Add one more agent marked as the Brain.
   - The Reviewer's instructions say, in words: "If the draft's hook is weak, send @writer a FLAG envelope saying why." The `## Team` section already shows every agent the envelope format.
   - Start it from Domain (the board's **Domain** link, or `…/workflows/<id>/domain?run=new`), with the goal as the first message.
   - While it runs, send one message to one node by name, e.g. "Editor, use British spelling."
   - Either leave one node waiting — set manual routing and leave one envelope **HELD** — or give the run a token budget small enough to block it. Don't End the run.
2. **Write the answer key** from Track, the logs or the database, and keep it from the tester:
   - which node produced the final artifact, and what it is;
   - which node is blocked or waiting, and on what;
   - what you told the node you messaged, and whether it got the message (delivered, done);
   - which node spent the most tokens;
   - whether any agent flagged another, and what happened next.
3. **Open Domain on that run** (`…/domain?run=<runId>`) and hand over the screen. Close every other tab.

## The five questions (read them to the tester; start the 5-minute clock)

| # | Question | Where Domain shows it (for your debrief; don't show the tester) | A wrong answer means |
|---|---|---|---|
| 1 | **Who produced the final artifact?** | The last HANDOFF line into the Output node (`@editor → Result`). The producing agent's message lists its files: written by a CLI tool, or a media output. The team panel shows that node COMPLETED. | Files a node wrote don't show on its message, or the hand-off to the Output node isn't narrated. |
| 2 | **Which node is blocked or waiting, and on what?** | The team panel's state and activity ("waiting for an answer from @x", BLOCKED). A HELD envelope with its reason. The system line "Run BLOCKED: LOOP_GUARD / BUDGET_EXCEEDED …". | A state or a reason never reaches the conversation or the panel. |
| 3 | **What was \<the node you messaged\> told, and did it get it?** | Click that node's lens. Your message is there with a delivery chip PENDING → DELIVERED → DONE (or DROPPED). The node's next turn says it was started by an instruction. | A delivery state isn't narrated, or the lens hides the message. |
| 4 | **Which node spent the most tokens?** | The team panel's tokens in and out per node. An estimate is marked `est.`; the per-turn table is beneath. | Usage missing for a node, or a total that doesn't match Track. |
| 5 | **Did any agent flag another, and what happened next?** | A FLAG line `@reviewer → @writer · FLAG · FORWARDED` with its summary. Below it, the Writer's turn started by that envelope, and its revised HANDOFF. | The FLAG, its routing or the turn it caused isn't shown. |

## Scoring

- **Pass:** all five are right, against your answer key, within 5 minutes.
- **Fail:** any wrong or unanswered question. Note which question failed and what the tester looked at. Then find the missing event or projection gap (the "A wrong answer means" column says where to start) and fix it before the visual pass.
- **Also note** anything the tester had to guess at, even when they guessed right.
