import { applyTheme, resolveTheme, type MatchMedia } from '../lib/theme.js';

/** A controllable `matchMedia`: `set(true)` flips the OS to light and fires `change`. */
function fakeMatchMedia(initialLight: boolean) {
  let matches = initialLight;
  const listeners = new Set<() => void>();
  const list = {
    get matches() {
      return matches;
    },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  } as unknown as MediaQueryList;
  const mm: MatchMedia = () => list;
  return {
    mm,
    listeners,
    set(light: boolean) {
      matches = light;
      listeners.forEach((fn) => fn());
    },
  };
}

describe('FR-SYS-005 applyTheme', () => {
  afterEach(() => {
    delete document.documentElement.dataset['theme'];
    document.documentElement.style.colorScheme = '';
  });

  it.each(['dark', 'light'] as const)('sets data-theme and color-scheme for %s', (theme) => {
    const cleanup = applyTheme(theme);
    expect(document.documentElement.dataset['theme']).toBe(theme);
    expect(document.documentElement.style.colorScheme).toBe(theme);
    cleanup();
  });

  it('system follows prefers-color-scheme and keeps following it until cleanup', () => {
    const media = fakeMatchMedia(false);
    const cleanup = applyTheme('system', media.mm);
    expect(document.documentElement.dataset['theme']).toBe('dark');

    media.set(true);
    expect(document.documentElement.dataset['theme']).toBe('light');

    cleanup();
    expect(media.listeners.size).toBe(0);
    media.set(false);
    expect(document.documentElement.dataset['theme']).toBe('light');
  });

  it('system without matchMedia falls back to dark', () => {
    const original = globalThis.matchMedia;
    // jsdom has no matchMedia; make sure of it for this test.
    Object.defineProperty(globalThis, 'matchMedia', { value: undefined, configurable: true });
    try {
      applyTheme('system')();
      expect(document.documentElement.dataset['theme']).toBe('dark');
      expect(resolveTheme('system')).toBe('dark');
    } finally {
      Object.defineProperty(globalThis, 'matchMedia', { value: original, configurable: true });
    }
  });

  it('applies to a given root and resolves explicit themes as themselves', () => {
    const root = document.createElement('div');
    applyTheme('light', undefined, root);
    expect(root.dataset['theme']).toBe('light');
    expect(resolveTheme('light')).toBe('light');
    expect(resolveTheme('system', fakeMatchMedia(true).mm)).toBe('light');
  });
});
