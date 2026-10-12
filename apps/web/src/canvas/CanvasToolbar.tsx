import { useViewport } from '@xyflow/react';

export interface CanvasToolbarProps {
  /** FR-MOB-003: a read-only Canvas keeps the view controls and drops lock and undo-move. */
  readOnly?: boolean;
  locked: boolean;
  hand: boolean;
  /** Whether the position history holds a step that would move something. */
  canUndoMove: boolean;
  onZoomIn(): void;
  onZoomOut(): void;
  onResetZoom(): void;
  onFit(): void;
  onToggleLock(): void;
  onToggleHand(): void;
  onUndoMove(): void;
}

const BUTTON =
  'flex h-[28px] cursor-pointer items-center justify-center rounded-[6px] border-none bg-transparent p-0 outline-none focus-visible:shadow-[0_0_0_2px_#ef6b3f]';

/**
 * The theme's bottom-left toolbar (D332): zoom in, zoom out, the zoom (click: back to 100%), fit,
 * lock, the hand tool and undo-move. Its own component so the percentage — which moves on every
 * pan and zoom frame — re-renders this toolbar and nothing else (NFR-PERF-01).
 */
export function CanvasToolbar({
  readOnly = false,
  locked,
  hand,
  canUndoMove,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  onFit,
  onToggleLock,
  onToggleHand,
  onUndoMove,
}: CanvasToolbarProps) {
  const { zoom } = useViewport();
  return (
    <div
      data-testid="canvas-toolbar"
      className="absolute bottom-[16px] left-[18px] z-[5] flex items-center gap-[2px] rounded-[10px] border border-[var(--line)] bg-[var(--surface)] p-[4px] shadow-[0_8px_24px_-12px_rgba(0,0,0,0.25)]"
    >
      <button
        type="button"
        title="Zoom in"
        aria-label="Zoom in"
        className={`${BUTTON} w-[28px] text-[16px] text-[var(--ink)] hover:bg-[var(--hover)]`}
        onClick={onZoomIn}
      >
        +
      </button>
      <button
        type="button"
        title="Zoom out"
        aria-label="Zoom out"
        className={`${BUTTON} w-[28px] text-[16px] text-[var(--ink)] hover:bg-[var(--hover)]`}
        onClick={onZoomOut}
      >
        −
      </button>
      <button
        type="button"
        title="Reset to 100%"
        aria-label="Reset to 100%"
        data-testid="canvas-zoom-level"
        className={`${BUTTON} min-w-[44px] font-machine text-[10px] text-[var(--muted)] hover:bg-[var(--hover)]`}
        onClick={onResetZoom}
      >
        {Math.round(zoom * 100)}%
      </button>
      <button
        type="button"
        title="Fit to screen"
        aria-label="Fit to view"
        className={`${BUTTON} w-[28px] text-[13px] text-[var(--ink)] hover:bg-[var(--hover)]`}
        onClick={onFit}
      >
        ⛶
      </button>
      {!readOnly && (
        <button
          type="button"
          title="Lock nodes"
          aria-label="Lock nodes"
          aria-pressed={locked}
          className={`${BUTTON} w-[28px] text-[12px]`}
          style={{
            background: locked ? 'var(--hover)' : 'transparent',
            color: locked ? '#ef6b3f' : 'var(--ink)',
          }}
          onClick={onToggleLock}
        >
          {locked ? '🔒︎' : '🔓︎'}
        </button>
      )}
      <button
        type="button"
        title="Hand tool"
        aria-label="Hand tool"
        aria-pressed={hand}
        className={`${BUTTON} w-[28px] text-[13px]`}
        style={{
          background: hand ? '#ef6b3f' : 'transparent',
          color: hand ? '#fff' : 'var(--ink)',
        }}
        onClick={onToggleHand}
      >
        ✋
      </button>
      {!readOnly && (
        <button
          type="button"
          title="Undo move"
          aria-label="Undo move"
          aria-disabled={!canUndoMove}
          className={`${BUTTON} w-[28px] text-[14px] hover:bg-[var(--hover)]`}
          style={{ color: canUndoMove ? 'var(--ink)' : 'var(--iconLine)' }}
          onClick={onUndoMove}
        >
          ↶
        </button>
      )}
    </div>
  );
}
