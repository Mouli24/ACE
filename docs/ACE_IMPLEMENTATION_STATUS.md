# ACE parity — implementation status

Branch `ace/parity` (worktree `D:\ACE offcl\wt\parity`), stacked on `x1/model-gateway` (D267).
Gap analysis and plan: [`ACE_FEATURE_PARITY.md`](ACE_FEATURE_PARITY.md). P0 design:
[`team-prompts/p0-tasks-build-design.md`](team-prompts/p0-tasks-build-design.md). Decisions D267–D271.

_Last updated: 2026-10-07 (in progress)._

## Implemented — P0 (tasks, workspaces, changes, review, local delivery)

| Slice | What works | Where | Tests |
|---|---|---|---|
| Contract | Task, stages/states, finish lines, outcomes, automation, executions, checks, reviews, deliveries, activity, changes, repository info; project Build settings; approval mode; `task.updated`/`task.deleted`; error codes | `packages/contracts/src/tasks.ts` (+ `graph.ts`, `api.ts`, `settings.ts`, `events.ts`, `errors.ts`) | contracts green |
| Storage | Migration `20261006T180000_parity_p0_tasks`: seven task tables + four project columns; repositories; backup import copies tasks under the new foreign keys | `packages/storage-local/src/repository-tasks.ts`, `migrations.ts` | 339 storage tests, coverage 98/94 |
| Git + commands | Git port over the `git` binary (inspect, init, worktrees, commit-all, changes with renames/binaries, per-file diff, merge with conflict abort; 5-minute timeout; ACE's own commits unsigned) and the check-command runner (platform shell, tree kill, output tail) | `packages/tools/src/git/`, `packages/tools/src/process/` | 50 Git tests on real temporary repositories |
| Task service | The state machine (design §2): plan/work runs of the team workflow in the task worktree (run id chosen before the run so the working folder is never the project folder), a commit per work run, checks per head, a review bound to a SHA, Apply with destination confirmation and conflict handling, Close, capacity queue, automation + pause, Autopilot only under Full access, crash recovery, project deletion removes worktrees | `packages/engine/src/tasks/` | 39 service + route tests |
| Mock coder | `mock-coder` edits files in its working folder from `ace-mock:` directives — the whole flow runs with no key | `packages/providers/src/adapters/mock-coder.ts` | 29 tests |
| Server | Task service wired with the real Git port and runner; late-bound working folder; attach after crash recovery; shutdown | `apps/server/src/server.ts` | end-to-end test on a real repository: brief → worktree → commit → check → changes → diff → review → Apply into `main`; conflict leaves the repo untouched; Initialize Git |
| Web | SDK methods; mock tasks engine; Tasks board (five columns, search, labels, Needs attention, paused banner); New task dialog; task page (Overview, Build, Changes with diff view, Checks, Activity, Review panel with Approve / Request changes / Apply with confirmed destination / Close); project navigation and project settings (repository + Initialize Git, checks, setup command, capacity, pause); approval mode in Settings; live `task.updated` patches | `apps/web/src/tasks/`, `apps/web/src/projects/`, `packages/sdk` | web 919 tests, sdk 151 |
| Team templates | *Single builder* (mock coder) and *Plan, build and review* (planner → builder → reviewer loop) | engine templates, web wizard + mock | template tests |

## P1 — contract landed, implementation in progress

The P1 contract (skills, bundles, secrets, schedules, deliverables, GitHub delivery, preview, the
pending-approvals list) and the engine ports for GitHub, preview and schedules are committed.
Remaining work, by slice:

- Skills library + per-agent enablement + run-snapshot freezing + `## Skills` prompt section; Bundles import.
- Secrets (keychain values, names in context, env injection into checks/CLI runs, exact-value scrubbing); global approvals inbox; approval mode → CLI permission ceiling.
- GitHub delivery (push, pull request, confirmed merge) and clone from GitHub; Preview of the task workspace.
- Schedules (once / recurring cron / after task); Document and Email deliverables; Send to Build from chat.

## Remaining (by priority)

- **P2**: Email send connector and import; Suggestions; team notes; Ace Assistant setup.
- **P3**: polish.

## Known limitations

- Workspaces are kept after *Close without verification* (removed with the task on delete).
- A recurring cosmetic diff: some contract/engine files were reformatted once with Prettier's
  defaults and then with the shared config, so a few object literals stay wrapped; content unchanged.
- Check and setup commands run unsandboxed in the worktree with the user's environment (D271) —
  the same trust as a local CI script; they are never written by an agent.

## Test status

Gates are re-run after each integration step; the latest full run is recorded in the final report.
