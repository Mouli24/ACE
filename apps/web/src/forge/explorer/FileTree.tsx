import type { FileEntryKind } from '@ace/contracts';
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
import { askAgentAboutFile } from '../ask-agent';
import { fileIconColor } from '../../theme/constants';
import type { AgentLook } from '../../theme/agents';
import { useChangesStore } from '../changes/changes-store';
import { usePendingChanges } from '../changes/hooks';
import { filesMoved, filesRemoved, openFile } from '../editor/actions';
import { useEditorStore, useProjectEditor } from '../editor/editor-store';
import {
  useCreateEntry,
  useDeleteEntry,
  useFileList,
  useMoveEntry,
  useRepoStatus,
} from '../files/hooks';
import { isWithin, joinPath, nameOf, parentOf } from '../files/paths';
import { buildDecorations, TONE_COLOR } from './decorations';
import { DeleteDialog, MoveDialog } from './EntryDialogs';
import { useExplorerStore, useProjectExplorer } from './explorer-store';
import { InlineName } from './InlineName';
import { nameProblem } from './names';
import { useTreeRows } from './useTreeRows';

const SAVING = 'Wait for the save to finish.';
/** [audit F-8] The filter renders at most this many matching files; the rest are counted. */
export const FILTER_ROWS_MAX = 500;
const DRAG_TYPE = 'application/x-ace-path';
/** Where a drop would land: the canvas's selection box, its orange wash and 1.5px line (D332). */
const DROP_TARGET = 'bg-[rgba(239,107,63,0.06)] shadow-[inset_0_0_0_1.5px_#ef6b3f]';
const messageOf = (error: unknown): string =>
  AceApiError.is(error) || error instanceof Error ? error.message : String(error);

export interface FileTreeProps {
  projectId: string;
  /** The tree's accessible name. */
  label: string;
  /**
   * A single click previews; a double click or Enter pins (§6.2's preview tab). Space previews and
   * keeps the focus in the tree (`focus: false`, [audit F-11]).
   */
  onOpen(path: string, options: { preview: boolean; focus?: boolean }): void;
  /** Non-empty: a flat list of the project's files whose path contains it (theme filter). */
  filter?: string;
  /** Path → the agent writing that file now, from the run (D334). */
  live?: ReadonlyMap<string, AgentLook>;
  /** PG-3.4: the node in focus and the files it wrote in the run, marked in its colour. */
  followed?: FollowedFiles | undefined;
  /** False on a phone: browse only (FR-MOB-001). */
  editable?: boolean;
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

/** PG-3.4: a followed node's files, as the Explorer marks them. */
export interface FollowedFiles {
  agent: AgentLook;
  paths: ReadonlySet<string>;
}

/**
 * The project folder as an ARIA tree (FR-GIT-003) in the theme's Explorer rows (D334): lazy (a
 * folder lists when it opens), folders first, ignored entries dimmed, the open file marked, unsaved
 * files dotted, git changes marked, a pulsing badge while an agent writes a file, an accent ±
 * on a file whose agent change waits for review (D300; it opens Changes), keyboard
 * navigation with one roving tab stop. With a filter it lists the matching files flat, each by its
 * full path. When editable, VS Code's operations (D299): inline create and rename (F2), delete
 * (Delete) after a confirm, move by drag after a confirm, all from a context menu too. Open tabs
 * follow every rename and move.
 */
export function FileTree({
  projectId,
  label,
  onOpen,
  filter = '',
  live = NO_AGENTS,
  followed,
  editable = true,
}: FileTreeProps) {
  const tree = useTreeRows(projectId);
  const list = useFileList(projectId, filter !== '');
  const { expanded, selected, editing: storedEditing } = useProjectExplorer(projectId);
  // A name field left open at desktop width must not show on a phone; it resumes when the window widens.
  const editing = editable ? storedEditing : undefined;
  const editor = useProjectEditor(projectId);
  const store = useExplorerStore;
  const status = useRepoStatus(projectId);
  const project = useProject(projectId);
  const decorations = useMemo(() => buildDecorations(status.data), [status.data]);
  // D300: files an agent changed that wait for review, apart from git's letters
  const pendingChanges = usePendingChanges(projectId);
  const create = useCreateEntry(projectId);
  const move = useMoveEntry(projectId);
  const remove = useDeleteEntry(projectId);
  const treeElement = useRef<HTMLDivElement>(null);
  const rowElements = useRef(new Map<string, HTMLDivElement>());
  const typed = useRef({ text: '', at: 0 });
  const dragging = useRef<string | undefined>(undefined);
  const [dropTarget, setDropTarget] = useState<string | undefined>();
  const [menuTarget, setMenuTarget] = useState<Row | undefined>();
  const [pendingMove, setPendingMove] = useState<{ from: string; folder: string } | undefined>();
  const [pendingDelete, setPendingDelete] = useState<Row | undefined>();
  /** The row to focus once it renders: a path, or none for the current row (never `avoid`). */
  const focusRequest = useRef<{ path?: string; avoid?: string } | undefined>(undefined);
  const requestFocus = (path?: string, avoid?: string): void => {
    focusRequest.current = { path, avoid };
  };
  /** Keep the first request of an operation: a success asked for a better row than the close did. */
  const requestFocusUnlessAsked = (path: string): void => {
    focusRequest.current ??= { path };
  };

  const query = filter.trim().toLowerCase();
  const matches = useMemo(
    () =>
      query === ''
        ? []
        : (list.data?.files ?? []).filter((path) => path.toLowerCase().includes(query)),
    [query, list.data],
  );
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
        : matches
            .slice(0, FILTER_ROWS_MAX)
            .map((path) => ({ path, name: path, folder: false, ignored: false, depth: 0 })),
    [query, tree.rows, matches],
  );
  /** Matching files past the rows rendered ([audit F-8]). */
  const more = matches.length - Math.min(matches.length, FILTER_ROWS_MAX);
  const loading = query === '' ? tree.loading : list.isPending;
  const error = query === '' ? tree.error : list.error;

  // One current row for the tab stop and the keys alike: the selected row if visible, else the first.
  const found = rows.findIndex((row) => row.path === selected);
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
      (rows[index]?.path !== request.avoid
        ? rows[index]?.path
        : rows.find((row) => row.path !== request.avoid)?.path);
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

  /** A folder's entries by name, from the folder tree (a filtered list shows files only). */
  const siblingsOf = (folder: string, except?: string): string[] =>
    tree.rows
      .filter((row) => parentOf(row.entry.path) === folder && row.entry.path !== except)
      .map((row) => row.entry.name);
  const folderFor = (row: Row | undefined): string =>
    row === undefined ? '' : row.folder ? row.path : parentOf(row.path);

  const focusRow = (path: string): void => {
    store.getState().select(projectId, path);
    rowElements.current.get(path)?.focus();
  };
  const activate = (row: Row, preview: boolean, focus = true): void => {
    if (row.folder) store.getState().toggle(projectId, row.path);
    else onOpen(row.path, focus ? { preview } : { preview, focus: false });
  };

  const commitCreate = async (
    parent: string,
    kind: FileEntryKind,
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
        if (!isOpen) store.getState().toggle(projectId, row.path);
        else go(rows[index + 1]?.depth === row.depth + 1 ? rows[index + 1] : undefined);
        break;
      case 'ArrowLeft':
        if (row === undefined) return;
        if (row.folder && isOpen) store.getState().toggle(projectId, row.path);
        else go(rows.find((candidate) => candidate.path === parentOf(row.path)));
        break;
      case 'Enter':
        if (row) activate(row, false);
        break;
      case ' ':
        if (row) activate(row, true, false);
        break;
      case 'F2':
        if (!editable || row === undefined) return;
        store.getState().startRename(projectId, row.path);
        break;
      case 'Delete':
        if (!editable || row === undefined) return;
        setPendingDelete(row);
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
        folder={kind === 'folder'}
        problemOf={(name) => nameProblem(name, siblingsOf(parent), { allowSlash: true })}
        onCommit={(name, wantFocus) => commitCreate(parent, kind, name, wantFocus)}
        onCancel={(wantFocus) => {
          if (wantFocus) requestFocus(parent === '' ? undefined : parent);
          store.getState().stopEditing(projectId);
        }}
      />
    );
  };

  const area = 'flex min-h-0 flex-1 flex-col gap-[1px] overflow-y-auto px-[6px] pb-[10px]';
  const note = 'px-[8px] py-[4px] text-[12px] text-[var(--muted)]';

  if (error) {
    return (
      <div className={area}>
        <p role="alert" className={cn(note, 'text-[#c94c27]')}>
          Couldn’t read the project folder: {messageOf(error)}
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

  const rendered: ReactNode[] = [];
  // a filtered list has no folder rows to open a field under, so a new entry's field leads it
  if (editing?.mode === 'create' && (editing.parent === '' || query !== ''))
    rendered.push(inputRow(0));
  for (const row of rows) {
    const { path, name, folder, depth } = row;
    const isOpen = folder && expanded.includes(path);
    const active = !folder && editor.active === path;
    const dirty = !folder && editor.files[path]?.dirty === true;
    const agent = folder ? undefined : live.get(path);
    const byFollowed = !folder && followed !== undefined && followed.paths.has(path);
    const changedIn = folder ? undefined : pendingChanges.get(path);
    const decoration = folder ? undefined : decorations.file(path);
    const tone = folder ? decorations.folder(path) : decoration?.tone;
    const renaming = editing?.mode === 'rename' && editing.path === path;
    rendered.push(
      renaming ? (
        <InlineName
          key={path}
          label={`Rename ${nameOf(path)}`}
          initial={nameOf(path)}
          depth={depth}
          folder={folder}
          problemOf={(next) =>
            nameProblem(next, siblingsOf(parentOf(path), path), { allowSlash: false })
          }
          onCommit={(next, wantFocus) =>
            commitMove(path, joinPath(parentOf(path), next), wantFocus)
          }
          onCancel={(wantFocus) => {
            if (wantFocus) requestFocus(path);
            store.getState().stopEditing(projectId);
          }}
        />
      ) : (
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
          title={path}
          draggable={editable}
          onDragStart={(event) => {
            dragging.current = path;
            event.dataTransfer.setData(DRAG_TYPE, path);
            event.dataTransfer.effectAllowed = 'move';
          }}
          onDragEnd={() => {
            dragging.current = undefined;
            setDropTarget(undefined);
          }}
          {...(editable ? dragTargetProps(folder ? path : parentOf(path), true) : {})}
          onContextMenu={() => store.getState().select(projectId, path)}
          className={cn(
            'flex h-[26px] w-full shrink-0 cursor-pointer select-none items-center gap-[7px] rounded-[6px] pr-[8px] text-left text-[12.5px] text-[var(--ink)] outline-none hover:bg-[var(--hover)] focus-visible:shadow-[inset_0_0_0_2px_#ef6b3f]',
            active ? 'bg-[var(--hover)]' : 'bg-transparent',
            folder || active ? 'font-semibold' : 'font-medium',
            dropTarget === path && DROP_TARGET,
            row.ignored && 'opacity-50',
          )}
          data-followed={byFollowed ? 'true' : undefined}
          style={{
            paddingLeft: 8 + depth * 14,
            ...(byFollowed && followed !== undefined
              ? { boxShadow: `inset 2px 0 0 ${followed.agent.color}` }
              : {}),
          }}
          onClick={() => {
            store.getState().select(projectId, path);
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
          <span
            className="min-w-0 flex-1 truncate"
            style={tone ? { color: TONE_COLOR[tone] } : undefined}
          >
            {name}
          </span>
          {decoration && (
            <span
              data-testid={`tree-git-${path}`}
              data-glyph={decoration.letter}
              title={decoration.title}
              className="shrink-0 font-machine text-[9.5px] font-medium after:content-[attr(data-glyph)]"
              style={{ color: TONE_COLOR[decoration.tone] }}
            />
          )}
          {dirty && (
            <span
              aria-hidden
              data-testid={`tree-dirty-${path}`}
              className="h-[6px] w-[6px] shrink-0 rounded-full bg-[#ef6b3f]"
            />
          )}
          {changedIn !== undefined && (
            <span
              role="button"
              tabIndex={-1}
              data-testid={`tree-change-${path}`}
              data-glyph="±"
              aria-label={`Review the agent's changes to ${nameOf(path)}`}
              title="An agent changed this file: review it in Changes"
              onClick={(event) => {
                event.stopPropagation();
                useChangesStore.getState().show(projectId, changedIn);
              }}
              onDoubleClick={(event) => event.stopPropagation()}
              className="flex h-[16px] w-[16px] shrink-0 cursor-pointer items-center justify-center rounded-full bg-[#ef6b3f] text-[9px] font-bold text-[#fff] after:content-[attr(data-glyph)]"
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
      ),
    );
    if (editing?.mode === 'create' && query === '' && folder && editing.parent === path && isOpen)
      rendered.push(inputRow(depth + 1));
    // [audit F-14] an open folder still listing, or unreadable, says so under its row
    const status = folder && isOpen && query === '' ? tree.folders.get(path) : undefined;
    if (status !== undefined) {
      rendered.push(
        'error' in status ? (
          <p
            key={`${path}\u0000status`}
            role="alert"
            className={cn(note, 'text-[#c94c27]')}
            style={{ paddingLeft: 8 + (depth + 1) * 14 }}
          >
            Couldn’t read {name}: {messageOf(status.error)}
          </p>
        ) : (
          <p
            key={`${path}\u0000status`}
            className={note}
            style={{ paddingLeft: 8 + (depth + 1) * 14 }}
          >
            Reading the folder…
          </p>
        ),
      );
    }
  }

  const folderPath = project.data?.folderPath ?? '';
  const separator = folderPath.includes('\\') ? '\\' : '/';
  const target = menuTarget;
  const treeView = (
    <div
      ref={treeElement}
      role="tree"
      aria-label={label}
      className={cn(area, 'outline-none', dropTarget === '' && DROP_TARGET)}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => {
        // The menu acts on the row under the pointer, or on the project folder anywhere else — the
        // empty note and a name field included — never on a row right-clicked earlier (review
        // minor 1). The name field keeps the browser's own menu: it never reaches this handler.
        const element = (event.target as Element).closest('[role="treeitem"]');
        setMenuTarget(
          rows.find((candidate) => rowElements.current.get(candidate.path) === element),
        );
      }}
      {...(editable ? dragTargetProps('', false) : {})}
    >
      {rows.length === 0 && editing === undefined && (
        <p className={note}>{query === '' ? 'This folder is empty.' : 'No files match.'}</p>
      )}
      {rendered}
      {more > 0 && (
        <p data-testid="filter-more" className={note}>
          {more.toLocaleString()} more — keep typing to narrow the list.
        </p>
      )}
    </div>
  );

  return (
    <>
      {editable ? (
        <ContextMenu modal={false}>
          <ContextMenuTrigger asChild>{treeView}</ContextMenuTrigger>
          <ContextMenuContent
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
                <ContextMenuItem destructive onSelect={() => setPendingDelete(target)}>
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
                {!target.folder && (
                  <>
                    <ContextMenuSeparator />
                    {/* D302: the file, by its path, as a chip in the chat composer. */}
                    <ContextMenuItem onSelect={() => askAgentAboutFile(target.path, projectId)}>
                      Ask Agent About This File
                    </ContextMenuItem>
                  </>
                )}
              </>
            )}
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        treeView
      )}
      {pendingDelete !== undefined && (
        <DeleteDialog
          path={pendingDelete.path}
          isFolder={pendingDelete.folder}
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
