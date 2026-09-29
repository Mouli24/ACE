/**
 * The PII rule pack (FR-GRD-003, FR-GRD-007, Arch §13.2 "PII — regex rule pack").
 *
 * Ordering is the whole design. An email address contains a run of characters the phone rule would
 * claim; a card number contains a run the phone rule would claim too. The pack is therefore listed
 * most-specific first and `findSpans` names an overlap after the earlier rule, so the type name a
 * `Verdict` carries is the right one. (The redaction still covers every overlapping finding whole.)
 */

import type { RulePack } from '../spans.js';

/** The type names this pack can report. Lowercase snake_case, so `RedactedTypeSchema` accepts them. */
export const PII_TYPES = ['email', 'iban', 'credit_card', 'national_id', 'phone'] as const;
export type PiiType = (typeof PII_TYPES)[number];

/**
 * The Luhn checksum. A 13-to-19-digit run is card-*shaped*; without this, every order number and
 * every long identifier in a document would be reported as a card and redacted out of the text.
 */
export function passesLuhn(candidate: string): boolean {
  const digits = candidate.replace(/[^0-9]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const code = digits.charCodeAt(i) - 48;
    let value = code;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

export const PII_RULES: RulePack = [
  // The lookbehind anchors a match to the first character of a run of local-part characters
  // (NFR-SAFE-01). Unanchored, the scan retried the local part from every position of a long run —
  // `a.a.a.…`, a hex blob, a page of letters — and rescanned the rest of the run each time: 40 KB of
  // dotted words took seconds. Anchored, each run is scanned once. It finds what the unanchored
  // pattern found, because a leftmost match always started at the run's first character anyway.
  {
    type: 'email',
    pattern:
      /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
  },

  // IBAN: two letters, two check digits, then 11–30 alphanumerics in optional groups of four.
  {
    type: 'iban',
    pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7} ?[A-Z0-9]{1,4}\b/g,
  },

  // Card-shaped: 13–19 digits, optionally spaced or dashed in groups — and Luhn-valid.
  {
    type: 'credit_card',
    pattern: /\b\d(?:[ -]?\d){12,18}\b/g,
    verify: passesLuhn,
  },

  // National-id-like: a US SSN and an Indian PAN are two distinctly shaped, widely used examples.
  { type: 'national_id', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { type: 'national_id', pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/g },

  // Phone: either an international `+` number, or a separated local number. Never a bare run of
  // digits — that is what the card rule is for, and a bare run is too often not a phone number.
  { type: 'phone', pattern: /\+\d(?:[ .-]?\d){7,16}\b/g },
  { type: 'phone', pattern: /\b\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g },
  { type: 'phone', pattern: /\b\d{5}[ .-]\d{5,6}\b/g },
];
