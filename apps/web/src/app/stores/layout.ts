import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

interface LayoutState {
  /** The chat column in Ideate and Forge, and Domain's Team aside: the header's Split (D330). */
  chatOpen: boolean;
  /** Forge's Explorer (Ctrl/⌘+B hides it). */
  sidebarOpen: boolean;
  toggleChat(): void;
  toggleSidebar(): void;
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
      toggleChat: () => set((s) => ({ chatOpen: !s.chatOpen })),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
    }),
    {
      name: LAYOUT_STORAGE_KEY,
      storage: createJSONStorage(storage),
      partialize: (s) => ({ chatOpen: s.chatOpen, sidebarOpen: s.sidebarOpen }),
    },
  ),
);
