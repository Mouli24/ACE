/**
 * A unified diff (`git diff` output for one file) read line by line for `DiffView`: each line's
 * kind, and its line numbers in the old and the new file, counted from the hunk headers.
 */
export type DiffLineKind = 'meta' | 'hunk' | 'add' | 'del' | 'context' | 'note';

export interface DiffLine {
  kind: DiffLineKind;
  /** The line without its one-character prefix (the whole line for `meta` and `hunk`). */
  text: string;
  oldNumber?: number;
  newNumber?: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const META =
  /^(diff --git |index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index|rename from|rename to|copy from|copy to|Binary files)/;

export function parseUnifiedDiff(patch: string): DiffLine[] {
  const lines = patch.split('\n');
  // a patch ends with a newline; the empty string after it is not a line of the file
  if (lines.at(-1) === '') lines.pop();
  const out: DiffLine[] = [];
  let oldNumber = 0;
  let newNumber = 0;
  let inHunk = false;
  for (const line of lines) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldNumber = Number(hunk[1]);
      newNumber = Number(hunk[2]);
      inHunk = true;
      out.push({ kind: 'hunk', text: line });
      continue;
    }
    // inside a hunk only a new file's header ends it: `--- x` there is a deleted line `-- x`
    if (line.startsWith('diff --git ')) inHunk = false;
    if (!inHunk) {
      out.push({ kind: META.test(line) || line === '' ? 'meta' : 'note', text: line });
      continue;
    }
    if (line.startsWith('+')) {
      out.push({ kind: 'add', text: line.slice(1), newNumber });
      newNumber += 1;
    } else if (line.startsWith('-')) {
      out.push({ kind: 'del', text: line.slice(1), oldNumber });
      oldNumber += 1;
    } else if (line.startsWith('\\')) {
      out.push({ kind: 'note', text: line });
    } else {
      out.push({ kind: 'context', text: line.slice(1), oldNumber, newNumber });
      oldNumber += 1;
      newNumber += 1;
    }
  }
  return out;
}
