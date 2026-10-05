import { create } from 'zustand';

export type BottomTab = 'validation' | 'events' | 'errors' | 'timeline';
export type SheetTab = 'configure' | 'inspect' | 'runs' | 'memory';

interface PanelsState {
  bottomTab: BottomTab;
  bottomOpen: boolean;
  sheetOpen: boolean;
  sheetTab: SheetTab;
  newNodeOpen: boolean;
  /** The node the Chat column talks to (FR-CHAT-004); undefined = intro state. */
  chatNodeId: string | undefined;
  /** Also opens a collapsed bottom panel. */
  setBottomTab(tab: BottomTab): void;
  toggleBottom(): void;
  /** Tab omitted = keep the current tab. */
  openSheet(tab?: SheetTab): void;
  closeSheet(): void;
  setSheetTab(tab: SheetTab): void;
  openNewNode(): void;
  closeNewNode(): void;
  chatWith(nodeId: string | undefined): void;
}

/** Sheet, bottom panel, New node dialog and chat target (Arch §10.1: Zustand for panels). */
export const usePanelsStore = create<PanelsState>()((set) => ({
  bottomTab: 'validation',
  bottomOpen: true,
  sheetOpen: false,
  sheetTab: 'configure',
  newNodeOpen: false,
  chatNodeId: undefined,
  setBottomTab: (bottomTab) => set({ bottomTab, bottomOpen: true }),
  toggleBottom: () => set((s) => ({ bottomOpen: !s.bottomOpen })),
  openSheet: (tab) => set((s) => ({ sheetOpen: true, sheetTab: tab ?? s.sheetTab })),
  closeSheet: () => set({ sheetOpen: false }),
  setSheetTab: (sheetTab) => set({ sheetTab }),
  openNewNode: () => set({ newNodeOpen: true }),
  closeNewNode: () => set({ newNodeOpen: false }),
  chatWith: (chatNodeId) => set({ chatNodeId }),
}));
