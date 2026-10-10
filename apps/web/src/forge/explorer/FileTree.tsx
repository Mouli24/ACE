import type { FileEntry } from '@ace/contracts';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
  cn,
} from '@ace/ui';
import { AceApiError } from '@ace/sdk';
import { ChevronRight, Folder, FolderOpen } from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { useProject } from '../../projects/hooks';
import { filesMoved, filesRemoved, openFile } from '../editor/actions';
import { useEditorStore } from '../editor/editor-store';
import { useCreateEntry, useDeleteEntry, useMoveEntry, useRepoStatus } from '../files/hooks';
import { isWithin, joinPath, nameOf, parentOf } from '../files/paths';
import { buildDecorations, TONE_COLOR } from './decorations';
import { DeleteDialog, MoveDialog } from './EntryDialogs';
import { useExplorerStore, useProjectExplorer } from './explorer-store';
import { FileIcon } from './FileIcon';
import { InlineName } from './InlineName';
import { nameProblem } from './names';
import { useTreeRows, type TreeRow } from './useTreeRows';

const SAVING = 'Wait for the save to finish.';
const DRAG_TYPE = 'application/x-ace-path';
const messageOf = (error: unknown): string =>
  AceApiError.is(error) || error instanceof Error ? error.message : String(error);

export interface FileTreeProps {
  projectId: string;
  label: string;
  onOpen(path: string, options: { preview: boolean }): void;
  /** False on a phone: browse only (FR-MOB-001). */
  editable?: boolean;
}

/**
 * The project folder as an ARIA tree (FR-GIT-003): lazy, folders first, ignored entries dimmed, git
 * decorations, keyboard navigation — and, when editable, VS Code's operations: inline create and
 * rename (F2), delete (Delete) after a confirm, move by drag after a confirm, all from a context
 * menu too. Open tabs follow every rename and move.
 */
export function FileTree({ projectId, label, onOpen, editable = true }: FileTreeProps) {
  const { rows, loading, error } = useTreeRows(projectId);
  const { expanded, selected, editing: storedEditing } = useProjectExplorer(projectId);
  // A name field left open at desktop width must not show on a phone; it resumes when the window widens.
  const editing = editable ? storedEditing : undefined;
  const store = useExplorerStore;
  const status = useRepoStatus(projectId);
  const project = useProject(projectId);
  const decorations = useMemo(() => buildDecorations(status.data), [status.data]);
  const create = useCreateEntry(projectId);
  const move = useMoveEntry(projectId);
  const remove = useDeleteEntry(projectId);
  const treeElement = useRef<HTMLDivElement>(null);
  const rowElements = useRef(new Map<string, HTMLDivElement>());
  const typed = useRef({ text: '', at: 0 });
  const dragging = useRef<string | undefined>(undefined);
  const [dropTarget, setDropTarget] = useState<string | undefined>();
  const [menuTarget, setMenuTarget] = useState<FileEntry | undefined>();
  const [pendingMove, setPendingMove] = useState<{ from: string; folder: string } | undefined>();
  const [pendingDelete, setPendingDelete] = useState<FileEntry | undefined>();
  /** The row to focus once it renders: a path, or none for the current row (never `avoid`). */
  const focusRequest = useRef<{ path?: string; avoid?: string } | undefined>(undefined);
  const requestFocus = (path?: string, avoid?: string): void => {
    focusRequest.current = { path, avoid };
  };
  /** Keep the first request of an operation: a success asked for a better row than the close did. */
  const requestFocusUnlessAsked = (path: string): void => {
    focusRequest.current ??= { path };
  };

  // One current row for the tab stop and the keys alike: the selected row if visible, else the first.
  const found = rows.findIndex((row) => row.entry.path === selected);
  const index = found === -1 ? 0 : found;

  useEffect(() => {
    const request = focusRequest.current;
    // a dialog traps focus until it has closed
    if (request === undefined || pendingDelete !== undefined || pendingMove !== undefined) return;
    // focus the person moved elsewhere (the editor, a field) is not ours to take back
    const active = document.activeElement;
    if (active !== null && active !== document.body && !treeElement.current?.contains(active)) {
      // a request lives for one decision: declined now, it must not fire on a later click
      focusRequest.current = undefined;
      return;
    }
    const path =
      request.path ??
      (rows[index]?.entry.path !== request.avoid
        ? rows[index]?.entry.path
        : rows.find((row) => row.entry.path !== request.avoid)?.entry.path);
    if (path === undefined) {
      if (request.path === undefined) focusRequest.current = undefined;
      return;
    }
    const element = rowElements.current.get(path);
    if (element === undefined) return;
    focusRequest.current = undefined;
    store.getState().select(projectId, path);
    element.focus();
  });

  const savingWithin = (path: string): boolean =>
    Object.values(useEditorStore.getState().projects[projectId]?.files ?? {}).some(
      (file) => file.saving && isWithin(file.path, path),
    );

  const siblingsOf = (folder: string, except?: string): string[] =>
    rows
      .filter((row) => parentOf(row.entry.path) === folder && row.entry.path !== except)
      .map((row) => row.entry.name);
  const folderFor = (entry: FileEntry | undefined): string =>
    entry === undefined ? '' : entry.kind === 'folder' ? entry.path : parentOf(entry.path);

  const focusRow = (path: string): void => {
    store.getState().select(projectId, path);
    rowElements.current.get(path)?.focus();
  };
  const activate = (row: TreeRow, preview: boolean): void => {
    if (row.entry.kind === 'folder') store.getState().toggle(projectId, row.entry.path);
    else onOpen(row.entry.path, { preview });
  };

  const commitCreate = async (
    parent: string,
    kind: FileEntry['kind'],
    name: string,
    wantFocus: boolean,
  ): Promise<string | undefined> => {
    try {
      const entry = await create.mutateAsync({ path: joinPath(parent, name), kind });
      if (wantFocus) requestFocus(entry.path);
      store.getState().stopEditing(projectId);
      if (kind === 'file') openFile(projectId, entry.path, { preview: false });
      else store.getState().expand(projectId, entry.path);
      return undefined;
    } catch (failure) {
      return messageOf(failure);
    }
  };

  const commitMove = async (
    from: string,
    to: string,
    wantFocus = true,
  ): Promise<string | undefined> => {
    if (savingWithin(from)) return SAVING;
    try {
      await move.mutateAsync({ from, to });
      if (wantFocus) requestFocus(to);
      store.getState().stopEditing(projectId);
      filesMoved(projectId, from, to);
      return undefined;
    } catch (failure) {
      return messageOf(failure);
    }
  };

  const commitDelete = async (path: string): Promise<string | undefined> => {
    if (savingWithin(path)) return SAVING;
    try {
      await remove.mutateAsync(path);
      requestFocus(undefined, path);
      filesRemoved(projectId, path);
      return undefined;
    } catch (failure) {
      return messageOf(failure);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
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
        if (!isOpen) store.getState().toggle(projectId, row.entry.path);
        else go(rows[index + 1]?.depth === row.depth + 1 ? rows[index + 1] : undefined);
        break;
      case 'ArrowLeft':
        if (row === undefined) return;
        if (row.entry.kind === 'folder' && isOpen)
          store.getState().toggle(projectId, row.entry.path);
        else go(rows.find((candidate) => candidate.entry.path === parentOf(row.entry.path)));
        break;
      case 'Enter':
        if (row) activate(row, false);
        break;
      case ' ':
        if (row) activate(row, true);
        break;
      case 'F2':
        if (!editable || row === undefined) return;
        store.getState().startRename(projectId, row.entry.path);
        break;
      case 'Delete':
        if (!editable || row === undefined) return;
        setPendingDelete(row.entry);
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

  /* drag and drop: a file or folder onto a folder row, or onto the empty tree for the root */
  /** Not into itself or its own subtree, and not where it already is. */
  const canMove = (from: string, folder: string): boolean =>
    !isWithin(folder, from) && parentOf(from) !== folder;
  const dragTargetProps = (folder: string, isRow: boolean) => ({
    onDragOver: (event: DragEvent) => {
      if (isRow) event.stopPropagation();
      else if ((event.target as Element).closest('[role="treeitem"]') !== null) return;
      // the dragged path is only readable on drop, so the drag in progress is remembered here
      if (dragging.current === undefined || !canMove(dragging.current, folder)) {
        if (isRow) event.dataTransfer.dropEffect = 'none';
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      setDropTarget(folder);
    },
    onDragLeave: () => setDropTarget((current) => (current === folder ? undefined : current)),
    onDrop: (event: DragEvent) => {
      if (isRow) event.stopPropagation();
      else if ((event.target as Element).closest('[role="treeitem"]') !== null) return;
      const from = dragging.current ?? event.dataTransfer.getData(DRAG_TYPE);
      setDropTarget(undefined);
      dragging.current = undefined;
      if (from === '' || !canMove(from, folder)) return;
      event.preventDefault();
      event.stopPropagation();
      setPendingMove({ from, folder });
    },
  });

  const inputRow = (depth: number): ReactNode => {
    if (editing?.mode !== 'create') return null;
    const { parent, kind } = editing;
    return (
      <InlineName
        key="__new__"
        label={kind === 'folder' ? 'New folder name' : 'New file name'}
        initial=""
        depth={depth}
        problemOf={(name) => nameProblem(name, siblingsOf(parent), { allowSlash: true })}
        onCommit={(name, wantFocus) => commitCreate(parent, kind, name, wantFocus)}
        onCancel={(wantFocus) => {
          if (wantFocus) requestFocus(parent === '' ? undefined : parent);
          store.getState().stopEditing(projectId);
        }}
      />
    );
  };

  if (error) {
    return (
      <p role="alert" className="px-3 py-2 text-[12px] text-danger">
        Couldn’t read the project folder: {messageOf(error)}
      </p>
    );
  }
  if (loading) return <p className="px-3 py-2 text-[12px] text-fg-muted">Reading the folder…</p>;

  const rendered: ReactNode[] = [];
  if (editing?.mode === 'create' && editing.parent === '') rendered.push(inputRow(0));
  for (const row of rows) {
    const { entry, depth } = row;
    const folder = entry.kind === 'folder';
    const isOpen = folder && expanded.includes(entry.path);
    const isCurrent = row === rows[index];
    const decoration = folder ? undefined : decorations.file(entry.path);
    const tone = folder ? decorations.folder(entry.path) : decoration?.tone;
    const renaming = editing?.mode === 'rename' && editing.path === entry.path;
    rendered.push(
      renaming ? (
        <InlineName
          key={entry.path}
          label={`Rename ${entry.name}`}
          initial={entry.name}
          depth={depth}
          problemOf={(name) =>
            nameProblem(name, siblingsOf(parentOf(entry.path), entry.path), { allowSlash: false })
          }
          onCommit={(name, wantFocus) =>
            commitMove(entry.path, joinPath(parentOf(entry.path), name), wantFocus)
          }
          onCancel={(wantFocus) => {
            if (wantFocus) requestFocus(entry.path);
            store.getState().stopEditing(projectId);
          }}
        />
      ) : (
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
          tabIndex={isCurrent ? 0 : -1}
          data-testid={`tree-item-${entry.path}`}
          title={entry.path}
          draggable={editable}
          onDragStart={(event) => {
            dragging.current = entry.path;
            event.dataTransfer.setData(DRAG_TYPE, entry.path);
            event.dataTransfer.effectAllowed = 'move';
          }}
          onDragEnd={() => {
            dragging.current = undefined;
            setDropTarget(undefined);
          }}
          {...(editable ? dragTargetProps(folder ? entry.path : parentOf(entry.path), true) : {})}
          onContextMenu={() => {
            setMenuTarget(entry);
            store.getState().select(projectId, entry.path);
          }}
          className={cn(
            'flex h-[22px] cursor-pointer select-none items-center gap-1 pr-2 font-machine text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent',
            entry.path === selected ? 'bg-selection/20 text-fg' : 'text-fg-soft hover:bg-card',
            dropTarget === entry.path && 'bg-selection/30 ring-1 ring-inset ring-accent',
            entry.ignored && 'opacity-50',
          )}
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => {
            store.getState().select(projectId, entry.path);
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
      ),
    );
    if (editing?.mode === 'create' && folder && editing.parent === entry.path && isOpen)
      rendered.push(inputRow(depth + 1));
  }

  const folderPath = project.data?.folderPath ?? '';
  const separator = folderPath.includes('\\') ? '\\' : '/';
  const target = menuTarget;
  const tree = (
    <div
      ref={treeElement}
      role="tree"
      aria-label={label}
      className={cn('min-h-full py-1 outline-none', dropTarget === '' && 'bg-selection/10')}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => {
        if (event.target === event.currentTarget) setMenuTarget(undefined);
      }}
      {...(editable ? dragTargetProps('', false) : {})}
    >
      {rows.length === 0 && editing === undefined && (
        <p className="px-3 py-2 text-[12px] text-fg-muted">This folder is empty.</p>
      )}
      {rendered}
    </div>
  );

  return (
    <>
      {editable ? (
        <ContextMenu modal={false}>
          <ContextMenuTrigger asChild>{tree}</ContextMenuTrigger>
          <ContextMenuContent
            className="w-56"
            onCloseAutoFocus={(event) => {
              // a name field opened from the menu keeps the focus; the menu must not take it back
              if (store.getState().projects[projectId]?.editing !== undefined)
                event.preventDefault();
            }}
          >
            <ContextMenuItem
              onSelect={() => store.getState().startCreate(projectId, folderFor(target), 'file')}
            >
              New File
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => store.getState().startCreate(projectId, folderFor(target), 'folder')}
            >
              New Folder
            </ContextMenuItem>
            {target !== undefined && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem
                  onSelect={() => store.getState().startRename(projectId, target.path)}
                >
                  Rename <ContextMenuShortcut>F2</ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem className="text-danger" onSelect={() => setPendingDelete(target)}>
                  Delete <ContextMenuShortcut>Del</ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  onSelect={() =>
                    void navigator.clipboard?.writeText(
                      `${folderPath}${separator}${target.path.split('/').join(separator)}`,
                    )
                  }
                >
                  Copy Path
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(target.path)}>
                  Copy Relative Path
                </ContextMenuItem>
              </>
            )}
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        tree
      )}
      {pendingDelete !== undefined && (
        <DeleteDialog
          path={pendingDelete.path}
          isFolder={pendingDelete.kind === 'folder'}
          onConfirm={() => commitDelete(pendingDelete.path)}
          onClose={() => {
            requestFocusUnlessAsked(pendingDelete.path);
            setPendingDelete(undefined);
          }}
        />
      )}
      {pendingMove !== undefined && (
        <MoveDialog
          from={pendingMove.from}
          folder={pendingMove.folder}
          onConfirm={() =>
            commitMove(pendingMove.from, joinPath(pendingMove.folder, nameOf(pendingMove.from)))
          }
          onClose={() => {
            requestFocusUnlessAsked(pendingMove.from);
            setPendingMove(undefined);
          }}
        />
      )}
    </>
  );
}
