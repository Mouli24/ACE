import type {
  CreateEntryRequest,
  FileContent,
  FileEntry,
  FileList,
  FileSearchRequest,
  FileSearchResult,
  FilesChangedPayload,
  FolderListing,
  RepoStatus,
  SaveFileRequest,
  SaveFileResult,
  SourcesResult,
} from '@ace/contracts';

/** One debounced watcher burst — the `files.changed` payload before the engine names the project. */
export type FileChangeBatch = Omit<FilesChangedPayload, 'projectId'>;

/** What `readSources` reads: extensions without the dot (`ts` covers `.d.ts`), and its caps. */
export interface ReadSourcesOptions {
  exts?: readonly string[];
  maxFiles?: number;
  maxBytes?: number;
}

/** `GET /files/raw`: the bytes and the type they are served with (image previews). */
export interface RawFile {
  bytes: ArrayBuffer;
  contentType: string;
}

/**
 * Forge's view of one project folder (D299, design §6.1). The engine names the folder (`root`, the
 * project's absolute `folderPath`); the adapter — `createFsProjectFiles` in `@ace/tools` — confines
 * every path to it (FR-GIT-008) and throws {@link WorkspaceFsError} for a refusal the person should
 * read. Paths in and out are project-relative with forward slashes.
 */
export interface ProjectFiles {
  listFolder(root: string, path: string): Promise<FolderListing>;
  read(root: string, path: string): Promise<FileContent>;
  readRaw(root: string, path: string): Promise<RawFile>;
  write(root: string, request: SaveFileRequest): Promise<SaveFileResult>;
  create(root: string, request: CreateEntryRequest): Promise<FileEntry>;
  move(root: string, from: string, to: string): Promise<FileEntry>;
  remove(root: string, path: string): Promise<void>;
  listAll(root: string): Promise<FileList>;
  status(root: string): Promise<RepoStatus>;
  /**
   * Search the files that are not ignored (design §6.4), skipping binary files and files over
   * 2 MB, capped at the request's `maxResults` and at a time limit (`truncated`; a regex search's
   * hard limit also says `timedOut`). A request the contract refuses — an invalid or runaway regex
   * — throws a `ZodError`. `signal` aborting (the client went away) stops it, answering what it has.
   */
  search(root: string, request: FileSearchRequest, signal?: AbortSignal): Promise<FileSearchResult>;
  /**
   * The project's TS/JS sources for cross-file IntelliSense (design §6.2): not ignored, never
   * `node_modules`, shallowest first, capped at 1,500 files and 2 MB (`truncated`), plus the root
   * `tsconfig.json` as text when there is one.
   */
  readSources(root: string, options?: ReadSourcesOptions): Promise<SourcesResult>;
  /**
   * Watch the folder recursively. `onChange` gets each debounced burst; `onError` fires once if
   * the watcher dies (it is stopped by then). The returned function stops watching.
   */
  watch(
    root: string,
    onChange: (batch: FileChangeBatch) => void,
    onError: (error: Error) => void,
  ): () => void;
}

/** Every refusal a `ProjectFiles` adapter may throw; each is an `ErrorCode` of the contract. */
export const WORKSPACE_FS_ERROR_CODES = [
  'not_found',
  'exists',
  'file_changed',
  'file_too_large',
  'outside_project',
  'protected_path',
  'invalid_path',
] as const;
export type WorkspaceFsErrorCode = (typeof WORKSPACE_FS_ERROR_CODES)[number];

/**
 * Shared through the global symbol registry, so a refusal thrown by `@ace/tools`' copy of this
 * class — a different object when the packages resolve to different builds — is still recognised.
 * The same arrangement as `SecretWriteRejectedError`.
 */
const BRAND: unique symbol = Symbol.for('@ace/engine/WorkspaceFsError');

export class WorkspaceFsError extends Error {
  override readonly name = 'WorkspaceFsError';
  readonly [BRAND] = true;

  constructor(
    readonly code: WorkspaceFsErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** True for a `WorkspaceFsError` from this copy of the engine or any other. */
export function isWorkspaceFsError(error: unknown): error is WorkspaceFsError {
  if (error instanceof WorkspaceFsError) return true;
  if (!(error instanceof Error)) return false;
  const branded = error as Error & { [BRAND]?: unknown; code?: unknown };
  return (
    branded[BRAND] === true &&
    typeof branded.code === 'string' &&
    (WORKSPACE_FS_ERROR_CODES as readonly string[]).includes(branded.code)
  );
}
