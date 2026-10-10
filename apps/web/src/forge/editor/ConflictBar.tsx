import { Button } from '@ace/ui';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Trash2 } from 'lucide-react';

import { nameOf } from '../files/paths';
import { keepMine, saveFile, takeTheirs } from './actions';
import { useCloseRequest } from './CloseDialogs';
import type { Conflict } from './editor-store';

const BAR = 'flex shrink-0 items-center gap-3 border-b border-border px-3 py-1.5 text-[12.5px]';

/** §5.4: the disk moved on under unsaved work. Compare, Take theirs, or Keep mine (the next save wins). */
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
  const { request, dialog } = useCloseRequest(projectId);
  return (
    <div role="alert" data-testid="conflict-bar" className={`${BAR} bg-card`}>
      {dialog}
      <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--color-status-WAITING)]" aria-hidden />
      <span className="min-w-0 flex-1">
        {conflict === 'deleted'
          ? `${nameOf(path)} was deleted on disk while you were editing it.`
          : `${nameOf(path)} changed on disk while you were editing it.`}
      </span>
      {conflict === 'changed' && (
        <Button size="sm" variant="ghost" onClick={onCompare}>
          {comparing ? 'Back to editing' : 'Compare'}
        </Button>
      )}
      {conflict === 'deleted' ? (
        <Button size="sm" variant="ghost" onClick={() => request([path])}>
          Discard and close
        </Button>
      ) : (
        <Button
          size="sm"
          variant="ghost"
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
    <div role="status" data-testid="deleted-bar" className={`${BAR} bg-card`}>
      {dialog}
      <Trash2 className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
      <span className="min-w-0 flex-1">
        {nameOf(path)} was deleted on disk. Saving puts it back.
      </span>
      <Button size="sm" variant="ghost" onClick={() => request([path])}>
        Close
      </Button>
      <Button size="sm" onClick={() => void saveFile(projectId, path, queryClient)}>
        Save
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
    <div role="alert" data-testid="save-error-bar" className={`${BAR} bg-card text-danger`}>
      <span className="min-w-0 flex-1">
        Couldn’t save {nameOf(path)}: {message}
      </span>
      <Button size="sm" variant="ghost" onClick={() => void saveFile(projectId, path, queryClient)}>
        Try again
      </Button>
    </div>
  );
}
