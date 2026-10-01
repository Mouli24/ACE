/** Arch §24: a token is estimated as four characters. The engine's `estimateTokens` uses the same rule. */
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** The character budget of `tokens` tokens. */
export function tokensToChars(tokens: number): number {
  return Math.max(1, Math.floor(tokens)) * CHARS_PER_TOKEN;
}

/** Maps character offsets to 1-based line numbers. */
export function createLineIndex(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if ((starts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

export interface Span {
  start: number;
  end: number;
}

/** Shrinks a span to exclude surrounding whitespace; null when nothing is left. */
export function trimSpan(text: string, span: Span): Span | null {
  let { start, end } = span;
  while (start < end && /\s/.test(text.charAt(start))) start += 1;
  while (end > start && /\s/.test(text.charAt(end - 1))) end -= 1;
  return start < end ? { start, end } : null;
}

/**
 * Hard-splits a span into pieces of at most `max` characters, preferring to cut at whitespace when that
 * keeps at least half of the piece.
 */
export function hardSplit(text: string, span: Span, max: number): Span[] {
  const pieces: Span[] = [];
  let start = span.start;
  while (start < span.end) {
    let end = Math.min(span.end, start + max);
    if (end < span.end) {
      for (let i = end; i > start + max / 2; i -= 1) {
        if (/\s/.test(text.charAt(i - 1))) {
          end = i;
          break;
        }
      }
    }
    const trimmed = trimSpan(text, { start, end });
    if (trimmed) pieces.push(trimmed);
    start = end;
  }
  return pieces;
}
