import { create } from 'zustand';

/**
 * What the workspace footer shows that only a page knows (D330): the open conversation's message
 * count. The chat aside publishes for Ideate and Forge, the Domain page for Domain; each clears its
 * entry on unmount, so the footer never shows a stale number. The token totals are no longer
 * published here: the footer reads the selected run's own in every mode (PG-3.3).
 */
export interface WorkspaceTokens {
  in: number;
  out: number;
}

interface WorkspaceStatusState {
  messageCount: number | null;
  setMessageCount: (count: number | null) => void;
}

export const useWorkspaceStatus = create<WorkspaceStatusState>((set) => ({
  messageCount: null,
  setMessageCount: (messageCount) => set({ messageCount }),
}));
