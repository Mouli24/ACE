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
