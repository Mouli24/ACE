import { Button, Icons } from '@ace/ui';
import { useState } from 'react';

import { TOUCH_TARGETS } from '../responsive/touch';
import { FileNotice } from './editor/FileNotice';
import { ImagePreview } from './editor/ImagePreview';
import { FileTree } from './explorer/FileTree';
import { useFileContent } from './files/hooks';
import { isImagePath } from './files/paths';

/**
 * Forge at ≤ 640 px (FR-MOB-001, design §2.1): the tree, then one file read-only. Editing needs a
 * wider screen. The theme has no phone layout, so it wears the theme's pieces (D328): the phone
 * Canvas's read-only banner, the Explorer's panel and rows, and for a file the path bar's mono
 * crumbs over the code view's surface, with finger-sized controls (FR-MOB-002).
 */
export function CompactForge({ projectId }: { projectId: string }) {
  const [path, setPath] = useState<string | undefined>();
  if (path !== undefined)
    return <CompactFile projectId={projectId} path={path} onBack={() => setPath(undefined)} />;
  return (
    <div
      data-testid="compact-forge"
      className="flex h-full min-h-0 flex-col bg-[var(--panel)] text-[var(--ink)]"
    >
      <p
        role="note"
        className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-[11.5px] text-[var(--muted)]"
      >
        Browse only on a phone — open Forge on a wider screen to edit.
      </p>
      <div className="flex min-h-0 flex-1 flex-col pt-[8px]">
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
  const crumbs = path.split('/');
  let body;
  if (image) body = <ImagePreview projectId={projectId} path={path} />;
  else if (content.isPending)
    body = (
      <div className="flex h-full items-center justify-center text-[13px] text-[var(--muted)]">
        Opening…
      </div>
    );
  else if (content.data?.kind === 'text')
    body = (
      <pre
        aria-label={`Contents of ${path}`}
        className="m-0 whitespace-pre px-[14px] pb-[24px] pt-[12px] font-machine text-[12px] leading-[20px] text-[var(--ink)]"
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
    <div
      data-testid="compact-file"
      className="flex h-full min-h-0 flex-col bg-[var(--surface)] text-[var(--ink)]"
    >
      <div
        className={`flex h-[44px] min-w-0 shrink-0 items-center gap-[6px] overflow-hidden border-b border-[var(--line)] bg-[var(--panel)] pl-[4px] pr-[14px] font-machine text-[11px] ${TOUCH_TARGETS}`}
      >
        <Button variant="ghost" size="sm" className="shrink-0 font-human" onClick={onBack}>
          <Icons.ArrowLeft aria-hidden size={12} /> Files
        </Button>
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <span key={`${index}:${crumb}`} className="contents">
              <span
                className={
                  last
                    ? 'min-w-0 truncate text-[var(--ink)]'
                    : 'shrink-0 whitespace-nowrap text-[var(--muted)]'
                }
              >
                {crumb}
              </span>
              {!last && <span className="text-[var(--muted)]">›</span>}
            </span>
          );
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{body}</div>
    </div>
  );
}
