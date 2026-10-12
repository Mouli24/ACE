/**
 * The Terminal takes the keyboard focus only when the person asked for it (D301): Ctrl+`, a click
 * on the panel's Terminal pill or on a terminal tab, New terminal, Show, a script button, the
 * footer's running count, the empty editor's Terminal button. A remount alone (Ctrl+J, back from
 * Ideate) never takes it, so the editor keeps the caret.
 *
 * A request is served after the current turn: by then React has mounted the view it opened (a new
 * tab, a panel shown), and in development StrictMode's second mount is the one registered. If no
 * view is on screen by then, the request lapses rather than waiting to surprise a later remount.
 */

let current: (() => void) | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

export function requestTerminalFocus(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    current?.();
  }, 0);
}

/** The view on screen says how to focus it; the returned function takes that back. */
export function registerTerminalFocus(focus: () => void): () => void {
  current = focus;
  return () => {
    if (current === focus) current = undefined;
  };
}

/** Tests: a request never outlives the test that made it. */
export function cancelTerminalFocus(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
}
