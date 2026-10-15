import { createContext } from 'react';

import type { PortConnectState } from '../canvas/interactions/ports';

/**
 * PG-1.1 (D350): while a line is being drawn, how each port shows — the start, compatible, or
 * incompatible with its reason — keyed by port id. Undefined while nothing is being drawn. The
 * Canvas provides it; it changes only when a drag starts or ends, so a pointer move never
 * re-renders a card.
 */
export const PortConnectContext = createContext<ReadonlyMap<string, PortConnectState> | undefined>(
  undefined,
);

/**
 * PG-1.2 (D360): what a card's always-visible Settings and More buttons do. The Canvas provides
 * it; a card rendered outside a Canvas (its component tests, a preview) has none and draws no
 * buttons.
 */
export interface NodeCardActions {
  readOnly: boolean;
  openSettings: (nodeId: string) => void;
  connectTo: (nodeId: string) => void;
  duplicate: (nodeId: string) => void;
  remove: (nodeId: string) => void;
  runFromHere: (nodeId: string) => void;
  /** Agent and Model nodes have a lens in Domain (D303); undefined outside a routed workspace. */
  openInDomain?: (nodeId: string) => void;
}

export const NodeActionsContext = createContext<NodeCardActions | undefined>(undefined);
