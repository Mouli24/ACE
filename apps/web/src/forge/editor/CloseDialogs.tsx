import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@ace/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, type ReactElement } from 'react';

import { nameOf } from '../files/paths';
import { closeFiles, saveFile } from './actions';
import { useEditorStore, type OpenFile } from './editor-store';

const NO_FILES: Record<string, OpenFile> = {};

/** Closing tabs that hold unsaved work asks Save / Don't save / Cancel first (§6.2); clean ones close at once. */
export function useCloseRequest(projectId: string): {
  request(paths: readonly string[]): void;
  dialog: ReactElement | null;
} {
  const [pending, setPending] = useState<readonly string[] | undefined>();
  const request = useCallback(
    (paths: readonly string[]) => {
      const files = useEditorStore.getState().projects[projectId]?.files ?? NO_FILES;
      if (paths.some((path) => files[path]?.dirty === true)) setPending(paths);
      else closeFiles(projectId, paths);
    },
    [projectId],
  );
  const dialog =
    pending === undefined ? null : (
      <UnsavedDialog projectId={projectId} paths={pending} onDone={() => setPending(undefined)} />
    );
  return { request, dialog };
}

function UnsavedDialog({
  projectId,
  paths,
  onDone,
}: {
  projectId: string;
  paths: readonly string[];
  onDone(): void;
}) {
  const queryClient = useQueryClient();
  const files = useEditorStore((state) => state.projects[projectId]?.files ?? NO_FILES);
  const dirty = paths.filter((path) => files[path]?.dirty === true);
  const [busy, setBusy] = useState(false);
  const first = dirty[0] ?? paths[0] ?? '';

  const saveAndClose = async (): Promise<void> => {
    setBusy(true);
    const saved = await Promise.all(dirty.map((path) => saveFile(projectId, path, queryClient)));
    setBusy(false);
    // a failed save keeps the dialog and the tab, with its reason on the tab (§10)
    if (saved.every(Boolean)) {
      closeFiles(projectId, paths);
      onDone();
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onDone()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {dirty.length > 1
              ? `Save changes to ${dirty.length} files?`
              : `Save changes to ${nameOf(first)}?`}
          </DialogTitle>
          <DialogDescription>Your changes are lost if you don’t save them.</DialogDescription>
        </DialogHeader>
        {dirty.length > 1 && (
          <ul className="font-machine text-[12px] text-fg-soft">
            {dirty.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              closeFiles(projectId, paths);
              onDone();
            }}
          >
            Don’t save
          </Button>
          <Button disabled={busy} onClick={() => void saveAndClose()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
