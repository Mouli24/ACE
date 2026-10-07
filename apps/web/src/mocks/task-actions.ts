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
  workspace: Pick<TaskWorkspace, 'status' | 'pullRequest'> | undefined;
  /** ACE parity P1 (D278): the project has a preview command. */
  projectHasPreview?: boolean;
}

type ActionFields = Pick<
  Task,
  'stage' | 'state' | 'type' | 'finishLine' | 'paused' | 'workflowId' | 'plannerWorkflowId'
> &
  Partial<Pick<Task, 'deliverable'>>;

const ACTIVE = new Set<Task['state']>(['running', 'waiting']);
const SETTLED = new Set<Task['state']>(['idle', 'failed']);

export function allowedTaskActions(task: ActionFields, context: TaskActionContext): TaskAction[] {
  const { stage, state } = task;
  const done = stage === 'done';
  const active = ACTIVE.has(state);
  const settled = SETTLED.has(state);
  const workspaceReady = context.workspace?.status === 'ready';
  const inReview = stage === 'review' && settled;
  const app = task.type === 'app';
  const githubMerge = inReview && app && task.finishLine === 'github_merge' && workspaceReady;
  const pullRequestOpen = context.workspace?.pullRequest?.state === 'open';

  const rules: [TaskAction, boolean][] = [
    ['start', stage === 'inbox' && state === 'idle'],
    [
      'plan',
      (stage === 'inbox' || stage === 'plan') && settled && task.plannerWorkflowId !== undefined,
    ],
    ['work', !done && settled && task.workflowId !== undefined],
    ['stop', active && context.hasLiveRun],
    ['retry', state === 'failed'],
    ['checks', app && workspaceReady && state !== 'running' && context.projectHasChecks],
    ['approve', inReview],
    ['request_changes', inReview],
    // D276: Apply is the local finish line only; GitHub's is open the pull request, then merge it
    ['apply', inReview && app && task.finishLine === 'apply_local' && workspaceReady],
    ['open_pr', githubMerge && !pullRequestOpen],
    ['merge_pr', githubMerge && pullRequestOpen],
    // D275: a Document or Email deliverable is accepted; an email whose finish line is Send asks to
    [
      'accept',
      inReview &&
        task.deliverable !== undefined &&
        (task.finishLine === 'accept_document' || task.finishLine === 'accept_draft'),
    ],
    ['send', inReview && task.type === 'email' && task.finishLine === 'send_email'],
    // D278: a preview of the workspace, whenever there is one and the project says how
    ['preview', app && !done && workspaceReady && context.projectHasPreview === true],
    ['close', !done && !active],
    ['pause', !done && !task.paused],
    ['resume', !done && task.paused],
    ['move', !done && settled],
    ['delete', !active],
  ];
  return rules.filter(([, allowed]) => allowed).map(([action]) => action);
}
