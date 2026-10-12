import '@testing-library/jest-dom/vitest';

// Forge's Monaco host is a lazy chunk that needs a browser; every test gets the textarea stand-in.
vi.mock('../forge/editor/CompareView', () => ({
  CompareView: ({ path }: { path: string }) => <div data-testid="compare-view">{path}</div>,
}));

vi.mock('../forge/editor/EditorHost', async () => ({
  EditorHost: (await import('./FakeEditorHost')).FakeEditorHost,
}));

/* jsdom has neither; React Flow and Radix need both to exist. */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}
if (typeof window !== 'undefined' && typeof window.DOMRect === 'undefined') {
  window.DOMRect = class {
    constructor(
      public x = 0,
      public y = 0,
      public width = 0,
      public height = 0,
    ) {}
    get top() {
      return this.y;
    }
    get left() {
      return this.x;
    }
    get right() {
      return this.x + this.width;
    }
    get bottom() {
      return this.y + this.height;
    }
    static fromRect() {
      return new window.DOMRect();
    }
    toJSON() {
      return {};
    }
  } as unknown as typeof DOMRect;
}

/* Radix Select relies on pointer capture and scrollIntoView, neither of which jsdom implements. */
if (typeof Element !== 'undefined') {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto['hasPointerCapture'] ??= () => false;
  proto['setPointerCapture'] ??= () => undefined;
  proto['releasePointerCapture'] ??= () => undefined;
  proto['scrollIntoView'] ??= () => undefined;
}
