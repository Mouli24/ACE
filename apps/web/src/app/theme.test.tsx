import { act, renderHook, waitFor } from '@testing-library/react';

import {
  THEME_KEY,
  initThemeMode,
  readThemeMode,
  setThemeMode,
  useThemeMode,
} from '../theme/mode';
import indexHtml from '../../index.html?raw';
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

describe('audit U-18 index.html sets the stored theme before the first paint', () => {
  /** index.html's inline (non-module) script, run as the browser would before the bundle. */
  const prePaint = new Function(
    /<script>([\s\S]*?)<\/script>/.exec(indexHtml)?.[1] ?? 'throw new Error("no script")',
  ) as () => void;
  const matchMedia = window.matchMedia;
  afterEach(() => {
    localStorage.removeItem(THEME_KEY);
    delete document.documentElement.dataset['theme'];
    document.documentElement.style.colorScheme = '';
    window.matchMedia = matchMedia;
  });

  it.each([
    [null, 'light'],
    ['light', 'light'],
    ['dark', 'dark'],
    ['nonsense', 'light'],
  ])('ace-theme %s → %s', (stored, theme) => {
    if (stored !== null) localStorage.setItem(THEME_KEY, stored);
    prePaint();
    expect(document.documentElement.dataset['theme']).toBe(theme);
    expect(document.documentElement.style.colorScheme).toBe(theme);
  });

  it('system follows prefers-color-scheme', () => {
    localStorage.setItem(THEME_KEY, 'system');
    window.matchMedia = ((query: string) => ({ matches: !query.includes('light') })) as never;
    prePaint();
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });
});
