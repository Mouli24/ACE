import { cn } from '@ace/ui';
import { useEffect, useState } from 'react';

import { useProject } from '../../projects/hooks';
import type { AgentLook } from '../../theme/agents';
import { useChangesStore, useProjectChanges } from '../changes/changes-store';
import { ChangesView } from '../changes/ChangesView';
import { openFile } from '../editor/actions';
import { useFileList } from '../files/hooks';
import { parentOf } from '../files/paths';
import { EXPLORER_WIDTH, useForgeSizes } from '../layout/sizes';
import { Splitter } from '../layout/Splitter';
import { SearchView } from '../search/SearchView';
import { useExplorerStore, useProjectExplorer } from './explorer-store';
import { FileTree, type FollowedFiles } from './FileTree';
import { useSideViewStore } from './side-view-store';
import { SideViewSwitch } from './SideViewSwitch';
import { useTreeRows } from './useTreeRows';

/** "{n} files" from the project's file list; `n+` when the engine cut the list short. */
function fileCount(list: { files: readonly string[]; truncated: boolean } | undefined): string {
  if (list === undefined) return '';
  return `${list.files.length}${list.truncated ? '+' : ''} files`;
}

/**
 * The theme's Explorer (D334): a 248px column — resizable from its right edge, as D299 has it, and
 * remembered ([audit F-7]). Its header switches EXPLORER · SEARCH · CHANGES (D299 Phase 4, D339) in
 * the kit's pill, and the body is the view picked: the project's files ({@link ExplorerFiles}),
 * {@link SearchView} or D300's {@link ChangesView}.
 */
export function ExplorerView({
  projectId,
  workflowId,
  live,
  followed,
}: {
  projectId: string;
  /** The workflow whose nodes name a chat's checkpoints in Changes ("Chat with Writer"). */
  workflowId?: string;
  /** Path → the agent writing it now (D334). */
  live?: ReadonlyMap<string, AgentLook>;
  /** PG-3.4: the node in focus and the files it wrote. */
  followed?: FollowedFiles | undefined;
}) {
  const view = useSideViewStore((state) => state.view);
  const width = useForgeSizes((state) => state.explorerWidth);
  const setWidth = useForgeSizes((state) => state.setExplorerWidth);
  // D300: an agent-change marker asks for Changes on its checkpoint; the switch shows it, and the
  // request is settled so the next marker click asks again. Its `focus` stays for the outline.
  const requested = useProjectChanges(projectId).requested;
  useEffect(() => {
    if (!requested) return;
    useSideViewStore.getState().show('changes');
    useChangesStore.getState().dismiss(projectId);
  }, [requested, projectId]);
  return (
    <nav
      aria-label="Explorer"
      style={{ width }}
      className="relative flex max-w-[50%] shrink-0 flex-col border-r border-[var(--line)] bg-[var(--panel)]"
    >
      <Splitter
        label="Resize the Explorer"
        orientation="vertical"
        grows="forward"
        value={width}
        bounds={EXPLORER_WIDTH}
        onResize={setWidth}
        className="right-[-4px]"
      />
      <div className="flex items-center px-[10px] pb-[8px] pt-[10px]">
        <SideViewSwitch />
      </div>
      {/* One body per side view. */}
      {view === 'explorer' && (
        <ExplorerFiles projectId={projectId} live={live} followed={followed} />
      )}
      {view === 'search' && <SearchView projectId={projectId} />}
      {view === 'changes' && <ChangesView projectId={projectId} workflowId={workflowId} />}
    </nav>
  );
}

/**
 * The Explorer's own body: the file count and New File / New Folder (D299, created where the
 * selection is, as in VS Code), the tree, and the filter at the bottom. The file watcher keeps it
 * fresh, so it has no refresh or collapse.
 */
function ExplorerFiles({
  projectId,
  live,
  followed,
}: {
  projectId: string;
  live: ReadonlyMap<string, AgentLook> | undefined;
  followed: FollowedFiles | undefined;
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
    <>
      <div className="flex items-center gap-[8px] px-[14px] pb-[8px]">
        {count !== '' && (
          <span
            data-testid="explorer-count"
            className="whitespace-nowrap text-[10.5px] text-[var(--muted)]"
          >
            {count}
          </span>
        )}
        <div className="flex-1" />
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
        followed={followed}
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
          className="h-[30px] w-full rounded-[8px] border border-[var(--line)] bg-[var(--surface)] px-[10px] text-[12px] [font-family:inherit] text-[var(--ink)] outline-none focus:border-[var(--focus)]"
        />
      </div>
    </>
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
      className="flex h-[20px] shrink-0 cursor-pointer items-center gap-[3px] rounded-[5px] border-none bg-transparent px-[5px] text-[12px] leading-none text-[var(--muted)] outline-none hover:bg-[var(--hover)] hover:text-[var(--ink)] focus-visible:shadow-[inset_0_0_0_2px_var(--focus)]"
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
