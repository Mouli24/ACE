import { create } from 'zustand';

import type { CanvasNodeKind, NewNodeInit } from '../nodes/factory';

export interface CanvasApi {
  addNode: (kind: CanvasNodeKind, init?: NewNodeInit) => unknown;
  deleteNodes: (nodeIds: string[]) => void;
  /**
   * D333: the node settings modal's "Remove node from canvas" — deletes the node and reconnects
   * every incoming edge to every outgoing one the types allow, as one undo step.
   */
  removeNodeReconnecting?: (nodeId: string) => void;
  fitView: () => void;
  duplicateSelection: () => void;
  /** FR-CAN-008: left-to-right layout, one undo step. */
  autoArrange?: () => void;
  /** FR-CAN-009: one step back / forward through this workflow's history. */
  undo?: () => void;
  redo?: () => void;
  /** FR-MOB-003: the Canvas is mounted read-only; editing actions above are no-ops. */
  readOnly?: boolean;
}

interface CanvasApiState {
  api: CanvasApi | undefined;
  register(api: CanvasApi): () => void;
}

/**
 * The Canvas publishes a few actions here so the node settings modal and the workspace menu can
 * call them without a shared React parent holding React Flow state.
 */
export const useCanvasApi = create<CanvasApiState>((set) => ({
  api: undefined,
  register: (api) => {
    set({ api });
    return () => set((s) => (s.api === api ? { api: undefined } : {}));
  },
}));
