import { useSelectionStore } from '../app/stores/selection';
import { showNode, useCanvasApi, type CanvasApi } from './canvas-api';

afterEach(() => {
  useCanvasApi.setState({ api: undefined });
  useSelectionStore.getState().clear();
});

const api = (focusNode: CanvasApi['focusNode']): CanvasApi => ({
  addNode: vi.fn(),
  deleteNodes: vi.fn(),
  fitView: vi.fn(),
  duplicateSelection: vi.fn(),
  ...(focusNode === undefined ? {} : { focusNode }),
});

describe('[audit W-10] "show node" brings the node into view', () => {
  it('asks the Canvas to select and centre it', () => {
    const focusNode = vi.fn(() => true);
    useCanvasApi.getState().register(api(focusNode));
    showNode('n1');
    expect(focusNode).toHaveBeenCalledWith('n1');
  });

  it('selects it when the Canvas cannot centre it yet, or there is no Canvas', () => {
    useCanvasApi.getState().register(api(() => false));
    showNode('n1');
    expect(useSelectionStore.getState().nodeIds).toEqual(['n1']);

    useCanvasApi.setState({ api: undefined });
    showNode('n2');
    expect(useSelectionStore.getState().nodeIds).toEqual(['n2']);
  });
});
