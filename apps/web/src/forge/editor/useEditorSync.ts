import type { TextFileContent } from '@ace/contracts';
import { AceApiError } from '@ace/sdk';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { fileContentQuery } from '../files/hooks';
import { fileKeys } from '../files/keys';
import { isImagePath } from '../files/paths';
import { logOutput } from '../panel/output-store';
import { useEditorStore, useProjectEditor, type OpenFile } from './editor-store';
import { replaceContent } from './models';

function diskChanged(projectId: string, file: OpenFile, disk: TextFileContent): void {
  const store = useEditorStore.getState();
  if (!file.dirty) {
    replaceContent(projectId, file.path, disk.content);
    store.resolved(projectId, file.path, disk.version);
    logOutput(projectId, 'info', `${file.path} changed on disk; reloaded.`);
    return;
  }
  if (file.conflict !== 'changed') {
    store.conflicted(projectId, file.path, 'changed');
    logOutput(projectId, 'warn', `${file.path} changed on disk while you were editing it.`);
  }
}

function diskGone(projectId: string, file: OpenFile): void {
  const store = useEditorStore.getState();
  if (file.dirty) {
    // A buffer typed into after the delete is the Deleted bar's (Save / Close), not a conflict.
    const barState = file.deletedOnDisk && file.conflict === undefined;
    if (file.conflict !== 'deleted' && !barState) {
      store.conflicted(projectId, file.path, 'deleted');
      logOutput(projectId, 'warn', `${file.path} was deleted on disk while you were editing it.`);
    }
  } else if (!file.deletedOnDisk) {
    store.markDeletedOnDisk(projectId, file.path);
    logOutput(projectId, 'info', `${file.path} was deleted on disk.`);
  }
}

const NOT_TEXT_WORDS = { binary: 'binary', too_large: 'over 2 MB' } as const;

/**
 * Conflict-aware editing (D300's half that Phase 1 needs, §5.4): every open file's content query is
 * watched; when the watcher invalidates one and the refetch shows a new version, a clean buffer
 * follows the disk and an unsaved one gets the conflict bar. A save in flight is left alone.
 *
 * [audit F-5] The watcher never reports ignored paths (`.env`, `dist`), so the active tab's content
 * is also read again whenever the tab is activated and whenever the window gets the focus back. A
 * file the disk now holds as binary or over 2 MB gets a bar, as a deleted one does.
 */
export function useEditorSync(projectId: string): void {
  const queryClient = useQueryClient();
  const editor = useProjectEditor(projectId);
  const paths = editor.tabs.filter((path) => !isImagePath(path));
  const results = useQueries({
    queries: paths.map((path) => ({
      ...fileContentQuery(projectId, path),
      enabled: projectId !== '',
    })),
  });

  const active = editor.active;
  useEffect(() => {
    if (projectId === '' || active === undefined || isImagePath(active)) return;
    // joins a read already running (the tab's first), rather than reading twice
    const refresh = (): void =>
      void queryClient.refetchQueries(
        { queryKey: fileKeys.content(projectId, active), type: 'active' },
        { cancelRefetch: false },
      );
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [projectId, active, queryClient]);

  useEffect(() => {
    paths.forEach((path, index) => {
      const result = results[index];
      const file = useEditorStore.getState().projects[projectId]?.files[path];
      if (
        result === undefined ||
        file === undefined ||
        file.saving ||
        file.baseVersion === undefined
      )
        return;
      if (result.error) {
        if (
          AceApiError.is(result.error) &&
          result.error.status === 404 &&
          (file.baseVersion !== null || file.conflict === 'changed')
        )
          diskGone(projectId, file);
        return;
      }
      const disk = result.data;
      if (disk === undefined) return;
      if (disk.kind !== 'text') {
        if (file.notText !== disk.kind) {
          useEditorStore.getState().markNotText(projectId, path, disk.kind);
          logOutput(
            projectId,
            'warn',
            `${path} is ${NOT_TEXT_WORDS[disk.kind]} on disk now; Forge can't show or save it.`,
          );
        }
        return;
      }
      if (file.notText !== undefined)
        useEditorStore.getState().markNotText(projectId, path, undefined);
      if (disk.version === file.baseVersion) return;
      diskChanged(projectId, file, disk);
    });
  });
}
