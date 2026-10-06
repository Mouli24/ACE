# ACE parity — implementation status

Branch `ace/parity` (worktree `D:\ACE offcl\wt\parity`), stacked on `x1/model-gateway` (D267).
Gap analysis and plan: [`ACE_FEATURE_PARITY.md`](ACE_FEATURE_PARITY.md). P0 design:
[`team-prompts/p0-tasks-build-design.md`](team-prompts/p0-tasks-build-design.md). Decisions D267–D271.

_Last updated: 2026-10-06 (in progress)._

## Implemented

| Slice | What works | Where | Tests |
|---|---|---|---|
| P0 contract | Task, stages/states, finish lines, outcomes, automation, executions, checks, reviews, deliveries, activity, changes, repository info; project Build settings; approval mode; `task.updated`/`task.deleted`; error codes | `packages/contracts/src/tasks.ts` (+ `graph.ts`, `api.ts`, `settings.ts`, `events.ts`, `errors.ts`) | `contracts` 1111 green |
| P0 engine ports | Task repositories, Git port, command runner port; `beginRun` accepts a chosen run id | `packages/engine/src/ports/tasks.ts`, `runs/index.ts` | typecheck |
| P0 task service | State machine (§2 of the design), plan/work runs of the team workflow in the task worktree, commit per work run, checks per head, review bound to a SHA, Apply with destination confirmation and conflict handling, Close, capacity queue, automation + pause, Autopilot under Full access, crash recovery | `packages/engine/src/tasks/` | 38 tests (service + routes), engine 1569 green, coverage 92/84/94/94 |
| P0 mock coder | `mock-coder` edits files in its working folder from `ace-mock:` directives — the whole flow runs with no key | `packages/providers/src/adapters/mock-coder.ts` | 29 tests |

## In progress

- Storage: migration `20261006T180000_parity_p0_tasks` + repositories (agent, `ace/p0-storage`).
- Git port + command runner over the real `git` binary (agent, `ace/p0-tools`).
- Web: SDK, mock engine, Tasks board, task page, project settings, approval mode (agent, `ace/p0-web`).
- Server wiring + an integration test on a real repository (after the three above).

## Remaining (by priority)

- **P1**: Skills library + per-agent enablement; Secrets; Preview; GitHub delivery + clone; Document
  tasks; Send to Build from chat; schedules; global approvals inbox; approval mode → CLI ceiling;
  team templates.
- **P2**: Email tasks and import; Suggestions; team notes; Bundles; Ace Assistant setup.
- **P3**: polish.

## Known limitations

- Workspaces are kept after *Close without verification* (removed with the task on delete).
- Deleting a project removes its task rows but not worktree folders under `<dataDir>/workspaces`.
- Some contract/engine files carry cosmetic formatting churn from one early default-config Prettier
  run (objects wrapped at 80 columns); the content is unchanged.

## Test status

See the table above; the full gates are re-run after each integration step.
