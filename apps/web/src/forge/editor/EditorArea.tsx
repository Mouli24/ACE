import { AceApiError } from '@ace/sdk';
import { Suspense, lazy } from 'react';

import { useFileContent } from '../files/hooks';
import { isImagePath, nameOf } from '../files/paths';
import { useProjectEditor } from './editor-store';
import { EmptyEditor } from './EmptyEditor';
import { FileNotice } from './FileNotice';
import { ImagePreview } from './ImagePreview';
import { getModel } from './models';
import { TabsBar } from './TabsBar';

const EditorHost = lazy(() =>
  import('./EditorHost').then((module) => ({ default: module.EditorHost })),
);

/** The editor area: tabs over the active file — text in Monaco, an image as a picture, the rest as a notice. */
export function EditorArea({ projectId }: { projectId: string }) {
  const editor = useProjectEditor(projectId);
  const active = editor.active;
  return (
    <section aria-label="Editor" className="flex h-full min-h-0 min-w-0 flex-col bg-canvas">
      {editor.tabs.length > 0 && <TabsBar projectId={projectId} />}
      <div className="relative min-h-0 flex-1">
        {active === undefined ? (
          <EmptyEditor />
        ) : isImagePath(active) ? (
          <ImagePreview projectId={projectId} path={active} />
        ) : (
          <TextFile projectId={projectId} path={active} />
        )}
      </div>
    </section>
  );
}

function TextFile({ projectId, path }: { projectId: string; path: string }) {
  const content = useFileContent(projectId, path);
  const text = content.data?.kind === 'text' ? content.data : undefined;
  if (getModel(projectId, path) === undefined) {
    if (content.isPending)
      return <p className="p-4 text-[13px] text-fg-muted">Opening {nameOf(path)}…</p>;
    if (content.error) {
      const gone = AceApiError.is(content.error) && content.error.status === 404;
      return (
        <FileNotice
          path={path}
          kind="missing"
          message={gone ? 'This file is no longer on disk.' : content.error.message}
        />
      );
    }
    if (content.data !== undefined && content.data.kind !== 'text') {
      return <FileNotice path={path} kind={content.data.kind} size={content.data.size} />;
    }
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <Suspense fallback={<p className="p-4 text-[13px] text-fg-muted">Loading the editor…</p>}>
          <EditorHost projectId={projectId} path={path} initial={text} />
        </Suspense>
      </div>
    </div>
  );
}
