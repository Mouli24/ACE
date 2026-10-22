import { renderHook } from '@testing-library/react';

import { FOLLOW_TAIL_PX, useFollowTail } from './follow-tail';

/** A scroller 300 px tall over `height` px of conversation, scrolled to `top`. */
function scroller(height: number, top: number) {
  return { scrollHeight: height, clientHeight: 300, scrollTop: top } as unknown as HTMLDivElement;
}

function mount(element: HTMLDivElement) {
  const { result } = renderHook(() => useFollowTail<HTMLDivElement>());
  (result.current.ref as { current: HTMLDivElement | null }).current = element;
  return result.current;
}

describe('[audit W-13] the chat follows its tail only while the reader is there', () => {
  it('at the tail (within 48 px), new content scrolls into view', () => {
    const element = scroller(1000, 1000 - 300 - FOLLOW_TAIL_PX);
    const tail = mount(element);
    tail.onScroll();
    (element as { scrollHeight: number }).scrollHeight = 1200;
    tail.follow();
    expect(element.scrollTop).toBe(1200);
  });

  it('scrolled up to read, a token leaves the view where it is', () => {
    const element = scroller(1000, 200);
    const tail = mount(element);
    tail.onScroll();
    (element as { scrollHeight: number }).scrollHeight = 1200;
    tail.follow();
    expect(element.scrollTop).toBe(200);
  });

  it('a new thread opens at its tail whatever the position', () => {
    const element = scroller(1000, 200);
    const tail = mount(element);
    tail.onScroll();
    tail.follow(true);
    expect(element.scrollTop).toBe(1000);
  });
});
