import {
  DEFAULT_BUILD_CAPACITY,
  DEFAULT_FINISH_LINE,
  DEFAULT_TASK_AUTOMATION,
  TASK_PRIORITIES,
  finishLineFits,
  type ApplyTaskRequest,
  type ChangedFile,
  type CheckCommand,
  type CreateTaskRequest,
  type ErrorKind,
  type ExecutionKind,
  type RepositoryInfo,
  type ReviewTaskRequest,
  type Task,
  type TaskAction,
  type TaskActivity,
  type TaskActivityKind,
  type TaskChanges,
  type TaskCheck,
  type TaskDetail,
  type TaskExecution,
  type TaskFileDiff,
  type TaskWorkspace,
  type UpdateTaskRequest,
} from '@ace/contracts';

import { newId } from '../lib/ulid';
import { fakeSha, type MockDb } from './db';
import { allowedTaskActions } from './task-actions';

/**
 * The mock tasks engine (ACE parity P0, design §2–§6): the real state machine's shape — stages,
 * states, allowed actions, capacity, automation, reviews, Apply — without Git. A work run "changes"
 * two fixed files after the work pace, records a commit, runs the checks and lands in Review; every
 * state change is announced as one `task.updated` on the engine scope, a delete as `task.deleted`.
 *
 * Knobs, like the run and ingest paces (D200): `setTaskWorkPace` (`'manual'` holds every run until a
 * test calls `completeMockWork`), `failNextWork`, `failNextChecks`, `failNextApply`.
 */

/* -------------------------------------------------------------------------- */
/* Knobs                                                                       */
/* -------------------------------------------------------------------------- */

/** How long a plan or work run takes before it completes, in ms; `'manual'` waits for a test. */
let workPace: number | 'manual' = 800;
export function setTaskWorkPace(pace: number | 'manual'): void {
  workPace = pace === 'manual' ? pace : Math.max(0, pace);
}

let failNextWorkReason: string | undefined;
/** The next run fails with this reason instead of completing (a Retry story). */
export function failNextWork(reason: string | false = 'The mock agent could not finish.'): void {
  failNextWorkReason = reason === false ? undefined : reason;
}

let failNextChecksOn = false;
/** The next checks fail their first command (an Apply-is-blocked story). */
export function failNextChecks(on = true): void {
  failNextChecksOn = on;
}

let failNextApplyReason: string | undefined;
/** The next Apply hits a merge conflict: delivery `failed`, the task (review, failed). */
export function failNextApply(reason: string | false = 'Merge conflict in src/search.ts.'): void {
  failNextApplyReason = reason === false ? undefined : reason;
}

/** Every pending completion, by task: one run at a time per task. */
const pending = new Map<
  string,
  { run: () => void; timer: ReturnType<typeof setTimeout> | undefined }
>();

function schedule(taskId: string, run: () => void): void {
  cancelPending(taskId);
  const entry = {
    run,
    timer:
      workPace === 'manual'
        ? undefined
        : setTimeout(() => {
            pending.delete(taskId);
            run();
          }, workPace),
  };
  pending.set(taskId, entry);
}

function cancelPending(taskId: string): void {
  const entry = pending.get(taskId);
  if (entry?.timer !== undefined) clearTimeout(entry.timer);
  pending.delete(taskId);
}

/** Finish this task's running plan or work run now. Answers whether one was waiting. */
export function completeMockWork(taskId: string): boolean {
  const entry = pending.get(taskId);
  if (entry === undefined) return false;
  cancelPending(taskId);
  entry.run();
  return true;
}

/** The tasks with a run still to complete — what a test waits on. */
export function pendingMockWork(): string[] {
  return [...pending.keys()];
}

/** Every pending run dropped and every knob back to its default: what a test calls between cases. */
export function resetMockTasks(): void {
  for (const taskId of [...pending.keys()]) cancelPending(taskId);
  workPace = 800;
  failNextWorkReason = undefined;
  failNextChecksOn = false;
  failNextApplyReason = undefined;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/** A refusal the handlers turn into the `ApiError` envelope (design §6). */
export class TaskEngineError extends Error {
  constructor(
    readonly status: number,
    readonly kind: ErrorKind,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const taskNotFound = () =>
  new TaskEngineError(404, 'workflow', 'task_not_found', 'Task not found.');

const ACTION_WORDS: Readonly<Record<TaskAction, string>> = {
  start: 'start',
  plan: 'start planning',
  work: 'start work',
  stop: 'stop',
  retry: 'retry',
  checks: 'run checks',
  approve: 'be approved',
  request_changes: 'have changes requested',
  apply: 'be applied',
  close: 'be closed',
  pause: 'be paused',
  resume: 'be resumed',
  move: 'move',
  delete: 'be deleted',
  accept: 'be accepted',
  send: 'be sent',
  open_pr: 'open a pull request',
  merge_pr: 'merge its pull request',
  preview: 'start a preview',
};

/* -------------------------------------------------------------------------- */
/* Fixed changes (no Git in the browser)                                       */
/* -------------------------------------------------------------------------- */

const SEARCH_PATCH = [
  'diff --git a/src/search.ts b/src/search.ts',
  'index 3b18e51..9f2c7aa 100644',
  '--- a/src/search.ts',
  '+++ b/src/search.ts',
  '@@ -1,8 +1,17 @@',
  " import { items } from './data';",
  ' ',
  '-export function search(query: string) {',
  '-  const q = query.toLowerCase();',
  '-  return items.filter((item) => item.name.toLowerCase().includes(q));',
  '+/** Lower-case and strip accents, so "Café" finds "cafe". */',
  '+export function normalize(text: string): string {',
  '+  return text',
  "+    .normalize('NFD')",
  "+    .replace(/\\p{Diacritic}/gu, '')",
  '+    .toLowerCase();',
  '+}',
  '+',
  '+export function search(query: string) {',
  '+  const q = normalize(query.trim());',
  "+  if (q === '') return [];",
  '+  return items.filter((item) => normalize(item.name).includes(q));',
  ' }',
  ' ',
  ' export const MAX_RESULTS = 50;',
  '',
].join('\n');

const SEARCH_TEST_LINES = [
  "import { describe, expect, it } from 'vitest';",
  '',
  "import { normalize, search } from './search';",
  '',
  "describe('normalize', () => {",
  "  it('lower-cases', () => {",
  "    expect(normalize('CAFE')).toBe('cafe');",
  '  });',
  '',
  "  it('strips accents', () => {",
  "    expect(normalize('Café')).toBe('cafe');",
  "    expect(normalize('Ångström')).toBe('angstrom');",
  '  });',
  '',
  "  it('leaves plain text alone', () => {",
  "    expect(normalize('search')).toBe('search');",
  '  });',
  '});',
  '',
  "describe('search', () => {",
  "  it('finds an accented name from a plain query', () => {",
  "    expect(search('cafe').map((item) => item.name)).toContain('Café Nord');",
  '  });',
  '',
  "  it('finds a plain name from an accented query', () => {",
  "    expect(search('Nörd').length).toBeGreaterThan(0);",
  '  });',
  '',
  "  it('ignores surrounding spaces', () => {",
  "    expect(search('  cafe  ')).toEqual(search('cafe'));",
  '  });',
  '',
  "  it('answers nothing for a blank query', () => {",
  "    expect(search('   ')).toEqual([]);",
  '  });',
  '',
  "  it('never answers more than MAX_RESULTS', () => {",
  "    expect(search('a').length).toBeLessThanOrEqual(50);",
  '  });',
  '});',
];

const SEARCH_TEST_PATCH = [
  'diff --git a/src/search.test.ts b/src/search.test.ts',
  'new file mode 100644',
  'index 0000000..4c1f0de',
  '--- /dev/null',
  '+++ b/src/search.test.ts',
  `@@ -0,0 +1,${SEARCH_TEST_LINES.length} @@`,
  ...SEARCH_TEST_LINES.map((line) => `+${line}`),
  '',
].join('\n');

/** Additions and deletions read off the patch itself, so the list and the diff always agree. */
function countPatch(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

const MOCK_CHANGES: readonly { file: ChangedFile; patch: string }[] = [
  { patch: SEARCH_PATCH, status: 'modified' as const, path: 'src/search.ts' },
  { patch: SEARCH_TEST_PATCH, status: 'added' as const, path: 'src/search.test.ts' },
].map(({ patch, status, path }) => ({
  patch,
  file: { path, status, ...countPatch(patch), binary: false },
}));

const MOCK_SUMMARY = [
  'Search now ignores accents and case.',
  '',
  '- `src/search.ts`: a `normalize()` helper (NFD, strip diacritics, lower-case) used on both the query and the names; a blank query answers nothing.',
  '- `src/search.test.ts`: tests for both directions (`cafe` ↔ `Café`), spaces and the result cap.',
].join('\n');

const MOCK_PLAN = [
  '1. Read `src/search.ts` and find where names are compared.',
  '2. Add a `normalize()` helper that strips accents and lower-cases.',
  '3. Use it on both the query and every name.',
  '4. Add tests for accented and plain queries.',
].join('\n');

/** The stand-in check of a project that never named any (absent `checkCommands`; `[]` is none). */
const STAND_IN_CHECKS: readonly CheckCommand[] = [{ name: 'test', command: 'npm test' }];

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

const now = (): string => new Date().toISOString();
const short = (sha: string): string => sha.slice(0, 7);

function requireTask(db: MockDb, id: string): Task {
  const task = db.getTask(id);
  if (task === undefined) throw taskNotFound();
  return task;
}

function checkCommandsOf(db: MockDb, projectId: string): readonly CheckCommand[] {
  return db.getProject(projectId)?.checkCommands ?? STAND_IN_CHECKS;
}

function latestExecution(db: MockDb, taskId: string): TaskExecution | undefined {
  return db.taskExecutionsOf(taskId).at(-1);
}

/** The task as the engine answers it: with `allowedActions` for its state right now. */
export function readTask(db: MockDb, task: Task): Task {
  const latest = latestExecution(db, task.id);
  const allowedActions = allowedTaskActions(task, {
    hasLiveRun: latest?.status === 'running' && latest.runId !== undefined,
    projectHasChecks: checkCommandsOf(db, task.projectId).length > 0,
    workspace: db.taskWorkspaceOf(task.id),
  });
  return { ...structuredClone(task), allowedActions };
}

export function taskDetail(db: MockDb, id: string): TaskDetail {
  const task = requireTask(db, id);
  const workspace = db.taskWorkspaceOf(id);
  return structuredClone({
    task: readTask(db, task),
    ...(workspace === undefined ? {} : { workspace }),
    executions: db.taskExecutionsOf(id),
    checks: db.taskChecksOf(id),
    reviews: db.taskReviewsOf(id),
    deliveries: db.taskDeliveriesOf(id),
  });
}

/** "Checks failed" for Apply and Autopilot: the latest result per name for the head (design §5). */
export function headChecksFailed(checks: readonly TaskCheck[], headSha: string): boolean {
  const latest = new Map<string, TaskCheck>();
  for (const check of checks) {
    if (check.headSha !== headSha) continue;
    const seen = latest.get(check.name);
    if (seen === undefined || seen.at <= check.at) latest.set(check.name, check);
  }
  return [...latest.values()].some((check) => check.status !== 'passed');
}

function isPaused(db: MockDb, task: Task): boolean {
  return task.paused || db.getProject(task.projectId)?.paused === true;
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                      */
/* -------------------------------------------------------------------------- */

function record(
  db: MockDb,
  task: Task,
  kind: TaskActivityKind,
  message: string,
  refs: { executionId?: string; runId?: string } = {},
): TaskActivity {
  return db.addTaskActivity({ id: newId(), taskId: task.id, kind, message, ...refs, at: now() });
}

/** One state change: the patch, its activity row, and one `task.updated` (design §6). */
function change(
  db: MockDb,
  taskId: string,
  patch: Partial<Task>,
  activity?: { kind: TaskActivityKind; message: string; executionId?: string; runId?: string },
): Task {
  const task = db.updateTask(taskId, patch);
  if (task === undefined) throw taskNotFound();
  const row =
    activity === undefined
      ? undefined
      : record(db, task, activity.kind, activity.message, {
          ...(activity.executionId === undefined ? {} : { executionId: activity.executionId }),
          ...(activity.runId === undefined ? {} : { runId: activity.runId }),
        });
  announce(db, task, row);
  return task;
}

function announce(db: MockDb, task: Task, activity?: TaskActivity): void {
  db.emit({
    type: 'task.updated',
    scope: 'engine',
    payload: { task: readTask(db, task), ...(activity === undefined ? {} : { activity }) },
  });
}

function requireAllowed(db: MockDb, task: Task, action: TaskAction): void {
  if (readTask(db, task).allowedActions.includes(action)) return;
  throw new TaskEngineError(
    409,
    'workflow',
    'invalid_transition',
    `A task in ${task.stage} that is ${task.state} cannot ${ACTION_WORDS[action]}.`,
  );
}

function requireWorkflowOf(db: MockDb, projectId: string, workflowId: string | null | undefined) {
  if (workflowId === null || workflowId === undefined) return;
  if (db.getWorkflow(workflowId)?.projectId !== projectId) {
    throw new TaskEngineError(
      422,
      'invalid_config',
      'validation_failed',
      'That team is not a workflow of this project.',
    );
  }
}

/* ---------------------------------------------------------------- create / edit / delete */

export function createTask(db: MockDb, projectId: string, body: CreateTaskRequest): Task {
  if (db.getProject(projectId) === undefined) {
    throw new TaskEngineError(404, 'workflow', 'not_found', 'Project not found.');
  }
  requireWorkflowOf(db, projectId, body.workflowId);
  requireWorkflowOf(db, projectId, body.plannerWorkflowId);
  const type = body.type ?? 'app';
  const ts = now();
  const task = db.addTask({
    id: newId(),
    projectId,
    number: db.nextTaskNumber(projectId),
    title: body.title,
    brief: body.brief ?? '',
    type,
    stage: 'inbox',
    state: 'idle',
    finishLine: body.finishLine ?? DEFAULT_FINISH_LINE[type],
    automation: body.automation ?? DEFAULT_TASK_AUTOMATION,
    priority: body.priority ?? 'normal',
    labels: body.labels ?? [],
    ...(body.workflowId === undefined ? {} : { workflowId: body.workflowId }),
    ...(body.plannerWorkflowId === undefined ? {} : { plannerWorkflowId: body.plannerWorkflowId }),
    plan: '',
    acceptance: body.acceptance ?? '',
    runChecks: body.runChecks ?? true,
    paused: false,
    allowedActions: [],
    createdAt: ts,
    updatedAt: ts,
  });
  announce(db, task, record(db, task, 'created', `Task #${task.number} created.`));
  if (body.start === 'now') startTask(db, task.id);
  return readTask(db, requireTask(db, task.id));
}

const EDIT_WORDS: Partial<Record<keyof UpdateTaskRequest, string>> = {
  title: 'title',
  brief: 'brief',
  plan: 'plan',
  acceptance: 'how to check',
  workflowId: 'team',
  plannerWorkflowId: 'planner',
  finishLine: 'finish line',
  automation: 'automation',
  priority: 'priority',
  labels: 'labels',
  runChecks: 'checks',
};

export function updateTask(db: MockDb, id: string, body: UpdateTaskRequest): Task {
  const task = requireTask(db, id);
  if (body.finishLine !== undefined && !finishLineFits(task.type, body.finishLine)) {
    throw new TaskEngineError(
      422,
      'invalid_config',
      'validation_failed',
      `A ${task.type} task cannot finish with ${body.finishLine}.`,
    );
  }
  requireWorkflowOf(db, task.projectId, body.workflowId);
  requireWorkflowOf(db, task.projectId, body.plannerWorkflowId);
  const moving = body.stage !== undefined && body.stage !== task.stage;
  if (moving) requireAllowed(db, task, 'move');

  const { stage, workflowId, plannerWorkflowId, ...fields } = body;
  const patch: Partial<Task> = { ...fields };
  // `null` clears a reference (D72); the merge removes a key set to undefined
  if (workflowId !== undefined) patch.workflowId = workflowId ?? undefined;
  if (plannerWorkflowId !== undefined) patch.plannerWorkflowId = plannerWorkflowId ?? undefined;
  if (moving && stage !== undefined) {
    patch.stage = stage;
    patch.state = 'idle';
    patch.stateReason = undefined;
  }
  const edited = Object.keys(body)
    .map((key) => EDIT_WORDS[key as keyof UpdateTaskRequest])
    .filter((word): word is string => word !== undefined);
  const activity = moving
    ? { kind: 'stage_changed' as const, message: `Moved to ${stage}.` }
    : edited.length > 0
      ? { kind: 'edited' as const, message: `Edited ${edited.join(', ')}.` }
      : undefined;
  return readTask(db, change(db, id, patch, activity));
}

export function deleteTask(db: MockDb, id: string): void {
  const task = requireTask(db, id);
  requireAllowed(db, task, 'delete');
  cancelPending(id);
  db.deleteTask(id);
  db.emit({
    type: 'task.deleted',
    scope: 'engine',
    payload: { taskId: id, projectId: task.projectId },
  });
}

/* ---------------------------------------------------------------- start / plan / work */

export function startTask(db: MockDb, id: string): Task {
  const task = requireTask(db, id);
  requireAllowed(db, task, 'start');
  change(
    db,
    id,
    { stage: 'plan', state: 'idle', stateReason: undefined, startedAt: task.startedAt ?? now() },
    { kind: 'stage_changed', message: 'Started: moved to Plan.' },
  );
  const started = requireTask(db, id);
  if (started.plannerWorkflowId !== undefined) automatic(db, id, () => planTask(db, id));
  else if (started.automation !== 'manual' && !isPaused(db, started)) {
    if (started.workflowId !== undefined) automatic(db, id, () => workTask(db, id));
  }
  return readTask(db, requireTask(db, id));
}

/**
 * An automatic step (start → plan, plan → work, a dequeue): a refusal does not fail the request that
 * caused it — it leaves the task `failed` with the reason, where Retry can pick it up.
 */
function automatic(db: MockDb, id: string, step: () => void): void {
  try {
    step();
  } catch (error) {
    if (!(error instanceof TaskEngineError) || db.getTask(id) === undefined) return;
    change(
      db,
      id,
      { state: 'failed', stateReason: error.message },
      { kind: 'error', message: error.message },
    );
  }
}

function requireRepository(db: MockDb, task: Task) {
  const repository = db.repositoryOf(task.projectId);
  if (!repository.isRepo || repository.headSha === undefined) {
    throw new TaskEngineError(
      422,
      'invalid_config',
      'not_a_repository',
      'The project folder is not a Git repository with a commit. Initialize Git in the project settings.',
    );
  }
  return { ...repository, headSha: repository.headSha };
}

function slugOf(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug === '' ? 'task' : slug;
}

/** Design §4: the worktree and its branch, created when the first plan or work run starts. */
function ensureWorkspace(db: MockDb, task: Task): TaskWorkspace | undefined {
  if (task.type !== 'app') return undefined;
  const existing = db.taskWorkspaceOf(task.id);
  if (existing?.status === 'ready') return existing;
  const repository = requireRepository(db, task);
  const project = db.getProject(task.projectId);
  const taken = new Set(
    db
      .listTasks(task.projectId)
      .map((other) => db.taskWorkspaceOf(other.id)?.branch)
      .filter((branch): branch is string => branch !== undefined),
  );
  const stem = `ace/task-${task.number}-${slugOf(task.title)}`;
  let branch = stem;
  for (let n = 2; taken.has(branch); n += 1) branch = `${stem}-${n}`;
  const ts = now();
  const workspace = db.putTaskWorkspace({
    id: newId(),
    taskId: task.id,
    repoPath: project?.folderPath ?? '/mock',
    path: `${db.settings.dataDir}/workspaces/${task.id}`,
    branch,
    baseBranch: repository.branch,
    baseSha: repository.headSha,
    headSha: repository.headSha,
    status: 'ready',
    createdAt: ts,
    updatedAt: ts,
  });
  announce(
    db,
    task,
    record(
      db,
      task,
      'workspace_ready',
      `Workspace ready on ${branch} (from ${repository.branch}).`,
    ),
  );
  return workspace;
}

function newExecution(
  db: MockDb,
  task: Task,
  kind: ExecutionKind,
  workflowId: string,
  request: string,
): TaskExecution {
  return db.putTaskExecution({
    id: newId(),
    taskId: task.id,
    kind,
    sequence: db.taskExecutionsOf(task.id).length + 1,
    workflowId,
    runId: newId(),
    status: 'running',
    request,
    startedAt: now(),
  });
}

export function planTask(db: MockDb, id: string): Task {
  const task = requireTask(db, id);
  requireAllowed(db, task, 'plan');
  const plannerId = task.plannerWorkflowId;
  if (plannerId === undefined) {
    throw new TaskEngineError(422, 'invalid_config', 'no_team', 'Choose a planner first.');
  }
  ensureWorkspace(db, task);
  const execution = newExecution(db, task, 'plan', plannerId, task.brief);
  const failure = consumeWorkFailure();
  change(
    db,
    id,
    { stage: 'plan', state: 'running', stateReason: undefined },
    {
      kind: 'run_started',
      message: `Plan run ${execution.sequence} started.`,
      executionId: execution.id,
      ...(execution.runId === undefined ? {} : { runId: execution.runId }),
    },
  );
  schedule(id, () => finishPlan(db, id, execution.id, failure));
  return readTask(db, requireTask(db, id));
}

function consumeWorkFailure(): string | undefined {
  const reason = failNextWorkReason;
  failNextWorkReason = undefined;
  return reason;
}

/** Work runs going at once in the project — what capacity counts (plan runs do not). */
function busyWorkSlots(db: MockDb, projectId: string): number {
  return db.listTasks(projectId).filter((task) => {
    if (task.state !== 'running' && task.state !== 'waiting') return false;
    return latestExecution(db, task.id)?.kind === 'work';
  }).length;
}

export function workTask(db: MockDb, id: string, message?: string): Task {
  const task = requireTask(db, id);
  const workflowId = task.workflowId;
  if (workflowId === undefined) {
    throw new TaskEngineError(
      422,
      'invalid_config',
      'no_team',
      'Choose a team (a workflow of this project) before starting work.',
    );
  }
  requireAllowed(db, task, 'work');
  if (task.type === 'app') requireRepository(db, task);

  const capacity = db.getProject(task.projectId)?.buildCapacity ?? DEFAULT_BUILD_CAPACITY;
  const busy = busyWorkSlots(db, task.projectId);
  if (busy >= capacity) {
    const request = message ?? task.pendingRequest;
    return readTask(
      db,
      change(
        db,
        id,
        {
          stage: 'work',
          state: 'queued',
          stateReason: `Waiting for a Build slot (${busy} of ${capacity} in use)`,
          pendingRequest: request,
        },
        { kind: 'queued', message: `Queued: all ${capacity} Build slots are in use.` },
      ),
    );
  }

  ensureWorkspace(db, task);
  const request = message ?? task.pendingRequest ?? task.brief;
  const execution = newExecution(db, task, 'work', workflowId, request);
  const failure = consumeWorkFailure();
  change(
    db,
    id,
    {
      stage: 'work',
      state: 'running',
      stateReason: undefined,
      pendingRequest: undefined,
      startedAt: task.startedAt ?? now(),
    },
    {
      kind: 'run_started',
      message:
        message === undefined
          ? `Work run ${execution.sequence} started.`
          : `Work run ${execution.sequence} started with a follow-up.`,
      executionId: execution.id,
      ...(execution.runId === undefined ? {} : { runId: execution.runId }),
    },
  );
  schedule(id, () => finishWork(db, id, execution.id, failure));
  return readTask(db, requireTask(db, id));
}

/** The run is still the task's live one: a stop or a delete since then leaves nothing to finish. */
function liveExecution(db: MockDb, taskId: string, executionId: string) {
  db.load();
  const task = db.getTask(taskId);
  const execution = db.taskExecutionsOf(taskId).find((row) => row.id === executionId);
  if (task === undefined || execution?.status !== 'running') return undefined;
  return { task, execution };
}

function failRun(db: MockDb, task: Task, execution: TaskExecution, reason: string): void {
  db.putTaskExecution({ ...execution, status: 'failed', error: reason, endedAt: now() });
  change(
    db,
    task.id,
    { state: 'failed', stateReason: reason },
    {
      kind: 'run_failed',
      message: `${execution.kind === 'plan' ? 'Plan' : 'Work'} run ${execution.sequence} failed: ${reason}`,
      executionId: execution.id,
      ...(execution.runId === undefined ? {} : { runId: execution.runId }),
    },
  );
}

function finishPlan(db: MockDb, taskId: string, executionId: string, failure?: string): void {
  const live = liveExecution(db, taskId, executionId);
  if (live === undefined) return;
  const { task, execution } = live;
  if (failure !== undefined) {
    failRun(db, task, execution, failure);
    return;
  }
  db.putTaskExecution({ ...execution, status: 'completed', summary: MOCK_PLAN, endedAt: now() });
  const planned = change(
    db,
    taskId,
    { plan: MOCK_PLAN, state: 'idle', stateReason: undefined },
    {
      kind: 'run_completed',
      message: `Plan run ${execution.sequence} completed: the plan is written.`,
      executionId,
      ...(execution.runId === undefined ? {} : { runId: execution.runId }),
    },
  );
  if (planned.automation !== 'manual' && !isPaused(db, planned) && planned.workflowId) {
    automatic(db, taskId, () => workTask(db, taskId));
  }
}

function finishWork(db: MockDb, taskId: string, executionId: string, failure?: string): void {
  const live = liveExecution(db, taskId, executionId);
  if (live === undefined) return;
  const { task, execution } = live;
  if (failure !== undefined) {
    failRun(db, task, execution, failure);
    dequeue(db, task.projectId);
    return;
  }

  const workspace = db.taskWorkspaceOf(taskId);
  const refs = {
    executionId,
    ...(execution.runId === undefined ? {} : { runId: execution.runId }),
  };
  if (workspace === undefined) {
    // an Email or Document task: the run's answer is the result
    db.putTaskExecution({
      ...execution,
      status: 'completed',
      summary: MOCK_SUMMARY,
      endedAt: now(),
    });
    change(
      db,
      taskId,
      {},
      { kind: 'run_completed', message: `Work run ${execution.sequence} completed.`, ...refs },
    );
  } else {
    const commitSha = fakeSha(`commit:${taskId}:${execution.sequence}`);
    db.putTaskExecution({
      ...execution,
      status: 'completed',
      summary: MOCK_SUMMARY,
      commitSha,
      changedFiles: MOCK_CHANGES.length,
      endedAt: now(),
    });
    db.putTaskWorkspace({ ...workspace, headSha: commitSha, updatedAt: now() });
    change(
      db,
      taskId,
      {},
      { kind: 'run_completed', message: `Work run ${execution.sequence} completed.`, ...refs },
    );
    change(
      db,
      taskId,
      {},
      {
        kind: 'committed',
        message: `Committed ${MOCK_CHANGES.length} changed files on ${workspace.branch} (${short(commitSha)}).`,
        ...refs,
      },
    );
    if (task.runChecks) runChecksNow(db, requireTask(db, taskId), executionId);
  }

  change(
    db,
    taskId,
    { stage: 'review', state: 'idle', stateReason: undefined },
    { kind: 'stage_changed', message: 'Ready for review.' },
  );
  autopilot(db, taskId);
  dequeue(db, task.projectId);
}

/* ---------------------------------------------------------------- checks */

function runChecksNow(db: MockDb, task: Task, executionId?: string): void {
  const workspace = db.taskWorkspaceOf(task.id);
  const commands = checkCommandsOf(db, task.projectId);
  if (workspace === undefined || commands.length === 0) return;
  const failing = failNextChecksOn;
  failNextChecksOn = false;
  const failed: string[] = [];
  commands.forEach((command, index) => {
    const fail = failing && index === 0;
    if (fail) failed.push(command.name);
    db.addTaskCheck({
      id: newId(),
      taskId: task.id,
      ...(executionId === undefined ? {} : { executionId }),
      name: command.name,
      command: command.command,
      status: fail ? 'failed' : 'passed',
      exitCode: fail ? 1 : 0,
      output: fail
        ? `$ ${command.command}\n✗ search › finds an accented name from a plain query\n  Expected 1 result, received 0\n\n1 failing, 7 passing\n`
        : `$ ${command.command}\n✓ 8 tests passed\n`,
      durationMs: 1200 + index * 300,
      headSha: workspace.headSha,
      at: now(),
    });
  });
  change(
    db,
    task.id,
    {},
    failed.length === 0
      ? {
          kind: 'checks_passed',
          message: `${commands.length === 1 ? 'The check' : `All ${commands.length} checks`} passed on ${short(workspace.headSha)}.`,
        }
      : {
          kind: 'checks_failed',
          message: `${failed.length} of ${commands.length} checks failed: ${failed.join(', ')}.`,
        },
  );
}

export function runTaskChecks(db: MockDb, id: string): Task {
  const task = requireTask(db, id);
  requireAllowed(db, task, 'checks');
  record(db, task, 'checks_started', 'Checks started.');
  runChecksNow(db, task);
  return readTask(db, requireTask(db, id));
}

/* ---------------------------------------------------------------- stop / retry */

export function stopTask(db: MockDb, id: string): Task {
  const task = requireTask(db, id);
  requireAllowed(db, task, 'stop');
  cancelPending(id);
  const execution = latestExecution(db, id);
  if (execution !== undefined && execution.status === 'running') {
    db.putTaskExecution({ ...execution, status: 'stopped', endedAt: now() });
  }
  change(
    db,
    id,
    { state: 'idle', stateReason: 'Stopped.' },
    {
      kind: 'run_stopped',
      message: 'Stopped.',
      ...(execution === undefined ? {} : { executionId: execution.id }),
    },
  );
  dequeue(db, task.projectId);
  return readTask(db, requireTask(db, id));
}

export function retryTask(db: MockDb, id: string): Task {
  const task = requireTask(db, id);
  requireAllowed(db, task, 'retry');
  const lastDelivery = db.taskDeliveriesOf(id).at(-1);
  const lastExecution = latestExecution(db, id);
  if (task.stage === 'review' && lastDelivery?.status === 'failed') {
    change(
      db,
      id,
      { state: 'idle', stateReason: undefined },
      { kind: 'retried', message: 'Retry: back to review.' },
    );
    return readTask(db, requireTask(db, id));
  }
  record(db, task, 'retried', 'Retrying what failed.');
  if (lastExecution?.status === 'failed') {
    if (lastExecution.kind === 'plan') return planTask(db, id);
    // a follow-up that failed is asked again; a first run is asked the brief again
    const followUp = lastExecution.request === task.brief ? undefined : lastExecution.request;
    return workTask(db, id, task.pendingRequest ?? followUp);
  }
  return readTask(db, change(db, id, { state: 'idle', stateReason: undefined }));
}

/* ---------------------------------------------------------------- review / apply / close */

export function reviewTask(db: MockDb, id: string, body: ReviewTaskRequest): Task {
  const task = requireTask(db, id);
  requireAllowed(db, task, body.decision === 'approved' ? 'approve' : 'request_changes');
  const workspace = db.taskWorkspaceOf(id);
  if (body.headSha !== undefined && workspace !== undefined && body.headSha !== workspace.headSha) {
    throw new TaskEngineError(
      409,
      'workflow',
      'stale_review',
      'The task branch has moved since you looked: review the latest changes.',
    );
  }
  db.addTaskReview({
    id: newId(),
    taskId: id,
    decision: body.decision,
    ...(body.note === undefined ? {} : { note: body.note }),
    ...(workspace === undefined ? {} : { headSha: workspace.headSha }),
    at: now(),
  });

  if (body.decision === 'approved') {
    const finished = task.finishLine === 'review';
    change(
      db,
      id,
      finished
        ? {
            stage: 'done',
            state: 'done',
            outcome: 'reviewed',
            stateReason: undefined,
            completedAt: now(),
          }
        : { stateReason: undefined },
      {
        kind: 'approved',
        message: finished ? 'Approved: the finish line is reached.' : 'Approved.',
      },
    );
    return readTask(db, requireTask(db, id));
  }

  const note = body.note ?? '';
  change(db, id, {}, { kind: 'changes_requested', message: `Changes requested: ${note}` });
  const current = requireTask(db, id);
  if (isPaused(db, current) || current.workflowId === undefined) {
    return readTask(
      db,
      change(db, id, {
        stage: 'work',
        state: 'idle',
        stateReason: undefined,
        pendingRequest: note,
      }),
    );
  }
  return workTask(db, id, note);
}

/** The destination Apply merges into: the project folder on the repository's current branch. */
export function applyDestination(db: MockDb, projectId: string) {
  return {
    folderPath: db.getProject(projectId)?.folderPath ?? '',
    branch: db.repositoryOf(projectId).branch,
  };
}

export function applyTask(db: MockDb, id: string, body: ApplyTaskRequest): Task {
  const task = requireTask(db, id);
  requireAllowed(db, task, 'apply');
  const workspace = db.taskWorkspaceOf(id);
  if (workspace !== undefined && headChecksFailed(db.taskChecksOf(id), workspace.headSha)) {
    throw new TaskEngineError(
      409,
      'workflow',
      'checks_failed',
      'A check failed on the latest changes: fix it or run the checks again before applying.',
    );
  }
  const destination = applyDestination(db, task.projectId);
  if (
    body.destination.folderPath !== destination.folderPath ||
    body.destination.branch !== destination.branch
  ) {
    throw new TaskEngineError(
      409,
      'workflow',
      'destination_changed',
      `The repository is now at ${destination.folderPath} @ ${destination.branch}: confirm the new destination.`,
    );
  }
  return readTask(db, deliver(db, task));
}

function deliver(db: MockDb, task: Task): Task {
  const destination = applyDestination(db, task.projectId);
  const where = `${destination.folderPath} @ ${destination.branch}`;
  const conflict = failNextApplyReason;
  failNextApplyReason = undefined;
  if (conflict !== undefined) {
    db.addTaskDelivery({
      id: newId(),
      taskId: task.id,
      kind: 'apply_local',
      status: 'failed',
      destination: where,
      detail: conflict,
      at: now(),
    });
    return change(
      db,
      task.id,
      { state: 'failed', stateReason: conflict },
      { kind: 'delivery_failed', message: `Apply to ${where} failed: ${conflict}` },
    );
  }
  const workspace = db.taskWorkspaceOf(task.id);
  const repository = db.repositoryOf(task.projectId);
  const sha = fakeSha(`merge:${task.id}:${workspace?.headSha ?? ''}`);
  db.setRepository(task.projectId, { ...repository, headSha: sha });
  if (workspace !== undefined) {
    db.putTaskWorkspace({ ...workspace, status: 'applied', updatedAt: now() });
  }
  db.addTaskDelivery({
    id: newId(),
    taskId: task.id,
    kind: 'apply_local',
    status: 'succeeded',
    destination: where,
    sha,
    at: now(),
  });
  return change(
    db,
    task.id,
    {
      stage: 'done',
      state: 'done',
      outcome: 'applied',
      stateReason: undefined,
      completedAt: now(),
    },
    { kind: 'delivered', message: `Applied to ${where} (${short(sha)}).` },
  );
}

export function closeTask(db: MockDb, id: string, reason?: string): Task {
  const task = requireTask(db, id);
  requireAllowed(db, task, 'close');
  cancelPending(id);
  return readTask(
    db,
    change(
      db,
      id,
      {
        stage: 'done',
        state: 'done',
        outcome: 'closed_unverified',
        stateReason: undefined,
        pendingRequest: undefined,
        completedAt: now(),
      },
      {
        kind: 'closed',
        message:
          reason === undefined
            ? 'Closed without verification.'
            : `Closed without verification: ${reason}`,
      },
    ),
  );
}

/* ---------------------------------------------------------------- pause / automation / capacity */

export function pauseTask(db: MockDb, id: string, paused: boolean): Task {
  const task = requireTask(db, id);
  requireAllowed(db, task, paused ? 'pause' : 'resume');
  change(
    db,
    id,
    { paused },
    paused
      ? { kind: 'paused', message: 'Paused: no automatic step until it is resumed.' }
      : { kind: 'unpaused', message: 'Resumed.' },
  );
  if (!paused) resumeSkippedStep(db, id);
  return readTask(db, requireTask(db, id));
}

/** Resume: the automatic step that was skipped while paused happens now (design §2). */
function resumeSkippedStep(db: MockDb, id: string): void {
  const task = requireTask(db, id);
  if (isPaused(db, task)) return;
  if (task.state === 'queued') {
    dequeue(db, task.projectId);
    return;
  }
  if (task.state !== 'idle' || task.workflowId === undefined) return;
  if (task.stage === 'work' && task.pendingRequest !== undefined) {
    automatic(db, id, () => workTask(db, id, task.pendingRequest));
  } else if (task.stage === 'plan' && task.automation !== 'manual' && task.plan !== '') {
    automatic(db, id, () => workTask(db, id));
  }
}

/** A project resumed: its queued tasks get their slots, as each task's own resume would. */
export function resumeProject(db: MockDb, projectId: string): void {
  dequeue(db, projectId);
  for (const task of db.listTasks(projectId)) {
    if (task.state === 'idle') resumeSkippedStep(db, task.id);
  }
}

/** Design §2.3: the oldest queued task by priority (urgent → low), then `updatedAt`, starts. */
function dequeue(db: MockDb, projectId: string): void {
  const project = db.getProject(projectId);
  if (project === undefined || project.paused) return;
  const capacity = project.buildCapacity ?? DEFAULT_BUILD_CAPACITY;
  const rank = (task: Task) => -TASK_PRIORITIES.indexOf(task.priority);
  for (;;) {
    if (busyWorkSlots(db, projectId) >= capacity) return;
    const next = db
      .listTasks(projectId)
      .filter((task) => task.state === 'queued' && !task.paused)
      .sort((a, b) => rank(a) - rank(b) || a.updatedAt.localeCompare(b.updatedAt))[0];
    if (next === undefined) return;
    const message = next.pendingRequest;
    // back to idle first, so `work` is allowed again; the request rides along
    db.updateTask(next.id, { state: 'idle', stateReason: undefined });
    automatic(db, next.id, () => workTask(db, next.id, message));
  }
}

/** Design §2.2: Autopilot's final action, when Full access, nothing paused and no check failed. */
function autopilot(db: MockDb, id: string): void {
  const task = requireTask(db, id);
  if (task.automation !== 'autopilot' || task.stage !== 'review') return;
  const workspace = db.taskWorkspaceOf(id);
  const why =
    (db.settings.approvalMode ?? 'ask') !== 'full_access'
      ? 'the approval mode is not Full access.'
      : isPaused(db, task)
        ? 'the task or its project is paused.'
        : workspace !== undefined && headChecksFailed(db.taskChecksOf(id), workspace.headSha)
          ? 'a check failed.'
          : undefined;
  if (why !== undefined) {
    change(db, id, { stateReason: `Autopilot is waiting: ${why}` });
    return;
  }
  if (task.finishLine === 'review') {
    db.addTaskReview({
      id: newId(),
      taskId: id,
      decision: 'approved',
      note: 'Autopilot under Full access.',
      ...(workspace === undefined ? {} : { headSha: workspace.headSha }),
      at: now(),
    });
    change(
      db,
      id,
      {
        stage: 'done',
        state: 'done',
        outcome: 'reviewed',
        stateReason: undefined,
        completedAt: now(),
      },
      { kind: 'approved', message: 'Autopilot approved it under Full access.' },
    );
  } else if (task.finishLine === 'apply_local' && workspace !== undefined) {
    deliver(db, task);
  }
}

/* -------------------------------------------------------------------------- */
/* Changes and repository                                                      */
/* -------------------------------------------------------------------------- */

function changedFilesOf(
  db: MockDb,
  taskId: string,
): { uncommitted: boolean; files: typeof MOCK_CHANGES } {
  const executions = db.taskExecutionsOf(taskId).filter((row) => row.kind === 'work');
  const committed = executions.some((row) => row.commitSha !== undefined);
  const running = executions.at(-1)?.status === 'running';
  return { uncommitted: running, files: committed || running ? MOCK_CHANGES : [] };
}

export function taskChanges(db: MockDb, id: string): TaskChanges {
  requireTask(db, id);
  const workspace = db.taskWorkspaceOf(id);
  if (workspace === undefined) {
    throw new TaskEngineError(404, 'workflow', 'no_workspace', 'This task has no workspace yet.');
  }
  const { uncommitted, files } = changedFilesOf(db, id);
  const list = files.map((entry) => entry.file);
  return {
    branch: workspace.branch,
    baseBranch: workspace.baseBranch,
    baseSha: workspace.baseSha,
    headSha: workspace.headSha,
    uncommitted,
    files: list,
    totals: {
      files: list.length,
      additions: list.reduce((sum, file) => sum + (file.additions ?? 0), 0),
      deletions: list.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    },
  };
}

export function taskFileDiff(db: MockDb, id: string, path: string): TaskFileDiff {
  taskChanges(db, id);
  const entry = changedFilesOf(db, id).files.find((candidate) => candidate.file.path === path);
  if (entry === undefined) {
    throw new TaskEngineError(404, 'workflow', 'not_found', `${path} has no changes in this task.`);
  }
  return { path, binary: false, patch: entry.patch, truncated: false };
}

export function repositoryInfo(db: MockDb, projectId: string): RepositoryInfo {
  const project = db.getProject(projectId);
  if (project === undefined) {
    throw new TaskEngineError(404, 'workflow', 'not_found', 'Project not found.');
  }
  const repository = db.repositoryOf(projectId);
  if (!repository.isRepo) {
    return { folderPath: project.folderPath, gitAvailable: true, isRepo: false };
  }
  return {
    folderPath: project.folderPath,
    gitAvailable: true,
    isRepo: true,
    branch: repository.branch,
    ...(repository.headSha === undefined ? {} : { headSha: repository.headSha }),
    clean: true,
    changedFiles: 0,
  };
}

export function initRepository(db: MockDb, projectId: string): RepositoryInfo {
  const info = repositoryInfo(db, projectId);
  if (info.isRepo) {
    throw new TaskEngineError(
      409,
      'workflow',
      'already_repository',
      'The project folder is already a Git repository.',
    );
  }
  db.setRepository(projectId, {
    isRepo: true,
    branch: 'main',
    headSha: fakeSha(`init:${projectId}:${now()}`),
  });
  return repositoryInfo(db, projectId);
}
