import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

export type ForgeView = 'explorer';
export type ForgePanelTab = 'problems' | 'output';

interface LayoutState {
  /** The chat column, in Ideate and in Forge (D299). */
  chatOpen: boolean;
  sidebarOpen: boolean;
  sidebarView: ForgeView;
  /** Forge's bottom panel: the person's choice, closed until first opened. */
  panelOpen: boolean;
  panelTab: ForgePanelTab;
  panelMaximized: boolean;
  toggleChat(): void;
  toggleSidebar(): void;
  /** Activity bar: the active view's icon hides the side bar, another one shows that view. */
  showView(view: ForgeView): void;
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

/** Which panels are open and on which view, remembered in the browser (D299, design §2.2). */
export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      chatOpen: true,
      sidebarOpen: true,
      sidebarView: 'explorer',
      panelOpen: false,
      panelTab: 'problems',
      panelMaximized: false,
      toggleChat: () => set((s) => ({ chatOpen: !s.chatOpen })),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      showView: (view) =>
        set((s) => ({
          sidebarView: view,
          sidebarOpen: s.sidebarView === view ? !s.sidebarOpen : true,
        })),
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
        sidebarView: s.sidebarView,
        panelOpen: s.panelOpen,
        panelTab: s.panelTab,
      }),
    },
  ),
);
