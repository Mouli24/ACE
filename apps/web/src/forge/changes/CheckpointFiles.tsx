import type { Checkpoint, CheckpointFile } from '@ace/contracts';
import { cn } from '@ace/ui';

import { fileIconColor } from '../../theme/constants';
import { TONE_COLOR } from '../explorer/decorations';
import { nameOf, parentOf } from '../files/paths';
import { useCheckpointConflicts } from './changes-store';
import { fileStateLabel } from './present';

/** A row's quiet action, as the Processes list's: mono, small, a hover wash, the accent ring. */
export const ROW_ACTION =
  'shrink-0 cursor-pointer rounded-[5px] border-none bg-transparent px-[5px] py-[2px] font-machine text-[10px] text-[var(--muted)] outline-none hover:bg-[var(--hover)] hover:text-[var(--ink)] focus-visible:shadow-[0_0_0_2px_#ef6b3f] disabled:cursor-default disabled:opacity-50';

/** `+3 −1` in the Explorer's added and deleted colours; `binary` for a binary file. */
export function ChangeCounts({ file }: { file: CheckpointFile }) {
  if (file.binary) {
    return <span className="shrink-0 font-machine text-[9.5px] text-[var(--muted)]">binary</span>;
  }
  return (
    <span
      className="shrink-0 font-machine text-[9.5px]"
      aria-label={`${file.additions} added, ${file.deletions} removed`}
    >
      <span style={{ color: TONE_COLOR.added }}>+{file.additions}</span>{' '}
      <span style={{ color: TONE_COLOR.deleted }}>−{file.deletions}</span>
    </span>
  );
}

export interface CheckpointFilesProps {
  checkpoint: Checkpoint;
  /** Opens the file's read-only diff (Review). */
  onReview(path: string): void;
  /** Per-file Keep and Revert; without it a row only reviews. */
  onAction?: (action: 'keep' | 'revert', path: string) => void;
  busy?: boolean;
}

/**
 * A checkpoint's files, one row each (D300): the name (which reviews it), its folder, `+/−`, and,
 * while it waits, Keep and Revert — or what was decided. A revert the engine refused shows why,
 * on that file.
 */
export function CheckpointFiles({ checkpoint, onReview, onAction, busy }: CheckpointFilesProps) {
  const conflicts = useCheckpointConflicts(checkpoint.id);
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {checkpoint.files.map((file) => {
        const pending = file.state === 'pending';
        const conflict = pending ? conflicts[file.path] : undefined;
        const folder = parentOf(file.path);
        return (
          <li
            key={file.path}
            data-testid={`change-${checkpoint.id}-${file.path}`}
            className="flex flex-col border-t border-[var(--line)] py-[3px] first:border-t-0"
          >
            <div className="flex min-h-[24px] items-center gap-[6px] text-[12px]">
              <span
                aria-hidden
                className="h-[6px] w-[6px] shrink-0 rounded-full"
                style={{ background: fileIconColor(file.path) }}
              />
              <button
                type="button"
                aria-label={`Review ${file.path}`}
                title={`Review ${file.path}`}
                onClick={() => onReview(file.path)}
                className={cn(
                  'flex min-w-0 flex-1 cursor-pointer items-baseline gap-[5px] rounded-[4px] border-none bg-transparent p-0 text-left text-[12px] text-[var(--ink)] outline-none hover:underline focus-visible:shadow-[0_0_0_2px_#ef6b3f]',
                  file.change === 'deleted' && 'line-through',
                  !pending && 'text-[var(--muted)]',
                )}
              >
                <span className="truncate">{nameOf(file.path)}</span>
                {folder !== '' && (
                  <span className="min-w-0 truncate text-[10.5px] text-[var(--muted)]">
                    {folder}
                  </span>
                )}
              </button>
              <ChangeCounts file={file} />
              {pending && onAction !== undefined ? (
                <>
                  <button
                    type="button"
                    aria-label={`Keep ${file.path}`}
                    title="Keep"
                    disabled={busy}
                    onClick={() => onAction('keep', file.path)}
                    className={ROW_ACTION}
                  >
                    Keep
                  </button>
                  <button
                    type="button"
                    aria-label={`Revert ${file.path}`}
                    title="Revert"
                    disabled={busy}
                    onClick={() => onAction('revert', file.path)}
                    className={cn(ROW_ACTION, 'text-[#c94c27] hover:text-[#c94c27]')}
                  >
                    Revert
                  </button>
                </>
              ) : (
                !pending && (
                  <span className="shrink-0 font-machine text-[9.5px] text-[var(--muted)]">
                    {fileStateLabel(file)}
                  </span>
                )
              )}
            </div>
            {conflict !== undefined && (
              <p role="alert" className="m-0 pl-[12px] text-[11px] leading-[1.35] text-[#c94c27]">
                {conflict}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
