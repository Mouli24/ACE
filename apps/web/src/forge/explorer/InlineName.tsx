
import { useEffect, useRef, useState } from 'react';

import { FileIcon } from '../icons/FileIcon';

/** Where a row's name starts: its indent, then the caret column (9 + 7) and the mark (8 + 7). */
const nameOffset = (depth: number): number => 8 + depth * 14 + 31;

/**
 * The tree's inline name field (VS Code): Enter commits, Escape cancels, leaving the field commits
 * a changed name. A problem shows under it as an alert, and the field stays open until it is fixed
 * or cancelled.
 *
 * In the theme (D334): a 26px Explorer row whose name is the Explorer filter's field, with the orange
 * focus border; the row keeps its mark — a folder's square, or a file's dot in the colour of the
 * extension being typed. The problem is a small card in the theme's menu shadow, in the error red.
 */
export function InlineName({
  label,
  initial,
  problemOf,
  onCommit,
  onCancel,
  depth,
  folder = false,
}: {
  label: string;
  initial: string;
  /** The reason a name cannot be used, checked locally, or undefined. */
  problemOf(name: string): string | undefined;
  /** Resolves with a refusal to show (the engine's), or undefined when done. */
  onCommit(name: string, wantFocus: boolean): Promise<string | undefined>;
  /** `wantFocus`: the edit ended by a key or by focus being lost, not by focus moving elsewhere. */
  onCancel(wantFocus: boolean): void;
  depth: number;
  /** What the row names: a folder's square mark, or a file's dot. */
  folder?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  const [problem, setProblem] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const element = input.current;
    if (element === null) return;
    element.focus();
    const dot = initial.lastIndexOf('.');
    element.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);

  const commit = async (wantFocus: boolean): Promise<void> => {
    if (busy) return;
    if (value === initial) {
      onCancel(wantFocus);
      return;
    }
    const local = problemOf(value);
    if (local !== undefined) {
      setProblem(local);
      return;
    }
    setBusy(true);
    const refused = await onCommit(value, wantFocus);
    setBusy(false);
    setProblem(refused);
  };

  return (
    <div className="relative shrink-0">
      <div
        className="flex h-[26px] items-center gap-[7px] pr-[8px]"
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        <span aria-hidden className="w-[9px] shrink-0" />
        <FileIcon path={value} folder={folder} />
        <input
          ref={input}
          aria-label={label}
          aria-invalid={problem !== undefined}
          value={value}
          readOnly={busy}
          aria-busy={busy}
          spellCheck={false}
          onChange={(event) => {
            setValue(event.target.value);
            setProblem(undefined);
          }}
          // the browser's own menu (paste), not the tree's: the tree's menu would preventDefault it
          onContextMenu={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') void commit(true);
            if (event.key === 'Escape') onCancel(true);
          }}
          onBlur={(event) => {
            // focus that moved to another element is the person's choice; only a lost focus is ours to restore
            const lost = event.relatedTarget === null;
            if (value.trim() === '' || value === initial) onCancel(lost);
            else void commit(lost);
          }}
          className="h-[24px] min-w-0 flex-1 rounded-[6px] border border-[var(--line)] bg-[var(--surface)] px-[6px] text-[12.5px] font-medium [font-family:inherit] text-[var(--ink)] outline-none focus:border-[var(--focus)] aria-[invalid=true]:border-[#c94c27]"
        />
      </div>
      {problem !== undefined && (
        <p
          role="alert"
          className="absolute left-0 right-[8px] z-10 mt-[2px] rounded-[6px] border border-[#c94c27] bg-[var(--surface)] px-[8px] py-[5px] text-[11.5px] leading-[1.4] text-danger shadow-[0_18px_40px_-16px_rgba(30,20,10,0.45)]"
          style={{ marginLeft: nameOffset(depth) }}
        >
          {problem}
        </p>
      )}
    </div>
  );
}
