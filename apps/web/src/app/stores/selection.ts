import { create } from 'zustand';

/** Which nodes and edges are selected on the Canvas (FR-CAN-003); the engine never sees this. */
interface SelectionState {
  nodeIds: string[];
  edgeIds: string[];
  /** The one node whose config panel is open: set only when exactly one node is selected. */
  focusedNodeId: string | undefined;
  setSelection(nodeIds: string[], edgeIds: string[]): void;
  clear(): void;
}

const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);

export const useSelectionStore = create<SelectionState>((set, get) => ({
  nodeIds: [],
  edgeIds: [],
  focusedNodeId: undefined,
  setSelection: (nodeIds, edgeIds) => {
    const current = get();
    // identical selection = no update, so the Canvas ↔ store sync never ping-pongs
    if (same(current.nodeIds, nodeIds) && same(current.edgeIds, edgeIds)) return;
    set({ nodeIds, edgeIds, focusedNodeId: nodeIds.length === 1 ? nodeIds[0] : undefined });
  },
  clear: () => set({ nodeIds: [], edgeIds: [], focusedNodeId: undefined }),
}));
