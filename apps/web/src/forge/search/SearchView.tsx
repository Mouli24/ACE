import { SEARCH_MAX_RESULTS, searchQueryProblem, type FileSearchFile } from '@ace/contracts';
import { Badge, Icons, cn } from '@ace/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { getSocket } from '../../app/socket';
import { fileIconColor } from '../../theme/constants';
import { openFile } from '../editor/actions';
import { useEditorStore } from '../editor/editor-store';
import { useSideViewStore } from '../explorer/side-view-store';
import { useFileSearch } from '../files/hooks';
import { fileKeys } from '../files/keys';
import { useProjectScope } from '../project-scope';
import { nameOf, parentOf } from '../files/paths';
import { EMPTY_SEARCH, requestOf, useSearchStore, type SearchForm } from './search-store';

/** Search waits this long after the last key before it asks the engine (design §6.4). */
export const SEARCH_DEBOUNCE_MS = 300;
/** While Search shows, file changes re-run it at most this often (fix I3). */
export const SEARCH_REFRESH_MS = 2_000;

/**
 * While Search shows (it is mounted only then), `files.changed` re-runs the search — at most once
 * per {@link SEARCH_REFRESH_MS}, however fast the disk churns (fix I3). The refetch cancels a
 * request still in flight, and that abort reaches the engine, which ends its search.
 */
function useRefreshOnChanges(projectId: string): void {
  const queryClient = useQueryClient();
  useProjectScope(projectId);
  useEffect(() => {
    const socket = getSocket();
    if (socket === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = socket.on('files.changed', (payload) => {
      if (payload.projectId !== projectId || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        // cancel first: a request still in flight is aborted (and so is its search), even one
        // that has no results yet, which a refetch alone would wait for instead
        const queryKey = fileKeys.searches(projectId);
        void queryClient
          .cancelQueries({ queryKey })
          .then(() => queryClient.invalidateQueries({ queryKey }));
      }, SEARCH_REFRESH_MS);
    });
    return () => {
      off();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [projectId, queryClient]);
}

const count = (n: number): string => n.toLocaleString('en-US');
const plural = (n: number, word: string): string => `${count(n)} ${word}${n === 1 ? '' : 's'}`;

/** The value, once it has stopped changing for `ms`. */
function useDebounced(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** The theme's field, as the Explorer's filter draws it. */
const FIELD =
  'h-[30px] w-full rounded-[8px] border border-[var(--line)] bg-[var(--surface)] px-[10px] text-[12px] [font-family:inherit] text-[var(--ink)] outline-none focus:border-[var(--focus)]';

/** A 20px toggle inside the query box; pressed, it takes the maximized panel button's look. */
function Toggle({
  label,
  pressed,
  onToggle,
  children,
}: {
  label: string;
  pressed: boolean;
  onToggle(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onToggle}
      className={cn(
        'flex h-[20px] min-w-[20px] shrink-0 cursor-pointer items-center justify-center rounded-[5px] border-none bg-transparent px-[3px] font-machine text-[10px] leading-none text-[var(--muted)] outline-none hover:bg-[var(--hover)] hover:text-[var(--ink)] focus-visible:shadow-[inset_0_0_0_2px_var(--focus)]',
        pressed && 'bg-[var(--hover)] text-[#ef6b3f] hover:text-[#ef6b3f]',
      )}
    >
      {children}
    </button>
  );
}

/** One match's line, the match itself marked in the theme's accent wash. */
function Preview({ preview, offset, length }: { preview: string; offset: number; length: number }) {
  return (
    <span className="min-w-0 flex-1 truncate whitespace-pre font-machine text-[11px]">
      {preview.slice(0, offset)}
      <mark className="rounded-[3px] bg-[rgba(239,107,63,0.18)] text-[var(--ink)]">
        {preview.slice(offset, offset + length)}
      </mark>
      {preview.slice(offset + length)}
    </span>
  );
}

/** One file's matches under its header: the extension dot, the name, the folder and a count. */
function FileResults({ projectId, file }: { projectId: string; file: FileSearchFile }) {
  const [open, setOpen] = useState(true);
  const reveal = (line: number, column: number): void => {
    openFile(projectId, file.path, { preview: true });
    useEditorStore.getState().revealAt(projectId, { path: file.path, line, column });
  };
  return (
    <section aria-label={file.path} className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex h-[24px] w-full min-w-0 cursor-pointer items-center gap-[6px] border-none bg-transparent px-[14px] text-left text-[12px] text-[var(--ink)] outline-none hover:bg-[var(--hover)] focus-visible:shadow-[inset_0_0_0_2px_var(--focus)]"
      >
        <span aria-hidden className="w-[8px] shrink-0 text-[8px] text-[var(--muted)]">
          {open ? (
            <Icons.ChevronDown aria-hidden size={10} />
          ) : (
            <Icons.ChevronRight aria-hidden size={10} />
          )}
        </span>
        <span
          aria-hidden
          className="h-[7px] w-[7px] shrink-0 rounded-full"
          style={{ background: fileIconColor(file.path) }}
        />
        <span className="shrink-0 font-semibold">{nameOf(file.path)}</span>
        <span className="min-w-0 flex-1 truncate font-machine text-[10px] text-[var(--muted)]">
          {parentOf(file.path)}
        </span>
        <Badge data-testid="search-file-count">{count(file.matches.length)}</Badge>
      </button>
      {open && (
        <ul className="m-0 flex list-none flex-col p-0">
          {file.matches.map((match) => (
            <li key={`${match.line}:${match.column}`}>
              <button
                type="button"
                aria-label={`Line ${match.line}, column ${match.column}: ${match.preview}`}
                title={`${file.path}:${match.line}:${match.column}`}
                onClick={() => reveal(match.line, match.column)}
                className="flex h-[22px] w-full min-w-0 cursor-pointer items-center gap-[8px] border-none bg-transparent pl-[36px] pr-[14px] text-left text-[var(--ink)] outline-none hover:bg-[var(--hover)] focus-visible:shadow-[inset_0_0_0_2px_var(--focus)]"
              >
                <Preview
                  preview={match.preview}
                  offset={match.previewOffset}
                  length={match.length}
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Search in Forge's left column (D299 Phase 4, design §6.4): the query with regex (`.*`), match
 * case (`Aa`) and whole word (`ab`), then the files to include and to exclude. It asks the engine
 * 300 ms after the last change; a regex that cannot run is said inline and never sent. Results
 * come by file with their counts, each line with its match marked; a click opens the file there.
 */
export function SearchView({ projectId }: { projectId: string }) {
  const form = useSearchStore((state) => state.byProject[projectId] ?? EMPTY_SEARCH);
  const update = useSearchStore((state) => state.update);
  const set = (change: Partial<SearchForm>): void => update(projectId, change);
  const focus = useSideViewStore((state) => state.searchFocus);
  const input = useRef<HTMLInputElement>(null);
  useRefreshOnChanges(projectId);

  // On opening, and on every Ctrl/⌘+Shift+F: the query box takes the focus, its text selected.
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focus]);

  const problem = form.query === '' ? undefined : searchQueryProblem(form.query, form.regex);
  const wanted = form.query === '' || problem !== undefined ? '' : JSON.stringify(requestOf(form));
  const settled = useDebounced(wanted, SEARCH_DEBOUNCE_MS);
  const results = useFileSearch(
    projectId,
    settled === '' || settled !== wanted ? undefined : settled,
  );
  const shown = wanted === '' ? undefined : results.data;
  const total = shown?.files.reduce((sum, file) => sum + file.matches.length, 0) ?? 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-[6px] px-[10px] pb-[8px]">
        <div className="relative">
          <input
            ref={input}
            type="text"
            value={form.query}
            onChange={(event) => set({ query: event.target.value })}
            placeholder="Search"
            aria-label="Search"
            aria-invalid={problem === undefined ? undefined : true}
            spellCheck={false}
            className={cn(FIELD, 'pr-[74px]', problem !== undefined && 'border-[#c94c27]')}
          />
          <div className="absolute right-[5px] top-[5px] flex items-center gap-[2px]">
            <Toggle
              label="Match case"
              pressed={form.matchCase}
              onToggle={() => set({ matchCase: !form.matchCase })}
            >
              Aa
            </Toggle>
            <Toggle
              label="Match whole word"
              pressed={form.wholeWord}
              onToggle={() => set({ wholeWord: !form.wholeWord })}
            >
              <span className="underline underline-offset-2">ab</span>
            </Toggle>
            <Toggle
              label="Use regular expression"
              pressed={form.regex}
              onToggle={() => set({ regex: !form.regex })}
            >
              .*
            </Toggle>
          </div>
        </div>
        {problem !== undefined && (
          <p role="alert" className="m-0 text-[11px] leading-[1.45] text-danger">
            {problem}
          </p>
        )}
        <input
          type="text"
          value={form.include}
          onChange={(event) => set({ include: event.target.value })}
          placeholder="files to include (src, *.ts)"
          aria-label="Files to include"
          spellCheck={false}
          className={FIELD}
        />
        <input
          type="text"
          value={form.exclude}
          onChange={(event) => set({ exclude: event.target.value })}
          placeholder="files to exclude"
          aria-label="Files to exclude"
          spellCheck={false}
          className={FIELD}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-[10px]" aria-live="polite">
        {results.isError && wanted !== '' && (
          <p role="alert" className="m-0 px-[14px] text-[11px] leading-[1.45] text-danger">
            {results.error instanceof Error ? results.error.message : 'The search failed.'}
          </p>
        )}
        {shown !== undefined && (
          <p
            data-testid="search-summary"
            className="m-0 px-[14px] pb-[6px] text-[11px] leading-[1.45] text-[var(--muted)]"
          >
            {total === 0
              ? 'No results'
              : `${plural(total, 'result')} in ${plural(shown.files.length, 'file')}`}
            {shown.truncated && total > 0 && shown.timedOut !== true && (
              <>
                {' — '}
                <span>showing the first {count(Math.min(total, SEARCH_MAX_RESULTS))}</span>
              </>
            )}
          </p>
        )}
        {shown?.timedOut === true && (
          <p
            role="status"
            className="m-0 px-[14px] pb-[6px] text-[11px] leading-[1.45] text-[#e8572e]"
          >
            Search stopped after 5 s; showing partial results
          </p>
        )}
        {shown?.files.map((file) => (
          <FileResults key={file.path} projectId={projectId} file={file} />
        ))}
      </div>
    </div>
  );
}
