import { usePanelsStore } from './panels';
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

describe('panels store (Arch §33.1 step 5 layout)', () => {
  it('defaults to the Validation tab with every pane visible', () => {
    const s = usePanelsStore.getState();
    expect(s.bottomTab).toBe('validation');
    expect(s.paletteOpen).toBe(true);
    expect(s.configOpen).toBe(true);
    expect(s.bottomOpen).toBe(true);
  });

  it('switches tabs and toggles panes', () => {
    usePanelsStore.getState().setBottomTab('events');
    usePanelsStore.getState().toggle('configOpen');
    expect(usePanelsStore.getState().bottomTab).toBe('events');
    expect(usePanelsStore.getState().configOpen).toBe(false);
    usePanelsStore.getState().toggle('configOpen');
    usePanelsStore.getState().setBottomTab('validation');
  });
});

describe('viewport store (FR-CAN-007, per workflow)', () => {
  it('remembers a viewport per workflow id', () => {
    useViewportStore.getState().setViewport('wf1', { x: 10, y: 20, zoom: 1.5 });
    expect(useViewportStore.getState().viewports['wf1']).toEqual({ x: 10, y: 20, zoom: 1.5 });
    expect(useViewportStore.getState().viewports['wf2']).toBeUndefined();
  });
});
