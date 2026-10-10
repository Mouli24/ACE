import { useQueryClient } from '@tanstack/react-query';
import type * as Monaco from 'monaco-editor';
import { useEffect, useRef } from 'react';

import { monaco } from '../../config-panel/monaco-loader';
import { fileContentQuery } from '../files/hooks';
import { languageOf } from './languages';
import { getModel } from './models';

/** §5.4 Compare: the disk on the left, read-only; your buffer on the right, still editable. */
export function CompareView({ projectId, path }: { projectId: string; path: string }) {
  const container = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  useEffect(() => {
    const element = container.current;
    const buffer = getModel(projectId, path);
    if (element === null || buffer === undefined) return;
    let disposed = false;
    let original: Monaco.editor.ITextModel | undefined;
    let diff: Monaco.editor.IStandaloneDiffEditor | undefined;
    queryClient.fetchQuery({ ...fileContentQuery(projectId, path), staleTime: 0 }).then(
      (disk) => {
        if (disposed) return;
        original = monaco.editor.createModel(
          disk.kind === 'text' ? disk.content : '',
          languageOf(path),
        );
        diff = monaco.editor.createDiffEditor(element, {
          automaticLayout: true,
          originalEditable: false,
          renderSideBySide: true,
          fontSize: 13,
        });
        diff.setModel({ original, modified: buffer });
      },
      () => undefined,
    );
    return () => {
      disposed = true;
      diff?.dispose();
      original?.dispose();
    };
  }, [projectId, path, queryClient]);
  return <div ref={container} className="h-full w-full" data-testid="compare-view" />;
}
