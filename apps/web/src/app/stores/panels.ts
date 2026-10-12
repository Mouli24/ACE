import { create } from 'zustand';

export type BottomTab = 'validation' | 'events' | 'errors' | 'timeline';
export type SheetTab = 'inspect' | 'runs' | 'memory';
/** What the node settings modal edits (D333): a node, or a loop edge. */
export type SettingsTarget = { kind: 'node'; id: string } | { kind: 'edge'; id: string };

interface PanelsState {
  bottomTab: BottomTab;
  bottomOpen: boolean;
  sheetOpen: boolean;
  sheetTab: SheetTab;
  /** The node the Chat column talks to (FR-CHAT-004); undefined = intro state. */
  chatNodeId: string | undefined;
  /** The node settings modal's target; undefined = closed. */
  settings: SettingsTarget | undefined;
  /** Also opens a collapsed bottom panel. */
  setBottomTab(tab: BottomTab): void;
  toggleBottom(): void;
  /** Tab omitted = keep the current tab. */
  openSheet(tab?: SheetTab): void;
  closeSheet(): void;
  setSheetTab(tab: SheetTab): void;
  chatWith(nodeId: string | undefined): void;
  openSettings(target: SettingsTarget): void;
  closeSettings(): void;
}

/**
 * Sheet, bottom panel, New node dialog, chat target and the node settings modal (Arch §10.1:
 * Zustand for panels). The bottom panel starts hidden; the workspace menu opens it (D332).
 */
export const usePanelsStore = create<PanelsState>()((set) => ({
  bottomTab: 'validation',
  bottomOpen: false,
  sheetOpen: false,
  sheetTab: 'inspect',
  chatNodeId: undefined,
  settings: undefined,
  setBottomTab: (bottomTab) => set({ bottomTab, bottomOpen: true }),
  toggleBottom: () => set((s) => ({ bottomOpen: !s.bottomOpen })),
  openSheet: (tab) => set((s) => ({ sheetOpen: true, sheetTab: tab ?? s.sheetTab })),
  closeSheet: () => set({ sheetOpen: false }),
  setSheetTab: (sheetTab) => set({ sheetTab }),
  chatWith: (chatNodeId) => set({ chatNodeId }),
  openSettings: (settings) => set({ settings }),
  closeSettings: () => set({ settings: undefined }),
}));
