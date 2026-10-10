import { useQueryClient } from '@tanstack/react-query';
import { ChevronsDownUp, FilePlus, FolderPlus, RefreshCw } from 'lucide-react';

import { useProject } from '../../projects/hooks';
import { openFile } from '../editor/actions';
import { fileKeys } from '../files/keys';
import { parentOf } from '../files/paths';
import { IconAction } from '../layout/IconAction';
import { useExplorerStore, useProjectExplorer } from './explorer-store';
import { FileTree } from './FileTree';
import { OpenEditors } from './OpenEditors';
import { useTreeRows } from './useTreeRows';

/** The Explorer view (design §6.4). Open editors sit above; New File and New Folder create where the selection is. */
export function ExplorerView({ projectId }: { projectId: string }) {
  const project = useProject(projectId);
  const queryClient = useQueryClient();
  const collapseAll = useExplorerStore((s) => s.collapseAll);
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
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-9 shrink-0 items-center px-3 font-machine text-[10.5px] uppercase tracking-[0.12em] text-fg-muted">
        Explorer
      </header>
      <OpenEditors projectId={projectId} />
      <section aria-label={name} className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-7 shrink-0 items-center gap-0.5 px-2">
          <h3 className="min-w-0 flex-1 truncate font-machine text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-soft">
            {name}
          </h3>
          <IconAction
            label="New File"
            Icon={FilePlus}
            onClick={() => startCreate(projectId, folderOfSelection(), 'file')}
          />
          <IconAction
            label="New Folder"
            Icon={FolderPlus}
            onClick={() => startCreate(projectId, folderOfSelection(), 'folder')}
          />
          <IconAction
            label="Refresh Explorer"
            Icon={RefreshCw}
            onClick={() =>
              void queryClient.invalidateQueries({ queryKey: fileKeys.all(projectId) })
            }
          />
          <IconAction
            label="Collapse folders"
            Icon={ChevronsDownUp}
            onClick={() => collapseAll(projectId)}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <FileTree
            projectId={projectId}
            label={`Files of ${name}`}
            onOpen={(path, options) => openFile(projectId, path, options)}
          />
        </div>
      </section>
    </div>
  );
}
