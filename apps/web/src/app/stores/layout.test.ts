import { beforeEach, describe, expect, it } from 'vitest';

import { LAYOUT_STORAGE_KEY, useLayoutStore } from './layout';

const initial = useLayoutStore.getState();
beforeEach(() => {
  localStorage.clear();
  useLayoutStore.setState(initial, true);
});

describe('D299 the workbench layout is the person’s choice, and is remembered', () => {
  it('starts with the chat and the side bar open and the bottom panel closed', () => {
    expect(useLayoutStore.getState()).toMatchObject({
      chatOpen: true,
      sidebarOpen: true,
      panelOpen: false,
    });
  });

  it('remembers each choice in the browser', () => {
    useLayoutStore.getState().togglePanel();
    useLayoutStore.getState().toggleChat();
    const saved = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) ?? '{}') as {
      state: Record<string, unknown>;
    };
    expect(saved.state).toMatchObject({ panelOpen: true, chatOpen: false });
  });

  it('clicking the active view hides the side bar, as in VS Code', () => {
    useLayoutStore.getState().showView('explorer');
    expect(useLayoutStore.getState().sidebarOpen).toBe(false);
    useLayoutStore.getState().showView('explorer');
    expect(useLayoutStore.getState().sidebarOpen).toBe(true);
  });

  it('closing the panel also leaves maximized', () => {
    useLayoutStore.getState().toggleMaximized();
    useLayoutStore.getState().closePanel();
    expect(useLayoutStore.getState()).toMatchObject({ panelOpen: false, panelMaximized: false });
  });
});
