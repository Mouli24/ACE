import { cn } from '@ace/ui';
import { useRef, type KeyboardEvent, type PointerEvent } from 'react';

import { clampSize, type SizeBounds } from './sizes';

/** How far one arrow key moves an edge. */
const KEY_STEP = 16;

/**
 * [audit F-7] A panel's draggable edge (D299): a 6px strip over the panel's own border line,
 * invisible at rest so the theme's look stays (D334), the accent line on hover and focus. A
 * `separator` with its value, so the arrow keys (16px), Home and End resize it too; a double click
 * puts the panel back to its first size. `vertical` sits on a side edge and drags along x;
 * `horizontal` on a top or bottom edge, along y. `grows` says which way the panel grows.
 */
export function Splitter({
  label,
  orientation,
  grows,
  value,
  bounds,
  onResize,
  className,
}: {
  label: string;
  orientation: 'vertical' | 'horizontal';
  /** `forward`: right or down makes the panel bigger; `backward`: left or up does. */
  grows: 'forward' | 'backward';
  value: number;
  bounds: SizeBounds;
  onResize(next: number): void;
  /** Where the strip sits on the panel's edge. */
  className?: string;
}) {
  const drag = useRef<{ from: number; value: number } | undefined>(undefined);
  const vertical = orientation === 'vertical';
  const sign = grows === 'forward' ? 1 : -1;
  const along = (event: PointerEvent<HTMLDivElement>): number =>
    vertical ? event.clientX : event.clientY;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const forward = vertical ? 'ArrowRight' : 'ArrowDown';
    const backward = vertical ? 'ArrowLeft' : 'ArrowUp';
    let next: number;
    if (event.key === forward) next = value + sign * KEY_STEP;
    else if (event.key === backward) next = value - sign * KEY_STEP;
    else if (event.key === 'Home') next = bounds.min;
    else if (event.key === 'End') next = bounds.max;
    else return;
    event.preventDefault();
    onResize(clampSize(next, bounds));
  };

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={value}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        drag.current = { from: along(event), value };
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (start === undefined) return;
        onResize(clampSize(start.value + sign * (along(event) - start.from), bounds));
      }}
      onPointerUp={(event) => {
        drag.current = undefined;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = undefined;
      }}
      onDoubleClick={() => onResize(bounds.initial)}
      onKeyDown={onKeyDown}
      className={cn(
        'absolute z-[3] touch-none outline-none before:absolute before:bg-transparent hover:before:bg-[#ef6b3f] focus-visible:before:bg-[#ef6b3f]',
        vertical
          ? 'inset-y-0 w-[6px] cursor-col-resize before:inset-y-0 before:left-[2px] before:w-[2px]'
          : 'inset-x-0 h-[6px] cursor-row-resize before:inset-x-0 before:top-[2px] before:h-[2px]',
        className,
      )}
    />
  );
}
