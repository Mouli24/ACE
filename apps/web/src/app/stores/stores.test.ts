import { useSelectionStore } from './selection';
import { useViewportStore } from './viewport';

describe('selection store (FR-CAN-003, FR-NODE-002)', () => {
  beforeEach(() => useSelectionStore.getState().clear());

  it('tracks selected node and edge ids and exposes the single focused node', () => {
    useSelectionStore.getState().setSelection(['a', 'b'], []);
    expect(useSelectionStore.getState().nodeIds).toEqual(['a', 'b']);
    expect(useSelectionStore.getState().focusedNodeId).toBeUndefined();
    useSelectionStore.getState().setSelection(['a'], ['e']);
    expect(useSelectionStore.getState().focusedNodeId).toBe('a');
    expect(useSelectionStore.getState().edgeIds).toEqual(['e']);
  });

  it('clear empties everything', () => {
    useSelectionStore.getState().setSelection(['a'], ['e']);
    useSelectionStore.getState().clear();
    expect(useSelectionStore.getState().nodeIds).toEqual([]);
    expect(useSelectionStore.getState().edgeIds).toEqual([]);
  });
});

describe('viewport store (FR-CAN-007, per workflow)', () => {
  it('remembers a viewport per workflow id', () => {
    useViewportStore.getState().setViewport('wf1', { x: 10, y: 20, zoom: 1.5 });
    expect(useViewportStore.getState().viewports['wf1']).toEqual({ x: 10, y: 20, zoom: 1.5 });
    expect(useViewportStore.getState().viewports['wf2']).toBeUndefined();
  });
});
