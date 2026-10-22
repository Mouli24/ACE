import type { CheckpointFile } from '@ace/contracts';

import { ConfirmDialog } from '../explorer/EntryDialogs';
import { nameOf } from '../files/paths';

/** The files to be deleted the confirm names; the rest are counted. */
export const DELETED_SHOWN = 10;

/**
 * Revert all asks first (D300, fix A-M9), in the Explorer's Delete confirm: how many files go back,
 * and — apart — the ones the agent added, which a revert deletes. One file's Revert stays one
 * click unless it deletes the file ({@link RevertFileDialog}). `files` are the ones Revert all
 * decides: the checkpoint's pending files.
 */
export function RevertAllDialog({
  files,
  onConfirm,
  onClose,
}: {
  files: readonly CheckpointFile[];
  onConfirm(): void;
  onClose(): void;
}) {
  const count = files.length;
  const deleted = files.filter((file) => file.change === 'added').map((file) => file.path);
  const shown = deleted.slice(0, DELETED_SHOWN);
  const more = deleted.length - shown.length;
  return (
    <ConfirmDialog
      title="Revert all changes?"
      description={
        count === 1
          ? 'Revert 1 file to how it was before this change.'
          : `Revert ${count} files to how they were before this change.`
      }
      action="Revert all"
      destructive
      returnFocus
      onConfirm={() => {
        onConfirm();
        return Promise.resolve(undefined);
      }}
      onClose={onClose}
    >
      {deleted.length > 0 && (
        <div className="flex flex-col gap-[4px] text-[12px] text-[var(--ink)]">
          <p className="m-0">
            {deleted.length === 1 ? 'This file will be deleted:' : 'These files will be deleted:'}
          </p>
          <ul
            aria-label="Files to be deleted"
            className="m-0 flex list-none flex-col gap-[2px] p-0 font-machine text-[11px] text-[var(--muted)]"
          >
            {shown.map((path) => (
              <li key={path} className="break-all">
                {path}
              </li>
            ))}
          </ul>
          {more > 0 && <p className="m-0 text-[11px] text-[var(--muted)]">and {more} more</p>}
        </div>
      )}
    </ConfirmDialog>
  );
}

/** [audit F-3] Whether one file's Revert deletes it: the agent created it, so before it there was none. */
export const revertDeletes = (file: CheckpointFile): boolean => file.change === 'added';

/**
 * [audit F-3] One file's Revert asks first when it deletes the file — one the agent created — in
 * Revert all's confirm, saying so; a Revert that puts the file's older text back stays one click.
 */
export function RevertFileDialog({
  path,
  onConfirm,
  onClose,
}: {
  path: string;
  onConfirm(): void;
  onClose(): void;
}) {
  return (
    <ConfirmDialog
      title={`Revert ${nameOf(path)}?`}
      description="The agent created this file, so reverting its change deletes the file."
      detail={path}
      action="Revert and delete"
      destructive
      returnFocus
      onConfirm={() => {
        onConfirm();
        return Promise.resolve(undefined);
      }}
      onClose={onClose}
    />
  );
}
