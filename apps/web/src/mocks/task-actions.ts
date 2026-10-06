import type { Task, TaskAction, TaskWorkspace } from '@ace/contracts';

/**
 * Design §2.1: what a person may do to a task right now. The engine writes this on every task it
 * answers; the mock computes it the same way on every read, so the board never guesses.
 */
export interface TaskActionContext {
  /** The latest execution is running with a run the engine can stop. */
  hasLiveRun: boolean;
  /** The project has check commands to run (`checks` needs some). */
  projectHasChecks: boolean;
  workspace: Pick<TaskWorkspace, 'status'> | undefined;
}

type ActionFields = Pick<
  Task,
  'stage' | 'state' | 'type' | 'finishLine' | 'paused' | 'workflowId' | 'plannerWorkflowId'
>;

const ACTIVE = new Set<Task['state']>(['running', 'waiting']);
const SETTLED = new Set<Task['state']>(['idle', 'failed']);

export function allowedTaskActions(task: ActionFields, context: TaskActionContext): TaskAction[] {
  const { stage, state } = task;
  const done = stage === 'done';
  const active = ACTIVE.has(state);
  const settled = SETTLED.has(state);
  const workspaceReady = context.workspace?.status === 'ready';
  const inReview = stage === 'review' && settled;

  const rules: [TaskAction, boolean][] = [
    ['start', stage === 'inbox' && state === 'idle'],
    [
      'plan',
      (stage === 'inbox' || stage === 'plan') && settled && task.plannerWorkflowId !== undefined,
    ],
    ['work', !done && settled && task.workflowId !== undefined],
    ['stop', active && context.hasLiveRun],
    ['retry', state === 'failed'],
    [
      'checks',
      task.type === 'app' && workspaceReady && state !== 'running' && context.projectHasChecks,
    ],
    ['approve', inReview],
    ['request_changes', inReview],
    ['apply', inReview && task.type === 'app' && task.finishLine !== 'review' && workspaceReady],
    ['close', !done && !active],
    ['pause', !done && !task.paused],
    ['resume', !done && task.paused],
    ['move', !done && settled],
    ['delete', !active],
  ];
  return rules.filter(([, allowed]) => allowed).map(([action]) => action);
}
