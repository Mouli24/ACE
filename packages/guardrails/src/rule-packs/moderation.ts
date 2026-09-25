/**
 * The moderation rule pack (FR-GRD-007, Arch §13.1 "Output — moderation", §13.2).
 *
 * Category word lists, matched on word boundaries. This is the *local, free* option of Arch §13.2 —
 * a keyword list is a blunt instrument and it is meant to be: the default policy's action for
 * moderation is `warn` (D10, round 3 §2.2), so a false positive costs a warning event, not a failed
 * run. The classifier (Llama Guard via Ollama) is the accurate option and it is later and optional.
 *
 * The lists hold clinical, neutral vocabulary for each category rather than slurs: a repository does
 * not need a dictionary of abuse in it to know that a word list matched.
 */

import type { RulePack } from '../spans.js';

export const MODERATION_CATEGORIES = [
  'violence',
  'self_harm',
  'sexual',
  'hate',
  'harassment',
  'weapons',
  'illegal_drugs',
] as const;
export type ModerationCategory = (typeof MODERATION_CATEGORIES)[number];

/** Word lists per category. Every entry is matched whole, case-insensitively. */
export const MODERATION_WORD_LISTS: Readonly<Record<ModerationCategory, readonly string[]>> = {
  violence: ['murder', 'homicide', 'behead', 'strangle', 'dismember', 'torture', 'massacre'],
  self_harm: ['suicide', 'self-harm', 'selfharm', 'cutting myself', 'overdose', 'kill myself'],
  sexual: ['pornographic', 'pornography', 'explicit sexual', 'sexually explicit'],
  hate: ['ethnic cleansing', 'racial superiority', 'subhuman', 'genocide'],
  harassment: ['dox', 'doxx', 'doxxing', 'stalk her', 'stalk him', 'swatting'],
  weapons: ['pipe bomb', 'nerve agent', 'pressure cooker bomb', 'silencer for', 'untraceable gun'],
  illegal_drugs: ['methamphetamine', 'fentanyl synthesis', 'cook meth', 'heroin synthesis'],
};

function escape(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One rule per category — a single alternation each, compiled once. `\b` on both ends keeps
 * "assassination" out of a match for "assassin"-style substrings of ordinary words.
 */
export const MODERATION_RULES: RulePack = MODERATION_CATEGORIES.map((category) => ({
  type: category,
  pattern: new RegExp(`\\b(?:${MODERATION_WORD_LISTS[category].map(escape).join('|')})\\b`, 'gi'),
}));
