/**
 * The prompt-injection rule pack (FR-GRD-003, TC-GRD-003, Arch §13.2).
 *
 * Three kinds of rule, and they are reported as three different types because they want different
 * fixes. An `injection_phrase` is something a human can read and judge. `hidden_markup` is an HTML
 * comment — text that is there in the source and gone once the page renders. A `hidden_marker` is a
 * zero-width, bidi, tag or variation-selector character a human cannot see at all, which is exactly
 * why it is worth failing on: it is how an instruction is smuggled past the reader of a document
 * (BR-13). The same characters also do honest work in emoji, Persian and Indic spelling, flags and
 * ideographs, so the rule looks at what stands around a run before it calls the run hidden.
 *
 * Arch §13.2 also lists "a small classifier via Ollama" at this point. That is optional and later
 * (CLAUDE.md §2, "Llama Guard via Ollama (optional, later)"); the rule pack is the local answer.
 */

import type { RulePack } from '../spans.js';

export const INJECTION_TYPES = ['injection_phrase', 'hidden_marker', 'hidden_markup'] as const;
export type InjectionType = (typeof INJECTION_TYPES)[number];

/**
 * The join between the words of a phrase: whitespace, optionally with up to three words in between,
 * so "ignore all of the previous instructions" reads as the same attempt as "ignore previous
 * instructions". Bounded at three, so the pattern cannot backtrack expensively (NFR-SAFE-01).
 */
const GAP = '(?:\\s+\\S+){0,3}\\s+';

const PHRASES: readonly string[] = [
  // The four the round file names, literally, so they can never fall through a generalisation.
  'ignore previous instructions',
  'disregard the system prompt',
  'you are now\\b',
  'print your system prompt',

  // …and the same attempts written any of the usual other ways.
  `ignore${GAP}(?:previous|prior|earlier|above|all)${GAP}instructions?`,
  `disregard${GAP}(?:previous|prior|earlier|above|system)${GAP}(?:instructions?|prompts?|rules?)`,
  `forget${GAP}(?:previous|prior|earlier|your|all)${GAP}(?:instructions?|rules?)`,
  `(?:print|reveal|repeat|show|output|display|echo)${GAP}(?:your|the)${GAP}(?:system prompt|system message|instructions?|initial prompt)`,
  `override${GAP}(?:your|the)${GAP}(?:rules?|instructions?|guardrails?|restrictions?)`,
];

/**
 * Hidden or direction-controlling characters: the zero-width space, non-joiner and joiner
 * (U+200B..U+200D), the byte-order mark (U+FEFF), the word joiner (U+2060), the bidi overrides and
 * isolates (U+202A..U+202E, U+2066..U+2069), and the tag characters (U+E0000..U+E007F), which spell
 * a whole sentence a reader cannot see and a model still reads.
 *
 * The ranges are written as code points and the character classes are assembled from them — once,
 * at module scope. Spelling them inline would put invisible characters into this file, which is both
 * unreviewable and something ESLint's `no-irregular-whitespace` rightly refuses.
 */
export const HIDDEN_MARKER_RANGES: readonly (readonly [number, number])[] = [
  [0x200b, 0x200d],
  [0xfeff, 0xfeff],
  [0x2060, 0x2060],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xe0000, 0xe007f],
];

/**
 * Variation selectors: the standard ones (U+FE00..U+FE0F — emoji presentation, keycaps) and the
 * ideographic supplement (U+E0100..U+E01EF). One selects a glyph variant of the character before
 * it; a run of them carries nothing a reader sees, which makes it a channel for smuggled bytes.
 */
export const VARIATION_SELECTOR_RANGES: readonly (readonly [number, number])[] = [
  [0xfe00, 0xfe0f],
  [0xe0100, 0xe01ef],
];

function runOf(ranges: readonly (readonly [number, number])[]): RegExp {
  const escape = (point: number): string => `\\u{${point.toString(16)}}`;
  const members = ranges.map(([low, high]) =>
    low === high ? escape(low) : `${escape(low)}-${escape(high)}`,
  );
  return new RegExp(`[${members.join('')}]+`, 'gu');
}

const ZWNJ = 0x200c;
const ZWJ = 0x200d;
const BOM = 0xfeff;
const BLACK_FLAG = 0x1f3f4;
const CANCEL_TAG = 0xe007f;
const FIRST_IDEOGRAPHIC_SELECTOR = 0xe0100;

/** The whole code point ending just before `index`, a surrogate pair included; none at the start. */
function pointBefore(text: string, index: number): number | undefined {
  if (index === 0) return undefined;
  const low = text.charCodeAt(index - 1);
  const high = index >= 2 ? text.charCodeAt(index - 2) : 0;
  const isPair = low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff;
  return isPair ? (high - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000 : low;
}

/**
 * Outside ASCII — an emoji, Persian, an Indic script. The joiners and ideographic selectors have
 * work to do next to such characters, and none next to an English letter or at the text's edge.
 */
const isBeyondAscii = (point: number | undefined): boolean => point !== undefined && point >= 0x80;

const codePoints = (run: string): number[] => [...run].map((char) => char.codePointAt(0) ?? 0);

/** A tag letter or digit — what a subdivision code (`gbeng`, `gbsct`, `usca`) is spelled in. */
const isTagLetterOrDigit = (point: number): boolean =>
  (point >= 0xe0030 && point <= 0xe0039) || (point >= 0xe0061 && point <= 0xe007a);

/**
 * The tags of a subdivision flag after its black flag: a CLDR subdivision id — a two-letter region
 * and a suffix of up to four, so three to seven tag letters or digits — then CANCEL TAG. Longer is
 * a sentence hidden behind a flag, not a flag.
 */
function isSubdivisionFlagTags(points: readonly number[]): boolean {
  const code = points.slice(0, -1);
  return (
    points.at(-1) === CANCEL_TAG &&
    code.length >= 3 &&
    code.length <= 7 &&
    code.every(isTagLetterOrDigit)
  );
}

/**
 * Whether a run of hidden characters hides something, rather than being part of the writing. Part
 * of the writing: one joiner or non-joiner between two characters beyond ASCII (an emoji sequence,
 * a Persian or Indic word), a byte-order mark that opens the text, and the tags of a subdivision
 * flag. Everything else — a zero-width space, a word joiner, a joiner inside an English word, a run
 * of any of them, a mid-text byte-order mark, a bidi control, a stray tag — hides something.
 */
function hidesText(run: string, text: string, start: number): boolean {
  const points = codePoints(run);
  const before = pointBefore(text, start);
  if (points.length === 1) {
    const only = points[0];
    if (only === BOM && start === 0) return false;
    const after = text.codePointAt(start + run.length);
    if ((only === ZWJ || only === ZWNJ) && isBeyondAscii(before) && isBeyondAscii(after)) {
      return false;
    }
  }
  return !(before === BLACK_FLAG && isSubdivisionFlagTags(points));
}

/**
 * Whether a run of variation selectors hides something. A run of standard selectors alone is left
 * be — a doubled emoji-presentation selector is sloppy, not hostile, and cannot spell text. Any run
 * of two or more with an ideographic selector in it is flagged: that is the shape bytes smuggled in
 * selectors take. One ideographic selector is part of the writing after a character beyond ASCII
 * (an ideograph's variant) and hides something after an English letter or at the start.
 */
function selectorsHideText(run: string, text: string, start: number): boolean {
  const points = codePoints(run);
  if (!points.some((point) => point >= FIRST_IDEOGRAPHIC_SELECTOR)) return false;
  if (points.length >= 2) return true;
  return !isBeyondAscii(pointBefore(text, start));
}

/**
 * An HTML comment: it does not render, so an instruction inside one reaches the model and not the
 * person reviewing the page. A comment left open hides everything after it, so the match runs to
 * the end of the text — and that alternative is also what keeps the scan linear: every `<!--` match
 * succeeds, at its closing marker or at the end, so no opener is ever rescanned from (NFR-SAFE-01).
 * Without the `$` alternative, each of 40 000 unclosed openers would rescan the rest of the text.
 */
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

/**
 * Hidden markup comes first, so a comment is named for what it is even when the text it hides trips
 * another rule too; the region redacted is the union either way (`findSpans`).
 */
export const INJECTION_RULES: RulePack = [
  { type: 'hidden_markup', pattern: HTML_COMMENT },
  { type: 'hidden_marker', pattern: runOf(HIDDEN_MARKER_RANGES), verify: hidesText },
  {
    type: 'hidden_marker',
    pattern: runOf(VARIATION_SELECTOR_RANGES),
    verify: selectorsHideText,
  },
  ...PHRASES.map((source) => ({
    type: 'injection_phrase' as const,
    pattern: new RegExp(source, 'gi'),
  })),
];
