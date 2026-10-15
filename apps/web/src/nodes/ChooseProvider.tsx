import type { Node, WorkflowGraphResponse } from '@ace/contracts';
import { Icons } from '@ace/ui';
import { QueryClientContext } from '@tanstack/react-query';
import { useContext, type SyntheticEvent } from 'react';

import { requestProviderChoice } from '../providers/provider-picker-store';
import { queryKeys } from '../workflows/query-keys';
import { getGraphSync } from '../workflows/sync-registry';

/**
 * Whether a stage card is in PG-1.3's red "Choose a provider" state (D351): an Agent/Model with no
 * provider, or one naming a provider the engine no longer has (a paste or an import from another
 * machine). Pre-flight blocks on both — `missing_provider` and `provider_missing` (D358).
 */
export function needsProvider(node: Node, providerMissing: boolean | undefined): boolean {
  if (node.kind !== 'agent' && node.kind !== 'model') return false;
  const { providerId } = node.config;
  return providerId === undefined || providerId === '' || providerMissing === true;
}

const stop = (event: SyntheticEvent) => event.stopPropagation();

/**
 * The card's "Choose a provider" button: opens the provider-first picker and, once a provider and
 * a model are chosen, puts the node on them as one `update_node` (the whole config, read from the
 * cache at that moment, as the settings modal patches it).
 */
export function ChooseProviderButton({ node }: { node: Node }) {
  // Read, not required: a card drawn outside the app (a test, a preview) has no client to write to.
  const queryClient = useContext(QueryClientContext);
  const choose = () => {
    if (queryClient === undefined) return;
    requestProviderChoice({
      title: `Choose a provider for “${node.name || 'Untitled'}”`,
      confirmLabel: 'Use this model',
      onChosen: ({ providerId, modelId }) => {
        const latest =
          queryClient
            .getQueryData<WorkflowGraphResponse>(queryKeys.workflow(node.workflowId))
            ?.nodes.find((each) => each.id === node.id) ?? node;
        const config = { ...latest.config, providerId, modelId } as Node['config'];
        getGraphSync(node.workflowId, queryClient).enqueue([
          { op: 'update_node', nodeId: node.id, patch: { config } },
        ]);
      },
    });
  };
  return (
    <button
      type="button"
      data-testid={`choose-provider-${node.id}`}
      aria-label={`Choose a provider for ${node.name || 'Untitled'}`}
      className="nodrag nopan mx-auto mt-[6px] inline-flex h-[24px] cursor-pointer items-center gap-[5px] rounded-full border border-[#c94c27] bg-[rgba(201,76,39,0.1)] px-[10px] text-[10.5px] font-semibold text-[#b03f1d] outline-none hover:bg-[rgba(201,76,39,0.18)] focus-visible:shadow-[0_0_0_2px_#ef6b3f]"
      onPointerDown={stop}
      onMouseDown={stop}
      onClick={(event) => {
        event.stopPropagation();
        choose();
      }}
    >
      <Icons.TriangleAlert aria-hidden size={12} />
      Choose a provider
    </button>
  );
}
