import type { FileContent, Project } from '@ace/contracts';
import { AceApiError } from '@ace/sdk';
import type { QueryClient } from '@tanstack/react-query';

import { api } from '../../app/api';
import { useReviewStore } from '../changes/review-store';
import { useExplorerStore } from '../explorer/explorer-store';
import { fileContentQuery } from '../files/hooks';
import { fileKeys } from '../files/keys';
import { isWithin, parentOf } from '../files/paths';
import { queryKeys } from '../../workflows/query-keys';
import { logOutput } from '../panel/output-store';
import { EMPTY_EDITOR, needsSaveAll, replaceablePreview, useEditorStore } from './editor-store';
import { languageOf } from './languages';
import { disposeModel, editorFor, getModel, markSaved, moveModels, replaceContent } from './models';

/** How a model tells the store its buffer is (un)saved. */
export const dirtyHandler =
  (projectId: string, path: string) =>
  (dirty: boolean): void =>
    useEditorStore.getState().setDirty(projectId, path, dirty);

/**
 * Open a file in Forge; a preview replaces the last preview, and the Explorer reveals the file. A
 * review showing gives the area back, even for the file already active (fix A-M12): the Explorer,
 * Quick Open, Search results and Problems rows all choose a file through here.
 */
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
  useReviewStore.getState().deactivate(projectId);
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

/**
 * Format Document (D299 Phase 4, design §6.2): Monaco's own formatter for the file's language,
 * run through the editor showing it — Shift+Alt+F and the context menu do the same. False when no
 * editor shows the file or no formatter knows its language; the text is then left as it is.
 */
export async function formatDocument(projectId: string, path: string): Promise<boolean> {
  const action = editorFor(projectId, path)?.getAction('editor.action.formatDocument');
  if (action === null || action === undefined || !action.isSupported()) return false;
  await action.run();
  return true;
}

/** The project's format-on-save, from the cache the workbench keeps (absent reads as off). */
async function formatsOnSave(projectId: string, queryClient: QueryClient): Promise<boolean> {
  try {
    const project = await queryClient.ensureQueryData<Project>({
      queryKey: queryKeys.project(projectId),
      queryFn: () => api().getProject(projectId),
    });
    return project.formatOnSave === true;
  } catch {
    return false;
  }
}
const isNotFound = (error: unknown): boolean => AceApiError.is(error) && error.status === 404;

/**
 * Save one buffer (FR-GIT-004, §6.1): against the version it was loaded from, so a file the disk
 * changed meanwhile is never overwritten — that answers 409 and raises the conflict bar (§5.4). A
 * clean file deleted on disk is saved too: that recreates it. Only the text that was sent counts
 * as saved; typing during the save stays unsaved. With the project's format-on-save on, the file
 * is formatted first when an editor shows it (D299 Phase 4) — so Save all formats only the active
 * file — and a language with no formatter saves as typed.
 */
/** Per file, the save running now: the next one waits for it (fix I4). */
const saving = new Map<string, Promise<boolean>>();

export function saveFile(
  projectId: string,
  path: string,
  queryClient: QueryClient,
): Promise<boolean> {
  // Saves of one file run one after another (fix I4). Format-on-save awaits the formatter before
  // the request, and a second Ctrl+S, or Save all, in that window used to send the same base
  // version again — the first save won and the second raised a false "changed on disk". Now the
  // second waits; by then the buffer is clean, or holds only what was typed since, and that saves.
  const key = `${projectId}\u0000${path}`;
  const before = saving.get(key);
  // With none in flight it starts now, so the text it sends is the text as Save was pressed.
  const next =
    before === undefined
      ? saveOnce(projectId, path, queryClient)
      : before.then(
          () => saveOnce(projectId, path, queryClient),
          () => saveOnce(projectId, path, queryClient),
        );
  saving.set(key, next);
  void next.finally(() => {
    if (saving.get(key) === next) saving.delete(key);
  });
  return next;
}

async function saveOnce(
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
  if (file.notText !== undefined) {
    // [audit F-5] never a text save over a file the disk holds as binary or too large
    logOutput(projectId, 'warn', `${path} is no longer a text file on disk; nothing was saved.`);
    return false;
  }
  if (file.conflict !== undefined) {
    // [audit F-4] the choices the file's conflict bar offers, and no others
    logOutput(
      projectId,
      'warn',
      file.conflict === 'deleted'
        ? `${path} was deleted on disk — choose Keep mine or Discard and close first.`
        : `${path} changed on disk — choose Compare, Take theirs or Keep mine first.`,
    );
    return false;
  }
  // Marked as saving before the formatter runs, so nothing takes this file for idle meanwhile.
  store.saveStarted(projectId, path);
  if (editorFor(projectId, path) !== undefined && (await formatsOnSave(projectId, queryClient))) {
    try {
      await formatDocument(projectId, path);
    } catch (error) {
      logOutput(projectId, 'warn', `Could not format ${path}: ${messageOf(error)}`);
    }
  }
  const content = model.getValue();
  const sent = model.getAlternativeVersionId();
  const eol = model.getEOL() === '\r\n' ? 'crlf' : 'lf';
  // read again after the format: a Keep mine meanwhile moves the base this save must name
  const base = useEditorStore.getState().projects[projectId]?.files[path]?.baseVersion;
  try {
    const result = await api().saveFile(projectId, {
      path,
      content,
      baseVersion: base ?? file.baseVersion,
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
