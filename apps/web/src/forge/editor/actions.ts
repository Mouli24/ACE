import type { FileContent } from '@ace/contracts';
import { AceApiError } from '@ace/sdk';
import type { QueryClient } from '@tanstack/react-query';

import { api } from '../../app/api';
import { useExplorerStore } from '../explorer/explorer-store';
import { fileContentQuery } from '../files/hooks';
import { fileKeys } from '../files/keys';
import { isWithin, parentOf } from '../files/paths';
import { logOutput } from '../panel/output-store';
import { EMPTY_EDITOR, needsSaveAll, replaceablePreview, useEditorStore } from './editor-store';
import { languageOf } from './languages';
import { disposeModel, getModel, markSaved, moveModels, replaceContent } from './models';

/** How a model tells the store its buffer is (un)saved. */
export const dirtyHandler =
  (projectId: string, path: string) =>
  (dirty: boolean): void =>
    useEditorStore.getState().setDirty(projectId, path, dirty);

/** Open a file in Forge; a preview replaces the last preview, and the Explorer reveals the file. */
export function openFile(
  projectId: string,
  path: string,
  options: { preview?: boolean } = {},
): void {
  const before = useEditorStore.getState().projects[projectId] ?? EMPTY_EDITOR;
  const replaced =
    options.preview === true && before.files[path] === undefined
      ? replaceablePreview(before, path)
      : undefined;
  useEditorStore.getState().open(projectId, path, options);
  if (replaced !== undefined) disposeModel(projectId, replaced);
  const explorer = useExplorerStore.getState();
  if (parentOf(path) !== '') explorer.expand(projectId, parentOf(path));
  explorer.select(projectId, path);
}

/** Close tabs and drop their models. The caller asks first when a buffer is unsaved (Task 15). */
export function closeFiles(projectId: string, paths: readonly string[]): void {
  useEditorStore.getState().closeMany(projectId, paths);
  for (const path of paths) disposeModel(projectId, path);
}

/** A file or folder was renamed or moved in the Explorer: tabs, models and the tree follow it, revealed. */
export function filesMoved(projectId: string, from: string, to: string): void {
  useEditorStore.getState().renamed(projectId, from, to);
  moveModels(projectId, from, to, (path) => dirtyHandler(projectId, path), languageOf);
  const explorer = useExplorerStore.getState();
  explorer.moved(projectId, from, to);
  if (parentOf(to) !== '') explorer.expand(projectId, parentOf(to));
  explorer.select(projectId, to);
}

/** A file or folder was deleted in the Explorer: its open tabs close. */
export function filesRemoved(projectId: string, path: string): void {
  const open = Object.keys(useEditorStore.getState().projects[projectId]?.files ?? {}).filter((p) =>
    isWithin(p, path),
  );
  closeFiles(projectId, open);
  useExplorerStore.getState().removed(projectId, path);
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const isNotFound = (error: unknown): boolean => AceApiError.is(error) && error.status === 404;

/**
 * Save one buffer (FR-GIT-004, §6.1): against the version it was loaded from, so a file the disk
 * changed meanwhile is never overwritten — that answers 409 and raises the conflict bar (§5.4). A
 * clean file deleted on disk is saved too: that recreates it. Only the text that was sent counts
 * as saved; typing during the save stays unsaved.
 */
export async function saveFile(
  projectId: string,
  path: string,
  queryClient: QueryClient,
): Promise<boolean> {
  const store = useEditorStore.getState();
  const file = store.projects[projectId]?.files[path];
  const model = getModel(projectId, path);
  if (file === undefined || model === undefined || file.baseVersion === undefined || file.saving)
    return false;
  if (!file.dirty && !file.deletedOnDisk) return true;
  if (file.conflict !== undefined) {
    logOutput(
      projectId,
      'warn',
      `${path} changed on disk — choose Compare, Take theirs or Keep mine first.`,
    );
    return false;
  }
  const content = model.getValue();
  const sent = model.getAlternativeVersionId();
  const eol = model.getEOL() === '\r\n' ? 'crlf' : 'lf';
  store.saveStarted(projectId, path);
  try {
    const result = await api().saveFile(projectId, {
      path,
      content,
      baseVersion: file.baseVersion,
      eol,
      bom: file.bom,
    });
    const cached: FileContent = {
      kind: 'text',
      path,
      content,
      version: result.version,
      eol,
      bom: file.bom,
      size: result.size,
    };
    // A refetch that started before the save would land the older text over the saved one, and
    // the sync would then revert a clean buffer or raise a phantom conflict (review I2): cancel
    // it before the cache takes the saved text — and both before the store stops `saving`, so the
    // sync never sees the save finished with the older text still cached.
    const queryKey = fileKeys.content(projectId, path);
    await queryClient.cancelQueries({ queryKey });
    queryClient.setQueryData(queryKey, cached);
    markSaved(projectId, path, sent);
    useEditorStore.getState().saved(projectId, path, result.version);
    logOutput(projectId, 'info', `Saved ${path}`);
    return true;
  } catch (error) {
    if (AceApiError.is(error) && error.code === 'file_changed') {
      const current =
        (error.details as { currentVersion?: string | null } | undefined)?.currentVersion ?? null;
      useEditorStore
        .getState()
        .conflicted(projectId, path, current === null ? 'deleted' : 'changed');
      logOutput(
        projectId,
        'warn',
        `${path} changed on disk after it was opened; nothing was overwritten.`,
      );
      return false;
    }
    useEditorStore.getState().saveFailed(projectId, path, messageOf(error));
    logOutput(projectId, 'error', `Could not save ${path}: ${messageOf(error)}`);
    return false;
  }
}

/** Save every unsaved buffer of the project that is not in conflict, one after another (review I1). */
export async function saveAll(projectId: string, queryClient: QueryClient): Promise<void> {
  const files = useEditorStore.getState().projects[projectId]?.files ?? {};
  for (const [path, file] of Object.entries(files)) {
    if (needsSaveAll(file)) await saveFile(projectId, path, queryClient);
  }
}

async function readDisk(
  projectId: string,
  path: string,
  queryClient: QueryClient,
): Promise<FileContent | null> {
  try {
    return await queryClient.fetchQuery({ ...fileContentQuery(projectId, path), staleTime: 0 });
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** §5.4 Keep mine: the disk's version becomes the base, so the next save wins. The buffer stays as typed. */
export async function keepMine(
  projectId: string,
  path: string,
  queryClient: QueryClient,
): Promise<void> {
  try {
    const disk = await readDisk(projectId, path, queryClient);
    useEditorStore
      .getState()
      .resolved(projectId, path, disk?.kind === 'text' ? disk.version : null);
    logOutput(
      projectId,
      'info',
      `Keeping your version of ${path}; your next save replaces the one on disk.`,
    );
  } catch (error) {
    logOutput(projectId, 'error', `Could not read ${path}: ${messageOf(error)}`);
  }
}

/** §5.4 Take theirs: the buffer takes the disk's text; a file gone from disk closes. */
export async function takeTheirs(
  projectId: string,
  path: string,
  queryClient: QueryClient,
): Promise<void> {
  try {
    const disk = await readDisk(projectId, path, queryClient);
    if (disk === null || disk.kind !== 'text') {
      closeFiles(projectId, [path]);
      logOutput(projectId, 'info', `Closed ${path}: it is no longer a text file on disk.`);
      return;
    }
    replaceContent(projectId, path, disk.content);
    useEditorStore.getState().resolved(projectId, path, disk.version);
    logOutput(
      projectId,
      'info',
      `Reloaded ${path} from disk; your unsaved changes were discarded.`,
    );
  } catch (error) {
    logOutput(projectId, 'error', `Could not read ${path}: ${messageOf(error)}`);
  }
}
