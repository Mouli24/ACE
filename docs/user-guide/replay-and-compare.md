# Replay and compare

Every run is recorded: its snapshot of the workflow, its inputs and what each node produced. Open a
run from the **Runs** tab to use that record.

## Replay run

**Replay run** plays a finished run (`COMPLETE` or `HALTED`) again from its recording. No provider
is called, so it costs nothing and needs no key or network. Each node gives back the output it gave
the first time, and you can watch the run go through the graph as before.

- Find it on the run's page, or in the **Workspace menu** in the header while that run is selected.
- The new run says **Replay of** _run_ · "answered from its recording, no provider calls".
- A replay uses no tools, no knowledge search and no checkpoints, and never stays open in Domain.
- A node the original run never recorded fails with `replay_missing`.

Replay is how you check that a run can be reproduced, or show it again without paying for it.

## Compare runs

**Compare…** on a run's page (or **Compare with…** in the **Workspace menu**) opens **Compare runs**.
Pick the second run from the same workflow's other runs, newest first.

The page shows the two runs side by side, node by node: how many outputs differ, each node's
output as a line diff (JSON is tidied first, so only real changes show), its tokens, its cost and
its time. A cost ACE could not price stays unknown. **⇄** swaps the two sides, to read the diff the other
way. Comparing records nothing.

## Export run

On a run's page:

- **Export run** downloads the whole run as JSON: the run, every node run, their outputs and the
  event log. Anything that looks like a secret is masked.
- **Export anonymised** does the same, and also renames the nodes **Node 1**, **Node 2** and so on
  and removes every provider and model name. Use it to have outputs judged blind, without saying
  which setup produced them. For judging many runs at once, see [Bench](bench.md).

See also: [Building a workflow](building-a-workflow.md), [Modes](modes.md).
