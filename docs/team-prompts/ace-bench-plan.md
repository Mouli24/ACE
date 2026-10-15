# ACE Bench — minimum plan (PG-5.6)

Status: **DRAFT — needs the owner's approval before any code** (product-gaps prompt, PG-5.6).

## What it must prove

The bench answers one question: does this workflow do better than one model doing the same job alone, with the same tools? (PRD G5 and US "governed benchmarks"; principle "measure before claiming: frozen, blind, pre-registered".)

## Scope

This plan covers FR-BEN-001 to FR-BEN-008, built to their minimum, with TC-BEN-001 to TC-BEN-007 as acceptance. It uses Arch §20.2's routes: `POST /bench/tasks`, `/freeze`, `POST /bench/experiments`, `/start`, `/blind-export`, `/scores`, `/report`. Not in scope: judge automation (an LLM judge), leaderboards, the training split (Arch §17), and hosted mode.

## Concepts

| Thing | What it is | Rules |
|---|---|---|
| **Task** | A prompt, its input values (text and artifact refs), and a rubric (free text for the human judge) | Draft: editable. Frozen: immutable, and its content hash is stored. An edit after freeze → 409 (TC-BEN-001). |
| **Arm** | One configuration being compared | Exactly two in the minimum:<br>**A: the workflow** (a workflow id, snapshotted at experiment start).<br>**B: the single-node baseline**, generated from A: one Agent node with A's most capable model (the one the person picks, shown), **the union of every tool A's nodes have**, and A's project guardrail policy. Same inputs, same budget caps. |
| **Experiment** | Tasks × arms × N repetitions (1–10) | Lists every planned run up front: 2 tasks × 2 arms × 3 reps = 12 (TC-BEN-002). Pre-registered outcome notes and win/partial/loss rules are written at creation and locked at start (TC-BEN-006). |
| **Bench run** | A normal ACE run, flagged `bench: { experimentId, taskId, arm, rep }` | Runs with routing forced to **Fixed** (Arch §14). Kept out of normal run history (TC-BEN-007). Records output, tokens, cost, time, models used, workflow and prompt snapshots, and build version (TC-BEN-003). |
| **Blind export** | The PG-5.5 run export bundle, anonymised | Arm names, node names, model and provider are stripped; each output gets a random label. The label → run key is kept in the engine, not in the export (TC-BEN-004). |
| **Scores** | A CSV or JSON of `label, score, note`, imported | Linked back to runs through the kept key (TC-BEN-005). |
| **Report** | Per task: mean score per arm, the win/partial/loss outcome by the locked rules, and tokens, cost and time per arm | Read-only once it is produced. |

## Data

- New tables in `packages/storage-local`, through one new migration (never editing an old one): `bench_tasks`, `bench_experiments`, `bench_runs`, `bench_scores`.
- `runs` gains a nullable `bench_experiment_id` column, so normal history can filter bench runs out.
- **Contract:** a new `packages/contracts/src/bench.ts`, landed first in its own commit.

## Engine

- A `BenchService` in `packages/engine/src/bench/`:
  - Freeze hashes a task with SHA-256 over its canonical JSON.
  - Start snapshots arm A's workflow, builds arm B's single-node graph in memory (never saved as a workflow), and queues the runs one at a time. Running them one at a time is the fair choice: concurrency changes provider latency.
  - Each run goes through the normal run service, so guardrails, budgets, approvals and the event log all apply as usual.
  - An approval request during a bench run pauses the experiment. It is shown to the person, never auto-answered.
- The report is computed on read from the stored scores and the locked rules.

## Web

- A `/bench` route with three tabs:
  - **Tasks:** create, edit, freeze.
  - **Experiments:** create with tasks, arms, reps, outcome notes and rules; start; progress.
  - **Results:** blind export, score import, report.
- Bench runs never appear in the Runs list, Timeline or Domain unless opened from the bench.
- Every screen shows real engine state; there is no demo data.

## Open questions for the owner

1. **Baseline model.** Should the person pick arm B's model, or should it default to the strongest model used in A? Recommendation: default to A's strongest, and let the person change it before start.
2. **Win/partial/loss rule format.** Free text plus one numeric threshold (B's mean − A's mean ≥ X = loss)? Or only a free-text rule that the person applies by hand in the report? Recommendation: the numeric threshold, so the report can apply it.
3. **Judging.** Human only in the minimum (export, then import scores)? Recommendation: yes.
4. **Repetitions.** A cap of 10? Recommendation: yes. It keeps a local bench under an hour on the mock or a local model.

## Tests (per D362, written after the build)

- TC-BEN-001 to TC-BEN-007 as Vitest over HTTP against the real engine.
- One Playwright walk: create 1 task, freeze it, make an experiment with 2 arms × 2 reps, start it on the mock provider, blind export, import scores, read the report.
