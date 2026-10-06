import type {
  ChangedFile,
  Id,
  Project,
  Run,
  RunState,
  StartRunRequest,
  TaskActivity,
  TaskCheck,
  TaskDelivery,
  TaskExecution,
  TaskReview,
  TaskWorkspace,
  Workflow,
} from '@ace/contracts';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { InProcessPubSubStub } from '../../__tests__/pubsub-stub.js';
import { createEventBus, type EventBus } from '../../events/index.js';
import { newId } from '../../ids.js';
import { createLogger } from '../../logging/index.js';
import {
  LOCAL_SCOPE,
  type CommandResult,
  type CommandRunner,
  type EngineEvent,
  type GitPort,
  type MergeResult,
  type RepoStatus,
  type Scope,
  type TaskActivityRepository,
  type TaskCheckRepository,
  type TaskDeliveryRepository,
  type TaskExecutionRepository,
  type TaskListFilter,
  type TaskRecord,
  type TaskRepository,
  type TaskReviewRepository,
  type TaskWorkspaceRepository,
} from '../../ports/index.js';
import { createTaskService, type TaskService } from '../service.js';

/* -------------------------------------------------------------------------- */
/* In-memory task repositories                                                */
/* -------------------------------------------------------------------------- */

const clone = <T>(value: T): T => structuredClone(value);

export class InMemoryTaskRepos {
  readonly taskRows = new Map<Id, TaskRecord>();
  readonly workspaceRows = new Map<Id, TaskWorkspace>();
  readonly executionRows = new Map<Id, TaskExecution>();
  readonly checkRows: TaskCheck[] = [];
  readonly reviewRows: TaskReview[] = [];
  readonly deliveryRows: TaskDelivery[] = [];
  readonly activityRows: TaskActivity[] = [];

  readonly tasks: TaskRepository = {
    create: async (_scope: Scope, task: TaskRecord) => {
      this.taskRows.set(task.id, clone(task));
      return clone(task);
    },
    get: async (_scope, id) => {
      const row = this.taskRows.get(id);
      return row === undefined ? null : clone(row);
    },
    listByProject: async (_scope, projectId, filter?: TaskListFilter) =>
      [...this.taskRows.values()]
        .filter((task) => task.projectId === projectId)
        .filter((task) => filter?.stage === undefined || task.stage === filter.stage)
        .filter((task) => filter?.states === undefined || filter.states.includes(task.state))
        .sort((a, b) => b.number - a.number)
        .map(clone),
    listByStates: async (_scope, states) =>
      [...this.taskRows.values()].filter((task) => states.includes(task.state)).map(clone),
    save: async (_scope, task) => {
      if (!this.taskRows.has(task.id)) throw new Error(`task ${task.id} missing`);
      this.taskRows.set(task.id, clone(task));
      return clone(task);
    },
    delete: async (_scope, id) => {
      const existed = this.taskRows.delete(id);
      for (const [key, row] of this.workspaceRows)
        if (row.taskId === id) this.workspaceRows.delete(key);
      for (const [key, row] of this.executionRows)
        if (row.taskId === id) this.executionRows.delete(key);
      return existed;
    },
    nextNumber: async (_scope, projectId) =>
      Math.max(
        0,
        ...[...this.taskRows.values()]
          .filter((task) => task.projectId === projectId)
          .map((task) => task.number),
      ) + 1,
  };

  readonly taskWorkspaces: TaskWorkspaceRepository = {
    create: async (_scope, workspace) => {
      this.workspaceRows.set(workspace.id, clone(workspace));
      return clone(workspace);
    },
    getByTask: async (_scope, taskId) => {
      const row = [...this.workspaceRows.values()].find((candidate) => candidate.taskId === taskId);
      return row === undefined ? null : clone(row);
    },
    save: async (_scope, workspace) => {
      this.workspaceRows.set(workspace.id, clone(workspace));
      return clone(workspace);
    },
  };

  readonly taskExecutions: TaskExecutionRepository = {
    create: async (_scope, execution) => {
      this.executionRows.set(execution.id, clone(execution));
      return clone(execution);
    },
    get: async (_scope, id) => {
      const row = this.executionRows.get(id);
      return row === undefined ? null : clone(row);
    },
    getByRun: async (_scope, runId) => {
      const row = [...this.executionRows.values()].find((candidate) => candidate.runId === runId);
      return row === undefined ? null : clone(row);
    },
    listByTask: async (_scope, taskId) =>
      [...this.executionRows.values()]
        .filter((row) => row.taskId === taskId)
        .sort((a, b) => a.sequence - b.sequence)
        .map(clone),
    save: async (_scope, execution) => {
      this.executionRows.set(execution.id, clone(execution));
      return clone(execution);
    },
  };

  readonly taskChecks: TaskCheckRepository = {
    create: async (_scope, check) => {
      this.checkRows.push(clone(check));
      return clone(check);
    },
    listByTask: async (_scope, taskId) =>
      this.checkRows.filter((row) => row.taskId === taskId).map(clone),
  };

  readonly taskReviews: TaskReviewRepository = {
    create: async (_scope, review) => {
      this.reviewRows.push(clone(review));
      return clone(review);
    },
    listByTask: async (_scope, taskId) =>
      this.reviewRows.filter((row) => row.taskId === taskId).map(clone),
  };

  readonly taskDeliveries: TaskDeliveryRepository = {
    create: async (_scope, delivery) => {
      this.deliveryRows.push(clone(delivery));
      return clone(delivery);
    },
    listByTask: async (_scope, taskId) =>
      this.deliveryRows.filter((row) => row.taskId === taskId).map(clone),
  };

  readonly taskActivity: TaskActivityRepository = {
    append: async (_scope, activity) => {
      this.activityRows.push(clone(activity));
      return clone(activity);
    },
    listByTask: async (_scope, taskId, limit) => {
      const rows = this.activityRows.filter((row) => row.taskId === taskId).map(clone);
      return limit === undefined ? rows : rows.slice(-limit);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* A Git port that simulates one repository and its worktrees                 */
/* -------------------------------------------------------------------------- */

const sha = (n: number): string => n.toString(16).padStart(40, '0');

export class FakeGit implements GitPort {
  status: RepoStatus = {
    gitAvailable: true,
    isRepo: true,
    branch: 'main',
    headSha: sha(1),
    clean: true,
    changedFiles: 0,
  };
  #counter = 100;
  /** Files the next `commitAll` in a worktree records (what a run "changed"). */
  pendingChanges = new Map<string, ChangedFile[]>();
  readonly worktrees = new Map<string, { branch: string; head: string }>();
  readonly branches = new Set<string>(['main']);
  readonly removed: string[] = [];
  mergeResult: MergeResult | undefined;
  readonly calls: string[] = [];
  createWorktreeError: Error | undefined;

  async inspect(_folder: string): Promise<RepoStatus> {
    this.calls.push('inspect');
    return { ...this.status };
  }

  async init(_folder: string): Promise<RepoStatus> {
    this.calls.push('init');
    this.status = { ...this.status, isRepo: true, branch: 'main', headSha: sha(1), clean: true };
    return { ...this.status };
  }

  async branchExists(_repo: string, branch: string): Promise<boolean> {
    return this.branches.has(branch);
  }

  async createWorktree(input: {
    repoPath: string;
    worktreePath: string;
    branch: string;
    baseRef: string;
  }): Promise<{ baseSha: string }> {
    this.calls.push(`worktree:${input.branch}`);
    if (this.createWorktreeError !== undefined) throw this.createWorktreeError;
    const base = this.status.headSha ?? sha(1);
    this.worktrees.set(input.worktreePath, { branch: input.branch, head: base });
    this.branches.add(input.branch);
    return { baseSha: base };
  }

  async removeWorktree(input: {
    repoPath: string;
    worktreePath: string;
    deleteBranch?: string;
  }): Promise<void> {
    this.removed.push(input.worktreePath);
    this.worktrees.delete(input.worktreePath);
    if (input.deleteBranch !== undefined) this.branches.delete(input.deleteBranch);
  }

  async commitAll(input: { cwd: string; message: string }): Promise<{ sha: string } | null> {
    this.calls.push(`commit:${input.message}`);
    const changes = this.pendingChanges.get(input.cwd);
    const tree = this.worktrees.get(input.cwd);
    if (changes === undefined || changes.length === 0 || tree === undefined) return null;
    this.#counter += 1;
    tree.head = sha(this.#counter);
    this.committed.set(tree.head, changes);
    this.pendingChanges.delete(input.cwd);
    return { sha: tree.head };
  }

  readonly committed = new Map<string, ChangedFile[]>();

  async headSha(cwd: string): Promise<string> {
    return this.worktrees.get(cwd)?.head ?? this.status.headSha ?? sha(1);
  }

  async changes(input: {
    cwd: string;
    baseSha: string;
    includeUncommitted: boolean;
    headRef?: string;
  }): Promise<{ files: ChangedFile[]; uncommitted: boolean }> {
    const head = input.headRef ?? (await this.headSha(input.cwd));
    const files = [...this.committed.entries()]
      .filter(([commit]) => commit > input.baseSha && commit <= head)
      .flatMap(([, rows]) => rows);
    const pending = this.pendingChanges.get(input.cwd) ?? [];
    return {
      files: input.includeUncommitted ? [...files, ...pending] : files,
      uncommitted: pending.length > 0,
    };
  }

  async fileDiff(input: {
    cwd: string;
    baseSha: string;
    path: string;
    includeUncommitted: boolean;
    maxBytes: number;
    headRef?: string;
  }): Promise<{ patch: string; truncated: boolean; binary: boolean }> {
    return {
      patch: `diff --git a/${input.path} b/${input.path}\n+change`,
      truncated: false,
      binary: false,
    };
  }

  async merge(input: {
    repoPath: string;
    branch: string;
    expectedBranch: string;
    message: string;
  }): Promise<MergeResult> {
    this.calls.push(`merge:${input.branch}->${input.expectedBranch}`);
    if (this.mergeResult !== undefined) return this.mergeResult;
    this.#counter += 1;
    this.status = { ...this.status, headSha: sha(this.#counter) };
    return { ok: true, sha: sha(this.#counter) };
  }
}

/* -------------------------------------------------------------------------- */
/* A scripted command runner                                                  */
/* -------------------------------------------------------------------------- */

export class FakeCommands implements CommandRunner {
  readonly ran: { command: string; cwd: string }[] = [];
  results = new Map<string, Partial<CommandResult>>();
  /** A command that waits until its signal aborts (to test Stop during checks). */
  hang = new Set<string>();

  async run(input: {
    command: string;
    cwd: string;
    timeoutMs: number;
    maxOutput: number;
    signal?: AbortSignal;
  }): Promise<CommandResult> {
    this.ran.push({ command: input.command, cwd: input.cwd });
    if (this.hang.has(input.command)) {
      await new Promise<void>((resolveWait) => {
        if (input.signal?.aborted === true) resolveWait();
        input.signal?.addEventListener('abort', () => resolveWait(), { once: true });
      });
      return { exitCode: null, output: 'killed', timedOut: false, durationMs: 5 };
    }
    const scripted = this.results.get(input.command) ?? {};
    return {
      exitCode: scripted.exitCode === undefined ? 0 : scripted.exitCode,
      output: scripted.output ?? `ran ${input.command}`,
      timedOut: scripted.timedOut ?? false,
      durationMs: scripted.durationMs ?? 3,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* The harness                                                                 */
/* -------------------------------------------------------------------------- */

export interface TaskHarness {
  service: TaskService;
  repository: FakeRepository;
  repos: InMemoryTaskRepos;
  git: FakeGit;
  commands: FakeCommands;
  bus: EventBus;
  events: EngineEvent[];
  project: Project;
  team: Workflow;
  planner: Workflow;
  /** Every run the service started, by id. */
  runs: Map<Id, { workflowId: Id; request: StartRunRequest }>;
  /** Ends a started run the way the run engine does: row updated, then `run.completed`. */
  finishRun(
    runId: Id,
    status: Extract<RunState, 'COMPLETE' | 'HALTED' | 'BLOCKED'>,
    options?: { text?: string; haltReason?: Run['haltReason']; changes?: ChangedFile[] },
  ): Promise<void>;
  /** The id of the latest run the service started. */
  lastRunId(): Id;
  /** Waits for every background step. */
  settle(): Promise<void>;
  stopped: Id[];
  detach(): void;
}

const NOW = '2026-10-06T12:00:00.000Z';

export async function createTaskHarness(options?: {
  startRunError?: Error;
  /** A run the engine already finished by the time `startRun` answers. */
  blockAtPreflight?: boolean;
  projectPatch?: Partial<Project>;
}): Promise<TaskHarness> {
  const repository = new FakeRepository();
  const repos = new InMemoryTaskRepos();
  Object.assign(repository, {
    tasks: repos.tasks,
    taskWorkspaces: repos.taskWorkspaces,
    taskExecutions: repos.taskExecutions,
    taskChecks: repos.taskChecks,
    taskReviews: repos.taskReviews,
    taskDeliveries: repos.taskDeliveries,
    taskActivity: repos.taskActivity,
  });
  const scope = LOCAL_SCOPE;
  const bus = createEventBus({ repository, scope, pubsub: new InProcessPubSubStub<EngineEvent>() });
  const events: EngineEvent[] = [];
  await bus.subscribe((event) => events.push(event));

  const project: Project = {
    id: newId(),
    name: 'Shop',
    folderPath: 'D:/repos/shop',
    createdAt: NOW,
    updatedAt: NOW,
    ...options?.projectPatch,
  };
  await repository.projects.create(scope, project);
  const workflow = (name: string): Workflow => ({
    id: newId(),
    projectId: project.id,
    name,
    version: 1,
    formatVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const team = workflow('Builder');
  const planner = workflow('Planner');
  for (const flow of [team, planner]) {
    await repository.workflows.create(scope, flow);
    await repository.nodes.insert(scope, {
      id: newId(),
      workflowId: flow.id,
      kind: 'input',
      name: 'Brief',
      position: { x: 0, y: 0 },
      inputs: [],
      outputs: [],
      config: { artifactIds: [], outputTypes: ['text'] },
    });
  }

  const git = new FakeGit();
  const commands = new FakeCommands();
  const runs = new Map<Id, { workflowId: Id; request: StartRunRequest }>();
  const stopped: Id[] = [];
  let lastRun: Id | undefined;

  const service = createTaskService({
    repository,
    scope,
    bus,
    logger: createLogger({ level: 'silent', destination: { write: () => undefined } }),
    git,
    commands,
    workspaceRoot: 'C:/ace/workspaces',
    mask: (text) => text.replace(/sk-[a-z0-9]+/g, '[REDACTED]'),
    startRun: async (workflowId, request, runId) => {
      if (options?.startRunError !== undefined) throw options.startRunError;
      runs.set(runId, { workflowId, request });
      lastRun = runId;
      const run: Run = {
        id: runId,
        workflowId,
        projectId: project.id,
        status: options?.blockAtPreflight === true ? 'BLOCKED' : 'RUNNING',
        snapshot: { version: 1, nodes: [], edges: [] },
        inputs: request.inputs ?? {},
        preflightIssues:
          options?.blockAtPreflight === true
            ? [{ severity: 'error', code: 'missing_model', message: 'Builder has no model.' }]
            : [],
        totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
        startedAt: NOW,
      };
      await repository.runs.create(scope, run);
      return run;
    },
    stopRun: async (runId) => {
      stopped.push(runId);
    },
  });
  const detach = await service.attach();

  return {
    service,
    repository,
    repos,
    git,
    commands,
    bus,
    events,
    project,
    team,
    planner,
    runs,
    stopped,
    detach,
    lastRunId: () => {
      if (lastRun === undefined) throw new Error('no run started');
      return lastRun;
    },
    settle: () => service.idle(),
    async finishRun(runId, status, finish) {
      await service.idle();
      const execution = await repos.taskExecutions.getByRun(scope, runId);
      if (finish?.changes !== undefined && execution !== null) {
        const workspace = await repos.taskWorkspaces.getByTask(scope, execution.taskId);
        if (workspace !== null) git.pendingChanges.set(workspace.path, finish.changes);
      }
      const outputNode = newId();
      await repository.runs.update(scope, runId, {
        status,
        ...(finish?.haltReason === undefined ? {} : { haltReason: finish.haltReason }),
        ...(finish?.text === undefined
          ? {}
          : { finalOutput: { [outputNode]: [{ type: 'text', text: finish.text }] } }),
        endedAt: NOW,
      });
      await bus.emit({
        type: 'run.completed',
        runId,
        payload: { runId, status, totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 } },
      });
      await service.idle();
    },
  };
}

export const file = (path: string, status: ChangedFile['status'] = 'modified'): ChangedFile => ({
  path,
  status,
  additions: 3,
  deletions: 1,
  binary: false,
});
