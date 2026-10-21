import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cancelTerminalFocus, registerTerminalFocus, requestTerminalFocus } from './focus';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cancelTerminalFocus();
  vi.useRealTimers();
});

describe('[audit U-8] a focus request waits for the terminal’s lazily loaded view', () => {
  it('a view that registers soon after the request takes the focus', () => {
    requestTerminalFocus();
    vi.advanceTimersByTime(0);
    const focus = vi.fn();
    const unregister = registerTerminalFocus(focus);
    expect(focus).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(focus).toHaveBeenCalledTimes(1);
    unregister();
  });

  it('the request lapses after a few seconds: a later mount never takes the focus', () => {
    requestTerminalFocus();
    vi.advanceTimersByTime(3_001);
    const focus = vi.fn();
    const unregister = registerTerminalFocus(focus);
    vi.advanceTimersByTime(10);
    expect(focus).not.toHaveBeenCalled();
    unregister();
  });

  it('a view already on screen is focused after the turn, as before', () => {
    const focus = vi.fn();
    const unregister = registerTerminalFocus(focus);
    requestTerminalFocus();
    vi.advanceTimersByTime(0);
    expect(focus).toHaveBeenCalledTimes(1);
    unregister();
  });
});
