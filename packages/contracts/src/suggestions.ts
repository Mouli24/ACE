import { z } from 'zod';

import { IdSchema, TimestampSchema } from './graph.js';
import { TaskTitleSchema } from './tasks.js';

/**
 * Suggestions, team notes and email import — the ACE parity P2 contract (docs/ACE_FEATURE_PARITY.md
 * §3.3, §3.6, D280–D282).
 *
 * A **responsibility** says what ACE should watch in a project, why it matters and what useful work
 * would look like. Saving one scans nothing: a scan runs on *Scan now*, or on a timer when *Watch
 * automatically* is on (while the engine runs, never while the project is paused). A scan produces
 * **suggestions** — each with its reason, evidence, proposed action and completion criteria — that
 * the user adds to the Inbox, keeps for later or dismisses. Adding one creates an Inbox task; it
 * never starts anything (ACE: "Accepting a suggestion creates a task for you to start").
 */

/* -------------------------------------------------------------------------- */
/* Responsibilities                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What a responsibility looks at. `software_health`: the project's recorded checks and failed tasks,
 * and — when the repository has a GitHub remote and `gh` is signed in — its open issues and failed
 * workflow runs. `email`: messages matching a search, which needs a mail connection this version
 * does not have (a scan answers `not_connected`).
 */
export const RESPONSIBILITY_KINDS = ['software_health', 'email'] as const;
export const ResponsibilityKindSchema = z.enum(RESPONSIBILITY_KINDS);
export type ResponsibilityKind = z.infer<typeof ResponsibilityKindSchema>;

export const SCAN_STATUSES = ['running', 'completed', 'failed', 'cancelled'] as const;
export const ScanStatusSchema = z.enum(SCAN_STATUSES);
export type ScanStatus = z.infer<typeof ScanStatusSchema>;

export const WATCH_INTERVAL_MINUTES_MIN = 15;
export const WATCH_INTERVAL_MINUTES_MAX = 24 * 60;
export const DEFAULT_WATCH_INTERVAL_MINUTES = 60;

export const ResponsibilitySchema = z.strictObject({
  id: IdSchema,
  projectId: IdSchema,
  kind: ResponsibilityKindSchema,
  /** What to watch, in the user's words. */
  title: z.string().trim().min(1).max(200),
  /** Why it matters. */
  why: z.string().max(4_000),
  /** What useful work would look like — becomes each suggestion's completion criteria by default. */
  goodWork: z.string().max(4_000),
  /** For `email`: the search messages must match. */
  query: z.string().max(400).optional(),
  /** Scan on a timer while the engine runs. Off until the user turns it on. */
  watch: z.boolean(),
  watchIntervalMinutes: z
    .number()
    .int()
    .min(WATCH_INTERVAL_MINUTES_MIN)
    .max(WATCH_INTERVAL_MINUTES_MAX),
  /** Pause watching: no future scan starts; a scan running finishes or is cancelled. */
  paused: z.boolean(),
  lastScanAt: TimestampSchema.optional(),
  lastScanStatus: ScanStatusSchema.optional(),
  /** What the last scan found, or why it failed. */
  lastScanMessage: z.string().max(2_000).optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Responsibility = z.infer<typeof ResponsibilitySchema>;

export const CreateResponsibilityRequestSchema = z.strictObject({
  kind: ResponsibilityKindSchema,
  title: z.string().trim().min(1).max(200),
  why: z.string().max(4_000).optional(),
  goodWork: z.string().max(4_000).optional(),
  query: z.string().max(400).optional(),
  watch: z.boolean().optional(),
  watchIntervalMinutes: z
    .number()
    .int()
    .min(WATCH_INTERVAL_MINUTES_MIN)
    .max(WATCH_INTERVAL_MINUTES_MAX)
    .optional(),
});
export type CreateResponsibilityRequest = z.infer<typeof CreateResponsibilityRequestSchema>;

export const UpdateResponsibilityRequestSchema = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  why: z.string().max(4_000).optional(),
  goodWork: z.string().max(4_000).optional(),
  query: z.string().max(400).optional(),
  watch: z.boolean().optional(),
  watchIntervalMinutes: z
    .number()
    .int()
    .min(WATCH_INTERVAL_MINUTES_MIN)
    .max(WATCH_INTERVAL_MINUTES_MAX)
    .optional(),
  paused: z.boolean().optional(),
});
export type UpdateResponsibilityRequest = z.infer<typeof UpdateResponsibilityRequestSchema>;

export const ResponsibilityListResponseSchema = z.strictObject({
  items: z.array(ResponsibilitySchema),
});
export type ResponsibilityListResponse = z.infer<typeof ResponsibilityListResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Suggestions                                                                 */
/* -------------------------------------------------------------------------- */

export const EVIDENCE_KINDS = [
  'failed_check',
  'failed_task',
  'github_issue',
  'github_run',
] as const;
export const EvidenceKindSchema = z.enum(EVIDENCE_KINDS);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

export const SuggestionEvidenceSchema = z.strictObject({
  kind: EvidenceKindSchema,
  /** One line: "Check `tests` failed on task #4", "Issue #12: Search is slow". */
  label: z.string().min(1).max(400),
  url: z.url().optional(),
  /** A short excerpt: the check's output tail, the issue's opening lines. Secrets masked. */
  detail: z.string().max(4_000).optional(),
  taskId: IdSchema.optional(),
});
export type SuggestionEvidence = z.infer<typeof SuggestionEvidenceSchema>;

/** `new` until the user decides; `later` keeps it out of the way; the other two are final. */
export const SUGGESTION_STATUSES = ['new', 'later', 'dismissed', 'accepted'] as const;
export const SuggestionStatusSchema = z.enum(SUGGESTION_STATUSES);
export type SuggestionStatus = z.infer<typeof SuggestionStatusSchema>;

export const SuggestionSchema = z.strictObject({
  id: IdSchema,
  projectId: IdSchema,
  responsibilityId: IdSchema,
  title: TaskTitleSchema,
  /** Why ACE thinks this is worth doing. */
  reason: z.string().min(1).max(2_000),
  evidence: z.array(SuggestionEvidenceSchema).min(1).max(20),
  /** The proposed action — the brief the Inbox task gets. */
  proposedAction: z.string().min(1).max(4_000),
  completionCriteria: z.string().max(4_000),
  status: SuggestionStatusSchema,
  /** The Inbox task made from it, once accepted. */
  taskId: IdSchema.optional(),
  /**
   * What the suggestion is about, stable across scans (`issue:12`, `check:<task>:<name>`): a scan
   * never suggests the same thing twice, and a dismissed suggestion stays dismissed.
   */
  fingerprint: z.string().min(1).max(200),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Suggestion = z.infer<typeof SuggestionSchema>;

export const SuggestionListQuerySchema = z.strictObject({
  status: SuggestionStatusSchema.optional(),
});
export type SuggestionListQuery = z.infer<typeof SuggestionListQuerySchema>;

export const SuggestionListResponseSchema = z.strictObject({ items: z.array(SuggestionSchema) });
export type SuggestionListResponse = z.infer<typeof SuggestionListResponseSchema>;

/** `POST /suggestions/:id/accept` — the Inbox task's team, optionally (the task never starts). */
export const AcceptSuggestionRequestSchema = z.strictObject({
  workflowId: IdSchema.optional(),
});
export type AcceptSuggestionRequest = z.infer<typeof AcceptSuggestionRequestSchema>;

/* -------------------------------------------------------------------------- */
/* Team notes                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A project's shared notes (ACE "team memory"). A note the user wrote or confirmed is `verified`;
 * one an agent or ACE saved by itself is `unverified` until the user confirms or corrects it. Task
 * runs are given the project's notes, unverified ones labelled so.
 */
export const NOTE_STATUSES = ['verified', 'unverified'] as const;
export const NoteStatusSchema = z.enum(NOTE_STATUSES);
export type NoteStatus = z.infer<typeof NoteStatusSchema>;

export const NOTE_SOURCES = ['user', 'task', 'chat'] as const;
export const NoteSourceSchema = z.enum(NOTE_SOURCES);
export type NoteSource = z.infer<typeof NoteSourceSchema>;

export const NOTE_TEXT_MAX = 2_000;

export const ProjectNoteSchema = z.strictObject({
  id: IdSchema,
  projectId: IdSchema,
  text: z.string().trim().min(1).max(NOTE_TEXT_MAX),
  status: NoteStatusSchema,
  source: NoteSourceSchema,
  /** The task or chat it came from, when not written by hand. */
  refId: IdSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type ProjectNote = z.infer<typeof ProjectNoteSchema>;

/** `POST /projects/:id/notes`. A note written here is `verified` unless the caller says otherwise. */
export const CreateProjectNoteRequestSchema = z.strictObject({
  text: z.string().trim().min(1).max(NOTE_TEXT_MAX),
  source: NoteSourceSchema.optional(),
  refId: IdSchema.optional(),
  status: NoteStatusSchema.optional(),
});
export type CreateProjectNoteRequest = z.infer<typeof CreateProjectNoteRequestSchema>;

/** `PATCH /notes/:id` — correct the text and/or confirm it. */
export const UpdateProjectNoteRequestSchema = z.strictObject({
  text: z.string().trim().min(1).max(NOTE_TEXT_MAX).optional(),
  status: NoteStatusSchema.optional(),
});
export type UpdateProjectNoteRequest = z.infer<typeof UpdateProjectNoteRequestSchema>;

export const ProjectNoteListResponseSchema = z.strictObject({ items: z.array(ProjectNoteSchema) });
export type ProjectNoteListResponse = z.infer<typeof ProjectNoteListResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Email import                                                                */
/* -------------------------------------------------------------------------- */

export const EMAIL_IMPORT_MAX = 2_000_000;

/**
 * `POST /projects/:id/tasks/import-email` — one message saved to the Inbox as a task; it never
 * starts an agent (ACE "Importing one email saves it to Inbox without starting an agent"). `raw` is
 * the message as an `.eml` file holds it; attachments are dropped, the text body kept.
 */
export const ImportEmailRequestSchema = z.strictObject({
  raw: z.string().min(1).max(EMAIL_IMPORT_MAX),
  workflowId: IdSchema.optional(),
});
export type ImportEmailRequest = z.infer<typeof ImportEmailRequestSchema>;
