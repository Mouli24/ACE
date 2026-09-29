/**
 * The secret-leak rule pack (FR-GRD-007, Arch §13.2 "Secret leaks — key-format patterns").
 *
 * These are the *shapes* the round file names: `sk-`, `sk-ant-`, `AIza`, `ghp_`, `AKIA`, a PEM or
 * PGP private-key block, and a generic long token that arrives behind a key-like label. Each shape
 * needs a long tail, or prose that merely mentions "sk-" trips the check.
 *
 * `packages/engine/src/security/secret-patterns.ts` holds the *storage* answer to the same
 * question — what SQLite refuses to write and what the logger masks (BR-07). That list has no type
 * names, because a log does not need one; a `Verdict` does (FR-GRD-014), so the shapes are named
 * here. The two cannot share code (the engine may not import this package), so the label rule and
 * `isCredentialValue` below are kept in step by hand, and `secret-drift.test.ts` asserts that both
 * lists catch — and both leave alone — every shape either side names.
 *
 * Every pattern here is linear in the length of the text: no quantified group can re-scan text a
 * failed attempt already walked (NFR-SAFE-01, `secret-shapes.test.ts`).
 */

import type { RulePack } from '../spans.js';

export const SECRET_TYPES = [
  'private_key',
  'anthropic_api_key',
  'openai_api_key',
  'google_api_key',
  'github_token',
  'aws_access_key_id',
  'slack_token',
  'bearer_token',
  'api_key',
] as const;
export type SecretType = (typeof SECRET_TYPES)[number];

/* -------------------------------------------------------------------------- */
/* Private keys                                                                */
/* -------------------------------------------------------------------------- */

/** `RSA PRIVATE KEY`, `OPENSSH PRIVATE KEY`, `PGP PRIVATE KEY BLOCK`, or plain `PRIVATE KEY`. */
const KEY_KIND = '(?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?';
const HEADER = `-----BEGIN ${KEY_KIND}-----`;
const FOOTER = `-----END ${KEY_KIND}-----`;
/**
 * A block's body: anything up to the next armour marker. Stopping at *any* `-----BEGIN ` or
 * `-----END ` rather than scanning on for a footer is what keeps the pack linear: a thousand
 * headers that never close each scan only as far as the next one.
 */
const BODY = '(?:(?!-----(?:BEGIN|END) )[\\s\\S])*?';
/** A PGP armour header (`Version: GnuPG v2`), which never runs past an armour marker. */
const ARMOUR_LINE = '[A-Za-z][A-Za-z0-9-]*:[ \\t](?:[^\\n-]|-(?!----))*\\n';
/** A line or run of key material: base64, long enough that no English word qualifies. */
const MATERIAL = '[A-Za-z0-9+/=]{16,}';

/* -------------------------------------------------------------------------- */
/* The label rule                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A label that makes the long token after it a credential rather than a hash or an id. It may be
 * the tail of a longer name — `OPENAI_API_KEY`, `DB_PASSWORD`, `"access_token"` — so it is only
 * required not to follow a letter or a digit (`\b` would refuse it after `_`).
 */
const KEY_LABEL =
  '(?<![A-Za-z0-9])(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|credentials?|auth)(?:[_-]?key)?';

/**
 * The label, then — on the same line — `:` or `=`, then the whole run of token characters, which
 * must not be followed by `(`: `token = createSessionToken(user)` is code, not a key.
 */
const LABELLED_VALUE = `${KEY_LABEL}["']?[ \\t]*[:=][ \\t]*["']?([A-Za-z0-9+/_-]{32,}={0,2})(?![A-Za-z0-9+/=_(-])`;

/**
 * Whether a run of 32+ token characters behind a label is a credential, or only words.
 *
 * - A piece that mixes letters and digits is random: `Zm9vYmFy…`, a hex digest, a UUID.
 * - One unbroken run of a single case, or of digits, is a passphrase or a numeric secret.
 * - Everything else is language: words joined by `_`, `-` or `/` are an identifier, a slug or a
 *   path (`your_api_key_here`, `/etc/kubernetes/pki`), and a mixed-case run with no digit is a
 *   type or a function name (`AuthenticationTokenProviderInterface`). A blank of underscores or
 *   dashes holds nothing at all.
 *
 * A random key with no digit anywhere in 32 characters is the price (about one in three hundred
 * for base62); the prefix rules above still name every provider key whatever its letters.
 */
function isCredentialValue(value: string): boolean {
  const pieces = value
    .replace(/=+$/, '')
    .split(/[+/_-]+/)
    .filter((piece) => piece !== '');
  if (pieces.some((piece) => /[A-Za-z]/.test(piece) && /\d/.test(piece))) return true;
  const [only] = pieces;
  return pieces.length === 1 && only !== undefined && /^(?:[a-z]+|[A-Z]+|\d+)$/.test(only);
}

export const SECRET_RULES: RulePack = [
  // A whole PEM or PGP block first: it contains base64 runs every later rule would happily claim.
  { type: 'private_key', pattern: new RegExp(`${HEADER}${BODY}${FOOTER}`, 'g') },
  // A block cut off before its footer: the header names a key on its own, and whatever key
  // material follows it goes with it, so a truncated key is never half-redacted.
  {
    type: 'private_key',
    pattern: new RegExp(
      `${HEADER}(?:\\s*(?:${ARMOUR_LINE}\\s*)*${MATERIAL}(?:\\s*${MATERIAL})*)?`,
      'g',
    ),
  },

  // `sk-ant-` before `sk-`: the longer prefix has to win the overlap to be named correctly.
  { type: 'anthropic_api_key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { type: 'openai_api_key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { type: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { type: 'github_token', pattern: /\bghp_[A-Za-z0-9]{20,}/g },
  { type: 'github_token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { type: 'aws_access_key_id', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: 'slack_token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}/g },
  {
    type: 'bearer_token',
    pattern: /\bBearer\s+([A-Za-z0-9._-]{24,})/g,
    group: 1,
  },

  // The generic rule, last. Only the token is redacted, so the label stays readable and the reader
  // can see what was removed.
  {
    type: 'api_key',
    pattern: new RegExp(LABELLED_VALUE, 'gi'),
    group: 1,
    verify: isCredentialValue,
  },
];
