import { AceApiError } from '@ace/sdk';
import { Suspense, lazy, useEffect, useRef, useState } from 'react';

import { NO_ATTRIBUTION, type FileTouch, type ForgeAttribution } from '../attribution';
import { useProjectReviews, useReviewStore } from '../changes/review-store';
import { ReviewView } from '../changes/ReviewView';
import { useFileContent } from '../files/hooks';
import { isImagePath, nameOf } from '../files/paths';
import { ConflictBar, DeletedBar, SaveErrorBar } from './ConflictBar';
import { useOpenFile, useProjectEditor } from './editor-store';
import { EmptyEditor } from './EmptyEditor';
import { FileNotice } from './FileNotice';
import { ImagePreview } from './ImagePreview';
import { getModel } from './models';
import { PathBar } from './PathBar';
import { TabsBar } from './TabsBar';

const EditorHost = lazy(() =>
  import('./EditorHost').then((module) => ({ default: module.EditorHost })),
);
const CompareView = lazy(() =>
  import('./CompareView').then((module) => ({ default: module.CompareView })),
);

/** One muted line in the code area, as the theme's empty state. */
function Quiet({ children }: { children: string }) {
  return (
    <div className="flex h-full items-center justify-center text-[13px] text-[var(--muted)]">
      {children}
    </div>
  );
}

/**
 * The theme's code column (D334): the tabs strip, the path bar over an open file, then the file —
 * text in Monaco, an image as a picture, the rest as a notice — or the empty state. An agent
 * change under review (D300) takes the area until a file tab is chosen again.
 */
export function EditorArea({
  projectId,
  workflowId,
  attribution = NO_ATTRIBUTION,
}: {
  projectId: string;
  /** The workflow "▶ Run pipeline" starts; without one the path bar has no run button. */
  workflowId?: string;
  /** The run's file writes: the path bar's "edited lines" and the editor's agent bars. */
  attribution?: ForgeAttribution;
}) {
  const editor = useProjectEditor(projectId);
  const active = editor.active;
  const touch = active === undefined ? undefined : attribution.last.get(active);
  const reviews = useProjectReviews(projectId);
  const review = reviews.reviews.find((each) => each.key === reviews.active);
  // a file opened or chosen since takes the area back from the review (D300)
  const shown = useRef(active);
  useEffect(() => {
    if (shown.current === active) return;
    shown.current = active;
    useReviewStore.getState().deactivate(projectId);
  }, [active, projectId]);
  return (
    <section
      aria-label="Editor"
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--surface)]"
    >
      <TabsBar projectId={projectId} />
      {review !== undefined ? (
        <div className="relative min-h-0 flex-1">
          <ReviewView projectId={projectId} checkpointId={review.checkpointId} path={review.path} />
        </div>
      ) : active === undefined ? (
        <EmptyEditor projectId={projectId} />
      ) : (
        <>
          <PathBar projectId={projectId} workflowId={workflowId} path={active} touch={touch} />
          <div className="relative min-h-0 flex-1">
            {isImagePath(active) ? (
              <ImagePreview projectId={projectId} path={active} />
            ) : (
              <TextFile projectId={projectId} path={active} touch={touch} />
            )}
          </div>
        </>
      )}
    </section>
  );
}

function TextFile({
  projectId,
  path,
  touch,
}: {
  projectId: string;
  path: string;
  touch: FileTouch | undefined;
}) {
  const content = useFileContent(projectId, path);
  const file = useOpenFile(projectId, path);
  const [comparing, setComparing] = useState(false);
  useEffect(() => {
    if (file?.conflict === undefined) setComparing(false);
  }, [file?.conflict]);
  const text = content.data?.kind === 'text' ? content.data : undefined;
  if (getModel(projectId, path) === undefined) {
    if (content.isPending) return <Quiet>{`Opening ${nameOf(path)}…`}</Quiet>;
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
      {file?.conflict !== undefined && (
        <ConflictBar
          projectId={projectId}
          path={path}
          conflict={file.conflict}
          comparing={comparing}
          onCompare={() => setComparing((value) => !value)}
        />
      )}
      {file?.deletedOnDisk === true && file.conflict === undefined && (
        <DeletedBar projectId={projectId} path={path} />
      )}
      {file?.error !== undefined && (
        <SaveErrorBar projectId={projectId} path={path} message={file.error} />
      )}
      <div className="min-h-0 flex-1">
        <Suspense fallback={<Quiet>Loading the editor…</Quiet>}>
          {comparing ? (
            <CompareView projectId={projectId} path={path} />
          ) : (
            <EditorHost projectId={projectId} path={path} initial={text} touch={touch} />
          )}
        </Suspense>
      </div>
    </div>
  );
}
