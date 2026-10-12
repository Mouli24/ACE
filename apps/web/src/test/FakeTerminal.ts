/**
 * xterm.js stands in as this in unit tests (registered in `setup.tsx`), so `TerminalView` runs for
 * real without a browser's canvas. What is written shows as plain text in a
 * `<pre data-testid="terminal-screen">`, and a test types with `FakeTerminal.latest().type(data)`,
 * exactly as xterm's `onData` reports keys. The real xterm runs in e2e.
 *
 * `clear()` mimics xterm 6: the buffer is emptied but the current (last) line stays as the new
 * first line, so a prompt survives `cls`.
 */

type Listener<T> = (value: T) => void;

interface KeyEvent {
  key: string;
  domEvent: KeyboardEvent;
}

interface Disposable {
  dispose(): void;
}

interface Addon {
  activate(terminal: FakeTerminal): void;
  dispose(): void;
}

/**
 * What a person would see: CR, LF (as CR LF, like xterm's `convertEol`), Backspace, cursor left
 * and right (`ESC [ n D`, `ESC [ n C`) and erase-to-end (`ESC [ K`) are applied; colours and every
 * other escape are dropped. Trailing spaces stay.
 */
export function screenText(stream: string): string {
  const lines: string[][] = [[]];
  let row = 0;
  let col = 0;
  const lineAt = (index: number): string[] => {
    let found = lines[index];
    if (found === undefined) {
      found = [];
      lines[index] = found;
    }
    return found;
  };
  for (let i = 0; i < stream.length; i += 1) {
    const ch = stream.charAt(i);
    if (ch === '\u001b' && stream.charAt(i + 1) === 'c') {
      // RIS: a full reset, in order with the writes around it.
      lines.length = 0;
      lines.push([]);
      row = 0;
      col = 0;
      i += 1;
      continue;
    }
    if (ch === '\u001b') {
      // eslint-disable-next-line no-control-regex -- escape sequences are exactly what is parsed
      const match = /^\u001b\[([0-9;?]*)([A-Za-z~])/.exec(stream.slice(i));
      if (match !== null) {
        const n = Number(match[1] === '' ? '1' : match[1]);
        if (match[2] === 'D') col = Math.max(0, col - n);
        else if (match[2] === 'C') col += n;
        else if (match[2] === 'K') lineAt(row).length = Math.min(lineAt(row).length, col);
        i += match[0].length - 1;
      }
      continue;
    }
    if (ch === '\r') {
      col = 0;
      continue;
    }
    if (ch === '\n') {
      row += 1;
      col = 0;
      lineAt(row);
      continue;
    }
    if (ch === '\b') {
      col = Math.max(0, col - 1);
      continue;
    }
    const line = lineAt(row);
    while (line.length < col) line.push(' ');
    line[col] = ch;
    col += 1;
  }
  return lines.map((chars) => chars.join('')).join('\n');
}

export class FakeTerminal {
  static instances: FakeTerminal[] = [];

  /** The terminal opened last. */
  static latest(): FakeTerminal {
    const last = FakeTerminal.instances.at(-1);
    if (last === undefined) throw new Error('no terminal was opened');
    return last;
  }

  readonly options: Record<string, unknown>;
  cols = 80;
  rows = 24;
  /** Everything written since the last reset or clear. */
  written = '';
  disposed = false;
  focused = 0;
  keyHandler: ((event: KeyboardEvent) => boolean) | undefined;
  readonly addons: Addon[] = [];
  private screen: HTMLPreElement | undefined;
  private readonly dataListeners = new Set<Listener<string>>();
  private readonly keyListeners = new Set<Listener<KeyEvent>>();
  private readonly resizeListeners = new Set<Listener<{ cols: number; rows: number }>>();

  constructor(options: Record<string, unknown> = {}) {
    this.options = { ...options };
    FakeTerminal.instances.push(this);
  }

  open(parent: HTMLElement): void {
    const screen = document.createElement('pre');
    screen.setAttribute('data-testid', 'terminal-screen');
    parent.appendChild(screen);
    this.screen = screen;
    this.render();
  }

  write(data: string | Uint8Array, callback?: () => void): void {
    this.written += typeof data === 'string' ? data : new TextDecoder().decode(data);
    this.render();
    callback?.();
  }

  writeln(data: string): void {
    this.write(`${data}\r\n`);
  }

  clear(): void {
    this.written = this.plain().split('\n').at(-1) ?? '';
    this.render();
  }

  reset(): void {
    this.written = '';
    this.render();
  }

  focus(): void {
    this.focused += 1;
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    for (const listener of [...this.resizeListeners]) listener({ cols, rows });
  }

  hasSelection(): boolean {
    return false;
  }

  getSelection(): string {
    return '';
  }

  onData(listener: Listener<string>): Disposable {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onKey(listener: Listener<KeyEvent>): Disposable {
    this.keyListeners.add(listener);
    return { dispose: () => this.keyListeners.delete(listener) };
  }

  onResize(listener: Listener<{ cols: number; rows: number }>): Disposable {
    this.resizeListeners.add(listener);
    return { dispose: () => this.resizeListeners.delete(listener) };
  }

  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
    this.keyHandler = handler;
  }

  loadAddon(addon: Addon): void {
    addon.activate(this);
    this.addons.push(addon);
  }

  dispose(): void {
    this.disposed = true;
    this.dataListeners.clear();
    this.keyListeners.clear();
    this.resizeListeners.clear();
    for (const addon of this.addons) addon.dispose();
    this.screen?.remove();
  }

  /** Test: what the person types, as `onData` reports it (Enter is `\r`, Ctrl+C is `\x03`). */
  type(data: string): void {
    // Like xterm, a terminal with stdin disabled reports nothing typed.
    if (this.options['disableStdin'] === true) return;
    for (const listener of [...this.dataListeners]) listener(data);
    this.fireKey(data, new KeyboardEvent('keydown', { key: data }));
  }

  /** Test: a key as the custom key handler sees it; answers whether xterm would handle it. */
  press(init: KeyboardEventInit): boolean {
    const event = new KeyboardEvent('keydown', init);
    const handled = this.keyHandler?.(event) ?? true;
    if (handled) this.fireKey(init.key ?? '', event);
    return handled;
  }

  private fireKey(key: string, domEvent: KeyboardEvent): void {
    for (const listener of [...this.keyListeners]) listener({ key, domEvent });
  }

  /** Test: the screen as a person reads it. */
  plain(): string {
    return screenText(this.written);
  }

  private render(): void {
    if (this.screen !== undefined) this.screen.textContent = this.plain();
  }
}

export class FakeFitAddon {
  fits = 0;
  activate = (): void => undefined;
  dispose = (): void => undefined;
  fit(): void {
    this.fits += 1;
  }
  proposeDimensions(): { cols: number; rows: number } {
    return { cols: 80, rows: 24 };
  }
}

export class FakeWebLinksAddon {
  constructor(readonly handler?: (event: MouseEvent, uri: string) => void) {}
  activate = (): void => undefined;
  dispose = (): void => undefined;
}

export class FakeSearchAddon {
  static instances: FakeSearchAddon[] = [];
  readonly calls: Array<[direction: 'next' | 'previous', term: string]> = [];
  cleared = 0;
  constructor() {
    FakeSearchAddon.instances.push(this);
  }
  activate = (): void => undefined;
  dispose = (): void => undefined;
  findNext(term: string): boolean {
    this.calls.push(['next', term]);
    return true;
  }
  findPrevious(term: string): boolean {
    this.calls.push(['previous', term]);
    return true;
  }
  clearDecorations(): void {
    this.cleared += 1;
  }
  clearActiveDecoration = (): void => undefined;
  onDidChangeResults = (): Disposable => ({ dispose: () => undefined });
}
