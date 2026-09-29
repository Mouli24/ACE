/**
 * The machinery every regex rule pack shares: find the offending spans, resolve overlaps, replace
 * them with a type marker (FR-GRD-003, FR-GRD-007, FR-GRD-014).
 *
 * Two properties matter more than cleverness here:
 *
 *  - **Nothing leaves but the type.** `redactSpans` returns the sanitized text and the set of type
 *    names it replaced. The matched substring is never returned, never counted into a message, never
 *    stored on a `Verdict` — that is FR-GRD-014.
 *  - **Regexes are compiled once, at module scope.** A rule pack runs on every node of every run;
 *    building `new RegExp` per call is how a rule pack starts costing more than the 300 ms of
 *    NFR-SAFE-01.
 */

import { redactionMarker } from './types.js';

/** One rule of a pack: a `g`-flagged pattern and the *type name* a match is reported as. */
export interface Rule {
  /** Lowercase snake_case, so it satisfies `RedactedTypeSchema` (`/^[a-z][a-z0-9_]*$/`). */
  readonly type: string;
  /** Must carry the `g` flag — `findSpans` walks it with `exec`. */
  readonly pattern: RegExp;
  /**
   * Which capture group holds the part to redact, when the pattern has to match surrounding
   * context to be sure. Defaults to the whole match.
   */
  readonly group?: number;
  /** An extra test a match must survive, e.g. the Luhn check on a card-shaped run of digits. */
  readonly verify?: (matched: string) => boolean;
}

/** A pack is an ordered list: earlier rules win an overlap, so put the specific ones first. */
export type RulePack = readonly Rule[];

export interface Span {
  readonly start: number;
  readonly end: number;
  readonly type: string;
  /** The rule's index in its pack — the tie-break when two spans overlap. */
  readonly priority: number;
}

/**
 * Every span a pack matches, overlaps already resolved in favour of the earlier rule, sorted by
 * position. The matched text is deliberately not part of a `Span`.
 */
export function findSpans(text: string, pack: RulePack): Span[] {
  const found: Span[] = [];

  pack.forEach((rule, priority) => {
    const pattern = rule.pattern;
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      const span = spanOf(match, rule, priority);
      if (span !== undefined) found.push(span);
      // A zero-length match would spin forever; nudge past it.
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
      match = pattern.exec(text);
    }
  });

  return resolveOverlaps(found);
}

function spanOf(match: RegExpExecArray, rule: Rule, priority: number): Span | undefined {
  const whole = match[0];
  const groupIndex = rule.group ?? 0;
  const captured = match[groupIndex];
  if (captured === undefined || captured.length === 0) return undefined;
  if (rule.verify !== undefined && !rule.verify(captured)) return undefined;

  const offset = groupIndex === 0 ? 0 : whole.indexOf(captured);
  if (offset < 0) return undefined;

  const start = match.index + offset;
  return { start, end: start + captured.length, type: rule.type, priority };
}

/**
 * Keep the highest-priority span of any overlapping group. An email contains digits a phone rule
 * would happily claim, and a card number contains a run a phone rule would claim too; whichever
 * rule the pack lists first is the one that names the type.
 *
 * n log n in the number of spans (NFR-SAFE-01): one sort, then one merge pass per priority against
 * the spans already kept. Comparing every span with every kept span was quadratic — 50 000 hidden
 * markers took seconds.
 */
function resolveOverlaps(spans: readonly Span[]): Span[] {
  const byPriorityThenPosition = [...spans].sort(
    (a, b) => a.priority - b.priority || a.start - b.start || b.end - a.end,
  );

  // Disjoint and sorted by start — and therefore by end as well.
  let kept: Span[] = [];
  let index = 0;
  while (index < byPriorityThenPosition.length) {
    const priority = byPriorityThenPosition[index]?.priority;
    const accepted: Span[] = [];
    let cursor = 0;
    let acceptedEnd = -1;
    for (
      let span = byPriorityThenPosition[index];
      span !== undefined && span.priority === priority;
      span = byPriorityThenPosition[(index += 1)]
    ) {
      // The first kept span still reaching past this start is the only one that can clash with it.
      while ((kept[cursor]?.end ?? Infinity) <= span.start) cursor += 1;
      const clashesKept = (kept[cursor]?.start ?? Infinity) < span.end;
      const clashesAccepted = span.start < acceptedEnd;
      if (clashesKept || clashesAccepted) continue;
      accepted.push(span);
      acceptedEnd = span.end;
    }
    kept = mergeByStart(kept, accepted);
  }

  return kept;
}

/** Two start-sorted lists of spans as one start-sorted list, in linear time. */
function mergeByStart(left: readonly Span[], right: readonly Span[]): Span[] {
  const merged: Span[] = [];
  let l = 0;
  let r = 0;
  for (;;) {
    const a = left[l];
    const b = right[r];
    if (a === undefined && b === undefined) return merged;
    if (b === undefined || (a !== undefined && a.start <= b.start)) {
      if (a !== undefined) merged.push(a);
      l += 1;
    } else {
      merged.push(b);
      r += 1;
    }
  }
}

export interface Redaction {
  /** The text with every span replaced by `[<type> redacted]`. */
  readonly sanitized: string;
  /** The type names that were replaced, deduplicated, in the pack's own order. */
  readonly redactedTypes: string[];
  /** How many spans were replaced — a count is safe to report, the values are not. */
  readonly count: number;
}

/** Replace every span, back to front so the earlier offsets stay valid. */
export function redactSpans(text: string, spans: readonly Span[]): Redaction {
  const ordered = [...spans].sort((a, b) => a.start - b.start);

  let sanitized = '';
  let cursor = 0;
  for (const span of ordered) {
    sanitized += text.slice(cursor, span.start) + redactionMarker(span.type);
    cursor = span.end;
  }
  sanitized += text.slice(cursor);

  const seen = new Set<string>();
  const redactedTypes: string[] = [];
  for (const span of [...ordered].sort((a, b) => a.priority - b.priority)) {
    if (seen.has(span.type)) continue;
    seen.add(span.type);
    redactedTypes.push(span.type);
  }

  return { sanitized, redactedTypes, count: ordered.length };
}

/**
 * `2 email, 1 phone` — a reason line that counts and names, and quotes nothing (FR-GRD-014).
 * Ordered by the rule's place in its pack, so the reason and `redactedTypes` read the same way.
 */
export function describeSpans(spans: readonly Span[]): string {
  const counts = new Map<string, number>();
  for (const span of [...spans].sort((a, b) => a.priority - b.priority)) {
    counts.set(span.type, (counts.get(span.type) ?? 0) + 1);
  }
  return [...counts.entries()].map(([type, count]) => `${count} ${type}`).join(', ');
}
