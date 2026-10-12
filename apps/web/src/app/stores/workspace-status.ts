import { create } from 'zustand';

/**
 * What the workspace footer shows that only a page knows (D330): the open conversation's message
 * count and the token totals in view. The chat aside publishes for Ideate and Forge, the Domain
 * page for Domain; each clears its entry on unmount, so the footer never shows a stale number.
 */
export interface WorkspaceTokens {
  in: number;
  out: number;
}

interface WorkspaceStatusState {
  messageCount: number | null;
  tokens: WorkspaceTokens | null;
  setMessageCount: (count: number | null) => void;
  setTokens: (tokens: WorkspaceTokens | null) => void;
}

export const useWorkspaceStatus = create<WorkspaceStatusState>((set) => ({
  messageCount: null,
  tokens: null,
  setMessageCount: (messageCount) => set({ messageCount }),
  setTokens: (tokens) => set({ tokens }),
}));
