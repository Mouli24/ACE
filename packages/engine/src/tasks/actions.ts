import type { Task, TaskAction } from '@ace/contracts';

import type { TaskRecord } from '../ports/index.js';

/**
 * What the task's surroundings add to its own fields when deciding what a person may do
 * (p0-tasks-build-design.md §2.1).
 */
export interface ActionContext {
  /** The task has a workspace in `ready` status. */
  workspaceReady: boolean;
  /** The task's project has at least one check command. */
  projectHasChecks: boolean;
  /** The task's latest execution has a run still going. */
  hasActiveRun: boolean;
}

/**
 * The allowed actions, computed — never stored — so the board and the engine cannot disagree about
 * them (the `allowedRunActions` pattern, FR-CTL-006). Every action the engine accepts is checked
 * against this same function before it does anything.
 */
export function allowedTaskActions(task: TaskRecord, context: ActionContext): TaskAction[] {
  const { stage, state } = task;
  const done = stage === 'done';
  const busy = state === 'running' || state === 'waiting';
  const settled = state === 'idle' || state === 'failed';
  const actions: TaskAction[] = [];

  if (stage === 'inbox' && state === 'idle') actions.push('start');
  if ((stage === 'inbox' || stage === 'plan') && settled && task.plannerWorkflowId !== undefined) {
    actions.push('plan');
  }
  if (!done && settled && task.workflowId !== undefined) actions.push('work');
  if (busy && context.hasActiveRun) actions.push('stop');
  if (state === 'failed') actions.push('retry');
  if (
    task.type === 'app' &&
    context.workspaceReady &&
    context.projectHasChecks &&
    !done &&
    !busy &&
    state !== 'queued'
  ) {
    actions.push('checks');
  }
  if (stage === 'review' && settled) {
    actions.push('approve', 'request_changes');
    if (task.type === 'app' && task.finishLine !== 'review' && context.workspaceReady) {
      actions.push('apply');
    }
  }
  if (!done && !busy) actions.push('close');
  if (!done) actions.push(task.paused ? 'resume' : 'pause');
  if (!done && settled) actions.push('move');
  if (!busy) actions.push('delete');
  return actions;
}

export function withActions(task: TaskRecord, context: ActionContext): Task {
  return { ...task, allowedActions: allowedTaskActions(task, context) };
}
