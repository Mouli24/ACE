/**
 * The context-point checks (round 5 §2.3, FR-GRD-004, TC-GRD-005): what runs over retrieved chunks,
 * memory values, upstream outputs and tool results before they reach a prompt.
 *
 * `prompt_injection` at this point does not merely detect — it **strips** hidden instructions and
 * returns the clean text as `sanitized`; the engine uses it when the check's action is `warn`,
 * `redact` or `block` (F13). `strippedTypes` names the kinds removed, once each, in the order they
 * first appear in the text. As everywhere in this package, the removed payload never leaves: the
 * `reason` counts and names, and only `sanitized` carries text.
 *
 * Every scan is linear in the text (NFR-SAFE-01): comments are found with `indexOf`, the rest are
 * single-pass regexes without nested quantifiers.
 */

import type { GuardrailCheck, HiddenInstructionType } from '@ace/contracts';

import type { CheckResult } from '../types.js';
import { checkPii } from './text.js';

export type ContextInjectionResult = CheckResult & { strippedTypes?: HiddenInstructionType[] };

interface Found {
  readonly start: number;
  readonly end: number;
  readonly type: HiddenInstructionType;
}

/** U+200B–U+200D, U+2060 and U+FEFF: characters that render as nothing. */
const ZERO_WIDTH = new RegExp('[\u200B-\u200D\u2060\uFEFF]', 'g');

/** `[//]: # (…)` and `[//]: <> (…)`: a Markdown comment, which no renderer shows. One whole line. */
const MARKDOWN_COMMENT = /^[ \t]*\[\/\/\]:[ \t]*(?:#|<>)[ \t]*\([^)\n]*\)[ \t]*$/gm;

/** "ignore/disregard/forget (all) (previous|prior|above) instructions…", to the sentence end. */
const INSTRUCTION_OVERRIDE =
  /\b(?:ignore|disregard|forget)[ \t]+(?:all[ \t]+)?(?:(?:the|your|my)[ \t]+)?(?:previous|prior|above)[ \t]+(?:instructions?|prompts?|rules)\b[^.!?\n]*[.!?]?/gi;

/** A run of base64 alphabet at least 200 characters long. */
const BASE64_RUN = /[A-Za-z0-9+/=]{200,}/g;

/** Whether text decoded from a base64 run reads as an instruction (non-global, so stateless). */
const INSTRUCTION_PHRASE =
  /\b(?:ignore|disregard|forget)[ \t]+(?:all[ \t]+)?(?:(?:the|your|my)[ \t]+)?(?:previous|prior|above)[ \t]+(?:instructions?|prompts?|rules)\b|\byou[ \t]+are[ \t]+now\b|\bsystem[ \t]+prompt\b/i;

function regexFound(text: string, pattern: RegExp, type: HiddenInstructionType): Found[] {
  const out: Found[] = [];
  pattern.lastIndex = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    if (match[0].length === 0) {
      pattern.lastIndex += 1;
    } else {
      out.push({ start: match.index, end: match.index + match[0].length, type });
    }
    match = pattern.exec(text);
  }
  return out;
}

/** `<!-- … -->` by `indexOf`: an unterminated opener ends the search, so the scan stays linear. */
function htmlComments(text: string): Found[] {
  const out: Found[] = [];
  let from = text.indexOf('<!--');
  while (from !== -1) {
    const close = text.indexOf('-->', from + 4);
    if (close === -1) break;
    out.push({ start: from, end: close + 3, type: 'html_comment' });
    from = text.indexOf('<!--', close + 3);
  }
  return out;
}

function base64Payloads(text: string): Found[] {
  return regexFound(text, BASE64_RUN, 'base64_payload').filter((run) => {
    const decoded = Buffer.from(text.slice(run.start, run.end), 'base64').toString('utf8');
    return INSTRUCTION_PHRASE.test(decoded);
  });
}

function isAsciiAt(text: string, index: number): boolean {
  return index >= 0 && index < text.length && text.charCodeAt(index) < 128;
}

/**
 * Zero-width characters. U+200B, U+2060 and U+FEFF are always hidden. U+200C and U+200D are only
 * hidden beside an ASCII character, where they obfuscate a Latin-script instruction; between two
 * non-ASCII characters they are real text (Persian and Indic ZWNJ, emoji ZWJ sequences) and are
 * kept, and keeping them is not a finding.
 */
function zeroWidth(text: string): Found[] {
  return regexFound(text, ZERO_WIDTH, 'zero_width').filter((item) => {
    const code = text.charCodeAt(item.start);
    if (code !== 0x200c && code !== 0x200d) return true;
    return isAsciiAt(text, item.start - 1) || isAsciiAt(text, item.end);
  });
}

/** Position order, longest first at the same position. */
function inOrder(found: Found[]): Found[] {
  return found.sort((a, b) => a.start - b.start || b.end - a.end);
}

/** Remove the union of the spans: a zero-width character inside a comment goes with the comment. */
function removeSpans(text: string, found: readonly Found[]): string {
  let stripped = '';
  let cursor = 0;
  for (const item of found) {
    if (item.start > cursor) stripped += text.slice(cursor, item.start);
    cursor = Math.max(cursor, item.end);
  }
  return stripped + text.slice(cursor);
}

/**
 * Two passes, so an instruction cannot hide by being split. Pass 1 removes what is invisible
 * (zero-width characters, HTML and Markdown comments). Pass 2 looks for instruction overrides and
 * base64 payloads in pass 1's output, where `ig<!--x-->nore previous instructions` has become what
 * it says. `found` holds both passes' findings, pass 1 first, each in text order.
 */
function stripPasses(text: string): { text: string; found: Found[] } {
  const first = inOrder([
    ...htmlComments(text),
    ...regexFound(text, MARKDOWN_COMMENT, 'markdown_comment'),
    ...zeroWidth(text),
  ]);
  const visible = removeSpans(text, first);
  const second = inOrder([
    ...regexFound(visible, INSTRUCTION_OVERRIDE, 'instruction_override'),
    ...base64Payloads(visible),
  ]);
  return { text: removeSpans(visible, second), found: [...first, ...second] };
}

function typesOf(found: readonly Found[]): HiddenInstructionType[] {
  const types: HiddenInstructionType[] = [];
  for (const item of found) {
    if (!types.includes(item.type)) types.push(item.type);
  }
  return types;
}

/**
 * Remove every hidden instruction from `text`. `strippedTypes` lists each kind found once, in the
 * order it was found (pass 1's kinds, then pass 2's); text with nothing hidden comes back untouched.
 */
export function stripHiddenInstructions(text: string): {
  text: string;
  strippedTypes: HiddenInstructionType[];
} {
  const { text: stripped, found } = stripPasses(text);
  return { text: stripped, strippedTypes: typesOf(found) };
}

/**
 * `prompt_injection` at the context point. `passed: false` whenever anything hidden was found, with
 * the cleaned text as `sanitized` — whatever the action, because the engine decides whether to use
 * it (F13: `warn`, `redact` and `block` strip; `pass` only reports).
 */
export function checkContextInjection(
  _check: GuardrailCheck,
  text: string,
): ContextInjectionResult {
  const { text: sanitized, found } = stripPasses(text);
  if (found.length === 0) {
    return { passed: true, reason: 'No hidden instruction found in context.' };
  }
  const strippedTypes = typesOf(found);

  // Counts per type, in first-found order — numbers and type names only, never the payload.
  const counts = new Map<HiddenInstructionType, number>();
  for (const item of found) counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
  const described = [...counts.entries()].map(([type, count]) => `${count} ${type}`).join(', ');

  return {
    passed: false,
    reason: `Hidden instructions found in context: ${described}.`,
    strippedTypes,
    sanitized,
  };
}

/** `pii` at the context point: the same pack as input and output, with the text redacted by type. */
export function checkContextPii(check: GuardrailCheck, text: string): CheckResult {
  return checkPii(check, text);
}

/** `untrusted_tagging`: tagging is the engine's doing; the check only says it will happen. */
export function checkUntrustedTagging(): CheckResult {
  return { passed: true, reason: 'Tagged untrusted.' };
}
