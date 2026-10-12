import { cn } from '@ace/ui';
import { useState } from 'react';

import { useProject } from '../../projects/hooks';
import type { AgentLook } from '../../theme/agents';
import { openFile } from '../editor/actions';
import { useFileList } from '../files/hooks';
import { parentOf } from '../files/paths';
import { useExplorerStore, useProjectExplorer } from './explorer-store';
import { FileTree } from './FileTree';
import { useTreeRows } from './useTreeRows';

/** "{n} files" from the project's file list; `n+` when the engine cut the list short. */
function fileCount(list: { files: readonly string[]; truncated: boolean } | undefined): string {
  if (list === undefined) return '';
  return `${list.files.length}${list.truncated ? '+' : ''} files`;
}

/**
 * The theme's Explorer (D334): a fixed 248px column — "EXPLORER", the file count and New File /
 * New Folder (D299, created where the selection is, as in VS Code), the tree, and the filter at the
 * bottom. The file watcher keeps it fresh, so it has no refresh or collapse.
 */
export function ExplorerView({
  projectId,
  live,
}: {
  projectId: string;
  /** Path → the agent writing it now (D334). */
  live?: ReadonlyMap<string, AgentLook>;
}) {
  const project = useProject(projectId);
  const list = useFileList(projectId, true);
  const [filter, setFilter] = useState('');
  const startCreate = useExplorerStore((s) => s.startCreate);
  const selected = useProjectExplorer(projectId).selected;
  const selectedRow = useTreeRows(projectId).rows.find((row) => row.entry.path === selected);
  /** Where a new entry goes, as in VS Code: the selected folder, the selected file's folder, or the root. */
  const folderOfSelection = (): string =>
    selectedRow === undefined
      ? ''
      : selectedRow.entry.kind === 'folder'
        ? selectedRow.entry.path
        : parentOf(selectedRow.entry.path);
  const name = project.data?.name ?? 'Project';
  const count = fileCount(list.data);
  return (
    <nav
      aria-label="Explorer"
      className="flex w-[248px] shrink-0 flex-col border-r border-[var(--line)] bg-[var(--panel)]"
    >
      <div className="flex items-center gap-[8px] px-[14px] pb-[8px] pt-[12px]">
        <span className="font-machine text-[10px] tracking-[0.1em] text-[var(--muted)]">
          EXPLORER
        </span>
        <div className="flex-1" />
        {count !== '' && (
          <span
            data-testid="explorer-count"
            className="whitespace-nowrap text-[10.5px] text-[var(--muted)]"
          >
            {count}
          </span>
        )}
        <div className="-my-[4px] -mr-[6px] flex items-center">
          <CreateButton
            label="New File"
            folder={false}
            onClick={() => startCreate(projectId, folderOfSelection(), 'file')}
          />
          <CreateButton
            label="New Folder"
            folder
            onClick={() => startCreate(projectId, folderOfSelection(), 'folder')}
          />
        </div>
      </div>
      <FileTree
        projectId={projectId}
        label={`Files of ${name}`}
        filter={filter}
        live={live}
        onOpen={(path, options) => openFile(projectId, path, options)}
      />
      <div className="border-t border-[var(--line)] p-[10px]">
        <input
          type="text"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter files…"
          aria-label="Filter files"
          spellCheck={false}
          className="h-[30px] w-full rounded-[8px] border border-[var(--line)] bg-[var(--surface)] px-[10px] text-[12px] [font-family:inherit] text-[var(--ink)] outline-none focus:border-[#ef6b3f]"
        />
      </div>
    </nav>
  );
}

/**
 * A 20px header button in the tab strip's close-button style: "+" beside the tree's own mark for
 * what it makes — a file's dot or a folder's square.
 */
function CreateButton({
  label,
  folder,
  onClick,
}: {
  label: string;
  folder: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-[20px] shrink-0 cursor-pointer items-center gap-[3px] rounded-[5px] border-none bg-transparent px-[5px] text-[12px] leading-none text-[var(--muted)] outline-none hover:bg-[var(--hover)] hover:text-[var(--ink)] focus-visible:shadow-[inset_0_0_0_2px_#ef6b3f]"
    >
      <span aria-hidden>+</span>
      <span
        aria-hidden
        className={cn(
          'h-[7px] w-[7px] shrink-0 bg-[var(--iconLine)]',
          folder ? 'rounded-[2px]' : 'rounded-full',
        )}
      />
    </button>
  );
}
