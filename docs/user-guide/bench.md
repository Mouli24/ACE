# Bench

**Bench** answers one question: does a workflow do better than one model doing the same job
alone, with the same tools? Open it from **Bench** in the site header (`/bench`). It has three
tabs: **Tasks**, **Experiments** and **Results**.

The method is fixed so the answer is fair: freeze the tasks, write down what counts as a win
before the first run, and judge the outputs without knowing which side produced them.

## Tasks

1. **New task**. Give it a **Name**, the **Prompt**, any **Extra text inputs (optional)** (separate
   them with a line holding only `---`), and a **Rubric for the judge**.
2. **Create draft**, then **Save draft** as you change it. A draft can still be edited.
3. **Freeze** locks the task for good and stores a fingerprint of it. Only frozen tasks can be used
   in an experiment, so every run of a task gets exactly the same text.

## Experiments

**New experiment** sets up a comparison between two arms:

- **Arm A — the workflow:** pick a **Project** and a **Workflow**.
- **Arm B — the single-model baseline:** one Agent with every tool arm A's agents have, arm A's
  project policy and the same budget caps. By default it uses **Arm A's strongest model** (the most
  expensive one arm A uses); you can choose another until the experiment starts.
- **Frozen tasks:** tick the tasks to run.
- **Repetitions per task and arm (1–10):** the page says how many runs that makes, for example
  "3 tasks × 2 arms × 2 = 12 runs, one at a time".
- **Pre-registered rules — locked at start:** **What you expect, and why**, and the **Threshold,
  in score points**. For each task, the workflow's mean score minus the baseline's decides the
  outcome: at least the threshold is a **win**, at most minus the threshold a **loss**, anything in
  between a **partial**.

**Create experiment** saves it as a draft; you can still change arm B's model. **Start — locks the
rules** begins the runs, task by task, the two arms back to back. **Planned runs** lists each one
with its task, arm, repetition, status, tokens, cost and time, and **Open run** for any that has
started.

If a run needs an approval, the experiment pauses and says "A bench run is waiting for your
approval"; **Open the run** to answer it, and the experiment carries on. If ACE restarts during an
experiment, the runs not yet finished are marked **skipped** and the experiment **interrupted**.
Bench runs count in your usage like any other run.

## Results

Choose a started **Experiment**.

1. **Blind judging → Download blind export.** The file holds each finished output under a random
   label, with the tasks and their rubrics, and nothing that says which arm, node, model or provider
   produced it. Give it to whoever judges.
2. **Import scores.** Paste, or load from a file, one score per label: CSV with the columns
   `label,score,note`, or JSON rows such as `[{"label": "K7Q2M9XA", "score": 4, "note": "clear"}]`.
   The note is optional and any number is a valid score. A label this experiment never exported is
   listed and not imported.
3. **Report.** Per task, the mean score of each arm and its outcome, **win**, **partial** or
   **loss**, under the locked threshold, with counts of each at the top. A task still waiting for
   scores reads **pending scores**.

See also: [Replay and compare](replay-and-compare.md).
