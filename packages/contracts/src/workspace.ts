import { z } from 'zod';

import { IdSchema, TimestampSchema } from './graph.js';

/**
 * Forge's project files (D299, design §6.1).
 *
 * Every path on this seam is project-relative, uses forward slashes and never starts with one; `''`
 * is the project root and names a folder only. Confinement is the engine's job (FR-GIT-008) — the
 * contract only bounds the length, so an absolute path is refused by the engine with a reason the
 * person can read rather than by a schema error.
 */
export const ProjectPathSchema = z.string().max(1024);
export type ProjectPath = z.infer<typeof ProjectPathSchema>;

/** The largest file Forge opens for editing, and the largest save it accepts. */
export const FILE_EDIT_MAX_BYTES = 2 * 1024 * 1024;
/** The largest file `GET /files/raw` serves (the image preview). */
export const FILE_RAW_MAX_BYTES = 20 * 1024 * 1024;
/** `GET /files/list` stops here and says so with `truncated` (quick open). */
export const FILE_LIST_LIMIT = 50_000;
/** More changes than this in one watcher burst arrive as `resync` instead of a list. */
export const FILES_CHANGED_MAX = 500;

export const FILE_ENTRY_KINDS = ['file', 'folder'] as const;
export const FileEntryKindSchema = z.enum(FILE_ENTRY_KINDS);
export type FileEntryKind = z.infer<typeof FileEntryKindSchema>;

export const FileEntrySchema = z.strictObject({
  path: ProjectPathSchema,
  name: z.string(),
  kind: FileEntryKindSchema,
  /** Bytes for a file; 0 for a folder. */
  size: z.number().int().min(0),
  mtime: TimestampSchema,
  /** Matched by a `.gitignore` or one of ACE's default excludes: shown dimmed, skipped by list. */
  ignored: z.boolean(),
});
export type FileEntry = z.infer<typeof FileEntrySchema>;

/** `GET /projects/:id/files/tree?path=` — one folder, one level, folders first. */
export const FolderListingSchema = z.strictObject({
  path: ProjectPathSchema,
  items: z.array(FileEntrySchema),
});
export type FolderListing = z.infer<typeof FolderListingSchema>;

export const LINE_ENDINGS = ['lf', 'crlf'] as const;
export const LineEndingSchema = z.enum(LINE_ENDINGS);
export type LineEnding = z.infer<typeof LineEndingSchema>;

/** A content hash: it changes whenever the bytes on disk change, and only then. */
export const FileVersionSchema = z.string().min(1).max(128);
export type FileVersion = z.infer<typeof FileVersionSchema>;

/**
 * `GET /projects/:id/files/content?path=`. Only UTF-8 text up to {@link FILE_EDIT_MAX_BYTES} is
 * editable; anything else is described, never sent.
 */
export const FileContentSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('text'),
    path: ProjectPathSchema,
    /** Without the BOM; line endings exactly as on disk. */
    content: z.string(),
    version: FileVersionSchema,
    eol: LineEndingSchema,
    bom: z.boolean(),
    size: z.number().int().min(0),
  }),
  /** Binary, or text that is not valid UTF-8 — saving it as text would corrupt it. */
  z.strictObject({
    kind: z.literal('binary'),
    path: ProjectPathSchema,
    size: z.number().int().min(0),
  }),
  z.strictObject({
    kind: z.literal('too_large'),
    path: ProjectPathSchema,
    size: z.number().int().min(0),
  }),
]);
export type FileContent = z.infer<typeof FileContentSchema>;
export type TextFileContent = Extract<FileContent, { kind: 'text' }>;

/** `PUT /projects/:id/files/content`. */
export const SaveFileRequestSchema = z.strictObject({
  path: ProjectPathSchema.min(1),
  content: z.string(),
  /**
   * The version the buffer was loaded from. A different version on disk answers 409
   * `file_changed`; `null` means "this file should not exist yet" (recreating a deleted one).
   */
  baseVersion: FileVersionSchema.nullable(),
  eol: LineEndingSchema,
  bom: z.boolean(),
});
export type SaveFileRequest = z.infer<typeof SaveFileRequestSchema>;

export const SaveFileResultSchema = z.strictObject({
  path: ProjectPathSchema,
  version: FileVersionSchema,
  size: z.number().int().min(0),
  mtime: TimestampSchema,
});
export type SaveFileResult = z.infer<typeof SaveFileResultSchema>;

/** `POST /projects/:id/files/entries` — missing parent folders are created too. */
export const CreateEntryRequestSchema = z.strictObject({
  path: ProjectPathSchema.min(1),
  kind: FileEntryKindSchema,
});
export type CreateEntryRequest = z.infer<typeof CreateEntryRequestSchema>;

/** `POST /projects/:id/files/move` — rename or move, inside the project only. */
export const MoveEntryRequestSchema = z.strictObject({
  from: ProjectPathSchema.min(1),
  to: ProjectPathSchema.min(1),
});
export type MoveEntryRequest = z.infer<typeof MoveEntryRequestSchema>;

/** `?path=` on `GET /files/tree`: the root when omitted. */
export const FilePathQuerySchema = z.object({ path: ProjectPathSchema.default('') });
/** `?path=` on the routes that name one entry. */
export const RequiredFilePathQuerySchema = z.object({ path: ProjectPathSchema.min(1) });

/** `GET /projects/:id/files/list` — every non-ignored file, breadth first, for quick open. */
export const FileListSchema = z.strictObject({
  files: z.array(ProjectPathSchema),
  truncated: z.boolean(),
});
export type FileList = z.infer<typeof FileListSchema>;

export const REPO_FILE_STATUSES = ['modified', 'added', 'deleted', 'renamed', 'untracked'] as const;
export const RepoFileStatusSchema = z.enum(REPO_FILE_STATUSES);
export type RepoFileStatus = z.infer<typeof RepoFileStatusSchema>;

/**
 * `GET /projects/:id/files/status` — the project repository's status, read-only, for the
 * Explorer's decorations (design §6.4). Never an error: no git, or no repository, is `repo: false`.
 * An untracked folder is one entry for the folder itself.
 */
export const RepoStatusSchema = z.union([
  z.strictObject({ repo: z.literal(false) }),
  z.strictObject({
    repo: z.literal(true),
    branch: z.string().nullable(),
    files: z.array(z.strictObject({ path: ProjectPathSchema, status: RepoFileStatusSchema })),
    truncated: z.boolean(),
  }),
]);
export type RepoStatus = z.infer<typeof RepoStatusSchema>;

export const FILE_CHANGE_KINDS = ['created', 'changed', 'deleted'] as const;
export const FileChangeSchema = z.strictObject({
  path: ProjectPathSchema,
  kind: z.enum(FILE_CHANGE_KINDS),
});
export type FileChange = z.infer<typeof FileChangeSchema>;

/**
 * The transient `files.changed` frame on the `project` scope: one debounced burst of the watcher.
 * Paths only — contents never travel on the socket. `resync: true` (with no changes) means "too
 * much changed to list; refetch what you show".
 */
export const FilesChangedPayloadSchema = z.strictObject({
  projectId: IdSchema,
  changes: z.array(FileChangeSchema).max(FILES_CHANGED_MAX),
  resync: z.boolean(),
});
export type FilesChangedPayload = z.infer<typeof FilesChangedPayloadSchema>;

/** `details` of a 409 `file_changed`: what is on disk now, `null` when the file is gone. */
export const FileChangedDetailsSchema = z.object({ currentVersion: FileVersionSchema.nullable() });
export type FileChangedDetails = z.infer<typeof FileChangedDetailsSchema>;

/* -------------------------------------------------------------------------- */
/* Processes: Forge's terminal (D301, design §6.3)                             */
/* -------------------------------------------------------------------------- */

/** The longest command line a start takes: the same bound as `run_command`. */
export const PROCESS_COMMAND_MAX = 8_000;
/** The most one `POST /input` writes to a process's stdin, in characters. */
export const PROCESS_INPUT_MAX = 65_536;
/** How much of a process's output the engine keeps, and a terminal tab shows, in UTF-16 code units. */
export const PROCESS_OUTPUT_MAX_CHARS = 1_048_576;
/** How many processes may run at once in one project; the next start answers 409 `process_limit`. */
export const PROCESS_RUNNING_MAX = 8;
/** How many finished processes per project the engine remembers, in memory only. */
export const PROCESS_RECENT_MAX = 20;
/** Output is collected this long before it goes out as `process.output` frames. */
export const PROCESS_OUTPUT_BATCH_MS = 50;
/**
 * The most one `process.output` frame carries. A larger batch goes out as several frames, in
 * order, so neither the engine's send queue nor the browser ever takes a multi-megabyte frame.
 */
export const PROCESS_FRAME_MAX_CHARS = 65_536;

/** `failed` means it never started (a spawn error); its reason is in the output. */
export const PROCESS_STATUSES = ['running', 'exited', 'failed'] as const;
export const ProcessStatusSchema = z.enum(PROCESS_STATUSES);
export type ProcessStatus = z.infer<typeof ProcessStatusSchema>;

export const PROCESS_STREAMS = ['stdout', 'stderr'] as const;
export const ProcessStreamSchema = z.enum(PROCESS_STREAMS);
export type ProcessStream = z.infer<typeof ProcessStreamSchema>;

export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;
export const PackageManagerSchema = z.enum(PACKAGE_MANAGERS);
export type PackageManager = z.infer<typeof PackageManagerSchema>;

const ProcessLabelSchema = z.string().min(1).max(120);

/**
 * `POST /projects/:id/processes`. Either the line a person typed, run through the platform shell
 * in `cwd` (project-relative and confined by the engine; the root when omitted), or the name of a
 * root package.json script, which the engine runs as `<pm> run <script>` in the project root.
 * The script form takes no `cwd`: a package manager reads the nearest package.json above its
 * working folder, so a sub-folder would run a script nobody checked (D301).
 */
export const ProcessStartRequestSchema = z.union([
  z.strictObject({
    command: z
      .string()
      .min(1)
      .max(PROCESS_COMMAND_MAX)
      .regex(/\S/, 'A command needs a character that is not a space.'),
    cwd: ProjectPathSchema.optional(),
    label: ProcessLabelSchema.optional(),
  }),
  z.strictObject({
    script: z.string().min(1).max(200),
    label: ProcessLabelSchema.optional(),
  }),
]);
export type ProcessStartRequest = z.infer<typeof ProcessStartRequestSchema>;

export const ProcessStartResponseSchema = z.strictObject({ processId: IdSchema });
export type ProcessStartResponse = z.infer<typeof ProcessStartResponseSchema>;

/** `POST /projects/:id/processes/:procId/input`: written to stdin as given; a line ends in `\n`. */
export const ProcessInputRequestSchema = z.strictObject({
  data: z.string().max(PROCESS_INPUT_MAX),
});
export type ProcessInputRequest = z.infer<typeof ProcessInputRequestSchema>;

/** One row of `GET /projects/:id/processes`. No pid crosses the wire. */
export const ProcessSummarySchema = z.strictObject({
  id: IdSchema,
  projectId: IdSchema,
  label: z.string(),
  command: z.string(),
  cwd: ProjectPathSchema,
  status: ProcessStatusSchema,
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  startedAt: TimestampSchema,
  endedAt: TimestampSchema.optional(),
});
export type ProcessSummary = z.infer<typeof ProcessSummarySchema>;

/**
 * `GET /projects/:id/processes/:procId`: the summary plus the output the engine kept — the last
 * {@link PROCESS_OUTPUT_MAX_CHARS} characters — for a terminal tab that re-attaches (design §6.3).
 */
export const ProcessDetailSchema = z.strictObject({
  ...ProcessSummarySchema.shape,
  output: z.string(),
  /** Earlier output was dropped to keep the last {@link PROCESS_OUTPUT_MAX_CHARS} characters. */
  truncated: z.boolean(),
});
export type ProcessDetail = z.infer<typeof ProcessDetailSchema>;

export const ProjectScriptSchema = z.strictObject({ name: z.string(), command: z.string() });
export type ProjectScript = z.infer<typeof ProjectScriptSchema>;

/** `GET /projects/:id/processes/scripts`: the root package.json scripts, in file order. */
export const ProjectScriptsSchema = z.strictObject({
  packageManager: PackageManagerSchema,
  scripts: z.array(ProjectScriptSchema),
});
export type ProjectScripts = z.infer<typeof ProjectScriptsSchema>;

/**
 * The transient `process.output` frame on the `project` scope: one stream's part of a 50 ms batch,
 * at most {@link PROCESS_FRAME_MAX_CHARS} characters.
 */
export const ProcessOutputPayloadSchema = z.strictObject({
  projectId: IdSchema,
  processId: IdSchema,
  stream: ProcessStreamSchema,
  data: z.string().max(PROCESS_FRAME_MAX_CHARS),
});
export type ProcessOutputPayload = z.infer<typeof ProcessOutputPayloadSchema>;

/** The transient `process.exited` frame: the process ended, or never started (`failed`). */
export const ProcessExitedPayloadSchema = z.strictObject({
  projectId: IdSchema,
  processId: IdSchema,
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  status: z.enum(['exited', 'failed']),
});
export type ProcessExitedPayload = z.infer<typeof ProcessExitedPayloadSchema>;
