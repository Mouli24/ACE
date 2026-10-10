import { useExplorerStore } from '../explorer/explorer-store';
import { isWithin, parentOf } from '../files/paths';
import { EMPTY_EDITOR, replaceablePreview, useEditorStore } from './editor-store';
import { languageOf } from './languages';
import { disposeModel, moveModels } from './models';

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
