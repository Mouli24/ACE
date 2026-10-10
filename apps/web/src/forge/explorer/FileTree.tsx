import { cn } from '@ace/ui';
import { ChevronRight, Folder, FolderOpen } from 'lucide-react';
import { useMemo, useRef, type KeyboardEvent } from 'react';

import { useRepoStatus } from '../files/hooks';
import { parentOf } from '../files/paths';
import { buildDecorations, TONE_COLOR } from './decorations';
import { useExplorerStore, useProjectExplorer } from './explorer-store';
import { FileIcon } from './FileIcon';
import { useTreeRows, type TreeRow } from './useTreeRows';

export interface FileTreeProps {
  projectId: string;
  /** The tree's accessible name. */
  label: string;
  /** A single click previews; a double click or Enter pins (§6.2's preview tab). */
  onOpen(path: string, options: { preview: boolean }): void;
}

/**
 * The project folder as an ARIA tree (FR-GIT-003): lazy (a folder lists when it opens), folders
 * first, ignored entries dimmed, git decorations as in VS Code, keyboard navigation with one
 * roving tab stop.
 */
export function FileTree({ projectId, label, onOpen }: FileTreeProps) {
  const { rows, loading, error } = useTreeRows(projectId);
  const { expanded, selected } = useProjectExplorer(projectId);
  const toggle = useExplorerStore((s) => s.toggle);
  const select = useExplorerStore((s) => s.select);
  const status = useRepoStatus(projectId);
  const decorations = useMemo(() => buildDecorations(status.data), [status.data]);
  const rowElements = useRef(new Map<string, HTMLDivElement>());
  const typed = useRef({ text: '', at: 0 });

  const focusRow = (path: string): void => {
    select(projectId, path);
    rowElements.current.get(path)?.focus();
  };

  const activate = (row: TreeRow, preview: boolean): void => {
    if (row.entry.kind === 'folder') toggle(projectId, row.entry.path);
    else onOpen(row.entry.path, { preview });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = rows.findIndex((row) => row.entry.path === selected);
    const row = rows[index];
    const isOpen = row !== undefined && expanded.includes(row.entry.path);
    const go = (target: TreeRow | undefined) => {
      if (target) focusRow(target.entry.path);
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
        if (row?.entry.kind !== 'folder') return;
        if (!isOpen) toggle(projectId, row.entry.path);
        else go(rows[index + 1]?.depth === row.depth + 1 ? rows[index + 1] : undefined);
        break;
      case 'ArrowLeft':
        if (row === undefined) return;
        if (row.entry.kind === 'folder' && isOpen) toggle(projectId, row.entry.path);
        else go(rows.find((candidate) => candidate.entry.path === parentOf(row.entry.path)));
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
        go(
          after.find((candidate) =>
            candidate.entry.name.toLowerCase().startsWith(typed.current.text),
          ),
        );
        break;
      }
    }
    event.preventDefault();
  };

  if (error) {
    return (
      <p role="alert" className="px-3 py-2 text-[12px] text-danger">
        Couldn’t read the project folder: {error instanceof Error ? error.message : String(error)}
      </p>
    );
  }
  if (loading) return <p className="px-3 py-2 text-[12px] text-fg-muted">Reading the folder…</p>;

  return (
    <div role="tree" aria-label={label} className="py-1 outline-none" onKeyDown={onKeyDown}>
      {rows.length === 0 && (
        <p className="px-3 py-2 text-[12px] text-fg-muted">This folder is empty.</p>
      )}
      {rows.map((row) => {
        const { entry, depth } = row;
        const folder = entry.kind === 'folder';
        const isOpen = folder && expanded.includes(entry.path);
        const isSelected = entry.path === selected || (selected === undefined && row === rows[0]);
        const decoration = folder ? undefined : decorations.file(entry.path);
        const tone = folder ? decorations.folder(entry.path) : decoration?.tone;
        return (
          <div
            key={entry.path}
            ref={(element) => {
              if (element) rowElements.current.set(entry.path, element);
              else rowElements.current.delete(entry.path);
            }}
            role="treeitem"
            aria-level={depth + 1}
            aria-expanded={folder ? isOpen : undefined}
            aria-selected={entry.path === selected}
            tabIndex={isSelected ? 0 : -1}
            data-testid={`tree-item-${entry.path}`}
            title={entry.path}
            className={cn(
              'flex h-[22px] cursor-pointer select-none items-center gap-1 pr-2 font-machine text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent',
              entry.path === selected ? 'bg-selection/20 text-fg' : 'text-fg-soft hover:bg-card',
              entry.ignored && 'opacity-50',
            )}
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => {
              select(projectId, entry.path);
              activate(row, true);
            }}
            onDoubleClick={() => {
              if (!folder) onOpen(entry.path, { preview: false });
            }}
          >
            {folder ? (
              <ChevronRight
                className={cn(
                  'h-3.5 w-3.5 shrink-0 text-fg-muted transition-transform',
                  isOpen && 'rotate-90',
                )}
                aria-hidden
              />
            ) : (
              <span className="w-3.5 shrink-0" />
            )}
            {folder ? (
              isOpen ? (
                <FolderOpen className="h-3.5 w-3.5 shrink-0 text-fg-muted" aria-hidden />
              ) : (
                <Folder className="h-3.5 w-3.5 shrink-0 text-fg-muted" aria-hidden />
              )
            ) : (
              <FileIcon path={entry.path} />
            )}
            <span
              className="min-w-0 flex-1 truncate"
              style={tone ? { color: TONE_COLOR[tone] } : undefined}
            >
              {entry.name}
            </span>
            {decoration && (
              <span
                className="pl-2 text-[10px] font-semibold"
                style={{ color: TONE_COLOR[decoration.tone] }}
                title={decoration.title}
              >
                {decoration.letter}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
