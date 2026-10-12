import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

/**
 * Forge's bottom panel views (D334 as amended 2026-10-13): the Terminal (D301) and Problems. The
 * Output view stays removed. On first open the panel shows Problems; after that Ctrl+J toggles it
 * on the view used last (remembered, as VS Code does), and Ctrl+` on the Terminal.
 */
export type ForgePanelTab = 'terminal' | 'problems';

const PANEL_TABS: readonly ForgePanelTab[] = ['terminal', 'problems'];

interface LayoutState {
  /** The chat column in Ideate and Forge, and Domain's Team aside: the header's Split (D330). */
  chatOpen: boolean;
  /** Forge's Explorer (Ctrl/⌘+B hides it). */
  sidebarOpen: boolean;
  /** Forge's bottom panel: the person's choice, closed until first opened (Ctrl/⌘+J, D299). */
  panelOpen: boolean;
  panelTab: ForgePanelTab;
  panelMaximized: boolean;
  toggleChat(): void;
  toggleSidebar(): void;
  togglePanel(): void;
  showPanel(tab: ForgePanelTab): void;
  closePanel(): void;
  toggleMaximized(): void;
}

export const LAYOUT_STORAGE_KEY = 'ace.layout';

const memory = new Map<string, string>();
const memoryStorage: StateStorage = {
  getItem: (name) => memory.get(name) ?? null,
  setItem: (name, value) => void memory.set(name, value),
  removeItem: (name) => void memory.delete(name),
};

/** localStorage when the browser allows it; private mode and blocked storage fall back to memory. */
function storage(): StateStorage {
  try {
    const probe = '__ace_probe__';
    localStorage.setItem(probe, probe);
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return memoryStorage;
  }
}

/** Which panels are open, remembered in the browser (D299, D330). */
export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      chatOpen: true,
      sidebarOpen: true,
      panelOpen: false,
      panelTab: 'problems',
      panelMaximized: false,
      toggleChat: () => set((s) => ({ chatOpen: !s.chatOpen })),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      togglePanel: () =>
        set((s) => ({
          panelOpen: !s.panelOpen,
          panelMaximized: s.panelOpen ? false : s.panelMaximized,
        })),
      showPanel: (panelTab) => set({ panelTab, panelOpen: true }),
      closePanel: () => set({ panelOpen: false, panelMaximized: false }),
      toggleMaximized: () => set((s) => ({ panelMaximized: !s.panelMaximized, panelOpen: true })),
    }),
    {
      name: LAYOUT_STORAGE_KEY,
      storage: createJSONStorage(storage),
      partialize: (s) => ({
        chatOpen: s.chatOpen,
        sidebarOpen: s.sidebarOpen,
        panelOpen: s.panelOpen,
        panelTab: s.panelTab,
      }),
      // A view this build does not have — Phase 1's 'output' — would open a blank panel with no
      // tab selected; it reads as Problems instead.
      merge: (stored, current) => {
        const saved = (stored ?? {}) as Partial<LayoutState>;
        const panelTab = PANEL_TABS.includes(saved.panelTab as ForgePanelTab)
          ? (saved.panelTab as ForgePanelTab)
          : 'problems';
        return { ...current, ...saved, panelTab };
      },
    },
  ),
);
