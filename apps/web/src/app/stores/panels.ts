import { create } from 'zustand';

export type BottomTab = 'validation' | 'events' | 'errors' | 'timeline';

type Pane = 'paletteOpen' | 'configOpen' | 'bottomOpen';

interface PanelsState {
  bottomTab: BottomTab;
  paletteOpen: boolean;
  configOpen: boolean;
  bottomOpen: boolean;
  setBottomTab(tab: BottomTab): void;
  toggle(pane: Pane): void;
}

/** Pane visibility and the bottom tab (Arch §10.1: Zustand for panels). */
export const usePanelsStore = create<PanelsState>((set) => ({
  bottomTab: 'validation',
  paletteOpen: true,
  configOpen: true,
  bottomOpen: true,
  setBottomTab: (bottomTab) => set({ bottomTab }),
  toggle: (pane) => set((s) => ({ [pane]: !s[pane] })),
}));
