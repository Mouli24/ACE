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

  it('D301 a stored view this build does not have (Phase 1’s Output) opens as Problems', async () => {
    localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({ state: { panelOpen: true, panelTab: 'output' }, version: 0 }),
    );
    await useLayoutStore.persist.rehydrate();
    expect(useLayoutStore.getState()).toMatchObject({ panelOpen: true, panelTab: 'problems' });
    localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({ state: { panelOpen: true, panelTab: 'terminal' }, version: 0 }),
    );
    await useLayoutStore.persist.rehydrate();
    expect(useLayoutStore.getState().panelTab).toBe('terminal');
  });
});
