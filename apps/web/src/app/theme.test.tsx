import { act, renderHook, waitFor } from '@testing-library/react';

import {
  THEME_KEY,
  initThemeMode,
  readThemeMode,
  setThemeMode,
  useThemeMode,
} from '../theme/mode';
import { useApplyTheme, useResolvedTheme } from './theme';

describe('FR-SYS-005 D329 the theme is the ace-theme choice, default light', () => {
  afterEach(() => {
    localStorage.removeItem(THEME_KEY);
    act(() => initThemeMode());
    delete document.documentElement.dataset['theme'];
    document.documentElement.style.colorScheme = '';
  });

  it('starts light when nothing is stored', () => {
    renderHook(() => useApplyTheme());
    expect(readThemeMode()).toBe('light');
    expect(document.documentElement.dataset['theme']).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('applies the stored dark choice', () => {
    localStorage.setItem(THEME_KEY, 'dark');
    renderHook(() => useApplyTheme());
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });

  it('the toggle flips the theme and stores it under ace-theme', () => {
    const { result } = renderHook(() => useThemeMode());
    expect(result.current.dark).toBe(false);
    act(() => result.current.toggle());
    expect(result.current.dark).toBe(true);
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
    act(() => result.current.toggle());
    expect(localStorage.getItem(THEME_KEY)).toBe('light');
  });

  it('useResolvedTheme follows data-theme on <html>', async () => {
    const { result } = renderHook(() => useResolvedTheme());
    expect(result.current).toBe('light');
    act(() => setThemeMode('dark'));
    await waitFor(() => expect(result.current).toBe('dark'));
  });
});
