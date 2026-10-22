import { Button, Dialog, DialogContent, DialogTitle, Input, MENU_ITEM_CLASS, cn } from '@ace/ui';
import { useEffect, useMemo, useState } from 'react';

import { fileIconColor } from '../../theme/constants';
import { openFile } from '../editor/actions';
import { useProjectEditor } from '../editor/editor-store';
import { useFileList } from '../files/hooks';
import { nameOf, parentOf } from '../files/paths';
import { rankPaths } from './fuzzy';
import { useQuickOpen } from './quick-open-store';

/** A line of the list that is not a file: muted, or the error red. */
const NOTE = 'flex items-center gap-[8px] px-[10px] py-[6px] text-[12px]';

/**
 * Ctrl/⌘+P (§6.2): open files first, then every non-ignored file of the project, matched as you
 * type. In the theme (D328): the modal shell high on the screen, the theme's field, and the matches
 * as the theme's menu rows — the extension dot, the name, the folder in mono — with the highlighted
 * one in the menu's orange wash.
 */
export function QuickOpen({ projectId }: { projectId: string }) {
  const open = useQuickOpen((s) => s.open);
  const hide = useQuickOpen((s) => s.hide);
  const list = useFileList(projectId, open);
  const editor = useProjectEditor(projectId);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setIndex(0);
  }, [open]);

  const results = useMemo(() => {
    const files = list.data?.files ?? [];
    const candidates = [...editor.tabs, ...files.filter((file) => !editor.tabs.includes(file))];
    return rankPaths(query, candidates);
  }, [list.data, editor.tabs, query]);

  useEffect(() => {
    if (!open) return;
    document.getElementById(`quick-open-${index}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, index, results]);

  const choose = (path: string | undefined): void => {
    if (path === undefined) return;
    openFile(projectId, path, { preview: false });
    hide();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && hide()}>
      <DialogContent
        className="top-[12%] max-w-[560px] translate-y-0 gap-0 overflow-hidden p-0"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">Go to file</DialogTitle>
        {/* room on the right for the shell's 28px ✕, level with the field */}
        <div className="border-b border-[var(--line)] p-[12px] pr-[52px]">
          <Input
            autoFocus
            role="combobox"
            aria-label="Go to file"
            aria-expanded
            aria-controls="quick-open-results"
            aria-activedescendant={results[index] === undefined ? undefined : `quick-open-${index}`}
            placeholder="Search files by name"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown')
                setIndex((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
              else if (event.key === 'ArrowUp') setIndex((i) => Math.max(i - 1, 0));
              else if (event.key === 'Enter') choose(results[index]);
              else return;
              event.preventDefault();
            }}
          />
        </div>
        <ul
          id="quick-open-results"
          role="listbox"
          aria-label="Files"
          className="m-0 flex max-h-[22rem] list-none flex-col gap-px overflow-auto p-1"
        >
          {results.map((path, i) => (
            <li
              key={path}
              id={`quick-open-${i}`}
              role="option"
              aria-selected={i === index}
              data-path={path}
              data-highlighted={i === index ? '' : undefined}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setIndex(i)}
              onClick={() => choose(path)}
              className={cn(MENU_ITEM_CLASS, 'gap-[8px]')}
            >
              <span
                aria-hidden
                className="h-[7px] w-[7px] shrink-0 rounded-full"
                style={{ background: fileIconColor(path) }}
              />
              <span className="shrink-0 truncate font-medium">{nameOf(path)}</span>
              <span className="min-w-0 truncate font-machine text-[10px] text-[var(--muted)]">
                {parentOf(path)}
              </span>
            </li>
          ))}
          {list.isError && (
            <li className={cn(NOTE, 'text-danger')}>
              <span className="min-w-0 flex-1">
                Could not list the project’s files: {list.error.message}.
              </span>
              <Button variant="secondary" size="sm" onClick={() => void list.refetch()}>
                Retry
              </Button>
            </li>
          )}
          {list.isPending && (
            <li className={cn(NOTE, 'text-[var(--muted)]')}>Listing the project’s files…</li>
          )}
          {list.isSuccess && results.length === 0 && (
            <li className={cn(NOTE, 'text-[var(--muted)]')}>No file matches.</li>
          )}
        </ul>
        {list.data?.truncated === true && (
          <p className="border-t border-[var(--line)] px-[14px] py-[7px] font-machine text-[10px] text-[var(--muted)]">
            Only the first 50,000 files are searched.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
