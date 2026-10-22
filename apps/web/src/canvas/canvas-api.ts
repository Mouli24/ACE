import { create } from 'zustand';

import { useSelectionStore } from '../app/stores/selection';
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
  /**
   * [audit W-10] Select a node and centre the view on it (PG-3.4); `false` while the Canvas cannot
   * yet (the node not measured).
   */
  focusNode?: (nodeId: string) => boolean;
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

/**
 * [audit W-10] "show node": select it and bring it into view on the Canvas. Selecting alone left a
 * node off-screen still off-screen; with no Canvas mounted (or not measured yet) it is selected.
 */
export function showNode(nodeId: string): void {
  if (useCanvasApi.getState().api?.focusNode?.(nodeId) === true) return;
  useSelectionStore.getState().setSelection([nodeId], []);
}
