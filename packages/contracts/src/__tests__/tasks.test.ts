import { describe, expect, it } from 'vitest';

import { EngineEventSchema } from '../events.js';
import { ProjectSchema } from '../graph.js';
import { UpdateProjectRequestSchema } from '../api.js';
import { SettingsPatchSchema } from '../settings.js';
import {
  ApplyTaskRequestSchema,
  CreateTaskRequestSchema,
  DEFAULT_FINISH_LINE,
  FINISH_LINES_BY_TYPE,
  ReviewTaskRequestSchema,
  RepositoryInfoSchema,
  TASK_STAGES,
  TaskChangesSchema,
  TaskDetailSchema,
  TaskListQuerySchema,
  TaskSchema,
  UpdateTaskRequestSchema,
  finishLineFits,
  isVerifiedOutcome,
  needsAttention,
  type Task,
} from '../tasks.js';
import { NOW, PROJECT_ID, RUN_ID, WORKFLOW_ID } from './fixtures.js';

const TASK_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0TSK1';
const WORKSPACE_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0WSP1';
const EXECUTION_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0EXE1';
const SHA = 'a'.repeat(40);
const SHA_2 = 'b'.repeat(40);

const task: Task = {
  id: TASK_ID,
  projectId: PROJECT_ID,
  number: 1,
  title: 'Add a search field',
  brief: 'Match names and show an empty state.',
  type: 'app',
  stage: 'inbox',
  state: 'idle',
  finishLine: 'apply_local',
  automation: 'assisted',
  priority: 'normal',
  labels: ['ui'],
  workflowId: WORKFLOW_ID,
  plan: '',
  acceptance: 'The list filters as I type.',
  runChecks: true,
  paused: false,
  allowedActions: ['start', 'close', 'pause', 'move', 'delete'],
  createdAt: NOW,
  updatedAt: NOW,
};

describe('ACE parity — Task', () => {
  it('declares the five board columns in order', () => {
    expect([...TASK_STAGES]).toEqual(['inbox', 'plan', 'work', 'review', 'done']);
  });

  it('parses a task and refuses a stray key', () => {
    expect(TaskSchema.safeParse(task).success).toBe(true);
    expect(TaskSchema.safeParse({ ...task, worker: 'x' }).success).toBe(false);
  });

  it('keeps finish lines to the ones a type can reach', () => {
    expect(finishLineFits('app', 'github_merge')).toBe(true);
    expect(finishLineFits('app', 'send_email')).toBe(false);
    expect(finishLineFits('document', 'accept_document')).toBe(true);
    for (const type of ['app', 'email', 'document'] as const) {
      expect(FINISH_LINES_BY_TYPE[type]).toContain(DEFAULT_FINISH_LINE[type]);
    }
  });

  it('refuses a create request whose finish line does not fit its type', () => {
    expect(
      CreateTaskRequestSchema.safeParse({
        title: 'x',
        type: 'email',
        finishLine: 'apply_local',
      }).success,
    ).toBe(false);
    expect(
      CreateTaskRequestSchema.safeParse({
        title: 'x',
        finishLine: 'apply_local',
      }).success,
    ).toBe(true);
  });

  it('never moves a task into done by a stage edit', () => {
    expect(UpdateTaskRequestSchema.safeParse({ stage: 'done' }).success).toBe(false);
    expect(UpdateTaskRequestSchema.safeParse({ stage: 'review' }).success).toBe(true);
    expect(UpdateTaskRequestSchema.safeParse({ workflowId: null }).success).toBe(true);
  });

  it('needs a note to request changes', () => {
    expect(ReviewTaskRequestSchema.safeParse({ decision: 'changes_requested' }).success).toBe(
      false,
    );
    expect(
      ReviewTaskRequestSchema.safeParse({
        decision: 'changes_requested',
        note: 'Use a debounce.',
      }).success,
    ).toBe(true);
    expect(ReviewTaskRequestSchema.safeParse({ decision: 'approved', headSha: SHA }).success).toBe(
      true,
    );
    expect(
      ReviewTaskRequestSchema.safeParse({
        decision: 'approved',
        headSha: 'abc',
      }).success,
    ).toBe(false);
  });

  it('makes Apply name its destination', () => {
    expect(ApplyTaskRequestSchema.safeParse({}).success).toBe(false);
    expect(
      ApplyTaskRequestSchema.safeParse({
        destination: { folderPath: 'D:/repo', branch: 'main' },
      }).success,
    ).toBe(true);
  });

  it('reads the attention query flag as a boolean', () => {
    expect(TaskListQuerySchema.parse({ attention: 'true' })).toEqual({
      attention: true,
    });
    expect(TaskListQuerySchema.parse({})).toEqual({});
  });

  it('counts waiting, failed and unreviewed work as needing attention', () => {
    expect(needsAttention({ stage: 'work', state: 'waiting' })).toBe(true);
    expect(needsAttention({ stage: 'plan', state: 'failed' })).toBe(true);
    expect(needsAttention({ stage: 'review', state: 'idle' })).toBe(true);
    expect(needsAttention({ stage: 'work', state: 'running' })).toBe(false);
    expect(needsAttention({ stage: 'inbox', state: 'idle' })).toBe(false);
  });

  it('certifies the finish line only for verified outcomes', () => {
    expect(isVerifiedOutcome('applied')).toBe(true);
    expect(isVerifiedOutcome('closed_unverified')).toBe(false);
    expect(isVerifiedOutcome(undefined)).toBe(false);
  });
});

describe('ACE parity — task detail, changes and repository', () => {
  it('parses a detail with its workspace, run and check', () => {
    const detail = {
      task: { ...task, stage: 'review', state: 'idle' },
      workspace: {
        id: WORKSPACE_ID,
        taskId: TASK_ID,
        repoPath: 'D:/repo',
        path: 'C:/Users/me/.ace/workspaces/x',
        branch: 'ace/task-1-add-a-search-field',
        baseBranch: 'main',
        baseSha: SHA,
        headSha: SHA_2,
        status: 'ready',
        createdAt: NOW,
        updatedAt: NOW,
      },
      executions: [
        {
          id: EXECUTION_ID,
          taskId: TASK_ID,
          kind: 'work',
          sequence: 1,
          workflowId: WORKFLOW_ID,
          runId: RUN_ID,
          status: 'completed',
          request: 'Add a search field',
          commitSha: SHA_2,
          changedFiles: 2,
          startedAt: NOW,
          endedAt: NOW,
        },
      ],
      checks: [
        {
          id: '01JBXQ8Z9KQ4R7N2VWXYZ0CHKA',
          taskId: TASK_ID,
          executionId: EXECUTION_ID,
          name: 'tests',
          command: 'pnpm test',
          status: 'passed',
          exitCode: 0,
          output: 'ok',
          durationMs: 1200,
          headSha: SHA_2,
          at: NOW,
        },
      ],
      reviews: [],
      deliveries: [],
    };
    expect(TaskDetailSchema.safeParse(detail).success).toBe(true);
  });

  it('parses changes with a binary file', () => {
    expect(
      TaskChangesSchema.safeParse({
        branch: 'ace/task-1',
        baseBranch: 'main',
        baseSha: SHA,
        headSha: SHA_2,
        uncommitted: false,
        files: [
          {
            path: 'a.ts',
            status: 'modified',
            additions: 3,
            deletions: 1,
            binary: false,
          },
          {
            path: 'logo.png',
            status: 'added',
            additions: null,
            deletions: null,
            binary: true,
          },
          {
            path: 'b.ts',
            oldPath: 'old/b.ts',
            status: 'renamed',
            additions: 0,
            deletions: 0,
            binary: false,
          },
        ],
        totals: { files: 3, additions: 3, deletions: 1 },
      }).success,
    ).toBe(true);
  });

  it('describes a folder that is not a repository with nothing past isRepo', () => {
    expect(
      RepositoryInfoSchema.safeParse({
        folderPath: 'D:/x',
        gitAvailable: true,
        isRepo: false,
      }).success,
    ).toBe(true);
  });

  it('carries a task change on the engine subscription', () => {
    const parsed = EngineEventSchema.safeParse({
      type: 'task.updated',
      payload: {
        task,
        activity: {
          id: '01JBXQ8Z9KQ4R7N2VWXYZ0ACT1',
          taskId: TASK_ID,
          kind: 'created',
          message: 'Task created.',
          at: NOW,
        },
      },
      seq: 3,
    });
    expect(parsed.success).toBe(true);
  });
});

describe('ACE parity — project and settings fields', () => {
  it('reads a project written before the Build settings', () => {
    expect(
      ProjectSchema.safeParse({
        id: PROJECT_ID,
        name: 'p',
        folderPath: 'D:/p',
        createdAt: NOW,
        updatedAt: NOW,
      }).success,
    ).toBe(true);
  });

  it('bounds capacity and check commands, and clears the setup command with null', () => {
    expect(UpdateProjectRequestSchema.safeParse({ buildCapacity: 0 }).success).toBe(false);
    expect(UpdateProjectRequestSchema.safeParse({ buildCapacity: 3 }).success).toBe(true);
    expect(
      UpdateProjectRequestSchema.safeParse({
        checkCommands: [{ name: 'tests', command: 'pnpm test' }],
        setupCommand: null,
        paused: true,
      }).success,
    ).toBe(true);
    expect(
      UpdateProjectRequestSchema.safeParse({
        checkCommands: [{ name: '', command: 'x' }],
      }).success,
    ).toBe(false);
  });

  it('takes the approval mode in a settings patch', () => {
    expect(SettingsPatchSchema.safeParse({ approvalMode: 'full_access' }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ approvalMode: 'yolo' }).success).toBe(false);
  });
});
