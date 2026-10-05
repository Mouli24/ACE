import { cn } from '@ace/ui';
import { useReactFlow, useViewport } from '@xyflow/react';

/** The same animation as the Canvas's own Fit (the `F` key, the top-right button). */
const ZOOM = { duration: 200 } as const;
const FIT = { padding: 0.2, duration: 200 } as const;

const round = cn(
  'grid h-7 min-w-7 place-items-center rounded-chip font-machine text-fg-muted transition-colors',
  'hover:bg-border hover:text-fg',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection',
);

/**
 * The zoom pill at the Canvas's bottom-left (FR-CAN-001): out, the zoom as a percentage, in, and
 * Fit. Its own component so the percentage — which moves on every pan and zoom frame — re-renders
 * this pill and nothing else (NFR-PERF-01). Rendered inside a React Flow `Panel`.
 */
export function CanvasZoomPill() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const { zoom } = useViewport();
  return (
    <div
      data-testid="canvas-zoom-pill"
      className="flex items-center gap-0.5 rounded-chip border border-border bg-panel p-[3px]"
    >
      <button
        type="button"
        aria-label="Zoom out"
        title="Zoom out"
        className={cn(round, 'w-7 text-[14px]')}
        onClick={() => void zoomOut(ZOOM)}
      >
        −
      </button>
      <span
        data-testid="canvas-zoom-level"
        className="min-w-[42px] text-center font-machine text-[10px] text-fg-muted tabular-nums"
      >
        {Math.round(zoom * 100)}%
      </span>
      <button
        type="button"
        aria-label="Zoom in"
        title="Zoom in"
        className={cn(round, 'w-7 text-[14px]')}
        onClick={() => void zoomIn(ZOOM)}
      >
        +
      </button>
      <button
        type="button"
        aria-label="Fit view"
        title="Fit view"
        className={cn(round, 'px-2.5 text-[9.5px] uppercase tracking-[0.14em]')}
        onClick={() => void fitView(FIT)}
      >
        Fit
      </button>
    </div>
  );
}
