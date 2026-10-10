import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';

/**
 * react-resizable-panels hit-tests its resize handles against element rects, which are all 0×0
 * in jsdom, so every pointerdown on the page is captured as a drag start and menus never open.
 * The panes are layout only; Playwright covers them in a real browser.
 */
vi.mock('react-resizable-panels', () => {
  type Props = { children?: ReactNode; className?: string; id?: string; 'data-testid'?: string };
  const Box = ({ children, className, id, 'data-testid': testId }: Props) => (
    <div className={className} id={id} data-testid={testId}>
      {children}
    </div>
  );
  return { Panel: Box, PanelGroup: Box, PanelResizeHandle: () => <div role="separator" /> };
});

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
