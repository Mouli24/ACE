import { z } from 'zod';

import { CHECK_COMMAND_MAX, CHECK_NAME_MAX, IdSchema, TimestampSchema } from './graph.js';

/**
 * Tasks, task workspaces, changes, checks, reviews and deliveries — the ACE parity P0 contract
 * (docs/ACE_FEATURE_PARITY.md §3.2–§3.3, D267–D271).
 *
 * A task is a unit of work on a project's board. It moves through five **stages** — the board's
 * columns — and at any moment has one **state** saying whether anything is happening in that stage.
 * Its plan and work stages are runs of a project workflow (the task's team, D268); an App task's
 * work happens in its own Git worktree on its own branch (D269). Reaching the Done column is not the
 * same as reaching the **finish line**: Done records an `outcome`, and only some outcomes certify
 * that the finish line was reached (`closed_unverified` and `cancelled` do not).
 *
 * Every body is strict, as round 3's are: on this seam a stray key is how an action the engine does
 * not check would ride in.
 */

/* -------------------------------------------------------------------------- */
/* Enums                                                                       */
/* -------------------------------------------------------------------------- */

/** What a task produces. App: changes in a workspace. Email: a draft. Document: Markdown. */
export const TASK_TYPES = ['app', 'email', 'document'] as const;
export const TaskTypeSchema = z.enum(TASK_TYPES);
export type TaskType = z.infer<typeof TaskTypeSchema>;

/** The board's columns, in order. */
export const TASK_STAGES = ['inbox', 'plan', 'work', 'review', 'done'] as const;
export const TaskStageSchema = z.enum(TASK_STAGES);
export type TaskStage = z.infer<typeof TaskStageSchema>;

/**
 * What is happening in the task's stage right now.
 *
 * - `idle` — nothing in flight: captured in the Inbox, a plan waiting to be started, work waiting
 *   for review.
 * - `queued` — waiting for a Build slot (the project's capacity) or for the project to be resumed.
 * - `running` — a plan or work run, the workspace setup or the checks are in progress.
 * - `waiting` — a run is waiting for a person: an approval card or an answer.
 * - `failed` — the last thing the stage tried failed; `stateReason` says what and Retry re-tries it.
 * - `done` — the task is in the Done column; `outcome` says how it got there.
 */
export const TASK_STATES = ['idle', 'queued', 'running', 'waiting', 'failed', 'done'] as const;
export const TaskStateSchema = z.enum(TASK_STATES);
export type TaskState = z.infer<typeof TaskStateSchema>;

/** The finish lines, by type. A task names one when it is created; it can be changed until Done. */
export const FINISH_LINES = [
  'review',
  'apply_local',
  'github_merge',
  'accept_draft',
  'send_email',
  'accept_document',
] as const;
export const FinishLineSchema = z.enum(FINISH_LINES);
export type FinishLine = z.infer<typeof FinishLineSchema>;

export const FINISH_LINES_BY_TYPE = {
  app: ['review', 'apply_local', 'github_merge'],
  email: ['accept_draft', 'send_email'],
  document: ['accept_document'],
} as const satisfies Record<TaskType, readonly FinishLine[]>;

export const DEFAULT_FINISH_LINE = {
  app: 'review',
  email: 'accept_draft',
  document: 'accept_document',
} as const satisfies Record<TaskType, FinishLine>;

export function finishLineFits(type: TaskType, finishLine: FinishLine): boolean {
  return (FINISH_LINES_BY_TYPE[type] as readonly FinishLine[]).includes(finishLine);
}

/**
 * How a Done task got there. The first five certify the finish line; `closed_unverified` records a
 * closure that certifies nothing; `cancelled` is a task stopped for good.
 */
export const TASK_OUTCOMES = [
  'reviewed',
  'applied',
  'merged',
  'accepted',
  'sent',
  'closed_unverified',
  'cancelled',
] as const;
export const TaskOutcomeSchema = z.enum(TASK_OUTCOMES);
export type TaskOutcome = z.infer<typeof TaskOutcomeSchema>;

/** The outcomes that mean the finish line was reached — what an *after task* trigger waits for. */
export const VERIFIED_TASK_OUTCOMES = [
  'reviewed',
  'applied',
  'merged',
  'accepted',
  'sent',
] as const satisfies readonly TaskOutcome[];

export function isVerifiedOutcome(outcome: TaskOutcome | undefined): boolean {
  return outcome !== undefined && (VERIFIED_TASK_OUTCOMES as readonly string[]).includes(outcome);
}

/**
 * Smart Actions (ACE "Teams and workflows"): how far the task moves by itself.
 *
 * - `manual` — every stage is started by a person.
 * - `assisted` — Plan → Work → Review advance by themselves; the final action waits for a person.
 * - `autopilot` — as assisted, and the final action runs by itself too, but only while the approval
 *   mode is Full access, neither the task nor its project is paused and the checks passed (D270).
 */
export const TASK_AUTOMATIONS = ['manual', 'assisted', 'autopilot'] as const;
export const TaskAutomationSchema = z.enum(TASK_AUTOMATIONS);
export type TaskAutomation = z.infer<typeof TaskAutomationSchema>;
export const DEFAULT_TASK_AUTOMATION: TaskAutomation = 'assisted';

export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const TaskPrioritySchema = z.enum(TASK_PRIORITIES);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

/**
 * What a person may do to a task right now, computed by the engine and written on every task so the
 * board never guesses (the `allowedRunActions` pattern, FR-CTL-006).
 */
export const TASK_ACTIONS = [
  'start',
  'plan',
  'work',
  'stop',
  'retry',
  'checks',
  'approve',
  'request_changes',
  'apply',
  'close',
  'pause',
  'resume',
  'move',
  'delete',
  /* ACE parity P1 (D275, D276): a Document/Email deliverable, GitHub delivery, the preview. */
  'accept',
  'send',
  'open_pr',
  'merge_pr',
  'preview',
] as const;
export const TaskActionSchema = z.enum(TASK_ACTIONS);
export type TaskAction = z.infer<typeof TaskActionSchema>;

/* -------------------------------------------------------------------------- */
/* Bounds                                                                      */
/* -------------------------------------------------------------------------- */

export const TASK_TITLE_MAX = 200;
export const TASK_BRIEF_MAX = 20_000;
export const TASK_PLAN_MAX = 50_000;
export const TASK_NOTE_MAX = 10_000;
export const TASK_LABEL_MAX = 40;
export const TASK_LABELS_MAX = 10;
/** The longest check output kept, as a tail — long enough to read a failure, short enough to store. */
export const CHECK_OUTPUT_MAX = 16_000;
/** The longest run summary kept on an execution. */
export const EXECUTION_SUMMARY_MAX = 8_000;

export const TaskTitleSchema = z.string().trim().min(1).max(TASK_TITLE_MAX);
export const TaskLabelSchema = z.string().trim().min(1).max(TASK_LABEL_MAX);
export const TaskLabelsSchema = z.array(TaskLabelSchema).max(TASK_LABELS_MAX);

/** A full Git object name (SHA-1 or SHA-256), lowercase hex. */
export const GitShaSchema = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, 'must be a git sha');

/* -------------------------------------------------------------------------- */
/* Deliverables and sources (ACE parity P1, D275)                              */
/* -------------------------------------------------------------------------- */

export const DOCUMENT_CONTENT_MAX = 500_000;
export const EMAIL_BODY_MAX = 100_000;
export const EMAIL_RECIPIENTS_MAX = 50;

/**
 * A path inside the project folder: relative, `/`-separated, no `..`, no drive or root, and not
 * inside `.git`. Where a Document task's file is accepted to.
 */
export const ProjectRelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(400)
  .refine(
    (path) =>
      !path.includes('\\') &&
      !/^[a-zA-Z]:/.test(path) &&
      !path.startsWith('/') &&
      !path.split('/').some((segment) => segment === '..' || segment === '') &&
      path.split('/')[0] !== '.git',
    'must be a relative path inside the project folder, like docs/notes.md',
  );

export const EmailAddressSchema = z.email();

/**
 * What a Document or Email task produces, edited in review and then accepted (or sent).
 * A document's `content` is Markdown written by the work run; the user may edit it.
 */
export const TaskDeliverableSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('document'),
    path: ProjectRelativePathSchema,
    content: z.string().max(DOCUMENT_CONTENT_MAX),
  }),
  z.strictObject({
    kind: z.literal('email'),
    to: z.array(EmailAddressSchema).max(EMAIL_RECIPIENTS_MAX),
    cc: z.array(EmailAddressSchema).max(EMAIL_RECIPIENTS_MAX),
    subject: z.string().max(400),
    body: z.string().max(EMAIL_BODY_MAX),
  }),
]);
export type TaskDeliverable = z.infer<typeof TaskDeliverableSchema>;

/**
 * Where a task came from, when not the New task dialog: a chat or timeline message handed over with
 * *Send to Build*, an imported email, an accepted suggestion, or a recurring schedule. Kept so the
 * card can link back, and so a task from a workflow's chat reports its outcome there.
 */
export const TASK_SOURCE_KINDS = ['chat', 'timeline', 'email', 'suggestion', 'schedule'] as const;
export const TaskSourceKindSchema = z.enum(TASK_SOURCE_KINDS);
export type TaskSourceKind = z.infer<typeof TaskSourceKindSchema>;

export const TaskSourceSchema = z.strictObject({
  kind: TaskSourceKindSchema,
  workflowId: IdSchema.optional(),
  threadId: IdSchema.optional(),
  messageId: IdSchema.optional(),
  /** The template task a schedule occurrence was made from, or the suggestion it came from. */
  refId: IdSchema.optional(),
  /** Who/what it is from, in words: an email sender, a suggestion title. */
  label: z.string().max(400).optional(),
});
export type TaskSource = z.infer<typeof TaskSourceSchema>;

/* -------------------------------------------------------------------------- */
/* Task                                                                        */
/* -------------------------------------------------------------------------- */

export const TaskSchema = z.strictObject({
  id: IdSchema,
  projectId: IdSchema,
  /** Per project, from 1 — what the board shows as `#12`. */
  number: z.number().int().min(1),
  title: TaskTitleSchema,
  /** The assignment, in the user's words. */
  brief: z.string().max(TASK_BRIEF_MAX),
  type: TaskTypeSchema,
  stage: TaskStageSchema,
  state: TaskStateSchema,
  /** Why the task is `failed`, `waiting` or `queued`, in words the card can show. */
  stateReason: z.string().optional(),
  /** Set exactly when `stage` is `done`. */
  outcome: TaskOutcomeSchema.optional(),
  finishLine: FinishLineSchema,
  automation: TaskAutomationSchema,
  priority: TaskPrioritySchema,
  labels: TaskLabelsSchema,
  /** The team: the project workflow whose run does the work. Required to start work. */
  workflowId: IdSchema.optional(),
  /** An optional workflow whose run writes the plan. Without one the plan is written by hand. */
  plannerWorkflowId: IdSchema.optional(),
  /** The agreed plan — written by the planner run or by hand, editable until work starts. */
  plan: z.string().max(TASK_PLAN_MAX),
  /** How the user will check the result (ACE: "say how you will check it"). */
  acceptance: z.string().max(TASK_BRIEF_MAX),
  /** Whether the project's check commands run after each work run. */
  runChecks: z.boolean(),
  /** A paused task takes no automatic step; a run already going finishes. */
  paused: z.boolean(),
  /** A correction waiting to be sent to the next work run (requested while paused or queued). */
  pendingRequest: z.string().max(TASK_NOTE_MAX).optional(),
  /** ACE parity P1: a Document or Email task's draft (D275). */
  deliverable: TaskDeliverableSchema.optional(),
  source: TaskSourceSchema.optional(),
  allowedActions: z.array(TaskActionSchema),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  startedAt: TimestampSchema.optional(),
  completedAt: TimestampSchema.optional(),
});
export type Task = z.infer<typeof TaskSchema>;

/* -------------------------------------------------------------------------- */
/* Workspace (D269)                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `ready` — the worktree exists and work happens in it. `applied` / `merged` — its branch reached
 * the destination; the worktree folder is removed, the branch kept. `removed` — discarded with the
 * task. `error` — it could not be created; `error` says why.
 */
export const WORKSPACE_STATUSES = ['ready', 'applied', 'merged', 'removed', 'error'] as const;
export const WorkspaceStatusSchema = z.enum(WORKSPACE_STATUSES);
export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;

export const TaskWorkspaceSchema = z.strictObject({
  id: IdSchema,
  taskId: IdSchema,
  /** The source repository — the project folder. */
  repoPath: z.string().min(1),
  /** The worktree folder, under the engine's data folder. */
  path: z.string().min(1),
  branch: z.string().min(1),
  /** The branch the worktree was cut from, and the commit it started at. */
  baseBranch: z.string().min(1),
  baseSha: GitShaSchema,
  /** The task branch's latest commit — what a review approves and Apply merges. */
  headSha: GitShaSchema,
  status: WorkspaceStatusSchema,
  error: z.string().optional(),
  /** ACE parity P1 (D276): the pull request opened from the task branch, as GitHub last reported it. */
  pullRequest: z
    .strictObject({
      number: z.number().int().min(1),
      url: z.url(),
      state: z.enum(['open', 'merged', 'closed']),
      base: z.string().min(1),
      /** `owner/name` of the repository the pull request is on. */
      repo: z.string().min(3),
    })
    .optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type TaskWorkspace = z.infer<typeof TaskWorkspaceSchema>;

/* -------------------------------------------------------------------------- */
/* Executions — the runs a task made                                           */
/* -------------------------------------------------------------------------- */

export const EXECUTION_KINDS = ['plan', 'work'] as const;
export const ExecutionKindSchema = z.enum(EXECUTION_KINDS);
export type ExecutionKind = z.infer<typeof ExecutionKindSchema>;

export const EXECUTION_STATUSES = ['running', 'completed', 'failed', 'stopped'] as const;
export const ExecutionStatusSchema = z.enum(EXECUTION_STATUSES);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

export const TaskExecutionSchema = z.strictObject({
  id: IdSchema,
  taskId: IdSchema,
  kind: ExecutionKindSchema,
  /** 1, 2, 3 … per task, across both kinds. */
  sequence: z.number().int().min(1),
  workflowId: IdSchema,
  /** Absent only if the run could not be started at all (`error` says why). */
  runId: IdSchema.optional(),
  status: ExecutionStatusSchema,
  /** What this run was asked: the brief for the first, the correction for a follow-up. */
  request: z.string().max(TASK_BRIEF_MAX + TASK_PLAN_MAX + TASK_NOTE_MAX),
  /** The run's final text output, trimmed to `EXECUTION_SUMMARY_MAX`. */
  summary: z.string().max(EXECUTION_SUMMARY_MAX).optional(),
  /** The commit a work run's changes were recorded in; absent when it changed nothing. */
  commitSha: GitShaSchema.optional(),
  changedFiles: z.number().int().min(0).optional(),
  error: z.string().optional(),
  startedAt: TimestampSchema,
  endedAt: TimestampSchema.optional(),
});
export type TaskExecution = z.infer<typeof TaskExecutionSchema>;

/* -------------------------------------------------------------------------- */
/* Checks — the project's verification commands, run in the workspace          */
/* -------------------------------------------------------------------------- */

/* `CheckCommandSchema` and its bounds live in graph.ts, beside the project that carries them. */

export const CHECK_STATUSES = ['passed', 'failed', 'error', 'timeout'] as const;
export const CheckStatusSchema = z.enum(CHECK_STATUSES);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const TaskCheckSchema = z.strictObject({
  id: IdSchema,
  taskId: IdSchema,
  executionId: IdSchema.optional(),
  name: z.string().min(1).max(CHECK_NAME_MAX),
  command: z.string().min(1).max(CHECK_COMMAND_MAX),
  status: CheckStatusSchema,
  exitCode: z.number().int().optional(),
  /** stdout and stderr together, the last `CHECK_OUTPUT_MAX` characters, secrets masked. */
  output: z.string().max(CHECK_OUTPUT_MAX),
  durationMs: z.number().int().min(0),
  /** The commit the check ran against: a check of an earlier commit says nothing about a later one. */
  headSha: GitShaSchema,
  at: TimestampSchema,
});
export type TaskCheck = z.infer<typeof TaskCheckSchema>;

/* -------------------------------------------------------------------------- */
/* Reviews and deliveries                                                      */
/* -------------------------------------------------------------------------- */

export const REVIEW_DECISIONS = ['approved', 'changes_requested'] as const;
export const ReviewDecisionSchema = z.enum(REVIEW_DECISIONS);
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

/** A review approves one commit: "a review of an earlier run does not approve later changes". */
export const TaskReviewSchema = z.strictObject({
  id: IdSchema,
  taskId: IdSchema,
  decision: ReviewDecisionSchema,
  note: z.string().max(TASK_NOTE_MAX).optional(),
  /** Absent for a task with no workspace (an Email or Document task). */
  headSha: GitShaSchema.optional(),
  at: TimestampSchema,
});
export type TaskReview = z.infer<typeof TaskReviewSchema>;

export const DELIVERY_KINDS = [
  'apply_local',
  'github_pr',
  'github_merge',
  'document_accept',
  'email_accept',
  'email_send',
] as const;
export const DeliveryKindSchema = z.enum(DELIVERY_KINDS);
export type DeliveryKind = z.infer<typeof DeliveryKindSchema>;

/**
 * `uncertain` is a delivery the destination did not confirm either way (ACE "Check Gmail"): it is
 * never retried automatically, so it cannot become a duplicate.
 */
export const DELIVERY_STATUSES = ['succeeded', 'failed', 'uncertain'] as const;
export const DeliveryStatusSchema = z.enum(DELIVERY_STATUSES);
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

export const TaskDeliverySchema = z.strictObject({
  id: IdSchema,
  taskId: IdSchema,
  kind: DeliveryKindSchema,
  status: DeliveryStatusSchema,
  /** Where it went, in words: `D:\repo @ main`, a PR URL, a file path, recipients. */
  destination: z.string().min(1),
  detail: z.string().optional(),
  /** The commit a code delivery produced (the merge commit). */
  sha: GitShaSchema.optional(),
  url: z.url().optional(),
  at: TimestampSchema,
});
export type TaskDelivery = z.infer<typeof TaskDeliverySchema>;

/* -------------------------------------------------------------------------- */
/* Activity                                                                    */
/* -------------------------------------------------------------------------- */

export const TASK_ACTIVITY_KINDS = [
  'created',
  'edited',
  'stage_changed',
  'queued',
  'workspace_ready',
  'workspace_failed',
  'run_started',
  'run_completed',
  'run_failed',
  'run_stopped',
  'waiting',
  'resumed',
  'committed',
  'checks_started',
  'checks_passed',
  'checks_failed',
  'approved',
  'changes_requested',
  'delivered',
  'delivery_failed',
  'closed',
  'paused',
  'unpaused',
  'retried',
  'error',
] as const;
export const TaskActivityKindSchema = z.enum(TASK_ACTIVITY_KINDS);
export type TaskActivityKind = z.infer<typeof TaskActivityKindSchema>;

export const TaskActivitySchema = z.strictObject({
  id: IdSchema,
  taskId: IdSchema,
  kind: TaskActivityKindSchema,
  /** One sentence for the card's activity feed. */
  message: z.string().min(1),
  executionId: IdSchema.optional(),
  runId: IdSchema.optional(),
  at: TimestampSchema,
});
export type TaskActivity = z.infer<typeof TaskActivitySchema>;

/* -------------------------------------------------------------------------- */
/* Changes — derived from Git, never stored                                    */
/* -------------------------------------------------------------------------- */

export const CHANGE_STATUSES = [
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'type_changed',
] as const;
export const ChangeStatusSchema = z.enum(CHANGE_STATUSES);
export type ChangeStatus = z.infer<typeof ChangeStatusSchema>;

export const ChangedFileSchema = z.strictObject({
  path: z.string().min(1),
  /** The path before a rename or copy. */
  oldPath: z.string().min(1).optional(),
  status: ChangeStatusSchema,
  /** `null` for a binary file. */
  additions: z.number().int().min(0).nullable(),
  deletions: z.number().int().min(0).nullable(),
  binary: z.boolean(),
});
export type ChangedFile = z.infer<typeof ChangedFileSchema>;

/** `GET /tasks/:id/changes` — base commit → the task branch, plus anything not yet committed. */
export const TaskChangesSchema = z.strictObject({
  branch: z.string(),
  baseBranch: z.string(),
  baseSha: GitShaSchema,
  headSha: GitShaSchema,
  /** True while the worktree has changes no commit holds yet (a run in progress). */
  uncommitted: z.boolean(),
  files: z.array(ChangedFileSchema),
  totals: z.strictObject({
    files: z.number().int().min(0),
    additions: z.number().int().min(0),
    deletions: z.number().int().min(0),
  }),
});
export type TaskChanges = z.infer<typeof TaskChangesSchema>;

/** The longest unified diff of one file returned in one response. */
export const FILE_DIFF_MAX = 512_000;

/** `GET /tasks/:id/changes/diff?path=` — one file's unified diff. */
export const TaskFileDiffSchema = z.strictObject({
  path: z.string().min(1),
  binary: z.boolean(),
  patch: z.string().max(FILE_DIFF_MAX),
  truncated: z.boolean(),
});
export type TaskFileDiff = z.infer<typeof TaskFileDiffSchema>;

/* -------------------------------------------------------------------------- */
/* Schedules (ACE parity P1, D277)                                             */
/* -------------------------------------------------------------------------- */

/**
 * When a task starts by itself. `once`: at a time. `recurring`: a five-field cron expression in an
 * IANA time zone — the task is then a template and each occurrence is a new task. `after_task`:
 * when another task of the project reaches a verified outcome. Schedules run while the engine runs
 * and skip occurrences missed while it was stopped (ACE: "skip occurrences missed while it is
 * closed"); a recurring occurrence waits while the previous one is not Done.
 */
export const TASK_TRIGGER_KINDS = ['once', 'recurring', 'after_task'] as const;
export const TaskTriggerKindSchema = z.enum(TASK_TRIGGER_KINDS);
export type TaskTriggerKind = z.infer<typeof TaskTriggerKindSchema>;

/** Five space-separated cron fields: minute hour day-of-month month day-of-week. */
export const CRON_REGEX = /^\s*(\S+\s+){4}\S+\s*$/;

export const TaskTriggerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('once'), at: TimestampSchema }),
  z.strictObject({
    kind: z.literal('recurring'),
    cron: z.string().regex(CRON_REGEX, 'must be five cron fields, like "0 9 * * 1-5"'),
    timezone: z.string().min(1).max(64),
  }),
  z.strictObject({ kind: z.literal('after_task'), taskId: IdSchema }),
]);
export type TaskTrigger = z.infer<typeof TaskTriggerSchema>;

export const TaskScheduleSchema = z.strictObject({
  id: IdSchema,
  taskId: IdSchema,
  trigger: TaskTriggerSchema,
  enabled: z.boolean(),
  /** The next time it fires (`once`, `recurring`); absent for `after_task` or once it has fired. */
  nextRunAt: TimestampSchema.optional(),
  lastRunAt: TimestampSchema.optional(),
  /** The task the latest occurrence created (`recurring`). */
  lastTaskId: IdSchema.optional(),
  /** Occurrences skipped because the engine was stopped or the previous one was not Done. */
  skipped: z.number().int().min(0),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type TaskSchedule = z.infer<typeof TaskScheduleSchema>;

/** `PUT /tasks/:id/schedule` → `TaskSchedule`; `DELETE` removes it. Only an Inbox task is scheduled. */
export const PutTaskScheduleRequestSchema = z.strictObject({
  trigger: TaskTriggerSchema,
  enabled: z.boolean().optional(),
});
export type PutTaskScheduleRequest = z.infer<typeof PutTaskScheduleRequestSchema>;

/* -------------------------------------------------------------------------- */
/* Preview (ACE parity P1, D278)                                               */
/* -------------------------------------------------------------------------- */

export const PREVIEW_STATUSES = ['starting', 'running', 'stopped', 'failed'] as const;
export const PreviewStatusSchema = z.enum(PREVIEW_STATUSES);
export type PreviewStatus = z.infer<typeof PreviewStatusSchema>;

/** The running app of a task's workspace, started from the project's preview command. */
export const TaskPreviewSchema = z.strictObject({
  taskId: IdSchema,
  status: PreviewStatusSchema,
  command: z.string().min(1),
  /** Where to open it: the project's `previewUrl` with `{port}` filled in. */
  url: z.string().optional(),
  port: z.number().int().min(1).max(65_535).optional(),
  /** The process output, the last `CHECK_OUTPUT_MAX` characters, secrets masked. */
  output: z.string().max(CHECK_OUTPUT_MAX),
  exitCode: z.number().int().optional(),
  startedAt: TimestampSchema.optional(),
  endedAt: TimestampSchema.optional(),
});
export type TaskPreview = z.infer<typeof TaskPreviewSchema>;

/* -------------------------------------------------------------------------- */
/* Detail                                                                      */
/* -------------------------------------------------------------------------- */

/** `GET /tasks/:id` — the task and everything its card and page show. */
export const TaskDetailSchema = z.strictObject({
  task: TaskSchema,
  workspace: TaskWorkspaceSchema.optional(),
  schedule: TaskScheduleSchema.optional(),
  preview: TaskPreviewSchema.optional(),
  executions: z.array(TaskExecutionSchema),
  checks: z.array(TaskCheckSchema),
  reviews: z.array(TaskReviewSchema),
  deliveries: z.array(TaskDeliverySchema),
});
export type TaskDetail = z.infer<typeof TaskDetailSchema>;

/* -------------------------------------------------------------------------- */
/* Requests                                                                    */
/* -------------------------------------------------------------------------- */

/** Where a new task goes: captured in the Inbox, or started at once. */
export const TASK_START_MODES = ['inbox', 'now'] as const;
export const TaskStartModeSchema = z.enum(TASK_START_MODES);
export type TaskStartMode = z.infer<typeof TaskStartModeSchema>;

const finishLineMatchesType = (
  body: { type?: TaskType; finishLine?: FinishLine },
  ctx: z.RefinementCtx,
): void => {
  if (body.finishLine !== undefined && !finishLineFits(body.type ?? 'app', body.finishLine)) {
    ctx.addIssue({
      code: 'custom',
      path: ['finishLine'],
      message: `A ${body.type ?? 'app'} task cannot finish with ${body.finishLine}.`,
    });
  }
};

/** `POST /projects/:id/tasks` → `Task`. */
export const CreateTaskRequestSchema = z
  .strictObject({
    title: TaskTitleSchema,
    brief: z.string().max(TASK_BRIEF_MAX).optional(),
    type: TaskTypeSchema.optional(),
    workflowId: IdSchema.optional(),
    plannerWorkflowId: IdSchema.optional(),
    finishLine: FinishLineSchema.optional(),
    automation: TaskAutomationSchema.optional(),
    priority: TaskPrioritySchema.optional(),
    labels: TaskLabelsSchema.optional(),
    acceptance: z.string().max(TASK_BRIEF_MAX).optional(),
    runChecks: z.boolean().optional(),
    start: TaskStartModeSchema.optional(),
    /* ACE parity P1. */
    /** A Document task's destination, relative to the project folder (D275). */
    documentPath: ProjectRelativePathSchema.optional(),
    /** An Email task's recipients (D275). */
    emailTo: z.array(EmailAddressSchema).max(EMAIL_RECIPIENTS_MAX).optional(),
    source: TaskSourceSchema.optional(),
    /** Starts the task later instead of now or in the Inbox (D277); `start` must then be `inbox`. */
    trigger: TaskTriggerSchema.optional(),
  })
  .superRefine(finishLineMatchesType)
  .superRefine((body, ctx) => {
    if (body.type === 'document' && body.documentPath === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['documentPath'],
        message: 'A document task needs the file it will be accepted to.',
      });
    }
    if (body.trigger !== undefined && body.start === 'now') {
      ctx.addIssue({
        code: 'custom',
        path: ['start'],
        message: 'A scheduled task waits in the Inbox; it cannot also start now.',
      });
    }
  });
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

/**
 * `PATCH /tasks/:id` → `Task`. `null` clears an optional reference (D72). `stage` moves an inactive
 * task between columns; it can never move a task into `done` — that is Close, or a finish line.
 */
export const UpdateTaskRequestSchema = z.strictObject({
  title: TaskTitleSchema.optional(),
  brief: z.string().max(TASK_BRIEF_MAX).optional(),
  plan: z.string().max(TASK_PLAN_MAX).optional(),
  acceptance: z.string().max(TASK_BRIEF_MAX).optional(),
  workflowId: IdSchema.nullable().optional(),
  plannerWorkflowId: IdSchema.nullable().optional(),
  finishLine: FinishLineSchema.optional(),
  automation: TaskAutomationSchema.optional(),
  priority: TaskPrioritySchema.optional(),
  labels: TaskLabelsSchema.optional(),
  runChecks: z.boolean().optional(),
  stage: z.enum(['inbox', 'plan', 'work', 'review']).optional(),
});
export type UpdateTaskRequest = z.infer<typeof UpdateTaskRequestSchema>;

/** `POST /tasks/:id/work` — start a work run; `message` is a correction or a follow-up. */
export const StartWorkRequestSchema = z.strictObject({
  message: z.string().trim().min(1).max(TASK_NOTE_MAX).optional(),
});
export type StartWorkRequest = z.infer<typeof StartWorkRequestSchema>;

/**
 * `POST /tasks/:id/review`. `headSha` is the commit the reviewer looked at; if the branch has moved
 * since, the review is refused (409) — it would approve changes nobody saw.
 */
export const ReviewTaskRequestSchema = z
  .strictObject({
    decision: ReviewDecisionSchema,
    note: z.string().trim().min(1).max(TASK_NOTE_MAX).optional(),
    headSha: GitShaSchema.optional(),
  })
  .superRefine((body, ctx) => {
    if (body.decision === 'changes_requested' && body.note === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['note'],
        message: 'Say what should change.',
      });
    }
  });
export type ReviewTaskRequest = z.infer<typeof ReviewTaskRequestSchema>;

/**
 * `POST /tasks/:id/apply` — merge the task branch into the source repository. The client repeats the
 * destination it showed the user; if the repository is no longer on that branch the apply is refused
 * (409), so changes never land somewhere nobody confirmed.
 */
export const ApplyTaskRequestSchema = z.strictObject({
  destination: z.strictObject({
    folderPath: z.string().min(1),
    branch: z.string().min(1),
  }),
});
export type ApplyTaskRequest = z.infer<typeof ApplyTaskRequestSchema>;

/** `POST /tasks/:id/close` — Done without verification. */
export const CloseTaskRequestSchema = z.strictObject({
  reason: z.string().trim().min(1).max(TASK_NOTE_MAX).optional(),
});
export type CloseTaskRequest = z.infer<typeof CloseTaskRequestSchema>;

/** `PUT /tasks/:id/deliverable` — the edited draft, kept until it is accepted or sent (D275). */
export const PutDeliverableRequestSchema = z.strictObject({ deliverable: TaskDeliverableSchema });
export type PutDeliverableRequest = z.infer<typeof PutDeliverableRequestSchema>;

/**
 * `POST /tasks/:id/accept` — a Document is written to its path in the project folder (never over an
 * existing file: 409 `file_exists`); an Email draft is accepted as it stands. `path` repeats the
 * destination the user saw, as Apply's destination does.
 */
export const AcceptTaskRequestSchema = z.strictObject({
  path: ProjectRelativePathSchema.optional(),
});
export type AcceptTaskRequest = z.infer<typeof AcceptTaskRequestSchema>;

/** `POST /tasks/:id/open-pr` — push the task branch and open a pull request (D276). */
export const OpenPullRequestRequestSchema = z.strictObject({
  title: z.string().trim().min(1).max(256).optional(),
  body: z.string().max(60_000).optional(),
  draft: z.boolean().optional(),
});
export type OpenPullRequestRequest = z.infer<typeof OpenPullRequestRequestSchema>;

export const MERGE_METHODS = ['merge', 'squash', 'rebase'] as const;
export const MergeMethodSchema = z.enum(MERGE_METHODS);
export type MergeMethod = z.infer<typeof MergeMethodSchema>;

/**
 * `POST /tasks/:id/merge-pr` — merge the task's pull request on GitHub. `confirm` repeats the
 * repository and base the user confirmed; the task is `merged` only once GitHub reports the merge.
 */
export const MergePullRequestRequestSchema = z.strictObject({
  method: MergeMethodSchema,
  confirm: z.strictObject({ repo: z.string().min(3), base: z.string().min(1) }),
});
export type MergePullRequestRequest = z.infer<typeof MergePullRequestRequestSchema>;

/** `POST /tasks/:id/pause` — `paused: false` resumes. */
export const PauseTaskRequestSchema = z.strictObject({ paused: z.boolean() });
export type PauseTaskRequest = z.infer<typeof PauseTaskRequestSchema>;

/** `GET /projects/:id/tasks` query. `attention` keeps only tasks waiting on a person. */
export const TaskListQuerySchema = z.strictObject({
  stage: TaskStageSchema.optional(),
  q: z.string().trim().min(1).max(200).optional(),
  label: TaskLabelSchema.optional(),
  attention: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});
export type TaskListQuery = z.infer<typeof TaskListQuerySchema>;

export const TaskListResponseSchema = z.strictObject({
  items: z.array(TaskSchema),
});
export type TaskListResponse = z.infer<typeof TaskListResponseSchema>;

export const TaskActivityListResponseSchema = z.strictObject({
  items: z.array(TaskActivitySchema),
});
export type TaskActivityListResponse = z.infer<typeof TaskActivityListResponseSchema>;

/** Whether a task is waiting on a person — the board's *Needs attention* filter. */
export function needsAttention(task: Pick<Task, 'stage' | 'state'>): boolean {
  if (task.state === 'waiting' || task.state === 'failed') return true;
  return task.stage === 'review' && task.state === 'idle';
}

/* -------------------------------------------------------------------------- */
/* Repository (the project folder as a Git repository)                         */
/* -------------------------------------------------------------------------- */

export const GitHubRepoSchema = z.strictObject({
  owner: z.string().min(1),
  repo: z.string().min(1),
});
export type GitHubRepo = z.infer<typeof GitHubRepoSchema>;

/** `GET /projects/:id/repository`. Every field past `isRepo` is absent when it is not one. */
export const RepositoryInfoSchema = z.strictObject({
  folderPath: z.string(),
  /** Whether a `git` binary was found at all. */
  gitAvailable: z.boolean(),
  isRepo: z.boolean(),
  /** `null` on a detached HEAD. */
  branch: z.string().nullable().optional(),
  /** Absent in a repository with no commit yet. */
  headSha: GitShaSchema.optional(),
  /** No tracked file has uncommitted changes (untracked files do not count). */
  clean: z.boolean().optional(),
  changedFiles: z.number().int().min(0).optional(),
  remoteUrl: z.string().optional(),
  github: GitHubRepoSchema.optional(),
});
export type RepositoryInfo = z.infer<typeof RepositoryInfoSchema>;
