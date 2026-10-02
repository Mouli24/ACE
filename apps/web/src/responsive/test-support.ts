/**
 * A controllable `window.matchMedia` for component tests (jsdom has none). `installMatchMedia`
 * answers every query with one flag; `set` flips it and notifies the listeners, the way a browser
 * does when the window crosses the breakpoint.
 */
export interface FakeMedia {
  set(matches: boolean): void;
  listeners(): number;
}

const original: { value: typeof window.matchMedia | undefined; saved: boolean } = {
  value: undefined,
  saved: false,
};

export function installMatchMedia(initial: boolean): FakeMedia {
  if (!original.saved) {
    original.value = window.matchMedia;
    original.saved = true;
  }
  let matches = initial;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();

  window.matchMedia = (query: string) =>
    ({
      get matches() {
        return matches;
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.delete(listener),
      addListener: (listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
      removeListener: (listener: (event: MediaQueryListEvent) => void) =>
        listeners.delete(listener),
      dispatchEvent: () => true,
    }) as unknown as MediaQueryList;

  return {
    set(next) {
      matches = next;
      for (const listener of [...listeners]) {
        listener({ matches: next, media: '' } as MediaQueryListEvent);
      }
    },
    listeners: () => listeners.size,
  };
}

/** Put back whatever jsdom had (normally nothing). */
export function uninstallMatchMedia(): void {
  if (!original.saved) return;
  if (original.value === undefined) Reflect.deleteProperty(window, 'matchMedia');
  else window.matchMedia = original.value;
  original.saved = false;
  original.value = undefined;
}
