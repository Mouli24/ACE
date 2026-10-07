import type {
  ApprovalMode,
  CreateTaskRequest,
  Id,
  Project,
  Task,
  TaskAction,
  TaskActivityKind,
} from '@ace/contracts';

import type { EventBus } from '../events/index.js';
import type { Logger } from '../logging/index.js';
import type {
  Repository,
  Scope,
  TaskActivityRepository,
  TaskCheckRepository,
  TaskDeliveryRepository,
  TaskExecutionRepository,
  TaskRecord,
  TaskRepository,
  TaskReviewRepository,
  TaskWorkspaceRepository,
} from '../ports/index.js';

/** The task repositories the service needs, resolved (it fails clearly when one is missing). */
export interface TaskRepos {
  tasks: TaskRepository;
  workspaces: TaskWorkspaceRepository;
  executions: TaskExecutionRepository;
  checks: TaskCheckRepository;
  reviews: TaskReviewRepository;
  deliveries: TaskDeliveryRepository;
  activity: TaskActivityRepository;
}

export interface ActivityInput {
  kind: TaskActivityKind;
  message: string;
  executionId?: Id;
  runId?: Id;
}

/**
 * What the task service lends its feature modules (deliverables, GitHub delivery, previews,
 * schedules — ACE parity P1): the same lock, persistence and announcement every P0 transition uses,
 * so a feature module can never change a task without its `task.updated` and activity row, nor
 * interleave with a run finishing.
 */
export interface TaskKernel {
  readonly repository: Repository;
  readonly scope: Scope;
  readonly bus: EventBus;
  readonly logger: Logger;
  now(): string;
  nextId(): string;
  repos(): TaskRepos;
  load(id: Id): Promise<TaskRecord>;
  loadProject(projectId: Id): Promise<Project>;
  /** Serialises everything that changes one task. Never hold it across a long operation. */
  withLock<T>(taskId: Id, fn: () => Promise<T>): Promise<T>;
  /** Runs work in the background, tracked by `idle()`, logging (never throwing) its failure. */
  track(work: () => Promise<unknown>): void;
  /** Persists the task, appends the activity row, emits one `task.updated`. */
  commit(task: TaskRecord, activity?: ActivityInput): Promise<Task>;
  /** The task with `changes` applied; an `undefined` value removes the field. */
  set(task: TaskRecord, changes: Partial<TaskRecord>): TaskRecord;
  /** A change of stage/state; `stateReason` is cleared unless a new one is given. */
  moveTo(
    task: TaskRecord,
    stage: TaskRecord['stage'],
    state: TaskRecord['state'],
    reason?: string,
  ): TaskRecord;
  assertAllowed(task: TaskRecord, action: TaskAction, verb: string): Promise<void>;
  present(task: TaskRecord): Promise<Task>;
  settings(): Promise<{ approvalMode: ApprovalMode }>;
  /** The names of the checks whose latest result for `headSha` is not a pass. */
  headChecksFailed(taskId: Id, headSha: string): Promise<string[]>;
  isPaused(task: TaskRecord): Promise<boolean>;
  /** Secret masking for anything stored from a process's output (BR-07). */
  mask(text: string): string;
  /** The environment the project's commands run with (D271, D274). */
  commandEnv(projectId: Id): Promise<Record<string, string> | undefined>;
  /** The service's own create and start, for schedules that make and start tasks. */
  createTask(projectId: Id, body: CreateTaskRequest): Promise<Task>;
  startTask(id: Id): Promise<Task>;
}
