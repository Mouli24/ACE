import { Icons } from '@ace/ui';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useFollowNode } from '../app/follow-node';
import { useSelectionStore } from '../app/stores/selection';
import { agentMap, type AgentLook } from '../theme/agents';
import { plural } from '../domain/looks';
import { useWorkflowGraph } from '../workflows/hooks';
import { filesWrittenBy, useNodeModel, type ForgeAttribution } from './attribution';
import type { FollowedFiles } from './explorer/FileTree';

/**
 * PG-3.4: the node in focus (`?node=`, the shared selection) as Forge has it — its agent look and
 * the files it wrote last in the run — or none when no agent of this workflow is in focus.
 */
export function useFollowedFiles(
  workflowId: string | undefined,
  attribution: ForgeAttribution,
): FollowedFiles | undefined {
  const focused = useSelectionStore((s) => s.focusedNodeId);
  const nodes = useWorkflowGraph(workflowId).data?.nodes;
  return useMemo(() => {
    if (focused === undefined || nodes === undefined) return undefined;
    const agent = agentMap(nodes).get(focused);
    return agent === undefined ? undefined : { agent, paths: filesWrittenBy(attribution, focused) };
  }, [focused, nodes, attribution]);
}

const CHIP =
  'flex h-[22px] shrink-0 cursor-pointer items-center gap-[5px] rounded-full border border-[var(--line)] bg-transparent px-[8px] text-[11px] font-semibold text-[var(--ink)] outline-none hover:bg-[var(--hover)] focus-visible:shadow-[0_0_0_2px_var(--focus)]';

/**
 * PG-3.4: a slim bar over the editor while a node is followed into Forge — who it is, the model it
 * ran on, how many files it wrote (marked in the Explorer), and the way back to it on the canvas
 * or in Domain. × stops following it.
 */
export function FollowedNodeBar({
  workflowId,
  followed,
}: {
  workflowId: string;
  followed: FollowedFiles;
}) {
  const { agent, paths } = followed;
  const model = useNodeModel(workflowId, agent.nodeId);
  const follow = useFollowNode({ workflowId });
  const [, setSearch] = useSearchParams();
  const stop = (): void => {
    useSelectionStore.getState().clear();
    setSearch(
      (current) => {
        const query = new URLSearchParams(current);
        query.delete('node');
        return query;
      },
      { replace: true },
    );
  };
  return (
    <div
      data-testid="forge-followed-node"
      className="flex h-[32px] shrink-0 items-center gap-[8px] overflow-hidden border-b border-[var(--line)] bg-[var(--soft)] px-[14px] font-human text-[11.5px] text-[var(--muted)]"
    >
      <AgentDot agent={agent} />
      <span className="min-w-0 truncate">
        <span className="font-semibold text-[var(--ink)]">{agent.name}</span>
        {model !== undefined && (
          <>
            {' · '}
            <span className="font-machine text-[10.5px]">{model}</span>
          </>
        )}
        {' · '}
        {paths.size === 0 ? 'wrote no files in this run' : `wrote ${plural(paths.size, 'file')}`}
      </span>
      <div className="flex-1" />
      <button type="button" className={CHIP} onClick={() => follow(agent.nodeId, 'ideate')}>
        <Icons.LocateFixed aria-hidden size={12} />
        Show on canvas
      </button>
      <button type="button" className={CHIP} onClick={() => follow(agent.nodeId, 'domain')}>
        Open in Domain
      </button>
      <button
        type="button"
        aria-label="Stop following"
        title="Stop following"
        onClick={stop}
        className="flex h-[22px] w-[22px] shrink-0 cursor-pointer items-center justify-center rounded-[6px] border-none bg-transparent text-[var(--muted)] outline-none hover:bg-[var(--hover)] hover:text-[var(--ink)] focus-visible:shadow-[0_0_0_2px_var(--focus)]"
      >
        <Icons.X aria-hidden size={12} />
      </button>
    </div>
  );
}

function AgentDot({ agent }: { agent: AgentLook }) {
  return (
    <span
      aria-hidden
      className="flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-full text-[8px] font-bold text-[#fff]"
      style={{ background: agent.color }}
    >
      {agent.letter}
    </span>
  );
}
