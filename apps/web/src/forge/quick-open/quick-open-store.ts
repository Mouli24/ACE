import { create } from 'zustand';

/** Whether quick open is showing — a store, so the empty editor's button and Ctrl/⌘+P share it. */
export const useQuickOpen = create<{ open: boolean; show(): void; hide(): void }>()((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));
