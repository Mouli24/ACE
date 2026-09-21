import type { NodeKind, NodeState, Port, ProviderType } from '@ace/contracts';

/** What a node card on the Canvas renders (FR-NODE-005/006/010). Pure data, no React Flow types. */
export interface NodeCardProps {
  id: string;
  kind: NodeKind;
  name: string;
  /** Status ring colour is chosen from this, separately from the provider accent (FR-NODE-010). */
  state: NodeState;
  /** Provider accent border; `undefined` renders the neutral border. Constant across states. */
  provider: ProviderType | undefined;
  /** Model chip text; "no model" until a model is chosen (FR-NODE-005). */
  modelLabel: string;
  inputs: Port[];
  outputs: Port[];
  selected: boolean;
}

/** One typed port handle on a node card (FR-NODE-006). */
export interface PortHandleProps {
  port: Port;
  direction: 'in' | 'out';
  /** Whether at least one edge touches this port; drives the filled/hollow handle style. */
  connected: boolean;
}
