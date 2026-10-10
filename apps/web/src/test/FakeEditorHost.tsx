import type { TextFileContent } from '@ace/contracts';
import { useEffect, useState } from 'react';

import { dirtyHandler } from '../forge/editor/actions';
import { useEditorStore } from '../forge/editor/editor-store';
import { ensureModel, getModel } from '../forge/editor/models';

/**
 * Monaco stands in as a textarea over the real model registry (with the fake Monaco installed), so
 * tests drive edits, unsaved state and saves exactly as the real host does, without a browser.
 */
export function FakeEditorHost({
  projectId,
  path,
  initial,
}: {
  projectId: string;
  path: string;
  initial: TextFileContent | undefined;
}) {
  const model =
    getModel(projectId, path) ??
    (initial
      ? ensureModel(projectId, path, initial.content, 'plaintext', dirtyHandler(projectId, path))
      : undefined);
  const [, rerender] = useState(0);
  useEffect(() => {
    const file = useEditorStore.getState().projects[projectId]?.files[path];
    if (initial && file?.baseVersion === undefined) {
      useEditorStore.getState().loaded(projectId, path, initial.version, initial.bom);
    }
  }, [projectId, path, initial]);
  useEffect(() => {
    const subscription = model?.onDidChangeContent(() => rerender((n) => n + 1));
    return () => subscription?.dispose();
  }, [model]);
  return (
    <textarea
      aria-label={`Editing ${path}`}
      data-testid="fake-editor"
      value={model?.getValue() ?? ''}
      onChange={(event) => model?.setValue(event.target.value)}
    />
  );
}
