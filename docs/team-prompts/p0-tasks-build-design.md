# ACE parity P0 — Tasks, workspaces, changes, review, local delivery — design

Date: 2026-10-06 · Branch `ace/parity` (worktree `D:\ACE offcl\wt\parity`, stacked on X1, D267)
Contract: `packages/contracts/src/tasks.ts` (+ project fields in `graph.ts`/`api.ts`, `approvalMode` in
`settings.ts`, `task.updated` / `task.deleted` in `events.ts`) — commit 578da93. Ports:
`packages/engine/src/ports/tasks.ts`. Decisions D267–D271. Gap analysis: `docs/ACE_FEATURE_PARITY.md`.

## 1. The flow this delivers

Create project (a Git repository, or _Initialize Git_) → **New task** (title, brief, how to check,
team = a project workflow, finish line, automation) → **Start** → Plan (a planner run, or a hand-
written plan) → **Work**: a run of the team workflow inside the task's own worktree and branch →
the run's changes are committed on the task branch → the project's check commands run there →
**Review**: changed files, diffs, checks, the agent's summary → _Request changes_ (a new work run
with the note) or _Approve_ → **Apply** (merge into the source repo's current branch after
confirming folder + branch) → **Done** with outcome `applied`. Failures keep the task where it is
with a reason and a Retry.

## 2. State machine (engine-owned; `stage` = column, `state` = what is happening)

| From (stage, state)                                 | Event                                      | To                                                                          | Side effects                                                                                                                                                                                                                                    |
| --------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| —                                                   | create                                     | (inbox, idle)                                                               | activity `created`; `start: 'now'` → _start_                                                                                                                                                                                                    |
| (inbox, idle)                                       | start                                      | (plan, idle)                                                                | `startedAt`; then: planner set → _plan_; else automation ≠ manual and project+task not paused → _work_                                                                                                                                          |
| (inbox\|plan, idle\|failed)                         | plan                                       | (plan, running)                                                             | needs `plannerWorkflowId`; workspace ensured first (App); execution kind `plan`                                                                                                                                                                 |
| plan run COMPLETE                                   | —                                          | (plan, idle)                                                                | `task.plan` = final text; then automation ≠ manual and not paused → _work_                                                                                                                                                                      |
| (plan\|work\|review, idle\|failed) or (inbox, idle) | work(message?)                             | (work, running) or (work, queued)                                           | needs `workflowId`; App needs the project folder to be a Git repo with a commit; capacity full → queued (reason "Waiting for a Build slot (2 of 2 in use)"); message kept as `pendingRequest` while queued                                      |
| (work, running)                                     | run COMPLETE                               | (work, running) → checks → (review, idle)                                   | commit all on the task branch; execution `commitSha`, `changedFiles`, `summary`; workspace `headSha`; checks if `runChecks` and the project has check commands; then autopilot rule (§2.2); then dequeue                                        |
| (plan\|work, running)                               | run HALTED `stopped`                       | (same stage, idle)                                                          | execution `stopped`; reason "Stopped."                                                                                                                                                                                                          |
| (plan\|work, running)                               | run HALTED other / BLOCKED                 | (same stage, failed)                                                        | execution `failed`, reason from the run (halt reason / pre-flight issue messages)                                                                                                                                                               |
| (*, running)                                        | `node.approval_required` for the run       | (same, waiting)                                                             | reason "Waiting for approval: <node name>"                                                                                                                                                                                                      |
| (*, waiting)                                        | `node.approval_decided`                    | (same, running)                                                             |                                                                                                                                                                                                                                                 |
| (review, idle)                                      | review approved (headSha = workspace head) | finish line `review` → (done, done) outcome `reviewed`; else (review, idle) | review row; stale headSha → 409                                                                                                                                                                                                                 |
| (review, idle\|failed)                              | review changes_requested(note)             | → _work(note)_ (or (work, idle) with `pendingRequest` when paused)          | review row                                                                                                                                                                                                                                      |
| (review, idle\|failed)                              | apply(destination)                         | (done, done) outcome `applied`                                              | checks of the head must not have failed; destination must equal folder + current branch; merge; delivery row; worktree folder removed, branch kept, workspace `applied`. Conflict / dirty / wrong branch → (review, failed) + delivery `failed` |
| any but running/waiting/done                        | close(reason?)                             | (done, done) outcome `closed_unverified`                                    |                                                                                                                                                                                                                                                 |
| (*, running\|waiting)                               | stop                                       | —                                                                           | stops the run; the run's HALTED event does the rest                                                                                                                                                                                             |
| (*, failed)                                         | retry                                      | re-does what failed                                                         | last execution failed → same kind again (work keeps the pending request); apply failed → (review, idle)                                                                                                                                         |
| any                                                 | pause / resume                             | `paused` toggled                                                            | resume → automatic step that was skipped now happens (queued → dequeue)                                                                                                                                                                         |
| (inbox\|plan\|work\|review, idle\|failed)           | move(stage)                                | (stage, idle)                                                               | stage edit only; never into done                                                                                                                                                                                                                |
| not running/waiting                                 | delete                                     | —                                                                           | worktree folder + branch removed (workspace `removed`); rows cascade; `task.deleted`                                                                                                                                                            |

### 2.1 Allowed actions (written on every task read)

`start` (inbox idle) · `plan` (inbox/plan, idle/failed, planner set) · `work` (inbox/plan/work/review,
idle/failed, workflow set) · `stop` (running/waiting with a run) · `retry` (failed) · `checks` (App,
workspace ready, not running, project has checks) · `approve` / `request_changes` (review, idle/failed)
· `apply` (review, idle/failed, App, finish line ≠ `review`, workspace ready) · `close` (not done, not
running/waiting) · `pause` / `resume` (not done) · `move` (not done, idle/failed) · `delete` (not
running/waiting).

### 2.2 Automation (Smart Actions)

- `manual`: nothing after `start` happens by itself except recording the results of what was started.
- `assisted`: plan completes → work starts; work completes → review. Final action waits.
- `autopilot`: as assisted; then, when `settings.approvalMode === 'full_access'`, the task and its
  project are not paused, and no check of the head failed, the finish line's final action runs:
  `review` → outcome `reviewed` (no human review needed under full access); `apply_local` → apply to
  the repository's current branch. Otherwise it waits in review with reason "Autopilot is waiting:
  <why>".
- A paused task or project takes **no** automatic step (planned → work, queued → work, autopilot).
  Explicit user actions still work.

### 2.3 Capacity

`project.buildCapacity ?? 2` work runs at once per project (plan runs do not count). Over it, the
task is `queued`. When any work execution ends (completed, failed, stopped), and when a project is
resumed, the oldest queued task of that project by priority (urgent → low) then `updatedAt` starts.

### 2.4 Recovery (engine start)

Every task `running`/`waiting`: its latest execution's run is read. A terminal run is handled as if
its `run.completed` had just arrived (idempotent). A run still non-terminal after the run engine's
own `recoverAfterCrash` → the task becomes `failed` "The engine stopped while this was running."
`queued` tasks are re-dequeued.

## 3. The work prompt (Input text of the run, D268)

```
# Task #<n>: <title>

<brief>

## Plan
<plan, or "No written plan.">

## How the result will be checked
<acceptance, or "Not stated.">

## Where to work
You are working in an isolated Git worktree of the project, on branch <branch> (from <baseBranch>).
Make your changes in this folder. Do not commit, push or switch branches — ACE records your changes
and the user reviews them before anything reaches <baseBranch>.

## Requested changes            ← only for a follow-up
<message>

## Your previous summary        ← only for a follow-up
<summary of the last work execution>
```

The plan prompt is the brief + acceptance + "Write a step-by-step plan for this task. Do not change
any files." Every Input node of the workflow gets the text (most workflows have exactly one).
A workflow with no Input node fails the stage: "The team workflow has no Input node."

## 4. Workspace (D269)

- Created when the first plan or work run starts (App tasks only); `setupCommand` then runs in it
  (failure → stage failed, the output kept as a check named `setup`).
- Path `<dataDir>/workspaces/<taskId>`; branch `ace/task-<number>-<slug>` (slug: lowercase
  `[a-z0-9-]`, ≤ 40 chars); if that branch exists, `-2`, `-3`, … ; base = the repository's current
  branch and HEAD. A detached HEAD or a repository without a commit refuses with a clear reason.
- A run's working folder (X1 `projectFolderFor(runId)`) = the workspace path when the run belongs to
  a task execution, else the project folder as before.
- After a work run: `commitAll` with message `ACE task #<n>: <title> (run <sequence>)`.
- Changes = `changes({ baseSha, includeUncommitted: state is running })`; the head is the
  workspace's `headSha`.

## 5. Checks (D271)

Each project check command, in order, in the worktree, through `CommandRunner` with a 10-minute
timeout and a 16 000-char tail; env = the engine's environment. Status: exit 0 `passed`, non-zero
`failed`, killed by timeout `timeout`, could not start `error`. Output is masked with the engine's
secret masker before storing. Activity `checks_passed` / `checks_failed`. A check's `headSha` is the
commit it ran on; "checks failed" for Apply/Autopilot means _the latest result per check name for the
current head_ has a non-`passed` status.

## 6. API (all under `/api/v1`, token required)

| Method + path                                                      | Body / query        | Answer                                      |
| ------------------------------------------------------------------ | ------------------- | ------------------------------------------- |
| GET `/projects/:id/tasks`                                          | `TaskListQuery`     | `TaskListResponse`                          |
| POST `/projects/:id/tasks`                                         | `CreateTaskRequest` | 201 `Task`                                  |
| GET `/tasks/:id`                                                   | —                   | `TaskDetail`                                |
| PATCH `/tasks/:id`                                                 | `UpdateTaskRequest` | `Task`                                      |
| DELETE `/tasks/:id`                                                | —                   | 204                                         |
| GET `/tasks/:id/activity`                                          | —                   | `TaskActivityListResponse`                  |
| POST `/tasks/:id/start` · `/plan` · `/stop` · `/retry` · `/checks` | `{}`                | `Task`                                      |
| POST `/tasks/:id/work`                                             | `StartWorkRequest`  | `Task`                                      |
| POST `/tasks/:id/review`                                           | `ReviewTaskRequest` | `Task`                                      |
| POST `/tasks/:id/apply`                                            | `ApplyTaskRequest`  | `Task`                                      |
| POST `/tasks/:id/close`                                            | `CloseTaskRequest`  | `Task`                                      |
| POST `/tasks/:id/pause`                                            | `PauseTaskRequest`  | `Task`                                      |
| GET `/tasks/:id/changes`                                           | —                   | `TaskChanges` (404 `no_workspace`)          |
| GET `/tasks/:id/changes/diff`                                      | `?path=`            | `TaskFileDiff`                              |
| GET `/projects/:id/repository`                                     | —                   | `RepositoryInfo`                            |
| POST `/projects/:id/repository/init`                               | `{}`                | `RepositoryInfo` (409 `already_repository`) |

Errors use the existing `ApiError` envelope: 404 `task_not_found`; 409 `invalid_transition`
(message names the state and the action), `stale_review`, `destination_changed`, `checks_failed`,
`workspace_busy`; 422 `not_a_repository`, `no_team`, `no_input_node`, `validation_failed`.
Every action answers with the task as it stands **after** the synchronous part (a started run is
`running`); the rest arrives as `task.updated`.

`task.updated` `{ task, activity? }` and `task.deleted` `{ taskId, projectId }` ride the engine
subscription. Every state change emits exactly one `task.updated`.

## 7. Mock coder (`packages/providers`, model `mock-coder`)

An agent-route model on the mock provider (D261-like): when the request has a `workingDir`, it reads
directives from the prompt and edits files there; with no `workingDir` it only answers text.

```
ace-mock:write <relative path>
<file content lines…>
ace-mock:end
ace-mock:delete <relative path>
ace-mock:fail <message>
```

Each `write`/`delete` → one `activity` chunk (`tool: 'write_file' | 'delete_file'`, `args: { path }`,
`status`, `summary`, `durationMs`); a path that resolves outside `workingDir` is refused
(`status: 'error'`, nothing written). `fail` ends the call with a provider error (not retryable).
Text answered: `Changed <n> file(s):\n- path…` or `No changes requested.` Usage: as `mock-text`.
Directives repeated in a follow-up prompt are simply re-applied (idempotent writes).

## 8. Web

- **Project navigation** on every project page: Overview (workflows) · Tasks · Runs · Knowledge ·
  Settings — `apps/web/src/projects/ProjectNav.tsx`; the top bar gains a _Tasks_ link when a project
  is open.
- **`/projects/:projectId/tasks`** board: five columns with counts; card = `#n` title, type,
  state chip (running / waiting / failed / queued), team name, labels, priority; search, label
  filter, _Needs attention_ toggle; project paused banner with Resume; **New task** dialog.
- **`/projects/:projectId/tasks/:taskId`** task page: header (number, title, stage stepper, state +
  reason, actions from `allowedActions`), tabs **Overview** (brief, plan editor, how to check, team,
  planner, finish line, automation, priority, labels) · **Build** (executions: kind, status, run link
  `/runs/:runId`, summary, commit; follow-up composer → `work({ message })`) · **Changes** (file list
  with +/−, unified diff per file, base → head, "uncommitted" note while running) · **Checks**
  (latest per name for the head, older collapsed) · **Activity**. A **Review** panel when in review:
  Approve, Request changes (note), Apply (shows folder + branch from `GET /projects/:id/repository`,
  confirm dialog), Close without verification.
- **`/projects/:projectId/settings`**: repository (status, _Initialize Git_), check commands editor,
  setup command, Build capacity, pause/resume project.
- **Settings page**: Approval mode (Ask / Approve for me / Full access) with one sentence each.
- Data: TanStack Query hooks in `apps/web/src/tasks/hooks.ts`; `task.updated` patches the task
  list/detail caches (engine subscription, as `provider.status`); `task.deleted` removes.
- SDK: one method per route (§6); MSW: a mock tasks engine in `src/mocks/handlers-tasks.ts`
  (in-memory, transitions without Git: work completes after ~1 s with two fake changed files).

## 9. Tests

contracts (done) · storage migration + repositories · Git adapter on real temporary repositories
(skipped when `git` is missing) · command runner · mock coder · task service on fakes (every row of
§2) · routes · server integration: real engine + real Git + mock coder, the whole §1 flow and the
conflict path · web components on MSW · acceptance Playwright on the real engine.
