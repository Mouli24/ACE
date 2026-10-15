import type { NodeRun, Part } from '@ace/contracts';

/**
 * PG-5.4 Compare runs: the text a node's output reads as, and a line diff of two of them.
 *
 * JSON is pretty-printed with sorted keys before it is diffed, so two answers that differ only in
 * key order or spacing read as identical and a changed value shows as one changed line.
 */

export type DiffLine = { kind: 'same' | 'added' | 'removed'; text: string };

/** Keys sorted at every depth, so key order never shows up as a difference. */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortedKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(sortedKeys(value), null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** One part as text: text and code as written, JSON pretty, a file as its reference. */
export function partText(part: Part): string {
  switch (part.type) {
    case 'text':
      return part.text;
    case 'json':
      return prettyJson(part.value);
    case 'code':
      return part.text;
    default:
      return `[${part.type} ${'artifactId' in part ? part.artifactId : ''}]`.replace(' ]', ']');
  }
}

export function outputText(output: readonly Part[] | undefined): string {
  return (output ?? []).map(partText).join('\n\n');
}

/**
 * The node run a comparison shows for a node: its last iteration's last COMPLETED attempt, else its
 * latest node run of any state (so a failure still shows, with its status).
 */
export function finalNodeRuns(nodeRuns: readonly NodeRun[]): Map<string, NodeRun> {
  const rank = (row: NodeRun) => [row.status === 'COMPLETED' ? 1 : 0, row.iteration, row.attempt];
  const best = new Map<string, NodeRun>();
  for (const row of nodeRuns) {
    const current = best.get(row.nodeId);
    if (current === undefined) {
      best.set(row.nodeId, row);
      continue;
    }
    const [a, b] = [rank(row), rank(current)];
    for (let index = 0; index < a.length; index += 1) {
      if (a[index]! === b[index]!) continue;
      if (a[index]! > b[index]!) best.set(row.nodeId, row);
      break;
    }
  }
  return best;
}

/** Past this many cells the LCS table is too big for a browser tab; the diff falls back. */
const MAX_CELLS = 4_000_000;

/** A line diff (longest common subsequence), `a` the left run's text, `b` the right's. */
export function diffLines(a: string, b: string): DiffLine[] {
  const left = a === '' ? [] : a.split('\n');
  const right = b === '' ? [] : b.split('\n');

  // The common head and tail never need the table.
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let endLeft = left.length;
  let endRight = right.length;
  while (endLeft > start && endRight > start && left[endLeft - 1] === right[endRight - 1]) {
    endLeft -= 1;
    endRight -= 1;
  }

  const head: DiffLine[] = left.slice(0, start).map((text) => ({ kind: 'same', text }));
  const tail: DiffLine[] = left.slice(endLeft).map((text) => ({ kind: 'same', text }));
  const midLeft = left.slice(start, endLeft);
  const midRight = right.slice(start, endRight);

  if (midLeft.length * midRight.length > MAX_CELLS) {
    return [
      ...head,
      ...midLeft.map((text): DiffLine => ({ kind: 'removed', text })),
      ...midRight.map((text): DiffLine => ({ kind: 'added', text })),
      ...tail,
    ];
  }

  const rows = midLeft.length;
  const cols = midRight.length;
  // lengths[i][j]: the LCS of midLeft[i..] and midRight[j..], flattened.
  const lengths = new Uint32Array((rows + 1) * (cols + 1));
  const at = (i: number, j: number) => i * (cols + 1) + j;
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      lengths[at(i, j)] =
        midLeft[i] === midRight[j]
          ? lengths[at(i + 1, j + 1)]! + 1
          : Math.max(lengths[at(i + 1, j)]!, lengths[at(i, j + 1)]!);
    }
  }

  const middle: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (midLeft[i] === midRight[j]) {
      middle.push({ kind: 'same', text: midLeft[i]! });
      i += 1;
      j += 1;
    } else if (lengths[at(i + 1, j)]! >= lengths[at(i, j + 1)]!) {
      middle.push({ kind: 'removed', text: midLeft[i]! });
      i += 1;
    } else {
      middle.push({ kind: 'added', text: midRight[j]! });
      j += 1;
    }
  }
  while (i < rows) middle.push({ kind: 'removed', text: midLeft[i++]! });
  while (j < cols) middle.push({ kind: 'added', text: midRight[j++]! });

  return [...head, ...middle, ...tail];
}
