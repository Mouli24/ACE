import { create } from 'zustand';

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

interface ViewportState {
  viewports: Record<string, Viewport>;
  setViewport(workflowId: string, viewport: Viewport): void;
}

/** Last pan/zoom per workflow so switching tabs restores the view (FR-CAN-007, FR-WF-002). */
export const useViewportStore = create<ViewportState>((set) => ({
  viewports: {},
  setViewport: (workflowId, viewport) =>
    set((s) => ({ viewports: { ...s.viewports, [workflowId]: viewport } })),
}));
