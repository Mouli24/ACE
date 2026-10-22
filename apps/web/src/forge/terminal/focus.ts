import { useLayoutStore } from '../../app/stores/layout';

/**
 * The Terminal takes the keyboard focus only when the person asked for it (D301): Ctrl+`, a click
 * on the panel's Terminal pill or on a terminal tab, New terminal, Show, a script button, the
 * footer's running count, the empty editor's Terminal button. A remount alone (Ctrl+J, back from
 * Ideate) never takes it, so the editor keeps the caret.
 *
 * A request is served after the current turn: by then React has mounted the view it opened (a new
 * tab, a panel shown), and in development StrictMode's second mount is the one registered. If no
 * view is on screen by then, the request waits {@link VIEW_LOAD_MS} for one — the view's code loads
 * with the first terminal shown ([audit U-8]) — then lapses rather than waiting to surprise a
 * later remount.
 */

/** How long a request waits for the view's lazily loaded code. */
const VIEW_LOAD_MS = 3_000;

let current: (() => void) | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
/** Until when a request that found no view waits for one to register (0: none waits). */
let waitingUntil = 0;

export function requestTerminalFocus(): void {
  if (timer !== undefined) clearTimeout(timer);
  waitingUntil = 0;
  timer = setTimeout(() => {
    timer = undefined;
    if (current !== undefined) current();
    else waitingUntil = Date.now() + VIEW_LOAD_MS;
  }, 0);
}

/** The view on screen says how to focus it; the returned function takes that back. */
export function registerTerminalFocus(focus: () => void): () => void {
  current = focus;
  // a request made while the view's code was loading: served after this turn, as any request
  if (waitingUntil > Date.now()) requestTerminalFocus();
  return () => {
    if (current === focus) current = undefined;
  };
}

/** Drops a pending request: a rename that keeps the caret, and tests (a request never outlives its test). */
export function cancelTerminalFocus(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  waitingUntil = 0;
}

/** Ctrl+` and the empty editor's Terminal pill: show the Terminal and focus it, or hide it. */
export function toggleTerminalFocused(): void {
  const layout = useLayoutStore.getState();
  if (!(layout.panelOpen && layout.panelTab === 'terminal')) requestTerminalFocus();
  layout.toggleTerminal();
}
