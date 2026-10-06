import {
  TASK_LABEL_MAX,
  TASK_LABELS_MAX,
  type ChangeStatus,
  type CheckStatus,
  type ExecutionStatus,
  type FinishLine,
  type TaskAutomation,
  type TaskOutcome,
  type TaskPriority,
  type TaskStage,
  type TaskState,
  type TaskType,
} from '@ace/contracts';

/** Words for the task contract's enums (ACE parity P0); the enum names stay the contract. */

export const STAGE_LABEL: Readonly<Record<TaskStage, string>> = {
  inbox: 'Inbox',
  plan: 'Plan',
  work: 'Work',
  review: 'Review',
  done: 'Done',
};

export const STATE_LABEL: Readonly<Record<TaskState, string>> = {
  idle: 'idle',
  queued: 'queued',
  running: 'running',
  waiting: 'waiting',
  failed: 'failed',
  done: 'done',
};

/** The node-state colours, so a running task and a running node read the same (FR-EXE-009). */
export const STATE_COLOR: Readonly<Record<TaskState, string>> = {
  idle: 'var(--color-status-IDLE)',
  queued: 'var(--color-status-READY)',
  running: 'var(--color-status-RUNNING)',
  waiting: 'var(--color-status-WAITING)',
  failed: 'var(--color-status-FAILED)',
  done: 'var(--color-status-COMPLETED)',
};

export const OUTCOME_LABEL: Readonly<Record<TaskOutcome, string>> = {
  reviewed: 'Reviewed',
  applied: 'Applied',
  merged: 'Merged',
  accepted: 'Accepted',
  sent: 'Sent',
  closed_unverified: 'Closed without verification',
  cancelled: 'Cancelled',
};

export const FINISH_LINE_LABEL: Readonly<Record<FinishLine, string>> = {
  review: 'Pass review',
  apply_local: 'Apply changes locally',
  github_merge: 'Merge on GitHub',
  accept_draft: 'Accept the draft',
  send_email: 'Send the email',
  accept_document: 'Accept the document',
};

/** Shown so the road ahead is visible, but not offered yet: the engine has no GitHub delivery. */
export const FINISH_LINES_LATER: ReadonlySet<FinishLine> = new Set<FinishLine>(['github_merge']);

export const TYPE_LABEL: Readonly<Record<TaskType, string>> = {
  app: 'App',
  email: 'Email',
  document: 'Document',
};

/** Only App tasks are built in this step; Email and Document are shown, disabled. */
export const TYPES_LATER: ReadonlySet<TaskType> = new Set<TaskType>(['email', 'document']);

export const AUTOMATION_META: Readonly<Record<TaskAutomation, { label: string; hint: string }>> = {
  manual: { label: 'Manual', hint: 'You start every stage yourself.' },
  assisted: {
    label: 'Assisted',
    hint: 'Plan, work and review move on by themselves; the final action waits for you.',
  },
  autopilot: {
    label: 'Autopilot',
    hint: 'As Assisted, and the final action runs by itself once the checks pass — only with Full access in Settings.',
  },
};

export const PRIORITY_LABEL: Readonly<Record<TaskPriority, string>> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

export const EXECUTION_STATUS_COLOR: Readonly<Record<ExecutionStatus, string>> = {
  running: 'var(--color-status-RUNNING)',
  completed: 'var(--color-status-COMPLETED)',
  failed: 'var(--color-status-FAILED)',
  stopped: 'var(--color-status-STOPPED)',
};

export const CHECK_STATUS_COLOR: Readonly<Record<CheckStatus, string>> = {
  passed: 'var(--color-status-COMPLETED)',
  failed: 'var(--color-status-FAILED)',
  error: 'var(--color-status-FAILED)',
  timeout: 'var(--color-status-BLOCKED)',
};

/** Git's one-letter status, as `git status --short` prints it. */
export const CHANGE_LETTER: Readonly<Record<ChangeStatus, string>> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  type_changed: 'T',
};

/** The first seven characters of a commit, as Git shows it. */
export const shortSha = (sha: string): string => sha.slice(0, 7);

/**
 * "search, ui , search" → `['search', 'ui']`: trimmed, blanks and repeats dropped, each label cut to
 * the contract's length and the list to its count, so what is typed is what the engine accepts.
 */
export function parseLabels(raw: string): string[] {
  const labels: string[] = [];
  for (const part of raw.split(',')) {
    const label = part.trim().slice(0, TASK_LABEL_MAX);
    if (label !== '' && !labels.includes(label)) labels.push(label);
  }
  return labels.slice(0, TASK_LABELS_MAX);
}

/** "3 min ago"-style relative time for the activity feed and cards. */
export function timeAgo(at: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(at).getTime()) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
