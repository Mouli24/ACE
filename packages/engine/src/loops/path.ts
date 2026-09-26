/**
 * Reading a loop's exit path out of a node's json output (FR-PAR-004, round 3 §2.4).
 *
 * The grammar is exactly what `DOTTED_PATH_REGEX` in `@ace/contracts` lets an edge be saved with —
 * `verdict`, `review.verdict`, `issues.0`, `issues[0]` — so every path the loop edge editor accepts
 * is one this reader resolves, and there is no second, looser grammar to drift from it (D73).
 *
 * A path that does not exist reads as `undefined` rather than throwing: a reviewer that answered
 * without the field has not met the exit condition, which is a loop decision, not a crash.
 */

/** The segments of a dotted path: `review.issues[0]` → `['review', 'issues', '0']`. */
export function pathSegments(path: string): string[] {
  return path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((segment) => segment !== '');
}

/** The value at `path` inside `value`, or `undefined` when any step of it is missing. */
export function readPath(value: unknown, path: string): unknown {
  let current = value;

  for (const segment of pathSegments(path)) {
    if (current === null || current === undefined) return undefined;

    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }

    if (typeof current !== 'object') return undefined;
    // `Object.hasOwn`: an inherited key such as `constructor` is not part of the model's answer.
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}
