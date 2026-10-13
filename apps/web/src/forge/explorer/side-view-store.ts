import { create } from 'zustand';

/**
 * The views Forge's left column switches between, in its header (D299 Phase 4, design §6.4; D339):
 * the Explorer, Search and Changes (D300's checkpoints), as in VS Code's side bar but without an
 * activity bar — one member here, one row in {@link SIDE_VIEWS}, one body in `ExplorerView`.
 */
export type SideView = 'explorer' | 'search' | 'changes';

/** The switch's segments, in order, with the label each shows. */
export const SIDE_VIEWS: ReadonlyArray<{ view: SideView; label: string }> = [
  { view: 'explorer', label: 'EXPLORER' },
  { view: 'search', label: 'SEARCH' },
  { view: 'changes', label: 'CHANGES' },
];

interface SideViewState {
  view: SideView;
  /** Bumped to ask Search to focus (and select) its query box. */
  searchFocus: number;
  show(view: SideView): void;
  /** Ctrl/⌘+Shift+F: Search, with the focus in its query. */
  focusSearch(): void;
}

export const useSideViewStore = create<SideViewState>()((set) => ({
  view: 'explorer',
  searchFocus: 0,
  show: (view) => set({ view }),
  focusSearch: () => set((state) => ({ view: 'search', searchFocus: state.searchFocus + 1 })),
}));
