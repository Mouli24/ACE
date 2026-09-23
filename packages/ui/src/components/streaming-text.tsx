import { useEffect, useRef } from 'react';

import { cn } from '../lib/cn.js';

export interface StreamingTextProps {
  /** Everything streamed so far for this node run; the caller folds the deltas (SDK `RunView`). */
  text: string;
  nodeRunId: string;
  className?: string;
  /** How many lines to show before the box scrolls; the card stays a card. */
  maxLines?: number;
}

/**
 * Model output as it arrives (FR-EXE-008). The component is deliberately dumb: it paints whatever
 * `text` it is handed in the same commit, so the only latency between a `node.token` frame and the
 * screen is the store update (NFR-PERF-04, TC-NFR-003). Batching happens engine-side (~50 ms,
 * Arch §24), not here.
 */
export function StreamingText({ text, nodeRunId, className, maxLines = 4 }: StreamingTextProps) {
  const box = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    // follow the tail while it grows, the way a terminal does
    const element = box.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [text]);

  if (text === '') return null;

  return (
    <p
      ref={box}
      data-testid={`stream-${nodeRunId}`}
      aria-live="polite"
      style={{ maxHeight: `${maxLines * 1.1}rem` }}
      className={cn(
        'overflow-y-auto whitespace-pre-wrap break-words font-machine text-[11px] leading-[1.1rem] text-fg-muted',
        className,
      )}
    >
      {text}
    </p>
  );
}
