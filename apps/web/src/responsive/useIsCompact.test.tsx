import { act, renderHook } from '@testing-library/react';

import { COMPACT_QUERY, useIsCompact } from './useIsCompact';
import { installMatchMedia, uninstallMatchMedia } from './test-support';

describe('FR-MOB-001 useIsCompact follows the 640 px breakpoint', () => {
  afterEach(() => uninstallMatchMedia());

  it('asks for exactly max-width: 640px', () => {
    expect(COMPACT_QUERY).toBe('(max-width: 640px)');
  });

  it('is false where matchMedia does not exist (jsdom, SSR): the desktop layout is the default', () => {
    uninstallMatchMedia();
    const { result } = renderHook(() => useIsCompact());
    expect(result.current).toBe(false);
  });

  it('is true when the query matches on first render', () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useIsCompact());
    expect(result.current).toBe(true);
  });

  it('follows the query as the window crosses the breakpoint, and stops listening on unmount', () => {
    const media = installMatchMedia(false);
    const { result, unmount } = renderHook(() => useIsCompact());
    expect(result.current).toBe(false);

    act(() => media.set(true));
    expect(result.current).toBe(true);
    act(() => media.set(false));
    expect(result.current).toBe(false);

    unmount();
    expect(media.listeners()).toBe(0);
  });
});
