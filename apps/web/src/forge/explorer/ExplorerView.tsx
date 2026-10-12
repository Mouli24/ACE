import { useState } from 'react';

import { useProject } from '../../projects/hooks';
import type { AgentLook } from '../../theme/agents';
import { openFile } from '../editor/actions';
import { useFileList } from '../files/hooks';
import { FileTree } from './FileTree';

/** "{n} files" from the project's file list; `n+` when the engine cut the list short. */
function fileCount(list: { files: readonly string[]; truncated: boolean } | undefined): string {
  if (list === undefined) return '';
  return `${list.files.length}${list.truncated ? '+' : ''} files`;
}

/**
 * The theme's Explorer (D334): a fixed 248px column — "EXPLORER" and the file count, the tree, and
 * the filter at the bottom. The file watcher keeps it fresh, so it has no refresh or collapse.
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
