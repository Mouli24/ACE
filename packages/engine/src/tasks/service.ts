import { isAbsolute, join, resolve } from 'node:path';

import type {
  AcceptTaskRequest,
  ApplyTaskRequest,
  ApprovalMode,
  CheckStatus,
  CloneProjectRequest,
  CloseTaskRequest,
  CreateTaskRequest,
  ExecutionKind,
  Id,
  MergePullRequestRequest,
  OpenPullRequestRequest,
  Project,
  PutDeliverableRequest,
  PutTaskScheduleRequest,
  RepositoryInfo,
  ReviewTaskRequest,
  Run,
  StartRunRequest,
  StartWorkRequest,
  Task,
  TaskActivity,
  TaskCheck,
  TaskChanges,
  TaskDetail,
  TaskExecution,
  TaskFileDiff,
  TaskListQuery,
  TaskPriority,
  TaskSchedule,
  TaskWorkspace,
  UpdateTaskRequest,
} from '@ace/contracts';
import {
  CHECK_OUTPUT_MAX,
  DEFAULT_APPROVAL_MODE,
  DEFAULT_BUILD_CAPACITY,
  DEFAULT_FINISH_LINE,
  DEFAULT_TASK_AUTOMATION,
  EXECUTION_SUMMARY_MAX,
  FILE_DIFF_MAX,
  TASK_PLAN_MAX,
  TASK_PRIORITIES,
  finishLineFits,
  needsAttention,
} from '@ace/contracts';

import type { EventBus } from '../events/index.js';
import { HttpError, notFound, notImplemented, validationFailed } from '../gateway/errors.js';
import { newId } from '../ids.js';
import type { Logger } from '../logging/index.js';
import type {
  CommandRunner,
  GitHubPort,
  GitPort,
  PreviewRunner,
  Repository,
  Scope,
  TaskRecord,
} from '../ports/index.js';
import { allowedTaskActions, withActions, type ActionContext } from './actions.js';
import {
  acceptDeliverable,
  createNodeDeliverableFiles,
  deliverableFromOutput,
  deliverableInstructions,
  initialDeliverable,
  putDeliverable,
  sendDeliverable,
  type DeliverableFiles,
} from './deliverables.js';
import { mergePullRequest, openPullRequest, parseGitHubRemote } from './github-delivery.js';
import type { ActivityInput, TaskKernel, TaskRepos } from './kernel.js';
import { createPreviewManager, type PreviewManager } from './previews.js';
import { branchName, outputText, planPrompt, workPrompt } from './prompts.js';
import { createTaskScheduler, type TaskScheduler } from './scheduler.js';

export { parseGitHubRemote } from './github-delivery.js';

/**
 * The task service (ACE parity P0, docs/team-prompts/p0-tasks-build-design.md, D268–D271).
 *
 * It owns the board's state machine. A task's plan and work are ordinary runs of a project workflow
 * (D268) started with a run id chosen here, so the run's working folder is the task's worktree from
 * its first dispatch (D269). Everything that takes long — creating a worktree, the setup command,
 * recording a run's changes, the checks — happens in the background while the task reads `running`;
 * every action answers with the task as it stands once the synchronous part is done, and the rest
 * arrives as `task.updated` (one per state change).
 *
 * Mutations of one task are serialised by a per-task lock, so a run finishing while the user presses
 * Stop cannot interleave. The lock is never held across a long operation.
 */
export interface TaskService {
  list(projectId: Id, query: TaskListQuery): Promise<Task[]>;
  create(projectId: Id, body: CreateTaskRequest): Promise<Task>;
  get(id: Id): Promise<TaskDetail>;
  update(id: Id, patch: UpdateTaskRequest): Promise<Task>;
  remove(id: Id): Promise<void>;
  activity(id: Id): Promise<TaskActivity[]>;

  start(id: Id): Promise<Task>;
  plan(id: Id): Promise<Task>;
  work(id: Id, body: StartWorkRequest): Promise<Task>;
  stop(id: Id): Promise<Task>;
  retry(id: Id): Promise<Task>;
  runChecks(id: Id): Promise<Task>;
  review(id: Id, body: ReviewTaskRequest): Promise<Task>;
  apply(id: Id, body: ApplyTaskRequest): Promise<Task>;
  close(id: Id, body: CloseTaskRequest): Promise<Task>;
  pause(id: Id, paused: boolean): Promise<Task>;

  changes(id: Id): Promise<TaskChanges>;
  fileDiff(id: Id, path: string): Promise<TaskFileDiff>;

  repository(projectId: Id): Promise<RepositoryInfo>;
  initRepository(projectId: Id): Promise<RepositoryInfo>;

  /**
   * Where a run works (X1 `projectFolderFor`): `{ task: false }` for a run no task started — the
   * caller uses the project folder as before — else the task's worktree, or no folder at all for a
   * task without a ready workspace (a CLI then runs read-only in a temporary folder). A restarted
   * run follows `restartedFromRunId` back to the run it restarted.
   */
  folderForRun(runId: Id): Promise<{ task: false } | { task: true; folder?: string }>;

  /** A project's settings changed: a resumed project or a raised capacity starts queued work. */
  projectChanged(projectId: Id): Promise<void>;
  /**
   * A project is about to be deleted: stop its tasks' runs and remove their worktree folders from
   * the data folder. The task branches stay in the user's repository — they are the user's history.
   */
  beforeProjectDelete(projectId: Id): Promise<void>;

  /* ACE parity P1 (D275–D278). Each answers 501 when the engine was built without its port. */
  putDeliverable(id: Id, body: PutDeliverableRequest): Promise<Task>;
  accept(id: Id, body: AcceptTaskRequest): Promise<Task>;
  send(id: Id): Promise<Task>;
  openPullRequest(id: Id, body: OpenPullRequestRequest): Promise<Task>;
  mergePullRequest(id: Id, body: MergePullRequestRequest): Promise<Task>;
  startPreview(id: Id): Promise<Task>;
  stopPreview(id: Id): Promise<Task>;
  putSchedule(id: Id, body: PutTaskScheduleRequest): Promise<TaskSchedule>;
  removeSchedule(id: Id): Promise<void>;
  /** `POST /projects/clone`: a new project in a fresh clone of a GitHub repository (D276). */
  cloneProject(body: CloneProjectRequest): Promise<Project>;
  /** One pass over the due schedules — what the scheduler's timer runs (D277). */
  tickSchedules(): Promise<void>;

  /** Subscribes to run events and recovers tasks a stopped engine left mid-flight. */
  attach(): Promise<() => void>;
  /** Resolves once every background step started so far has finished (tests, shutdown). */
  idle(): Promise<void>;
  /** Cancels setup and check commands in flight and waits for the background to unwind. */
  shutdown(): Promise<void>;
}

export interface TaskServiceDeps {
  repository: Repository;
  scope: Scope;
  bus: EventBus;
  logger: Logger;
  git: GitPort;
  commands: CommandRunner;
  /** Starts a run as `POST /workflows/:id/runs` does, under the given id; answers after pre-flight. */
  startRun: (workflowId: Id, request: StartRunRequest, runId: Id) => Promise<Run>;
  /** Stops a run as `POST /runs/:id/stop` does. */
  stopRun: (runId: Id) => Promise<unknown>;
  /** `<dataDir>/workspaces` — every task worktree is a folder in it (D269). */
  workspaceRoot: string;
  /** Masks secret-shaped text before a check's output is stored (BR-07). */
  mask?: (text: string) => string;
  /** The environment check and setup commands run with (D271). */
  commandEnv?: () => Record<string, string>;
  checkTimeoutMs?: number;
  now?: () => string;
  nextId?: () => string;

  /* ACE parity P1 (D275–D278). Each feature answers 501 `not_implemented` without its port. */
  github?: GitHubPort;
  preview?: PreviewRunner;
  /** How an accepted Document is written into the project folder; Node's filesystem by default. */
  files?: DeliverableFiles;
  /** Posts a line on a workflow's timeline — how a task sent from a chat reports its outcome. */
  postNote?: (workflowId: Id, text: string) => Promise<void>;
  /** Creates a project as `POST /projects` does — what Clone from GitHub ends with. */
  createProject?: (body: { name: string; folderPath: string }) => Promise<Project>;
  /** Where a cloned project's folder goes when the request names none. */
  projectsRoot?: string;
  /** How often the scheduler looks for due schedules (D277); 30 s by default. */
  schedulerTickMs?: number;
}

const DEFAULT_CHECK_TIMEOUT_MS = 600_000;
const SETUP_CHECK_NAME = 'setup';

/** The activity kinds that move a task into Done (what `reachedDone` reacts to). */
const ENTERS_DONE = new Set<ActivityInput['kind']>(['approved', 'delivered', 'closed']);

/** What a failed stage says when the engine stopped under it. */
const ENGINE_STOPPED = 'The engine stopped while this was running. Retry to run it again.';

const invalidState = (task: TaskRecord, action: string): HttpError =>
  new HttpError(
    'workflow',
    'invalid_task_state',
    `Task #${task.number} is ${task.stage} / ${task.state}; it cannot ${action} now.`,
    { stage: task.stage, state: task.state, action },
  );

const shortSha = (sha: string | undefined): string => (sha === undefined ? '' : sha.slice(0, 7));

/** A 400 naming one field, in the `ValidationIssue` shape every other refusal uses. */
const invalidField = (code: string, message: string): HttpError =>
  validationFailed(message, [{ severity: 'error', code, message }]);

const PRIORITY_RANK = new Map<TaskPriority, number>(
  TASK_PRIORITIES.map((priority, index) => [priority, TASK_PRIORITIES.length - index]),
);

function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

export function createTaskService(deps: TaskServiceDeps): TaskService {
  const { repository, scope, bus, logger, git, commands } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const nextId = deps.nextId ?? newId;
  const mask = deps.mask ?? ((text: string) => text);
  const checkTimeoutMs = deps.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;

  /* ------------------------------------------------------------------------ */
  /* Repositories                                                              */
  /* ------------------------------------------------------------------------ */

  function repos(): TaskRepos {
    const {
      tasks,
      taskWorkspaces,
      taskExecutions,
      taskChecks,
      taskReviews,
      taskDeliveries,
      taskActivity,
    } = repository;
    if (
      tasks === undefined ||
      taskWorkspaces === undefined ||
      taskExecutions === undefined ||
      taskChecks === undefined ||
      taskReviews === undefined ||
      taskDeliveries === undefined ||
      taskActivity === undefined
    ) {
      throw notImplemented('tasks');
    }
    return {
      tasks,
      workspaces: taskWorkspaces,
      executions: taskExecutions,
      checks: taskChecks,
      reviews: taskReviews,
      deliveries: taskDeliveries,
      activity: taskActivity,
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Locks, background work and cancellation                                   */
  /* ------------------------------------------------------------------------ */

  const locks = new Map<Id, Promise<unknown>>();
  const background = new Set<Promise<unknown>>();
  /** The background step of a task that Stop can cancel (workspace setup, checks). */
  const aborts = new Map<Id, AbortController>();

  async function withLock<T>(taskId: Id, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(taskId) ?? Promise.resolve();
    const result = previous.then(fn, fn);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    locks.set(taskId, settled);
    try {
      return await result;
    } finally {
      if (locks.get(taskId) === settled) locks.delete(taskId);
    }
  }

  function track(work: () => Promise<unknown>): void {
    const promise = work().catch((error: unknown) => {
      logger.error({ subsystem: 'tasks', err: error }, 'background task step failed');
    });
    background.add(promise);
    void promise.finally(() => background.delete(promise));
  }

  /* ------------------------------------------------------------------------ */
  /* Reading                                                                   */
  /* ------------------------------------------------------------------------ */

  async function load(id: Id): Promise<TaskRecord> {
    const task = await repos().tasks.get(scope, id);
    if (task === null) throw notFound(`Task ${id}`);
    return task;
  }

  async function loadProject(projectId: Id): Promise<Project> {
    const project = await repository.projects.get(scope, projectId);
    if (project === null) throw notFound(`Project ${projectId}`);
    return project;
  }

  async function latestExecution(taskId: Id): Promise<TaskExecution | undefined> {
    return (await repos().executions.listByTask(scope, taskId)).at(-1);
  }

  async function contextFor(task: TaskRecord): Promise<ActionContext> {
    const [workspace, project, latest] = await Promise.all([
      repos().workspaces.getByTask(scope, task.id),
      repository.projects.get(scope, task.projectId),
      latestExecution(task.id),
    ]);
    return {
      workspaceReady: workspace?.status === 'ready',
      projectHasChecks: (project?.checkCommands ?? []).length > 0,
      hasActiveRun: aborts.has(task.id) || latest?.status === 'running',
      projectHasPreview: project?.previewCommand !== undefined && project.previewCommand !== null,
      pullRequestOpen: workspace?.pullRequest?.state === 'open',
    };
  }

  async function present(task: TaskRecord): Promise<Task> {
    return withActions(task, await contextFor(task));
  }

  async function assertAllowed(
    task: TaskRecord,
    action: Task['allowedActions'][number],
    verb: string,
  ): Promise<void> {
    if (!allowedTaskActions(task, await contextFor(task)).includes(action)) {
      throw invalidState(task, verb);
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Writing                                                                   */
  /* ------------------------------------------------------------------------ */

  /** Persists the task, appends the activity row and announces both in one `task.updated`. */
  async function commit(task: TaskRecord, activity?: ActivityInput): Promise<Task> {
    const stamped: TaskRecord = { ...task, updatedAt: now() };
    const saved = await repos().tasks.save(scope, stamped);
    let row: TaskActivity | undefined;
    if (activity !== undefined) {
      row = await repos().activity.append(scope, {
        id: nextId(),
        taskId: saved.id,
        kind: activity.kind,
        message: activity.message,
        ...(activity.executionId === undefined ? {} : { executionId: activity.executionId }),
        ...(activity.runId === undefined ? {} : { runId: activity.runId }),
        at: stamped.updatedAt,
      });
    }
    const presented = await present(saved);
    await bus.emit({
      type: 'task.updated',
      payload: { task: presented, ...(row === undefined ? {} : { activity: row }) },
    });
    if (saved.stage === 'done' && activity !== undefined && ENTERS_DONE.has(activity.kind)) {
      track(() => reachedDone(saved));
    }
    return presented;
  }

  /**
   * After a task reaches Done: the tasks waiting on its verified outcome start (D277), and a task
   * sent from a workflow's chat reports its outcome there (Send to Build).
   */
  async function reachedDone(task: TaskRecord): Promise<void> {
    await scheduler?.taskDone(task);
    const workflowId = task.source?.workflowId;
    if (workflowId !== undefined && deps.postNote !== undefined) {
      await deps.postNote(
        workflowId,
        `Task #${task.number} "${task.title}" reached Done: ${task.outcome ?? 'closed'}.`,
      );
    }
  }

  /** A task with the optional fields removed when they are `undefined`. */
  function set(task: TaskRecord, changes: Partial<TaskRecord>): TaskRecord {
    const next: Record<string, unknown> = { ...task, ...changes };
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined) delete next[key];
    }
    return next as TaskRecord;
  }

  /** A change of state: `stateReason` is cleared unless a new one is given. */
  function moveTo(
    task: TaskRecord,
    stage: TaskRecord['stage'],
    state: TaskRecord['state'],
    reason?: string,
  ): TaskRecord {
    return set(task, { stage, state, stateReason: reason });
  }

  async function settings(): Promise<{ approvalMode: ApprovalMode }> {
    const stored = await repository.settings.get(scope);
    return { approvalMode: stored.approvalMode ?? DEFAULT_APPROVAL_MODE };
  }

  /* ------------------------------------------------------------------------ */
  /* Validation of references                                                  */
  /* ------------------------------------------------------------------------ */

  async function assertWorkflowInProject(
    projectId: Id,
    workflowId: Id | null | undefined,
    field: string,
  ): Promise<void> {
    if (workflowId === undefined || workflowId === null) return;
    const workflow = await repository.workflows.get(scope, workflowId);
    if (workflow === null || workflow.projectId !== projectId) {
      throw invalidField(
        'invalid_reference',
        `The ${field} must be a workflow of this project; ${workflowId} is not.`,
      );
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Workspaces (D269)                                                          */
  /* ------------------------------------------------------------------------ */

  /**
   * The task's ready workspace, created (worktree + setup command) when it has none. Throws a
   * message meant for the card when it cannot.
   */
  async function ensureWorkspace(task: TaskRecord, signal: AbortSignal): Promise<TaskWorkspace> {
    const existing = await repos().workspaces.getByTask(scope, task.id);
    if (existing?.status === 'ready') return existing;
    if (existing !== null && (existing.status === 'applied' || existing.status === 'merged')) {
      throw new Error('This task was already delivered; start a new task for more changes.');
    }

    const project = await loadProject(task.projectId);
    const repo = await git.inspect(project.folderPath);
    if (!repo.gitAvailable) throw new Error('Git was not found on this computer.');
    if (!repo.isRepo) {
      throw new Error(
        'The project folder is not a Git repository. Initialize Git in the project settings.',
      );
    }
    if (repo.headSha === undefined) {
      throw new Error('The repository has no commit yet. Make a first commit, then retry.');
    }
    if (repo.branch === null || repo.branch === undefined) {
      throw new Error('The repository is on a detached HEAD. Check out a branch, then retry.');
    }

    const path = join(deps.workspaceRoot, task.id);
    if (existing !== null) {
      // An earlier attempt failed part-way: discard what it left before trying again.
      await git
        .removeWorktree({
          repoPath: existing.repoPath,
          worktreePath: existing.path,
          deleteBranch: existing.branch,
        })
        .catch(() => undefined);
    }

    const base = branchName(task);
    let branch = base;
    for (let suffix = 2; await git.branchExists(project.folderPath, branch); suffix += 1) {
      branch = `${base}-${suffix}`;
    }

    const { baseSha } = await git.createWorktree({
      repoPath: project.folderPath,
      worktreePath: path,
      branch,
      baseRef: repo.branch,
    });
    const timestamp = now();
    const workspace: TaskWorkspace = {
      id: existing?.id ?? nextId(),
      taskId: task.id,
      repoPath: project.folderPath,
      path,
      branch,
      baseBranch: repo.branch,
      baseSha,
      headSha: baseSha,
      status: 'ready',
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };

    if (project.setupCommand !== undefined && project.setupCommand !== null) {
      const result = await commands.run({
        command: project.setupCommand,
        cwd: path,
        ...(deps.commandEnv === undefined ? {} : { env: deps.commandEnv() }),
        timeoutMs: checkTimeoutMs,
        maxOutput: CHECK_OUTPUT_MAX,
        signal,
      });
      const status = checkStatusOf(result.exitCode, result.timedOut);
      await repos().checks.create(scope, {
        id: nextId(),
        taskId: task.id,
        name: SETUP_CHECK_NAME,
        command: project.setupCommand,
        status,
        ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
        output: tail(mask(result.output), CHECK_OUTPUT_MAX),
        durationMs: result.durationMs,
        headSha: baseSha,
        at: now(),
      });
      if (status !== 'passed') {
        const failed: TaskWorkspace = {
          ...workspace,
          status: 'error',
          error: `The setup command ${signal.aborted ? 'was stopped' : 'failed'}.`,
        };
        if (existing === null) await repos().workspaces.create(scope, failed);
        else await repos().workspaces.save(scope, failed);
        throw new Error(
          signal.aborted
            ? 'Stopped while the setup command ran.'
            : `The setup command failed (${status}). Its output is under Checks.`,
        );
      }
    }

    return existing === null
      ? repos().workspaces.create(scope, workspace)
      : repos().workspaces.save(scope, workspace);
  }

  function checkStatusOf(exitCode: number | null, timedOut: boolean): CheckStatus {
    if (timedOut) return 'timeout';
    if (exitCode === null) return 'error';
    return exitCode === 0 ? 'passed' : 'failed';
  }

  /* ------------------------------------------------------------------------ */
  /* Launching runs                                                             */
  /* ------------------------------------------------------------------------ */

  async function runningWorkCount(projectId: Id): Promise<number> {
    const tasks = await repos().tasks.listByProject(scope, projectId, {
      stage: 'work',
      states: ['running', 'waiting'],
    });
    return tasks.length;
  }

  /**
   * Starts a plan or work run for a task the caller holds the lock of. Validates synchronously,
   * marks the task running (or queued when the project's Build slots are full) and leaves the slow
   * part — the workspace, the run — to the background.
   */
  async function launch(
    task: TaskRecord,
    kind: ExecutionKind,
    request: string | undefined,
  ): Promise<Task> {
    const workflowId = kind === 'plan' ? task.plannerWorkflowId : task.workflowId;
    if (workflowId === undefined) {
      throw new HttpError(
        'invalid_config',
        'no_team',
        kind === 'plan'
          ? `Task #${task.number} has no planner workflow.`
          : `Task #${task.number} has no team. Choose the workflow that should do the work.`,
      );
    }
    const workflow = await repository.workflows.get(scope, workflowId);
    if (workflow === null || workflow.projectId !== task.projectId) {
      throw new HttpError(
        'invalid_config',
        'no_team',
        `The ${kind === 'plan' ? 'planner' : 'team'} workflow of task #${task.number} no longer exists.`,
      );
    }

    const stage = kind === 'plan' ? 'plan' : 'work';
    if (kind === 'work') {
      const project = await loadProject(task.projectId);
      const capacity = project.buildCapacity ?? DEFAULT_BUILD_CAPACITY;
      const inUse = await runningWorkCount(task.projectId);
      if (inUse >= capacity) {
        const queued = set(
          moveTo(
            task,
            'work',
            'queued',
            `Waiting for a Build slot (${inUse} of ${capacity} in use).`,
          ),
          {
            pendingRequest: request,
          },
        );
        return commit(queued, {
          kind: 'queued',
          message: `Queued: all ${capacity} Build slots are in use.`,
        });
      }
    }

    const previous = await latestExecution(task.id);
    const executions = await repos().executions.listByTask(scope, task.id);
    const execution = await repos().executions.create(scope, {
      id: nextId(),
      taskId: task.id,
      kind,
      sequence: executions.length + 1,
      workflowId,
      status: 'running',
      request: request ?? '',
      startedAt: now(),
    });

    const controller = new AbortController();
    aborts.set(task.id, controller);
    const running = set(
      moveTo(
        task,
        stage,
        'running',
        task.type === 'app' ? 'Preparing the workspace…' : 'Starting…',
      ),
      {
        pendingRequest: kind === 'work' ? request : task.pendingRequest,
        startedAt: task.startedAt ?? now(),
      },
    );
    const presented = await commit(running, {
      kind: 'run_started',
      message:
        kind === 'plan'
          ? 'Planning started.'
          : request === undefined
            ? 'Work started.'
            : 'Work started on the requested changes.',
      executionId: execution.id,
    });

    track(() => prepareAndRun(task.id, execution.id, previous, controller));
    return presented;
  }

  /** The background half of `launch`: workspace, prompt, run. */
  async function prepareAndRun(
    taskId: Id,
    executionId: Id,
    previous: TaskExecution | undefined,
    controller: AbortController,
  ): Promise<void> {
    const failExecution = async (message: string, stopped: boolean): Promise<void> => {
      await withLock(taskId, async () => {
        aborts.delete(taskId);
        const execution = await repos().executions.get(scope, executionId);
        if (execution === null || execution.status !== 'running') return;
        await repos().executions.save(scope, {
          ...execution,
          status: stopped ? 'stopped' : 'failed',
          ...(stopped ? {} : { error: message }),
          endedAt: now(),
        });
        const task = await load(taskId);
        const stage = execution.kind === 'plan' ? 'plan' : 'work';
        await commit(
          stopped
            ? moveTo(task, stage, 'idle', 'Stopped.')
            : moveTo(task, stage, 'failed', message),
          stopped
            ? { kind: 'run_stopped', message: 'Stopped before the run began.', executionId }
            : {
                kind:
                  execution.kind === 'plan' || task.type !== 'app'
                    ? 'run_failed'
                    : 'workspace_failed',
                message,
                executionId,
              },
        );
      });
      await dequeue((await load(taskId)).projectId);
    };

    let task = await load(taskId);
    let workspace: TaskWorkspace | null = null;
    if (task.type === 'app') {
      try {
        const before = await repos().workspaces.getByTask(scope, taskId);
        workspace = await ensureWorkspace(task, controller.signal);
        if (before?.status !== 'ready') {
          await withLock(taskId, async () => {
            const current = await load(taskId);
            await commit(set(current, { stateReason: 'Starting…' }), {
              kind: 'workspace_ready',
              message: `Workspace ready on branch ${workspace?.branch ?? ''} from ${workspace?.baseBranch ?? ''} (${shortSha(workspace?.baseSha)}).`,
              executionId,
            });
          });
        }
      } catch (error) {
        await failExecution(
          error instanceof Error ? error.message : String(error),
          controller.signal.aborted,
        );
        return;
      }
    }
    if (controller.signal.aborted) {
      await failExecution('Stopped.', true);
      return;
    }

    task = await load(taskId);
    const execution = await repos().executions.get(scope, executionId);
    if (execution === null) return;
    const nodes = await repository.nodes.listByWorkflow(scope, execution.workflowId);
    const inputs = nodes.filter((node) => node.kind === 'input');
    if (inputs.length === 0) {
      await failExecution('The team workflow has no Input node to give the task to.', false);
      return;
    }

    const text =
      execution.kind === 'plan'
        ? planPrompt(task)
        : workPrompt({
            task,
            workspace,
            request: execution.request === '' ? undefined : execution.request,
            previous: previous?.kind === 'work' ? previous : undefined,
            produce: deliverableInstructions(task),
          });

    const runId = nextId();
    // Linked before the run exists, so `folderForRun` answers the worktree from the first dispatch.
    await withLock(taskId, async () => {
      aborts.delete(taskId);
      const current = await repos().executions.get(scope, executionId);
      if (current !== null) await repos().executions.save(scope, { ...current, runId });
    });

    let run: Run;
    try {
      run = await deps.startRun(
        execution.workflowId,
        { inputs: Object.fromEntries(inputs.map((node) => [node.id, [{ type: 'text', text }]])) },
        runId,
      );
    } catch (error) {
      await withLock(taskId, async () => {
        const current = await repos().executions.get(scope, executionId);
        if (current !== null) {
          const { runId: _dropped, ...rest } = current;
          void _dropped;
          await repos().executions.save(scope, rest);
        }
      });
      await failExecution(
        `The run could not start: ${error instanceof Error ? error.message : String(error)}`,
        false,
      );
      return;
    }

    await withLock(taskId, async () => {
      const current = await load(taskId);
      if (current.state === 'running' && current.stateReason !== undefined) {
        await commit(set(current, { stateReason: undefined }), {
          kind: 'run_started',
          message: `Run ${run.id.slice(-6)} started.`,
          executionId,
          runId: run.id,
        });
      }
    });

    // A run that ended before its events could be mapped (pre-flight BLOCKED, a very fast run).
    const stored = (await repository.runs.get(scope, run.id)) ?? run;
    if (isTerminal(stored)) {
      await finishRun(stored);
      return;
    }
    const pending = await repository.approvals.listPendingByRun(scope, run.id);
    if (pending.length > 0) await markWaiting(run.id, pending[0]?.nodeName);
  }

  function isTerminal(run: Run): boolean {
    return run.status === 'COMPLETE' || run.status === 'HALTED' || run.status === 'BLOCKED';
  }

  /* ------------------------------------------------------------------------ */
  /* Run events                                                                 */
  /* ------------------------------------------------------------------------ */

  function runFailureReason(run: Run): string {
    if (run.status === 'BLOCKED') {
      const issues = run.preflightIssues.map((issue) => issue.message).join(' ');
      return issues === ''
        ? 'The run was blocked at pre-flight.'
        : `Blocked at pre-flight: ${issues}`;
    }
    switch (run.haltReason) {
      case 'budget_exceeded':
        return 'The run stopped: its budget was exceeded.';
      case 'shutdown':
      case 'crash':
        return ENGINE_STOPPED;
      default:
        return 'The run failed. Open it to see which step failed and why.';
    }
  }

  async function finishRun(run: Run): Promise<void> {
    const execution = await repos().executions.getByRun(scope, run.id);
    if (execution === null) return;
    let continuation: (() => Promise<void>) | undefined;

    await withLock(execution.taskId, async () => {
      const current = await repos().executions.get(scope, execution.id);
      if (current === null || current.status !== 'running') return;
      const task = await load(execution.taskId);
      const stage = current.kind === 'plan' ? 'plan' : 'work';
      const summary = outputText(run.finalOutput);

      if (run.status === 'COMPLETE') {
        const completed: TaskExecution = {
          ...current,
          status: 'completed',
          ...(summary === '' ? {} : { summary: summary.slice(0, EXECUTION_SUMMARY_MAX) }),
          endedAt: now(),
        };
        if (current.kind === 'plan') {
          await repos().executions.save(scope, completed);
          const planned = moveTo(
            set(task, { plan: summary.slice(0, TASK_PLAN_MAX) }),
            'plan',
            'idle',
          );
          await commit(planned, {
            kind: 'run_completed',
            message: 'Plan written.',
            executionId: current.id,
            runId: run.id,
          });
          continuation = () => afterPlan(task.id);
          return;
        }
        await repos().executions.save(scope, completed);
        await commit(
          set(task, {
            stateReason: task.type === 'app' ? 'Recording changes…' : undefined,
            // D275: a Document or Email task's run output is its draft.
            ...(task.type === 'app' ? {} : { deliverable: deliverableFromOutput(task, summary) }),
          }),
          {
            kind: 'run_completed',
            message: 'The run finished.',
            executionId: current.id,
            runId: run.id,
          },
        );
        continuation = () => afterWork(task.id, current.id);
        return;
      }

      const stopped = run.status === 'HALTED' && run.haltReason === 'stopped';
      await repos().executions.save(scope, {
        ...current,
        status: stopped ? 'stopped' : 'failed',
        ...(stopped ? {} : { error: runFailureReason(run) }),
        ...(summary === '' ? {} : { summary: summary.slice(0, EXECUTION_SUMMARY_MAX) }),
        endedAt: now(),
      });
      await commit(
        stopped
          ? moveTo(task, stage, 'idle', 'Stopped.')
          : moveTo(task, stage, 'failed', runFailureReason(run)),
        {
          kind: stopped ? 'run_stopped' : 'run_failed',
          message: stopped ? 'The run was stopped.' : runFailureReason(run),
          executionId: current.id,
          runId: run.id,
        },
      );
      if (stage === 'work') continuation = () => dequeue(task.projectId);
    });

    if (continuation !== undefined) await continuation();
  }

  async function markWaiting(runId: Id, nodeName: string | undefined): Promise<void> {
    const execution = await repos().executions.getByRun(scope, runId);
    if (execution === null) return;
    await withLock(execution.taskId, async () => {
      const task = await load(execution.taskId);
      if (task.state !== 'running') return;
      const reason = `Waiting for approval${nodeName === undefined ? '' : `: ${nodeName}`}.`;
      await commit(set(task, { state: 'waiting', stateReason: reason }), {
        kind: 'waiting',
        message: reason,
        executionId: execution.id,
        runId,
      });
    });
  }

  async function markResumed(runId: Id): Promise<void> {
    const execution = await repos().executions.getByRun(scope, runId);
    if (execution === null) return;
    await withLock(execution.taskId, async () => {
      const task = await load(execution.taskId);
      if (task.state !== 'waiting') return;
      // Another approval of the same run may still be open.
      const pending = await repository.approvals.listPendingByRun(scope, runId);
      if (pending.length > 0) return;
      await commit(set(task, { state: 'running', stateReason: undefined }), {
        kind: 'resumed',
        message: 'Approval answered; the run continues.',
        executionId: execution.id,
        runId,
      });
    });
  }

  /* ------------------------------------------------------------------------ */
  /* After a stage                                                              */
  /* ------------------------------------------------------------------------ */

  async function isPaused(task: TaskRecord): Promise<boolean> {
    if (task.paused) return true;
    return (await loadProject(task.projectId)).paused === true;
  }

  /** A plan was written: assisted and autopilot tasks go on to work. */
  async function afterPlan(taskId: Id): Promise<void> {
    await withLock(taskId, async () => {
      const task = await load(taskId);
      if (task.stage !== 'plan' || task.state !== 'idle') return;
      if (task.automation === 'manual' || task.workflowId === undefined) return;
      if (await isPaused(task)) {
        await commit(set(task, { stateReason: 'Paused — start work when ready.' }));
        return;
      }
      await launch(task, 'work', undefined);
    });
  }

  /** A work run finished: record its changes, run the checks, hand over to review. */
  async function afterWork(taskId: Id, executionId: Id): Promise<void> {
    let task = await load(taskId);
    const workspace = await repos().workspaces.getByTask(scope, taskId);

    if (task.type === 'app' && workspace?.status === 'ready') {
      let headSha = workspace.headSha;
      let changed = 0;
      try {
        const committed = await git.commitAll({
          cwd: workspace.path,
          message: `ACE task #${task.number}: ${task.title} (run ${(await repos().executions.get(scope, executionId))?.sequence ?? 1})`,
        });
        if (committed !== null) {
          changed = (
            await git.changes({
              cwd: workspace.path,
              baseSha: workspace.headSha,
              includeUncommitted: false,
              headRef: committed.sha,
            })
          ).files.length;
          headSha = committed.sha;
        }
      } catch (error) {
        await withLock(taskId, async () => {
          const current = await load(taskId);
          const message = `Could not record the changes: ${error instanceof Error ? error.message : String(error)}`;
          await commit(moveTo(current, 'work', 'failed', message), {
            kind: 'error',
            message,
            executionId,
          });
        });
        await dequeue(task.projectId);
        return;
      }

      await withLock(taskId, async () => {
        const execution = await repos().executions.get(scope, executionId);
        if (execution !== null) {
          await repos().executions.save(scope, {
            ...execution,
            changedFiles: changed,
            ...(headSha === workspace.headSha ? {} : { commitSha: headSha }),
          });
        }
        await repos().workspaces.save(scope, { ...workspace, headSha, updatedAt: now() });
        const current = await load(taskId);
        await commit(set(current, { stateReason: undefined }), {
          kind: 'committed',
          message:
            headSha === workspace.headSha
              ? 'The run changed no files.'
              : `Recorded ${changed} changed file${changed === 1 ? '' : 's'} in ${shortSha(headSha)}.`,
          executionId,
        });
      });

      task = await load(taskId);
      if (task.runChecks) {
        const project = await loadProject(task.projectId);
        if ((project.checkCommands ?? []).length > 0) {
          await runChecksNow(taskId, executionId, true);
        }
      }
    }

    let continuation: (() => Promise<void>) | undefined;
    await withLock(taskId, async () => {
      const current = await load(taskId);
      if (current.stage !== 'work' || current.state !== 'running') return;
      await commit(set(moveTo(current, 'review', 'idle'), { pendingRequest: undefined }), {
        kind: 'stage_changed',
        message: 'Ready for review.',
        executionId,
      });
      continuation = async () => {
        await autopilot(taskId);
        await dequeue(current.projectId);
      };
    });
    if (continuation !== undefined) await continuation();
  }

  /* ------------------------------------------------------------------------ */
  /* Checks (D271)                                                              */
  /* ------------------------------------------------------------------------ */

  /** Runs the project's checks in the task's workspace, recording each against the current head. */
  async function runChecksNow(
    taskId: Id,
    executionId: Id | undefined,
    announce: boolean,
  ): Promise<TaskCheck[]> {
    const task = await load(taskId);
    const workspace = await repos().workspaces.getByTask(scope, taskId);
    const project = await loadProject(task.projectId);
    const commandsToRun = project.checkCommands ?? [];
    if (workspace?.status !== 'ready' || commandsToRun.length === 0) return [];

    const controller = aborts.get(taskId) ?? new AbortController();
    aborts.set(taskId, controller);
    if (announce) {
      await withLock(taskId, async () => {
        const current = await load(taskId);
        await commit(set(current, { state: 'running', stateReason: 'Running checks…' }), {
          kind: 'checks_started',
          message: checksStartedMessage(commandsToRun.length),
          ...(executionId === undefined ? {} : { executionId }),
        });
      });
    }

    const results: TaskCheck[] = [];
    for (const check of commandsToRun) {
      if (controller.signal.aborted) break;
      const result = await commands.run({
        command: check.command,
        cwd: workspace.path,
        ...(deps.commandEnv === undefined ? {} : { env: deps.commandEnv() }),
        timeoutMs: checkTimeoutMs,
        maxOutput: CHECK_OUTPUT_MAX,
        signal: controller.signal,
      });
      results.push(
        await repos().checks.create(scope, {
          id: nextId(),
          taskId,
          ...(executionId === undefined ? {} : { executionId }),
          name: check.name,
          command: check.command,
          status: checkStatusOf(result.exitCode, result.timedOut),
          ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
          output: tail(mask(result.output), CHECK_OUTPUT_MAX),
          durationMs: result.durationMs,
          headSha: workspace.headSha,
          at: now(),
        }),
      );
    }
    aborts.delete(taskId);

    const failed = results.filter((check) => check.status !== 'passed');
    await withLock(taskId, async () => {
      const current = await load(taskId);
      await commit(set(current, { stateReason: undefined }), {
        kind: failed.length === 0 && !controller.signal.aborted ? 'checks_passed' : 'checks_failed',
        message: controller.signal.aborted
          ? 'Checks were stopped.'
          : failed.length === 0
            ? `All ${results.length} check${results.length === 1 ? '' : 's'} passed.`
            : `${failed.length} of ${results.length} check${results.length === 1 ? '' : 's'} failed: ${failed.map((check) => check.name).join(', ')}.`,
        ...(executionId === undefined ? {} : { executionId }),
      });
    });
    return results;
  }

  function checksStartedMessage(count: number): string {
    return `Running ${count} check${count === 1 ? '' : 's'}.`;
  }

  /** Whether the latest result of some check, for the workspace's head, is not a pass. */
  async function headChecksFailed(taskId: Id, headSha: string): Promise<string[]> {
    const checks = (await repos().checks.listByTask(scope, taskId)).filter(
      (check) => check.headSha === headSha && check.name !== SETUP_CHECK_NAME,
    );
    const latest = new Map<string, TaskCheck>();
    for (const check of checks) latest.set(check.name, check);
    return [...latest.values()]
      .filter((check) => check.status !== 'passed')
      .map((check) => check.name);
  }

  /* ------------------------------------------------------------------------ */
  /* Delivery                                                                   */
  /* ------------------------------------------------------------------------ */

  /**
   * Merges the task branch into the repository's current branch (D269). The caller holds the lock
   * and has checked the destination. Answers the task as it stands afterwards.
   */
  async function deliverLocally(
    task: TaskRecord,
    workspace: TaskWorkspace,
    branch: string,
    actor: 'user' | 'autopilot',
  ): Promise<Task> {
    const destination = `${workspace.repoPath} @ ${branch}`;
    const result = await git.merge({
      repoPath: workspace.repoPath,
      branch: workspace.branch,
      expectedBranch: branch,
      message: `ACE task #${task.number}: ${task.title}`,
    });
    const at = now();
    if (!result.ok) {
      const detail =
        result.reason === 'conflict'
          ? `${result.message}${result.conflicts.length === 0 ? '' : ` Conflicting files: ${result.conflicts.join(', ')}.`}`
          : result.message;
      await repos().deliveries.create(scope, {
        id: nextId(),
        taskId: task.id,
        kind: 'apply_local',
        status: 'failed',
        destination,
        detail,
        at,
      });
      const reason =
        result.reason === 'conflict'
          ? `The changes conflict with ${branch}. ${detail} Request changes or resolve it in the repository, then retry.`
          : result.reason === 'dirty'
            ? `The project folder has uncommitted changes in tracked files. Commit or stash them, then retry.`
            : `Apply failed: ${detail}`;
      return commit(moveTo(task, 'review', 'failed', reason), {
        kind: 'delivery_failed',
        message: reason,
      });
    }

    await repos().deliveries.create(scope, {
      id: nextId(),
      taskId: task.id,
      kind: 'apply_local',
      status: 'succeeded',
      destination,
      detail:
        actor === 'autopilot' ? 'Applied by Autopilot under Full access.' : 'Applied after review.',
      sha: result.sha,
      at,
    });
    await previews?.stopFor(task.id);
    await git
      .removeWorktree({ repoPath: workspace.repoPath, worktreePath: workspace.path })
      .catch((error: unknown) =>
        logger.warn(
          { subsystem: 'tasks', err: error, taskId: task.id },
          'worktree not removed after apply',
        ),
      );
    await repos().workspaces.save(scope, { ...workspace, status: 'applied', updatedAt: at });
    const done = set(moveTo(task, 'done', 'done'), {
      outcome: 'applied',
      completedAt: at,
      pendingRequest: undefined,
    });
    return commit(done, {
      kind: 'delivered',
      message: `Applied to ${destination} (${shortSha(result.sha)}).`,
    });
  }

  /** Autopilot's final action (design §2.2), run after work lands in review. */
  async function autopilot(taskId: Id): Promise<void> {
    await withLock(taskId, async () => {
      const task = await load(taskId);
      if (task.automation !== 'autopilot' || task.stage !== 'review' || task.state !== 'idle')
        return;
      const why: string[] = [];
      if ((await settings()).approvalMode !== 'full_access')
        why.push('the approval mode is not Full access');
      if (await isPaused(task)) why.push('the task or project is paused');
      const workspace = await repos().workspaces.getByTask(scope, taskId);
      if (task.type === 'app' && workspace !== null) {
        const failed = await headChecksFailed(taskId, workspace.headSha);
        if (failed.length > 0) why.push(`checks failed (${failed.join(', ')})`);
      }
      if (why.length > 0) {
        await commit(set(task, { stateReason: `Autopilot is waiting: ${why.join('; ')}.` }));
        return;
      }

      if (task.finishLine === 'review') {
        await repos().reviews.create(scope, {
          id: nextId(),
          taskId,
          decision: 'approved',
          note: 'Approved by Autopilot under Full access.',
          ...(workspace === null ? {} : { headSha: workspace.headSha }),
          at: now(),
        });
        await commit(
          set(moveTo(task, 'done', 'done'), { outcome: 'reviewed', completedAt: now() }),
          {
            kind: 'approved',
            message: 'Approved by Autopilot under Full access.',
          },
        );
        return;
      }
      if (task.finishLine === 'apply_local' && workspace?.status === 'ready') {
        const project = await loadProject(task.projectId);
        const repo = await git.inspect(project.folderPath);
        if (repo.branch === null || repo.branch === undefined) {
          await commit(
            set(task, {
              stateReason: 'Autopilot is waiting: the repository is on a detached HEAD.',
            }),
          );
          return;
        }
        await deliverLocally(task, workspace, repo.branch, 'autopilot');
        return;
      }
      await commit(
        set(task, {
          stateReason: `Autopilot is waiting: ${task.finishLine} needs a person in this version.`,
        }),
      );
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Capacity queue (design §2.3)                                               */
  /* ------------------------------------------------------------------------ */

  async function dequeue(projectId: Id): Promise<void> {
    const project = await repository.projects.get(scope, projectId);
    if (project === null || project.paused === true) return;
    const capacity = project.buildCapacity ?? DEFAULT_BUILD_CAPACITY;
    const queued = (await repos().tasks.listByProject(scope, projectId, { states: ['queued'] }))
      .filter((task) => !task.paused)
      .sort(
        (a, b) =>
          (PRIORITY_RANK.get(b.priority) ?? 0) - (PRIORITY_RANK.get(a.priority) ?? 0) ||
          a.updatedAt.localeCompare(b.updatedAt),
      );
    for (const candidate of queued) {
      if ((await runningWorkCount(projectId)) >= capacity) return;
      await withLock(candidate.id, async () => {
        const task = await load(candidate.id);
        if (task.state !== 'queued') return;
        await launch(set(task, { state: 'idle' }), 'work', task.pendingRequest);
      });
    }
  }

  /* ------------------------------------------------------------------------ */
  /* The service                                                                */
  /* ------------------------------------------------------------------------ */

  async function detail(id: Id): Promise<TaskDetail> {
    const task = await load(id);
    const [workspace, executions, checks, reviews, deliveries] = await Promise.all([
      repos().workspaces.getByTask(scope, id),
      repos().executions.listByTask(scope, id),
      repos().checks.listByTask(scope, id),
      repos().reviews.listByTask(scope, id),
      repos().deliveries.listByTask(scope, id),
    ]);
    const schedule = await scheduler?.get(id);
    const preview = previews?.info(id);
    return {
      task: await present(task),
      ...(workspace === null ? {} : { workspace }),
      ...(schedule === undefined ? {} : { schedule }),
      ...(preview === undefined ? {} : { preview }),
      executions,
      checks,
      reviews,
      deliveries,
    };
  }

  async function changeRange(id: Id): Promise<{
    workspace: TaskWorkspace;
    cwd: string;
    includeUncommitted: boolean;
    headRef?: string;
  }> {
    const task = await load(id);
    const workspace = await repos().workspaces.getByTask(scope, id);
    if (workspace === null || workspace.status === 'removed' || workspace.status === 'error') {
      throw new HttpError(
        'workflow',
        'no_workspace',
        `Task #${task.number} has no workspace to compare.`,
      );
    }
    if (workspace.status === 'ready') {
      return { workspace, cwd: workspace.path, includeUncommitted: task.state === 'running' };
    }
    // Delivered: the worktree is gone, the branch remains in the source repository.
    return {
      workspace,
      cwd: workspace.repoPath,
      includeUncommitted: false,
      headRef: workspace.headSha,
    };
  }

  /* ------------------------------------------------------------------------ */
  /* P1 feature modules (D275–D278)                                             */
  /* ------------------------------------------------------------------------ */

  const kernel: TaskKernel = {
    repository,
    scope,
    bus,
    logger,
    now,
    nextId,
    repos,
    load,
    loadProject,
    withLock,
    track,
    commit,
    set,
    moveTo,
    assertAllowed,
    present,
    settings,
    headChecksFailed,
    isPaused,
    mask,
    commandEnv: async () => deps.commandEnv?.(),
    createTask: (projectId, body) => service.create(projectId, body),
    startTask: (id) => service.start(id),
  };
  const files = deps.files ?? createNodeDeliverableFiles();
  const previews: PreviewManager | undefined =
    deps.preview === undefined ? undefined : createPreviewManager(kernel, deps.preview);
  const scheduler: TaskScheduler | undefined =
    repository.taskSchedules === undefined
      ? undefined
      : createTaskScheduler(kernel, repository.taskSchedules);

  const service: TaskService = {
    async list(projectId, query) {
      await loadProject(projectId);
      const records = await repos().tasks.listByProject(scope, projectId, {
        ...(query.stage === undefined ? {} : { stage: query.stage }),
      });
      const needle = query.q?.toLowerCase();
      const filtered = records.filter((task) => {
        if (query.label !== undefined && !task.labels.includes(query.label)) return false;
        if (query.attention === true && !needsAttention(task)) return false;
        if (needle !== undefined) {
          const haystack =
            `#${task.number} ${task.title} ${task.brief} ${task.labels.join(' ')}`.toLowerCase();
          if (!haystack.includes(needle)) return false;
        }
        return true;
      });
      return Promise.all(filtered.map((task) => present(task)));
    },

    async create(projectId, body) {
      await loadProject(projectId);
      await assertWorkflowInProject(projectId, body.workflowId, 'workflowId');
      await assertWorkflowInProject(projectId, body.plannerWorkflowId, 'plannerWorkflowId');
      const type = body.type ?? 'app';
      const timestamp = now();
      const record: TaskRecord = {
        id: nextId(),
        projectId,
        number: await repos().tasks.nextNumber(scope, projectId),
        title: body.title,
        brief: body.brief ?? '',
        type,
        stage: 'inbox',
        state: 'idle',
        finishLine: body.finishLine ?? DEFAULT_FINISH_LINE[type],
        automation: body.automation ?? DEFAULT_TASK_AUTOMATION,
        priority: body.priority ?? 'normal',
        labels: [...new Set(body.labels ?? [])],
        ...(body.workflowId === undefined ? {} : { workflowId: body.workflowId }),
        ...(body.plannerWorkflowId === undefined
          ? {}
          : { plannerWorkflowId: body.plannerWorkflowId }),
        plan: '',
        acceptance: body.acceptance ?? '',
        runChecks: body.runChecks ?? true,
        paused: false,
        ...(body.source === undefined ? {} : { source: body.source }),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const deliverable = initialDeliverable(type, body);
      if (deliverable !== undefined) record.deliverable = deliverable;
      if (body.trigger !== undefined && scheduler === undefined) throw notImplemented('schedules');
      const created = await repos().tasks.create(scope, record);
      const presented = await commit(created, {
        kind: 'created',
        message:
          body.source?.kind === 'chat' || body.source?.kind === 'timeline'
            ? 'Task created from a chat message.'
            : 'Task created in the Inbox.',
      });
      if (body.trigger !== undefined && scheduler !== undefined) {
        await scheduler.put(created.id, { trigger: body.trigger });
        return present(await load(created.id));
      }
      if (body.start === 'now') return service.start(created.id);
      return presented;
    },

    get: detail,

    async update(id, patch) {
      return withLock(id, async () => {
        const task = await load(id);
        if (
          task.stage === 'done' &&
          (patch.stage !== undefined || patch.finishLine !== undefined)
        ) {
          throw invalidState(task, 'change its stage or finish line');
        }
        await assertWorkflowInProject(task.projectId, patch.workflowId, 'workflowId');
        await assertWorkflowInProject(task.projectId, patch.plannerWorkflowId, 'plannerWorkflowId');
        if (patch.finishLine !== undefined && !finishLineFits(task.type, patch.finishLine)) {
          throw invalidField(
            'invalid_finish_line',
            `A ${task.type} task cannot finish with ${patch.finishLine}.`,
          );
        }
        let next = set(task, {
          ...(patch.title === undefined ? {} : { title: patch.title }),
          ...(patch.brief === undefined ? {} : { brief: patch.brief }),
          ...(patch.plan === undefined ? {} : { plan: patch.plan }),
          ...(patch.acceptance === undefined ? {} : { acceptance: patch.acceptance }),
          ...(patch.workflowId === undefined ? {} : { workflowId: patch.workflowId ?? undefined }),
          ...(patch.plannerWorkflowId === undefined
            ? {}
            : { plannerWorkflowId: patch.plannerWorkflowId ?? undefined }),
          ...(patch.finishLine === undefined ? {} : { finishLine: patch.finishLine }),
          ...(patch.automation === undefined ? {} : { automation: patch.automation }),
          ...(patch.priority === undefined ? {} : { priority: patch.priority }),
          ...(patch.labels === undefined ? {} : { labels: [...new Set(patch.labels)] }),
          ...(patch.runChecks === undefined ? {} : { runChecks: patch.runChecks }),
        });
        if (patch.stage !== undefined && patch.stage !== task.stage) {
          await assertAllowed(task, 'move', `move to ${patch.stage}`);
          next = moveTo(next, patch.stage, 'idle');
          return commit(next, { kind: 'stage_changed', message: `Moved to ${patch.stage}.` });
        }
        return commit(next, { kind: 'edited', message: 'Task edited.' });
      });
    },

    async remove(id) {
      await withLock(id, async () => {
        const task = await load(id);
        await assertAllowed(task, 'delete', 'be deleted');
        await previews?.stopFor(id);
        const workspace = await repos().workspaces.getByTask(scope, id);
        if (workspace !== null && (workspace.status === 'ready' || workspace.status === 'error')) {
          await git
            .removeWorktree({
              repoPath: workspace.repoPath,
              worktreePath: workspace.path,
              deleteBranch: workspace.branch,
            })
            .catch((error: unknown) =>
              logger.warn(
                { subsystem: 'tasks', err: error, taskId: id },
                'worktree not removed with its task',
              ),
            );
        }
        await repos().tasks.delete(scope, id);
        await bus.emit({
          type: 'task.deleted',
          payload: { taskId: id, projectId: task.projectId },
        });
      });
    },

    async activity(id) {
      await load(id);
      return repos().activity.listByTask(scope, id);
    },

    async start(id) {
      return withLock(id, async () => {
        const task = await load(id);
        await assertAllowed(task, 'start', 'start');
        const started = set(moveTo(task, 'plan', 'idle'), { startedAt: task.startedAt ?? now() });
        if (task.plannerWorkflowId !== undefined) return launch(started, 'plan', undefined);
        if (task.workflowId !== undefined) return launch(started, 'work', undefined);
        return commit(set(started, { stateReason: 'Choose a team to start work.' }), {
          kind: 'stage_changed',
          message: 'Started — write the plan, choose a team, then start work.',
        });
      });
    },

    async plan(id) {
      return withLock(id, async () => {
        const task = await load(id);
        await assertAllowed(task, 'plan', 'start planning');
        return launch(task, 'plan', undefined);
      });
    },

    async work(id, body) {
      return withLock(id, async () => {
        const task = await load(id);
        await assertAllowed(task, 'work', 'start work');
        return launch(task, 'work', body.message ?? task.pendingRequest);
      });
    },

    async stop(id) {
      return withLock(id, async () => {
        const task = await load(id);
        if (task.state === 'queued') {
          return commit(
            set(moveTo(task, 'work', 'idle', 'Taken out of the queue.'), {
              pendingRequest: task.pendingRequest,
            }),
            {
              kind: 'run_stopped',
              message: 'Taken out of the Build queue.',
            },
          );
        }
        await assertAllowed(task, 'stop', 'be stopped');
        aborts.get(id)?.abort();
        const latest = await latestExecution(id);
        if (latest?.status === 'running' && latest.runId !== undefined) {
          await deps
            .stopRun(latest.runId)
            .catch((error: unknown) =>
              logger.warn({ subsystem: 'tasks', err: error, taskId: id }, 'run stop refused'),
            );
        }
        return present(await load(id));
      });
    },

    async retry(id) {
      return withLock(id, async () => {
        const task = await load(id);
        await assertAllowed(task, 'retry', 'be retried');
        if (task.stage === 'review') {
          return commit(moveTo(task, 'review', 'idle'), {
            kind: 'retried',
            message: 'Back in review.',
          });
        }
        const latest = await latestExecution(id);
        if (
          task.stage === 'plan' &&
          task.plannerWorkflowId !== undefined &&
          latest?.kind !== 'work'
        ) {
          return launch(task, 'plan', undefined);
        }
        if (task.workflowId === undefined) {
          return commit(moveTo(task, task.stage, 'idle'), {
            kind: 'retried',
            message: 'Cleared the failure.',
          });
        }
        const request =
          task.pendingRequest ??
          (latest?.kind === 'work' && latest.request !== '' ? latest.request : undefined);
        return launch(task, 'work', request);
      });
    },

    async runChecks(id) {
      return withLock(id, async () => {
        const task = await load(id);
        await assertAllowed(task, 'checks', 'run its checks');
        const project = await loadProject(task.projectId);
        const previousState = task.state;
        aborts.set(id, new AbortController());
        const running = await commit(
          set(task, { state: 'running', stateReason: 'Running checks…' }),
          {
            kind: 'checks_started',
            message: checksStartedMessage((project.checkCommands ?? []).length),
          },
        );
        track(async () => {
          try {
            await runChecksNow(id, undefined, false);
          } finally {
            aborts.delete(id);
            await withLock(id, async () => {
              const current = await load(id);
              if (current.state === 'running') {
                await commit(
                  set(current, {
                    state: previousState === 'failed' ? 'failed' : 'idle',
                    stateReason: undefined,
                  }),
                );
              }
            });
          }
        });
        return running;
      });
    },

    async review(id, body) {
      return withLock(id, async () => {
        const task = await load(id);
        await assertAllowed(
          task,
          body.decision === 'approved' ? 'approve' : 'request_changes',
          body.decision === 'approved' ? 'be approved' : 'take a change request',
        );
        const workspace = await repos().workspaces.getByTask(scope, id);
        if (
          body.headSha !== undefined &&
          workspace !== null &&
          body.headSha !== workspace.headSha
        ) {
          throw new HttpError(
            'workflow',
            'stale_review',
            `The task's changes moved to ${shortSha(workspace.headSha)} after the review of ${shortSha(body.headSha)}; review them again.`,
            { headSha: workspace.headSha },
          );
        }
        const headSha = workspace?.status === 'ready' ? workspace.headSha : undefined;
        await repos().reviews.create(scope, {
          id: nextId(),
          taskId: id,
          decision: body.decision,
          ...(body.note === undefined ? {} : { note: body.note }),
          ...(headSha === undefined ? {} : { headSha }),
          at: now(),
        });

        if (body.decision === 'changes_requested') {
          const noted = set(task, { pendingRequest: body.note });
          if (task.workflowId === undefined) {
            return commit(
              moveTo(noted, 'work', 'idle', 'Changes requested — choose a team to continue.'),
              {
                kind: 'changes_requested',
                message: `Changes requested: ${body.note ?? ''}`,
              },
            );
          }
          await repos().activity.append(scope, {
            id: nextId(),
            taskId: id,
            kind: 'changes_requested',
            message: `Changes requested: ${body.note ?? ''}`,
            at: now(),
          });
          return launch(noted, 'work', body.note);
        }

        if (task.finishLine === 'review') {
          return commit(
            set(moveTo(task, 'done', 'done'), { outcome: 'reviewed', completedAt: now() }),
            {
              kind: 'approved',
              message: `Approved${headSha === undefined ? '' : ` at ${shortSha(headSha)}`} — the task passed review.`,
            },
          );
        }
        return commit(moveTo(task, 'review', 'idle'), {
          kind: 'approved',
          message: `Approved${headSha === undefined ? '' : ` at ${shortSha(headSha)}`}. Apply the changes when ready.`,
        });
      });
    },

    async apply(id, body) {
      return withLock(id, async () => {
        const task = await load(id);
        await assertAllowed(task, 'apply', 'be applied');
        const workspace = await repos().workspaces.getByTask(scope, id);
        if (workspace?.status !== 'ready') {
          throw new HttpError(
            'workflow',
            'no_workspace',
            `Task #${task.number} has no workspace to apply.`,
          );
        }
        const failedChecks = await headChecksFailed(id, workspace.headSha);
        if (failedChecks.length > 0) {
          throw new HttpError(
            'workflow',
            'checks_failed',
            `Checks failed on ${shortSha(workspace.headSha)}: ${failedChecks.join(', ')}. Request changes or close the task.`,
            { checks: failedChecks },
          );
        }
        const project = await loadProject(task.projectId);
        const repo = await git.inspect(project.folderPath);
        if (
          !samePath(body.destination.folderPath, project.folderPath) ||
          repo.branch !== body.destination.branch
        ) {
          throw new HttpError(
            'workflow',
            'destination_changed',
            `The repository is now ${project.folderPath} @ ${repo.branch ?? '(detached HEAD)'}, not the destination you confirmed. Check it and apply again.`,
            { folderPath: project.folderPath, branch: repo.branch ?? null },
          );
        }
        const worktreeHead = await git.headSha(workspace.path);
        const { uncommitted } = await git.changes({
          cwd: workspace.path,
          baseSha: workspace.baseSha,
          includeUncommitted: false,
        });
        if (worktreeHead !== workspace.headSha || uncommitted) {
          throw invalidState(
            set(task, {}),
            'be applied: its workspace changed after it was reviewed — run its checks or a work run so the change is recorded',
          );
        }
        return deliverLocally(task, workspace, body.destination.branch, 'user');
      });
    },

    async close(id, body) {
      return withLock(id, async () => {
        const task = await load(id);
        await assertAllowed(task, 'close', 'be closed');
        const closed = set(moveTo(task, 'done', 'done', body.reason), {
          outcome: 'closed_unverified',
          completedAt: now(),
        });
        return commit(closed, {
          kind: 'closed',
          message: `Closed without verification${body.reason === undefined ? '.' : `: ${body.reason}`}`,
        });
      });
    },

    async pause(id, paused) {
      let resumed: TaskRecord | undefined;
      const answer = await withLock(id, async () => {
        const task = await load(id);
        await assertAllowed(task, paused ? 'pause' : 'resume', paused ? 'be paused' : 'be resumed');
        const next = set(task, { paused });
        if (!paused) resumed = next;
        return commit(next, {
          kind: paused ? 'paused' : 'unpaused',
          message: paused
            ? 'Paused: no automatic step will start; a run already going finishes.'
            : 'Resumed.',
        });
      });
      if (resumed !== undefined) {
        const task = resumed;
        if (task.state === 'queued') await dequeue(task.projectId);
        else if (task.stage === 'plan' && task.state === 'idle' && task.plan.trim() !== '')
          await afterPlan(id);
        return present(await load(id));
      }
      return answer;
    },

    async changes(id) {
      const range = await changeRange(id);
      const { files, uncommitted } = await git.changes({
        cwd: range.cwd,
        baseSha: range.workspace.baseSha,
        includeUncommitted: range.includeUncommitted,
        ...(range.headRef === undefined ? {} : { headRef: range.headRef }),
      });
      return {
        branch: range.workspace.branch,
        baseBranch: range.workspace.baseBranch,
        baseSha: range.workspace.baseSha,
        headSha: range.workspace.headSha,
        uncommitted: range.workspace.status === 'ready' && uncommitted,
        files,
        totals: {
          files: files.length,
          additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
          deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
        },
      };
    },

    async fileDiff(id, path) {
      if (path.trim() === '' || isAbsolute(path) || path.split(/[\\/]/).includes('..')) {
        throw invalidField(
          'invalid_path',
          'The path must be a relative path inside the repository.',
        );
      }
      const range = await changeRange(id);
      const diff = await git.fileDiff({
        cwd: range.cwd,
        baseSha: range.workspace.baseSha,
        path,
        includeUncommitted: range.includeUncommitted,
        maxBytes: FILE_DIFF_MAX,
        ...(range.headRef === undefined ? {} : { headRef: range.headRef }),
      });
      return { path, ...diff };
    },

    async repository(projectId) {
      const project = await loadProject(projectId);
      const status = await git.inspect(project.folderPath);
      const github = parseGitHubRemote(status.remoteUrl);
      return {
        folderPath: project.folderPath,
        gitAvailable: status.gitAvailable,
        isRepo: status.isRepo,
        ...(status.isRepo ? { branch: status.branch ?? null } : {}),
        ...(status.headSha === undefined ? {} : { headSha: status.headSha }),
        ...(status.clean === undefined ? {} : { clean: status.clean }),
        ...(status.changedFiles === undefined ? {} : { changedFiles: status.changedFiles }),
        ...(status.remoteUrl === undefined ? {} : { remoteUrl: status.remoteUrl }),
        ...(github === undefined ? {} : { github }),
      };
    },

    async initRepository(projectId) {
      const project = await loadProject(projectId);
      const status = await git.inspect(project.folderPath);
      if (!status.gitAvailable) {
        throw new HttpError(
          'invalid_config',
          'not_a_repository',
          'Git was not found on this computer.',
        );
      }
      if (status.isRepo) {
        throw new HttpError(
          'workflow',
          'already_repository',
          `${project.folderPath} is already a Git repository.`,
        );
      }
      await git.init(project.folderPath);
      return service.repository(projectId);
    },

    async folderForRun(runId) {
      let current: Id | undefined = runId;
      for (let depth = 0; current !== undefined && depth < 20; depth += 1) {
        const execution = await repos().executions.getByRun(scope, current);
        if (execution !== null) {
          const workspace = await repos().workspaces.getByTask(scope, execution.taskId);
          return workspace?.status === 'ready'
            ? { task: true, folder: workspace.path }
            : { task: true };
        }
        const run: Run | null = await repository.runs.get(scope, current);
        current = run?.restartedFromRunId;
      }
      return { task: false };
    },

    async projectChanged(projectId) {
      await dequeue(projectId);
      const planned = await repos().tasks.listByProject(scope, projectId, {
        stage: 'plan',
        states: ['idle'],
      });
      for (const task of planned) {
        if (task.plan.trim() !== '' && task.automation !== 'manual') await afterPlan(task.id);
      }
    },

    async beforeProjectDelete(projectId) {
      const tasks = await repos().tasks.listByProject(scope, projectId);
      for (const task of tasks) {
        aborts.get(task.id)?.abort();
        const latest = await latestExecution(task.id);
        if (latest?.status === 'running' && latest.runId !== undefined) {
          await deps.stopRun(latest.runId).catch(() => undefined);
        }
        const workspace = await repos().workspaces.getByTask(scope, task.id);
        if (workspace !== null && (workspace.status === 'ready' || workspace.status === 'error')) {
          await git
            .removeWorktree({ repoPath: workspace.repoPath, worktreePath: workspace.path })
            .catch((error: unknown) =>
              logger.warn(
                { subsystem: 'tasks', err: error, taskId: task.id },
                'worktree not removed with its project',
              ),
            );
        }
      }
    },

    async attach() {
      const unsubscribe = await bus.subscribe((event) => {
        if (event.type === 'run.completed' && event.runId !== undefined) {
          const runId = event.runId;
          track(async () => {
            const run = await repository.runs.get(scope, runId);
            if (run !== null) await finishRun(run);
          });
        } else if (event.type === 'node.approval_required' && event.runId !== undefined) {
          const runId = event.runId;
          const payload = event.payload as { request?: { nodeName?: string } };
          track(() => markWaiting(runId, payload.request?.nodeName));
        } else if (event.type === 'node.approval_decided' && event.runId !== undefined) {
          const runId = event.runId;
          track(() => markResumed(runId));
        }
      });

      // Recovery (design §2.4): whatever a stopped engine left mid-flight.
      track(async () => {
        const stuck = await repos().tasks.listByStates(scope, ['running', 'waiting']);
        for (const task of stuck) {
          const latest = await latestExecution(task.id);
          if (latest?.status === 'running' && latest.runId !== undefined) {
            const run = await repository.runs.get(scope, latest.runId);
            if (run !== null && isTerminal(run)) {
              await finishRun(run);
              continue;
            }
            if (run !== null && run.status !== 'PREFLIGHT') continue;
          }
          await withLock(task.id, async () => {
            const current = await load(task.id);
            if (current.state !== 'running' && current.state !== 'waiting') return;
            if (latest?.status === 'running') {
              await repos().executions.save(scope, {
                ...latest,
                status: 'failed',
                error: ENGINE_STOPPED,
                endedAt: now(),
              });
            }
            const stage =
              current.stage === 'inbox' || current.stage === 'done' ? 'work' : current.stage;
            await commit(moveTo(current, stage, 'failed', ENGINE_STOPPED), {
              kind: 'error',
              message: ENGINE_STOPPED,
            });
          });
        }
        const queued = await repos().tasks.listByStates(scope, ['queued']);
        for (const projectId of new Set(queued.map((task) => task.projectId)))
          await dequeue(projectId);
      });

      const stopScheduler =
        scheduler === undefined ? () => undefined : await scheduler.start(deps.schedulerTickMs);
      return () => {
        unsubscribe();
        stopScheduler();
      };
    },

    async idle() {
      while (background.size > 0) {
        await Promise.allSettled([...background]);
      }
    },

    async shutdown() {
      for (const controller of aborts.values()) controller.abort();
      await previews?.stopAll();
      await service.idle();
    },

    putDeliverable: (id, body) => putDeliverable(kernel, id, body),
    accept: (id, body) => acceptDeliverable(kernel, files, id, body),
    send: (id) => sendDeliverable(kernel, id),

    openPullRequest(id, body) {
      if (deps.github === undefined) throw notImplemented('GitHub delivery');
      return openPullRequest(kernel, git, deps.github, id, body);
    },
    mergePullRequest(id, body) {
      if (deps.github === undefined) throw notImplemented('GitHub delivery');
      return mergePullRequest(kernel, git, deps.github, id, body, async (task) => {
        await previews?.stopFor(task.id);
      });
    },

    startPreview(id) {
      if (previews === undefined) throw notImplemented('previews');
      return previews.start(id);
    },
    stopPreview(id) {
      if (previews === undefined) throw notImplemented('previews');
      return previews.stop(id);
    },

    putSchedule(id, body) {
      if (scheduler === undefined) throw notImplemented('schedules');
      return scheduler.put(id, body);
    },
    async tickSchedules() {
      await scheduler?.tick();
      await service.idle();
    },

    async removeSchedule(id) {
      if (scheduler === undefined) throw notImplemented('schedules');
      await load(id);
      await scheduler.remove(id);
    },

    async cloneProject(body) {
      if (deps.github === undefined || deps.createProject === undefined) {
        throw notImplemented('Clone from GitHub');
      }
      const repoName = /([^/]+?)(?:\.git)?\/?$/.exec(body.repo.trim())?.[1] ?? 'project';
      const folderPath = body.folderPath ?? join(deps.projectsRoot ?? deps.workspaceRoot, repoName);
      const status = await deps.github.status();
      if (!status.installed || !status.loggedIn) {
        throw new HttpError(
          'invalid_config',
          'not_connected',
          status.detail ?? 'The GitHub CLI is not signed in. Run gh auth login in a terminal.',
        );
      }
      try {
        await deps.github.clone({ repo: body.repo, folder: folderPath });
      } catch (error) {
        throw new HttpError(
          'invalid_config',
          'delivery_failed',
          `Cloning ${body.repo} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return deps.createProject({ name: body.name ?? repoName, folderPath });
    },
  };

  return service;
}
