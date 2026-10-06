import type {
  ChangedFile,
  Id,
  Task,
  TaskActivity,
  TaskCheck,
  TaskDelivery,
  TaskExecution,
  TaskReview,
  TaskStage,
  TaskState,
  TaskWorkspace,
} from '@ace/contracts';

import type { Scope } from './scope.js';

/*
 * ACE parity P0 ports (docs/ACE_FEATURE_PARITY.md, D268, D269, D271): where tasks and their
 * workspaces, runs, checks, reviews, deliveries and activity are kept, and the two things the task
 * service drives on the machine — Git and the user's check commands. Interfaces only:
 * `packages/storage-local` implements the repositories and `packages/tools` the Git port and the
 * command runner, exactly as it implements the Sandbox.
 */

/* -------------------------------------------------------------------------- */
/* Repositories                                                                */
/* -------------------------------------------------------------------------- */

/** A task as stored: `allowedActions` is computed from it on every read, never kept. */
export type TaskRecord = Omit<Task, 'allowedActions'>;

export interface TaskListFilter {
  stage?: TaskStage;
  states?: readonly TaskState[];
}

export interface TaskRepository {
  create(scope: Scope, task: TaskRecord): Promise<TaskRecord>;
  get(scope: Scope, id: Id): Promise<TaskRecord | null>;
  /** One project's tasks, newest number first. */
  listByProject(scope: Scope, projectId: Id, filter?: TaskListFilter): Promise<TaskRecord[]>;
  /** Every project's tasks in these states — what start-up recovery and the capacity queue read. */
  listByStates(scope: Scope, states: readonly TaskState[]): Promise<TaskRecord[]>;
  /** Replaces the stored task with this one (same id); throws if it does not exist. */
  save(scope: Scope, task: TaskRecord): Promise<TaskRecord>;
  /** Removes the task and every row that belongs to it. `false` if it was not there. */
  delete(scope: Scope, id: Id): Promise<boolean>;
  /** The number the project's next task gets: one more than the highest so far, from 1. */
  nextNumber(scope: Scope, projectId: Id): Promise<number>;
}

export interface TaskWorkspaceRepository {
  create(scope: Scope, workspace: TaskWorkspace): Promise<TaskWorkspace>;
  getByTask(scope: Scope, taskId: Id): Promise<TaskWorkspace | null>;
  save(scope: Scope, workspace: TaskWorkspace): Promise<TaskWorkspace>;
}

export interface TaskExecutionRepository {
  create(scope: Scope, execution: TaskExecution): Promise<TaskExecution>;
  get(scope: Scope, id: Id): Promise<TaskExecution | null>;
  /** The execution a run belongs to, or `null` for a run no task started. */
  getByRun(scope: Scope, runId: Id): Promise<TaskExecution | null>;
  /** In sequence order. */
  listByTask(scope: Scope, taskId: Id): Promise<TaskExecution[]>;
  save(scope: Scope, execution: TaskExecution): Promise<TaskExecution>;
}

export interface TaskCheckRepository {
  create(scope: Scope, check: TaskCheck): Promise<TaskCheck>;
  /** Oldest first. */
  listByTask(scope: Scope, taskId: Id): Promise<TaskCheck[]>;
}

export interface TaskReviewRepository {
  create(scope: Scope, review: TaskReview): Promise<TaskReview>;
  /** Oldest first. */
  listByTask(scope: Scope, taskId: Id): Promise<TaskReview[]>;
}

export interface TaskDeliveryRepository {
  create(scope: Scope, delivery: TaskDelivery): Promise<TaskDelivery>;
  /** Oldest first. */
  listByTask(scope: Scope, taskId: Id): Promise<TaskDelivery[]>;
}

export interface TaskActivityRepository {
  append(scope: Scope, activity: TaskActivity): Promise<TaskActivity>;
  /** Oldest first; the last `limit` rows when a limit is given. */
  listByTask(scope: Scope, taskId: Id, limit?: number): Promise<TaskActivity[]>;
}

/* -------------------------------------------------------------------------- */
/* Git (D269)                                                                  */
/* -------------------------------------------------------------------------- */

export interface RepoStatus {
  /** Whether a `git` binary could be run at all. */
  gitAvailable: boolean;
  isRepo: boolean;
  /** `null` on a detached HEAD. Absent when not a repository. */
  branch?: string | null;
  /** Absent in a repository with no commit yet. */
  headSha?: string;
  /** No tracked file has uncommitted changes. */
  clean?: boolean;
  changedFiles?: number;
  /** The `origin` remote's URL, when there is one. */
  remoteUrl?: string;
}

export type MergeResult =
  | { ok: true; sha: string }
  | { ok: false; reason: 'conflict'; conflicts: string[]; message: string }
  | { ok: false; reason: 'dirty' | 'wrong_branch' | 'failed'; message: string };

/**
 * Git on the machine. Every call runs `git` with an argument array — never a shell — and with
 * `GIT_TERMINAL_PROMPT=0`, so nothing can wait on a password prompt. A failure the caller should
 * show is a `GitError` (`packages/tools`) whose message is Git's own stderr, trimmed.
 */
export interface GitPort {
  inspect(folder: string): Promise<RepoStatus>;
  /**
   * `git init` with an initial commit of whatever the folder holds (an empty commit if nothing), so
   * a worktree has a base to start from. Refuses a folder that is already a repository.
   */
  init(folder: string): Promise<RepoStatus>;
  branchExists(repoPath: string, branch: string): Promise<boolean>;
  /** `git worktree add -b <branch> <worktreePath> <baseRef>`; returns the commit it started at. */
  createWorktree(input: {
    repoPath: string;
    worktreePath: string;
    branch: string;
    baseRef: string;
  }): Promise<{ baseSha: string }>;
  /** Removes the worktree folder (forced) and, when named, deletes the branch. */
  removeWorktree(input: {
    repoPath: string;
    worktreePath: string;
    deleteBranch?: string;
  }): Promise<void>;
  /**
   * Stages everything in `cwd` and commits it with hooks skipped (ACE's own bookkeeping, D269).
   * `null` when there was nothing to commit. Uses the repository's configured identity, or
   * `ACE <ace@localhost>` when none is configured.
   */
  commitAll(input: { cwd: string; message: string }): Promise<{ sha: string } | null>;
  headSha(cwd: string): Promise<string>;
  /**
   * The files that differ between `baseSha` and HEAD — or the working tree, including untracked
   * files, when `includeUncommitted` — with rename detection and per-file line counts.
   */
  changes(input: {
    cwd: string;
    baseSha: string;
    includeUncommitted: boolean;
    /**
     * Diff `baseSha`..`headRef` instead of HEAD — how an applied task's changes are still shown
     * from the source repository once its worktree is gone. Ignored with `includeUncommitted`.
     */
    headRef?: string;
  }): Promise<{ files: ChangedFile[]; uncommitted: boolean }>;
  /** One file's unified diff over the same range as `changes`, cut at `maxBytes`. */
  fileDiff(input: {
    cwd: string;
    baseSha: string;
    path: string;
    includeUncommitted: boolean;
    maxBytes: number;
    /** As `changes`' `headRef`. */
    headRef?: string;
  }): Promise<{ patch: string; truncated: boolean; binary: boolean }>;
  /**
   * Merges `branch` into the repository's current branch with `--no-ff`. Refuses (without touching
   * anything) a repository whose tracked files have uncommitted changes, or whose current branch is
   * not `expectedBranch`. A conflict aborts the merge and reports the conflicting paths.
   */
  merge(input: {
    repoPath: string;
    branch: string;
    expectedBranch: string;
    message: string;
  }): Promise<MergeResult>;
}

/* -------------------------------------------------------------------------- */
/* Commands (D271)                                                             */
/* -------------------------------------------------------------------------- */

export interface CommandResult {
  /** `null` when the process was killed (timeout or abort) before it exited. */
  exitCode: number | null;
  /** stdout and stderr interleaved as they arrived, the last `maxOutput` characters. */
  output: string;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Runs one user-configured command line through the platform shell (`cmd.exe /d /s /c` on Windows,
 * `/bin/sh -c` elsewhere) in `cwd`. Timeout and abort kill the whole process tree. Used for a
 * project's check and setup commands only — never for anything an agent wrote (D271).
 */
export interface CommandRunner {
  run(input: {
    command: string;
    cwd: string;
    env?: Record<string, string>;
    timeoutMs: number;
    maxOutput: number;
    signal?: AbortSignal;
  }): Promise<CommandResult>;
}
