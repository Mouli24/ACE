import { cn } from '@ace/ui';
import { useMemo, useRef, type KeyboardEvent } from 'react';

import { fileIconColor } from '../../theme/constants';
import type { AgentLook } from '../../theme/agents';
import { useProjectEditor } from '../editor/editor-store';
import { useFileList } from '../files/hooks';
import { parentOf } from '../files/paths';
import { useExplorerStore, useProjectExplorer } from './explorer-store';
import { useTreeRows } from './useTreeRows';

export interface FileTreeProps {
  projectId: string;
  /** The tree's accessible name. */
  label: string;
  /** A single click previews; a double click or Enter pins (§6.2's preview tab). */
  onOpen(path: string, options: { preview: boolean }): void;
  /** Non-empty: a flat list of the project's files whose path contains it (theme filter). */
  filter?: string;
  /** Path → the agent writing that file now, from the run (D334). */
  live?: ReadonlyMap<string, AgentLook>;
}

/** One visible row, from the folder tree or from the filtered file list. */
interface Row {
  path: string;
  name: string;
  folder: boolean;
  ignored: boolean;
  /** 0 for the root's entries, and for every filtered row. */
  depth: number;
}

const NO_AGENTS: ReadonlyMap<string, AgentLook> = new Map();

/**
 * The project folder as an ARIA tree (FR-GIT-003) in the theme's Explorer rows (D334): lazy (a
 * folder lists when it opens), folders first, ignored entries dimmed, the open file marked, unsaved
 * files dotted, a pulsing badge while an agent writes a file, keyboard navigation with one roving
 * tab stop. With a filter it lists the matching files flat, each by its full path.
 */
export function FileTree({
  projectId,
  label,
  onOpen,
  filter = '',
  live = NO_AGENTS,
}: FileTreeProps) {
  const tree = useTreeRows(projectId);
  const list = useFileList(projectId, filter !== '');
  const { expanded, selected } = useProjectExplorer(projectId);
  const editor = useProjectEditor(projectId);
  const toggle = useExplorerStore((s) => s.toggle);
  const select = useExplorerStore((s) => s.select);
  const rowElements = useRef(new Map<string, HTMLDivElement>());
  const typed = useRef({ text: '', at: 0 });

  const query = filter.trim().toLowerCase();
  const rows = useMemo<Row[]>(
    () =>
      query === ''
        ? tree.rows.map(({ entry, depth }) => ({
            path: entry.path,
            name: entry.name,
            folder: entry.kind === 'folder',
            ignored: entry.ignored,
            depth,
          }))
        : (list.data?.files ?? [])
            .filter((path) => path.toLowerCase().includes(query))
            .map((path) => ({ path, name: path, folder: false, ignored: false, depth: 0 })),
    [query, tree.rows, list.data],
  );
  const loading = query === '' ? tree.loading : list.isPending;
  const error = query === '' ? tree.error : list.error;

  // One current row for the tab stop and the keys alike: the selected row if visible, else the first.
  const found = rows.findIndex((row) => row.path === selected);
  const index = found === -1 ? 0 : found;

  const focusRow = (path: string): void => {
    select(projectId, path);
    rowElements.current.get(path)?.focus();
  };

  const activate = (row: Row, preview: boolean): void => {
    if (row.folder) toggle(projectId, row.path);
    else onOpen(row.path, { preview });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const row = rows[index];
    const isOpen = row !== undefined && expanded.includes(row.path);
    const go = (target: Row | undefined) => {
      if (target) focusRow(target.path);
    };
    switch (event.key) {
      case 'ArrowDown':
        go(rows[Math.min(index + 1, rows.length - 1)] ?? rows[0]);
        break;
      case 'ArrowUp':
        go(rows[Math.max(index - 1, 0)]);
        break;
      case 'Home':
        go(rows[0]);
        break;
      case 'End':
        go(rows[rows.length - 1]);
        break;
      case 'ArrowRight':
        if (row?.folder !== true) return;
        if (!isOpen) toggle(projectId, row.path);
        else go(rows[index + 1]?.depth === row.depth + 1 ? rows[index + 1] : undefined);
        break;
      case 'ArrowLeft':
        if (row === undefined) return;
        if (row.folder && isOpen) toggle(projectId, row.path);
        else go(rows.find((candidate) => candidate.path === parentOf(row.path)));
        break;
      case 'Enter':
        if (row) activate(row, false);
        break;
      case ' ':
        if (row) activate(row, true);
        break;
      default: {
        if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
        const now = Date.now();
        typed.current = {
          text:
            now - typed.current.at < 600
              ? typed.current.text + event.key.toLowerCase()
              : event.key.toLowerCase(),
          at: now,
        };
        const after = [...rows.slice(index + 1), ...rows.slice(0, index + 1)];
        go(after.find((candidate) => candidate.name.toLowerCase().startsWith(typed.current.text)));
        break;
      }
    }
    event.preventDefault();
  };

  const area = 'flex min-h-0 flex-1 flex-col gap-[1px] overflow-y-auto px-[6px] pb-[10px]';
  const note = 'px-[8px] py-[4px] text-[12px] text-[var(--muted)]';

  if (error) {
    return (
      <div className={area}>
        <p role="alert" className={cn(note, 'text-[#c94c27]')}>
          Couldn’t read the project folder: {error instanceof Error ? error.message : String(error)}
        </p>
      </div>
    );
  }
  if (loading) {
    return (
      <div className={area}>
        <p className={note}>{query === '' ? 'Reading the folder…' : 'Listing the files…'}</p>
      </div>
    );
  }

  return (
    <div role="tree" aria-label={label} className={cn(area, 'outline-none')} onKeyDown={onKeyDown}>
      {rows.length === 0 && (
        <p className={note}>{query === '' ? 'This folder is empty.' : 'No files match.'}</p>
      )}
      {rows.map((row) => {
        const { path, name, folder, depth } = row;
        const isOpen = folder && expanded.includes(path);
        const active = !folder && editor.active === path;
        const dirty = !folder && editor.files[path]?.dirty === true;
        const agent = folder ? undefined : live.get(path);
        return (
          <div
            key={path}
            ref={(element) => {
              if (element) rowElements.current.set(path, element);
              else rowElements.current.delete(path);
            }}
            role="treeitem"
            aria-level={depth + 1}
            aria-expanded={folder ? isOpen : undefined}
            aria-selected={path === selected}
            tabIndex={row === rows[index] ? 0 : -1}
            data-testid={`tree-item-${path}`}
            className={cn(
              'flex h-[26px] w-full shrink-0 cursor-pointer select-none items-center gap-[7px] rounded-[6px] pr-[8px] text-left text-[12.5px] text-[var(--ink)] outline-none hover:bg-[var(--hover)] focus-visible:shadow-[inset_0_0_0_2px_#ef6b3f]',
              active ? 'bg-[var(--hover)]' : 'bg-transparent',
              folder || active ? 'font-semibold' : 'font-medium',
              row.ignored && 'opacity-50',
            )}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => {
              select(projectId, path);
              activate(row, true);
            }}
            onDoubleClick={() => {
              if (!folder) onOpen(path, { preview: false });
            }}
          >
            {/* The glyphs are CSS content, so a row's text is exactly its name. */}
            <span
              aria-hidden
              data-glyph={folder ? (isOpen ? '▾' : '▸') : ''}
              className="w-[9px] shrink-0 text-[9px] text-[var(--muted)] after:content-[attr(data-glyph)]"
            />
            <span
              aria-hidden
              className={cn('h-[8px] w-[8px] shrink-0', folder ? 'rounded-[2px]' : 'rounded-full')}
              style={{ background: folder ? 'var(--iconLine)' : fileIconColor(path) }}
            />
            <span className="min-w-0 flex-1 truncate">{name}</span>
            {dirty && (
              <span
                aria-hidden
                data-testid={`tree-dirty-${path}`}
                className="h-[6px] w-[6px] shrink-0 rounded-full bg-[#ef6b3f]"
              />
            )}
            {agent && (
              <span
                data-testid={`tree-agent-${path}`}
                data-glyph={agent.letter}
                title={`${agent.name} is editing`}
                className="flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-full text-[8px] font-bold text-[#fff] after:content-[attr(data-glyph)]"
                style={{ background: agent.color, animation: 'livePulse 2s ease-in-out infinite' }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
