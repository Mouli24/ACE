import { Button, Dialog, DialogContent, DialogTitle, Input, cn } from '@ace/ui';
import { useEffect, useMemo, useState } from 'react';

import { openFile } from '../editor/actions';
import { useProjectEditor } from '../editor/editor-store';
import { FileIcon } from '../explorer/FileIcon';
import { useFileList } from '../files/hooks';
import { nameOf, parentOf } from '../files/paths';
import { rankPaths } from './fuzzy';
import { useQuickOpen } from './quick-open-store';

/** Ctrl/⌘+P (§6.2): open files first, then every non-ignored file of the project, matched as you type. */
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
        className="top-[12%] max-w-xl translate-y-0 gap-0 p-0"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">Go to file</DialogTitle>
        <Input
          autoFocus
          role="combobox"
          aria-label="Go to file"
          aria-expanded
          aria-controls="quick-open-results"
          aria-activedescendant={results[index] === undefined ? undefined : `quick-open-${index}`}
          placeholder="Search files by name"
          value={query}
          className="rounded-none border-0 border-b border-border font-machine text-[13px]"
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
        <ul
          id="quick-open-results"
          role="listbox"
          aria-label="Files"
          className="max-h-[22rem] overflow-auto py-1"
        >
          {results.map((path, i) => (
            <li
              key={path}
              id={`quick-open-${i}`}
              role="option"
              aria-selected={i === index}
              data-path={path}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setIndex(i)}
              onClick={() => choose(path)}
              className={cn(
                'flex cursor-pointer items-center gap-2 px-3 py-1 font-machine text-[12.5px]',
                i === index ? 'bg-selection/20 text-fg' : 'text-fg-soft',
              )}
            >
              <FileIcon path={path} />
              <span className="truncate">{nameOf(path)}</span>
              <span className="truncate text-[11px] text-fg-faint">{parentOf(path)}</span>
            </li>
          ))}
          {list.isError && (
            <li className="flex items-center gap-2 px-3 py-1 text-[12px] text-danger">
              <span>Could not list the project’s files: {list.error.message}.</span>
              <Button variant="secondary" size="sm" onClick={() => void list.refetch()}>
                Retry
              </Button>
            </li>
          )}
          {list.isPending && (
            <li className="px-3 py-1 text-[12px] text-fg-muted">Listing the project’s files…</li>
          )}
          {list.isSuccess && results.length === 0 && (
            <li className="px-3 py-1 text-[12px] text-fg-muted">No file matches.</li>
          )}
        </ul>
        {list.data?.truncated === true && (
          <p className="border-t border-border px-3 py-1 text-[11px] text-fg-faint">
            Only the first 50,000 files are searched.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
