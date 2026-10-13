import type {
  CreateEntryRequest,
  FileContent,
  FileEntry,
  FileList,
  FileSearchRequest,
  FileSearchResult,
  FolderListing,
  Id,
  RepoStatus,
  SaveFileRequest,
  SaveFileResult,
  SourcesResult,
} from '@ace/contracts';

import type { EventBus } from '../events/index.js';
import { invalidPath, notFound } from '../gateway/errors.js';
import type { Logger } from '../logging/index.js';
import type { FileChangeBatch, ProjectFiles, RawFile, Repository, Scope } from '../ports/index.js';

/**
 * Forge's project files (D299, design §6.1): every call names a project, and the service hands the
 * adapter that project's folder. It also runs the watcher for a project while a WebSocket client is
 * subscribed to its `project` scope, turning each burst into a transient `files.changed` — never
 * persisted, paths only (design §7).
 */
export interface WorkspaceService {
  listFolder(projectId: Id, path: string): Promise<FolderListing>;
  read(projectId: Id, path: string): Promise<FileContent>;
  readRaw(projectId: Id, path: string): Promise<RawFile>;
  save(projectId: Id, request: SaveFileRequest): Promise<SaveFileResult>;
  create(projectId: Id, request: CreateEntryRequest): Promise<FileEntry>;
  move(projectId: Id, from: string, to: string): Promise<FileEntry>;
  remove(projectId: Id, path: string): Promise<void>;
  listAll(projectId: Id): Promise<FileList>;
  status(projectId: Id): Promise<RepoStatus>;
  /** `POST /files/search` (D299 Phase 4): the project's files that are not ignored. */
  search(projectId: Id, request: FileSearchRequest): Promise<FileSearchResult>;
  /** `GET /files/sources` (D299 Phase 4): TS/JS sources for cross-file IntelliSense, capped. */
  sources(projectId: Id): Promise<SourcesResult>;
  /** The WS hub says a project gained its first subscriber (`true`) or lost its last (`false`). */
  setWatched(projectId: Id, watched: boolean): Promise<void>;
  /** Shutdown: every watcher stops and no restart is pending. */
  stopAll(): void;
}

export interface WorkspaceServiceDeps {
  repository: Repository;
  scope: Scope;
  files: ProjectFiles;
  bus: EventBus;
  logger: Logger;
  /** How long a watcher that died waits before it starts again while someone still watches. */
  restartDelayMs?: number;
  /**
   * D300: told the paths of each person's write that succeeded — a save, a create, both sides of
   * a move, a remove — so an agent's checkpoint recording meanwhile never claims them. A throw
   * here is logged and never fails the write.
   */
  onPersonWrite?: (projectId: Id, paths: string[]) => void;
}

/** A wire path as the checkpoint names files: forward slashes, no `./` or trailing slash. */
const asProjectPath = (path: string): string =>
  path
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '');

export function createWorkspaceService(deps: WorkspaceServiceDeps): WorkspaceService {
  const { repository, scope, files, bus, logger } = deps;
  const restartDelayMs = deps.restartDelayMs ?? 2000;
  const watchers = new Map<Id, () => void>();
  /** Who should be watched; a subscribe and unsubscribe racing the folder lookup settle on the last word. */
  const wanted = new Set<Id>();
  const restarts = new Set<ReturnType<typeof setTimeout>>();

  async function folderOf(projectId: Id): Promise<string> {
    const project = await repository.projects.get(scope, projectId);
    if (project === null) throw notFound(`Project ${projectId}`);
    if (project.folderPath === '') throw invalidPath('(none)', 'this project has no folder.');
    return project.folderPath;
  }

  /** The person wrote these paths: tell the checkpoints, never failing the write (D300). */
  function personWrote(projectId: Id, paths: string[]): void {
    try {
      deps.onPersonWrite?.(projectId, paths.map(asProjectPath));
    } catch (error) {
      logger.warn(
        {
          subsystem: 'workspace',
          projectId,
          reason: error instanceof Error ? error.message : String(error),
        },
        'could not note a person write for the checkpoints',
      );
    }
  }

  const announce = (projectId: Id, batch: FileChangeBatch): void => {
    void bus.emitTransient({ type: 'files.changed', payload: { projectId, ...batch } });
  };

  /** One delayed restart, shared by a watcher that died and a restart that failed. */
  function scheduleRestart(projectId: Id): void {
    if (!wanted.has(projectId)) return;
    const timer = setTimeout(() => {
      restarts.delete(timer);
      void start(projectId);
    }, restartDelayMs);
    timer.unref?.();
    restarts.add(timer);
  }

  async function start(projectId: Id): Promise<void> {
    if (!wanted.has(projectId) || watchers.has(projectId)) return;
    let root: string;
    try {
      root = await folderOf(projectId);
    } catch {
      logger.warn(
        { subsystem: 'workspace', projectId },
        'not watching: the project or its folder is missing',
      );
      return;
    }
    if (!wanted.has(projectId) || watchers.has(projectId)) return;
    let stop: (() => void) | undefined;
    let died = false;
    const onError = (error: Error): void => {
      // Only the current watcher of a still-wanted project may act; a late error from a
      // replaced or stopped watcher must not touch its successor or schedule anything.
      if (!wanted.has(projectId) || watchers.get(projectId) !== stop) return;
      died = true;
      watchers.delete(projectId);
      logger.warn(
        { subsystem: 'workspace', projectId, reason: error.message },
        'the file watcher stopped',
      );
      announce(projectId, { changes: [], resync: true });
      scheduleRestart(projectId);
    };
    try {
      stop = files.watch(root, (batch) => announce(projectId, batch), onError);
    } catch (error) {
      logger.warn(
        {
          subsystem: 'workspace',
          projectId,
          reason: error instanceof Error ? error.message : String(error),
        },
        'the file watcher could not start',
      );
      scheduleRestart(projectId);
      return;
    }
    if (!died) watchers.set(projectId, stop);
  }

  return {
    listFolder: async (projectId, path) => files.listFolder(await folderOf(projectId), path),
    read: async (projectId, path) => files.read(await folderOf(projectId), path),
    readRaw: async (projectId, path) => files.readRaw(await folderOf(projectId), path),
    async save(projectId, request) {
      const saved = await files.write(await folderOf(projectId), request);
      personWrote(projectId, [saved.path]);
      return saved;
    },
    async create(projectId, request) {
      const entry = await files.create(await folderOf(projectId), request);
      personWrote(projectId, [entry.path]);
      return entry;
    },
    async move(projectId, from, to) {
      const entry = await files.move(await folderOf(projectId), from, to);
      personWrote(projectId, [from, entry.path]);
      return entry;
    },
    async remove(projectId, path) {
      await files.remove(await folderOf(projectId), path);
      personWrote(projectId, [path]);
    },
    listAll: async (projectId) => files.listAll(await folderOf(projectId)),
    status: async (projectId) => files.status(await folderOf(projectId)),
    search: async (projectId, request) => files.search(await folderOf(projectId), request),
    sources: async (projectId) => files.readSources(await folderOf(projectId)),

    async setWatched(projectId, watched) {
      if (watched) {
        wanted.add(projectId);
        await start(projectId);
        return;
      }
      wanted.delete(projectId);
      watchers.get(projectId)?.();
      watchers.delete(projectId);
    },

    stopAll() {
      wanted.clear();
      for (const timer of restarts) clearTimeout(timer);
      restarts.clear();
      for (const stop of watchers.values()) stop();
      watchers.clear();
    },
  };
}
