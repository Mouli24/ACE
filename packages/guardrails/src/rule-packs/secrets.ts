/**
 * The secret-leak rule pack (FR-GRD-007, Arch §13.2 "Secret leaks — key-format patterns").
 *
 * These are the *shapes* the round file names: `sk-`, `sk-ant-`, `AIza`, `ghp_`, `AKIA`, a PEM
 * private-key block, and a generic long hex/base64 token that arrives behind a key-like label.
 * Each shape needs a long tail, or prose that merely mentions "sk-" trips the check.
 *
 * `packages/engine/src/security/secret-patterns.ts` holds the *storage* answer to the same
 * question — what SQLite refuses to write and what the logger masks (BR-07). That list has no type
 * names, because a log does not need one; a `Verdict` does (FR-GRD-014), so the shapes are named
 * here. `secrets.drift.test.ts` asserts that every shape the storage guard rejects is also caught
 * by this pack, which is the guard against the two lists drifting apart.
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

/** A label that makes the long token after it a credential rather than a hash or an id. */
const KEY_LABEL = '(?:api[_-]?key|secret|token|password|passwd|credential|auth)';

export const SECRET_RULES: RulePack = [
  // A PEM block first: it contains base64 runs every later rule would happily claim.
  {
    type: 'private_key',
    pattern:
      /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
  },
  // A truncated block still names a key; the marker alone is enough to fail the check.
  { type: 'private_key', pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g },

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

  // The generic rule, last: 32+ hex or base64 characters behind a key-like label. Only the token
  // is redacted, so the label stays readable and the reader can see what was removed.
  {
    type: 'api_key',
    pattern: new RegExp(`\\b${KEY_LABEL}\\b["']?\\s*[:=]\\s*["']?([A-Za-z0-9+/=_-]{32,})`, 'gi'),
    group: 1,
  },
];
