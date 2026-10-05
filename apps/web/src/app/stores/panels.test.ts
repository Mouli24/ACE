import { usePanelsStore } from './panels';

const reset = () => usePanelsStore.setState(usePanelsStore.getInitialState());

describe('panels store', () => {
  beforeEach(reset);

  it('opens the sheet on a tab and keeps the tab when reopened', () => {
    usePanelsStore.getState().openSheet('inspect');
    expect(usePanelsStore.getState()).toMatchObject({ sheetOpen: true, sheetTab: 'inspect' });
    usePanelsStore.getState().closeSheet();
    usePanelsStore.getState().openSheet();
    expect(usePanelsStore.getState()).toMatchObject({ sheetOpen: true, sheetTab: 'inspect' });
  });

  it('choosing a bottom tab opens a collapsed bottom panel', () => {
    usePanelsStore.getState().toggleBottom();
    usePanelsStore.getState().setBottomTab('errors');
    expect(usePanelsStore.getState()).toMatchObject({ bottomOpen: true, bottomTab: 'errors' });
  });

  it('sets and clears the chat target', () => {
    usePanelsStore.getState().chatWith('n1');
    expect(usePanelsStore.getState().chatNodeId).toBe('n1');
    usePanelsStore.getState().chatWith(undefined);
    expect(usePanelsStore.getState().chatNodeId).toBeUndefined();
  });
});
