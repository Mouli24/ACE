import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@ace/ui';
import { useState, type ReactNode } from 'react';

import { joinPath, nameOf } from '../files/paths';

/**
 * A confirm with an error line for the engine's refusal; the action resolves to that refusal or
 * undefined. The theme's modal shell (D328), as Forge's unsaved-changes dialog wears it: the paths
 * in mono, the refusal in the error red, Cancel as the Close pill. Changes' Revert all asks with it
 * too (fix A-M9), its files to be deleted as `children`.
 */
export function ConfirmDialog({
  title,
  description,
  detail,
  children,
  action,
  destructive,
  returnFocus = false,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  /** The project-relative path or paths the action touches. */
  detail?: string;
  /** More of the body, under the detail. */
  children?: ReactNode;
  action: string;
  destructive: boolean;
  /** Focus goes back where it was on close; the tree's dialogs place it themselves. */
  returnFocus?: boolean;
  onConfirm(): Promise<string | undefined>;
  onClose(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        onCloseAutoFocus={(event) => {
          // the tree puts focus on the right row itself; the dialog's row may be gone
          if (!returnFocus) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {detail !== undefined && (
          <p className="break-all font-machine text-[11px] text-[var(--muted)]">{detail}</p>
        )}
        {children}
        {problem !== undefined && (
          <p role="alert" className="text-[12px] text-[#c94c27]">
            {problem}
          </p>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const refused = await onConfirm();
              setBusy(false);
              if (refused === undefined) onClose();
              else setProblem(refused);
            }}
          >
            {action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Phase 1: a delete is permanent and says so. Phase 3 keeps a checkpoint first (D300) and changes this line. */
export function DeleteDialog({
  path,
  isFolder,
  onConfirm,
  onClose,
}: {
  path: string;
  isFolder: boolean;
  onConfirm(): Promise<string | undefined>;
  onClose(): void;
}) {
  return (
    <ConfirmDialog
      title={`Delete “${nameOf(path)}”?`}
      description={`${isFolder ? 'The folder and everything in it are' : 'The file is'} removed from disk. This cannot be undone. Open files with unsaved changes are closed without saving.`}
      detail={isFolder ? `${path}/` : path}
      action="Delete"
      destructive
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}

export function MoveDialog({
  from,
  folder,
  onConfirm,
  onClose,
}: {
  from: string;
  folder: string;
  onConfirm(): Promise<string | undefined>;
  onClose(): void;
}) {
  const where = folder === '' ? 'the project folder' : folder;
  return (
    <ConfirmDialog
      title={`Move “${nameOf(from)}” into ${where}?`}
      description="Open files follow it."
      detail={`${from} → ${joinPath(folder, nameOf(from))}`}
      action="Move"
      destructive={false}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}
