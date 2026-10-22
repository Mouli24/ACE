import { Button, cn } from '@ace/ui';
import { useQueryClient } from '@tanstack/react-query';

import { nameOf } from '../files/paths';
import { closeFiles, keepMine, saveFile, takeTheirs } from './actions';
import { useCloseRequest } from './CloseDialogs';
import type { Conflict } from './editor-store';

/** A bar under the path bar, in the theme's panel colours and type. */
const BAR =
  'flex min-h-[34px] shrink-0 items-center gap-[8px] border-b border-[var(--line)] bg-[var(--panel)] py-[4px] pl-[18px] pr-[12px] text-[12px] text-[var(--ink)]';

/**
 * §5.4: the disk moved on under unsaved work. Compare, Take theirs, or Keep mine (the next save
 * wins); for a file deleted on disk, Discard and close, or Keep mine (the next save puts it back).
 */
export function ConflictBar({
  projectId,
  path,
  conflict,
  comparing,
  onCompare,
}: {
  projectId: string;
  path: string;
  conflict: Conflict;
  comparing: boolean;
  onCompare(): void;
}) {
  const queryClient = useQueryClient();
  return (
    <div role="alert" data-testid="conflict-bar" className={BAR}>
      <span className="min-w-0 flex-1">
        {conflict === 'deleted'
          ? `${nameOf(path)} was deleted on disk while you were editing it.`
          : `${nameOf(path)} changed on disk while you were editing it.`}
      </span>
      {conflict === 'changed' && (
        <Button size="sm" variant="secondary" onClick={onCompare}>
          {comparing ? 'Back to editing' : 'Compare'}
        </Button>
      )}
      {conflict === 'deleted' ? (
        // [audit F-4] The button is the discard: it closes at once. Through the unsaved-changes
        // dialog it offered Save, which a deleted-file conflict always refuses.
        <Button size="sm" variant="secondary" onClick={() => closeFiles(projectId, [path])}>
          Discard and close
        </Button>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void takeTheirs(projectId, path, queryClient)}
        >
          Take theirs
        </Button>
      )}
      <Button size="sm" onClick={() => void keepMine(projectId, path, queryClient)}>
        Keep mine
      </Button>
    </div>
  );
}

/** A clean file that is gone from disk: saving recreates it. */
export function DeletedBar({ projectId, path }: { projectId: string; path: string }) {
  const queryClient = useQueryClient();
  const { request, dialog } = useCloseRequest(projectId);
  return (
    <div role="status" data-testid="deleted-bar" className={BAR}>
      {dialog}
      <span className="min-w-0 flex-1">
        {nameOf(path)} was deleted on disk. Saving puts it back.
      </span>
      <Button size="sm" variant="secondary" onClick={() => request([path])}>
        Close
      </Button>
      <Button size="sm" onClick={() => void saveFile(projectId, path, queryClient)}>
        Save
      </Button>
    </div>
  );
}

/**
 * [audit F-5] The disk's file is binary or over 2 MB now: Forge can't show that version, and never
 * saves text over it. Close (Discard and close with unsaved text, at once, as F-4's) is the way out;
 * the buffer stays to copy from meanwhile.
 */
export function NotTextBar({
  projectId,
  path,
  kind,
  dirty,
}: {
  projectId: string;
  path: string;
  kind: 'binary' | 'too_large';
  dirty: boolean;
}) {
  return (
    <div role="alert" data-testid="not-text-bar" className={BAR}>
      <span className="min-w-0 flex-1">
        {nameOf(path)} is {kind === 'binary' ? 'binary' : 'over 2 MB'} on disk now, so Forge can’t
        show or save it.
      </span>
      <Button size="sm" variant="secondary" onClick={() => closeFiles(projectId, [path])}>
        {dirty ? 'Discard and close' : 'Close'}
      </Button>
    </div>
  );
}

/** The last save failed: the buffer is still unsaved, and this says why (§10). */
export function SaveErrorBar({
  projectId,
  path,
  message,
}: {
  projectId: string;
  path: string;
  message: string;
}) {
  const queryClient = useQueryClient();
  return (
    <div role="alert" data-testid="save-error-bar" className={cn(BAR, 'text-danger')}>
      <span className="min-w-0 flex-1">
        Couldn’t save {nameOf(path)}: {message}
      </span>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => void saveFile(projectId, path, queryClient)}
      >
        Try again
      </Button>
    </div>
  );
}
