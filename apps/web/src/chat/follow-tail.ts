import { useCallback, useRef } from 'react';

/** How close to the bottom still counts as reading the tail. */
export const FOLLOW_TAIL_PX = 48;

/**
 * [audit W-13] A conversation follows its tail — new turns, the reply streaming in — only while the
 * reader is at it: within {@link FOLLOW_TAIL_PX} of the bottom. Scrolled up to read an earlier
 * turn, a token no longer drags the view away. `follow(true)` jumps regardless (a new thread).
 */
export function useFollowTail<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const atTail = useRef(true);
  const onScroll = useCallback(() => {
    const element = ref.current;
    if (element === null) return;
    atTail.current =
      element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_TAIL_PX;
  }, []);
  const follow = useCallback((force = false) => {
    const element = ref.current;
    if (element === null || (!force && !atTail.current)) return;
    element.scrollTop = element.scrollHeight;
    atTail.current = true;
  }, []);
  return { ref, onScroll, follow };
}
