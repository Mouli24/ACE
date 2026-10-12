import { beforeEach, describe, expect, it } from 'vitest';

import { LAYOUT_STORAGE_KEY, useLayoutStore } from './layout';

const initial = useLayoutStore.getState();
beforeEach(() => {
  localStorage.clear();
  useLayoutStore.setState(initial, true);
});

describe('D299 D330 the workspace layout is the person’s choice, and is remembered', () => {
  it('starts with the chat (Split) and the Explorer open and Forge’s bottom panel closed', () => {
    expect(useLayoutStore.getState()).toMatchObject({
      chatOpen: true,
      sidebarOpen: true,
      panelOpen: false,
    });
  });

  it('remembers each choice in the browser', () => {
    useLayoutStore.getState().toggleChat();
    useLayoutStore.getState().toggleSidebar();
    useLayoutStore.getState().togglePanel();
    const saved = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) ?? '{}') as {
      state: Record<string, unknown>;
    };
    expect(saved.state).toEqual({
      chatOpen: false,
      sidebarOpen: false,
      panelOpen: true,
      panelTab: 'problems',
    });
  });

  it('closing the panel also leaves maximized', () => {
    useLayoutStore.getState().toggleMaximized();
    useLayoutStore.getState().closePanel();
    expect(useLayoutStore.getState()).toMatchObject({ panelOpen: false, panelMaximized: false });
  });
});
