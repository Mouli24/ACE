/**
 * The terminal's line discipline (D301, design §6.3). xterm only renders; this decides what a key
 * does — local echo, editing within the line, history, Enter and Ctrl+C. A tab keeps its state in
 * the terminal store, so a half-typed line survives the panel being hidden. `feed` (the key table)
 * is below the state.
 */

/** Entered commands a tab remembers for ↑/↓. */
export const HISTORY_MAX = 100;

export interface LineState {
  /** The line being typed. */
  line: string;
  /** Where the cursor is in `line`, 0…line.length. */
  cursor: number;
  /** Entered commands, oldest first, at most {@link HISTORY_MAX}. */
  history: readonly string[];
  /** Where ↑/↓ is in `history`; `history.length` is the line being typed. */
  recall: number;
  /** The line being typed when ↑ was first pressed; ↓ past the newest entry gives it back. */
  draft: string;
  /** A process runs, or is starting: Enter feeds its stdin and Ctrl+C stops it. */
  busy: boolean;
}

export function initialLineState(history: readonly string[] = []): LineState {
  return { line: '', cursor: 0, history, recall: history.length, draft: '', busy: false };
}

/** A run or a built-in finished: an empty line at a fresh prompt, history kept. */
export function settleLine(state: LineState): LineState {
  return { ...state, line: '', cursor: 0, recall: state.history.length, draft: '', busy: false };
}

/** A process started without typing (a script button): what is typed now goes to it. */
export function busyLine(state: LineState): LineState {
  return { ...settleLine(state), busy: true };
}

/** `~ $ ` at the project root, `src/app $ ` in a folder. */
export const promptFor = (cwd: string): string => `${cwd === '' ? '~' : cwd} $ `;

/** What a line asks for. `run` and `prompt` happen with nothing running; `input` and `stop` while busy. */
export type LineAction =
  | { kind: 'run'; line: string }
  | { kind: 'input'; data: string }
  | { kind: 'stop' }
  | { kind: 'prompt' };

export interface LineStep {
  state: LineState;
  /** What to write to the screen now: local echo, before any action has an answer. */
  echo: string;
  actions: LineAction[];
}

type Key =
  | { kind: 'text'; text: string }
  | { kind: 'enter' | 'backspace' | 'delete' | 'left' | 'right' | 'home' | 'end' }
  | { kind: 'up' | 'down' | 'interrupt' };

const left = (n: number): string => (n > 0 ? `\u001b[${n}D` : '');
const right = (n: number): string => (n > 0 ? `\u001b[${n}C` : '');
const ERASE_TO_END = '\u001b[K';

/** The key a CSI or SS3 sequence names, by its final character and parameters. */
function keyOfSequence(final: string, params: string): Key | undefined {
  switch (final) {
    case 'A':
      return { kind: 'up' };
    case 'B':
      return { kind: 'down' };
    case 'C':
      return { kind: 'right' };
    case 'D':
      return { kind: 'left' };
    case 'H':
      return { kind: 'home' };
    case 'F':
      return { kind: 'end' };
    case '~':
      if (params === '3') return { kind: 'delete' };
      if (params === '1' || params === '7') return { kind: 'home' };
      if (params === '4' || params === '8') return { kind: 'end' };
      return undefined;
    default:
      return undefined;
  }
}

/** xterm's `onData` string as keys. Unknown sequences and other control characters are dropped. */
function keysOf(data: string): Key[] {
  const keys: Key[] = [];
  let text = '';
  const flush = (): void => {
    if (text !== '') keys.push({ kind: 'text', text });
    text = '';
  };
  for (let i = 0; i < data.length; i += 1) {
    const ch = data.charAt(i);
    if (ch === '\u001b') {
      flush();
      const introducer = data.charAt(i + 1);
      if (introducer === '[' || introducer === 'O') {
        // CSI: parameter bytes 0x20–0x3F, then one final byte. SS3: one final byte.
        let end = i + 2;
        if (introducer === '[') {
          while (end < data.length && data.charCodeAt(end) >= 0x20 && data.charCodeAt(end) <= 0x3f) {
            end += 1;
          }
        }
        const key = end < data.length ? keyOfSequence(data.charAt(end), data.slice(i + 2, end)) : undefined;
        if (key !== undefined) keys.push(key);
        i = end;
        continue;
      }
      // A lone ESC, or Alt+key: dropped with the key it modifies.
      if (introducer !== '') i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      flush();
      keys.push({ kind: 'enter' });
      if (ch === '\r' && data.charAt(i + 1) === '\n') i += 1;
      continue;
    }
    if (ch === '\u007f' || ch === '\b') {
      flush();
      keys.push({ kind: 'backspace' });
      continue;
    }
    if (ch === '\u0003') {
      flush();
      keys.push({ kind: 'interrupt' });
      continue;
    }
    // Tab and the other control characters do nothing in line mode.
    if (ch < ' ') continue;
    text += ch;
  }
  flush();
  return keys;
}

function remember(history: readonly string[], line: string): readonly string[] {
  if (history.at(-1) === line) return history;
  return [...history, line].slice(-HISTORY_MAX);
}

/**
 * One `onData` string through the line discipline (D301): the state after it, what to echo, and
 * what to do — in order, so a pasted block runs its first line and feeds the rest to what that
 * started. Pure: the caller stores the state and performs the actions.
 */
export function feed(state: LineState, data: string): LineStep {
  let s = state;
  let echo = '';
  const actions: LineAction[] = [];
  for (const key of keysOf(data)) {
    switch (key.kind) {
      case 'text': {
        const rest = s.line.slice(s.cursor);
        echo += key.text + rest + left(rest.length);
        s = {
          ...s,
          line: s.line.slice(0, s.cursor) + key.text + rest,
          cursor: s.cursor + key.text.length,
        };
        break;
      }
      case 'backspace': {
        if (s.cursor === 0) break;
        const rest = s.line.slice(s.cursor);
        echo += `\b${rest} ${left(rest.length + 1)}`;
        s = { ...s, line: s.line.slice(0, s.cursor - 1) + rest, cursor: s.cursor - 1 };
        break;
      }
      case 'delete': {
        if (s.cursor === s.line.length) break;
        const rest = s.line.slice(s.cursor + 1);
        echo += `${rest} ${left(rest.length + 1)}`;
        s = { ...s, line: s.line.slice(0, s.cursor) + rest };
        break;
      }
      case 'left':
        if (s.cursor > 0) {
          echo += left(1);
          s = { ...s, cursor: s.cursor - 1 };
        }
        break;
      case 'right':
        if (s.cursor < s.line.length) {
          echo += right(1);
          s = { ...s, cursor: s.cursor + 1 };
        }
        break;
      case 'home':
        echo += left(s.cursor);
        s = { ...s, cursor: 0 };
        break;
      case 'end':
        echo += right(s.line.length - s.cursor);
        s = { ...s, cursor: s.line.length };
        break;
      case 'up':
      case 'down': {
        const recall = key.kind === 'up' ? s.recall - 1 : s.recall + 1;
        if (recall < 0 || recall > s.history.length) break;
        const draft = s.recall === s.history.length ? s.line : s.draft;
        const next = recall === s.history.length ? draft : (s.history[recall] ?? '');
        echo += left(s.cursor) + next + ERASE_TO_END;
        s = { ...s, line: next, cursor: next.length, recall, draft };
        break;
      }
      case 'enter': {
        echo += '\r\n';
        const line = s.line;
        const blank = line.trim() === '';
        if (s.busy) actions.push({ kind: 'input', data: `${line}\n` });
        else if (blank) actions.push({ kind: 'prompt' });
        else actions.push({ kind: 'run', line });
        const history = !s.busy && !blank ? remember(s.history, line) : s.history;
        s = {
          ...s,
          line: '',
          cursor: 0,
          history,
          recall: history.length,
          draft: '',
          busy: s.busy || !blank,
        };
        break;
      }
      case 'interrupt':
        echo += '^C\r\n';
        actions.push(s.busy ? { kind: 'stop' } : { kind: 'prompt' });
        s = { ...s, line: '', cursor: 0, recall: s.history.length, draft: '' };
        break;
    }
  }
  return { state: s, echo, actions };
}
