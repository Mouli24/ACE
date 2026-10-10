import type { TextFileContent } from '@ace/contracts';
import { AceApiError } from '@ace/sdk';
import { useQueries } from '@tanstack/react-query';
import { useEffect } from 'react';

import { fileContentQuery } from '../files/hooks';
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

/**
 * Conflict-aware editing (D300's half that Phase 1 needs, §5.4): every open file's content query is
 * watched; when the watcher invalidates one and the refetch shows a new version, a clean buffer
 * follows the disk and an unsaved one gets the conflict bar. A save in flight is left alone.
 */
export function useEditorSync(projectId: string): void {
  const editor = useProjectEditor(projectId);
  const paths = editor.tabs.filter((path) => !isImagePath(path));
  const results = useQueries({
    queries: paths.map((path) => ({
      ...fileContentQuery(projectId, path),
      enabled: projectId !== '',
    })),
  });

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
      if (disk?.kind !== 'text' || disk.version === file.baseVersion) return;
      diskChanged(projectId, file, disk);
    });
  });
}
