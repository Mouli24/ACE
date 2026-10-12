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
