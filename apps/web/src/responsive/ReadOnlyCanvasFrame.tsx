import type { ReactNode } from 'react';

/**
 * The banner over the phone Canvas (FR-MOB-003): building a workflow is not done on a phone, so the
 * Canvas is there to look at — pan and zoom, tap a node to inspect it — and says so. A muted line on
 * the theme's panel colour (D328).
 */
export function ReadOnlyBanner() {
  return (
    <p
      role="note"
      data-testid="readonly-banner"
      className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-[11.5px] text-[var(--muted)]"
    >
      <span>Editing is available on a larger screen.</span>
    </p>
  );
}

/**
 * Banner above, Canvas filling the rest (FR-MOB-003). `touch-none` hands every touch on the Canvas
 * to React Flow, so a one-finger drag pans and a pinch zooms instead of scrolling the page.
 * `relative` + a filled child for the same reason as the desktop pane: React Flow needs a
 * measurable box.
 */
export function ReadOnlyCanvasFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--canvas)]" data-testid="readonly-canvas">
      <ReadOnlyBanner />
      <div className="relative min-h-0 flex-1 touch-none">{children}</div>
    </div>
  );
}
