import { Button } from '@ace/ui';
import { useState } from 'react';

import { FileNotice } from './editor/FileNotice';
import { ImagePreview } from './editor/ImagePreview';
import { FileTree } from './explorer/FileTree';
import { useFileContent } from './files/hooks';
import { isImagePath } from './files/paths';

/** Forge at ≤ 640 px (FR-MOB-001, design §2.1): the tree, then one file read-only. Editing needs a wider screen. */
export function CompactForge({ projectId }: { projectId: string }) {
  const [path, setPath] = useState<string | undefined>();
  if (path !== undefined)
    return <CompactFile projectId={projectId} path={path} onBack={() => setPath(undefined)} />;
  return (
    <div data-testid="compact-forge" className="flex h-full min-h-0 flex-col bg-panel">
      <p className="border-b border-border px-3 py-2 text-[12px] text-fg-muted">
        Browse only on a phone — open Forge on a wider screen to edit.
      </p>
      <div className="min-h-0 flex-1 overflow-auto">
        <FileTree
          projectId={projectId}
          label="Project files"
          editable={false}
          onOpen={(next) => setPath(next)}
        />
      </div>
    </div>
  );
}

function CompactFile({
  projectId,
  path,
  onBack,
}: {
  projectId: string;
  path: string;
  onBack(): void;
}) {
  const image = isImagePath(path);
  const content = useFileContent(projectId, image ? undefined : path);
  let body;
  if (image) body = <ImagePreview projectId={projectId} path={path} />;
  else if (content.isPending) body = <p className="p-3 text-[12px] text-fg-muted">Opening…</p>;
  else if (content.data?.kind === 'text')
    body = (
      <pre
        aria-label={`Contents of ${path}`}
        className="whitespace-pre p-3 font-machine text-[12px] leading-5 text-fg"
      >
        {content.data.content}
      </pre>
    );
  else if (content.data !== undefined)
    body = <FileNotice path={path} kind={content.data.kind} size={content.data.size} />;
  else
    body = (
      <FileNotice
        path={path}
        kind="missing"
        message={content.error instanceof Error ? content.error.message : undefined}
      />
    );

  return (
    <div data-testid="compact-file" className="flex h-full min-h-0 flex-col bg-canvas">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <span aria-hidden>←</span> Files
        </Button>
        <span className="truncate font-machine text-[12px] text-fg-soft">{path}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{body}</div>
    </div>
  );
}
