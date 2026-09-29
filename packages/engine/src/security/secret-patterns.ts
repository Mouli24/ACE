/**
 * What counts as a secret, defined once (BR-07, NFR-SEC-02, FR-SYS-007).
 *
 * Two places consume this: `packages/storage-local` refuses to *write* a matching value to SQLite,
 * and the engine's logger *masks* one on its way to a log file. Those two answers must never drift
 * apart — a value the database rejects but the log prints is exactly the leak BR-07 exists to stop —
 * so the patterns live here, in the one package both are allowed to import.
 *
 * `packages/guardrails/src/rule-packs/secrets.ts` answers the same question for the `secret_leak`
 * check and the always-on output masker, with a type name per shape (FR-GRD-014). The engine may not
 * import that package, so the private-key and label rules below are kept in step with it by hand and
 * `packages/guardrails/src/__tests__/secret-drift.test.ts` proves the two agree. The direction that
 * matters most is D86's: whatever this list refuses, the guardrail masker must already have removed,
 * or a run fails at the write.
 *
 * Every pattern is linear in the length of the text (NFR-SAFE-01): this runs on every string the
 * repository writes and every line the engine logs.
 */

/** Field names whose value is a secret by definition, regardless of shape. */
export const SECRET_FIELD_NAMES: ReadonlySet<string> = new Set([
  'apikey',
  'api_key',
  'apisecret',
  'api_secret',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'privatekey',
  'private_key',
  'clientsecret',
  'client_secret',
  'password',
  'secret',
  'token',
  'authorization',
]);

/** One credential shape. */
export interface SecretPattern {
  /** Must carry the `g` flag: a scan walks the text once with `exec`. */
  readonly pattern: RegExp;
  /**
   * The capture group that holds the secret itself, when the pattern has to match a label around
   * it to be sure. Only that group is masked, so a log line still says what was there. The pattern
   * must then also carry the `d` flag, which is what reports where the group sits.
   */
  readonly group?: number;
  /** A test the secret must also pass — the judgement a regex cannot make on its own. */
  readonly verify?: (value: string) => boolean;
}

/* -------------------------------------------------------------------------- */
/* Private keys                                                                */
/* -------------------------------------------------------------------------- */

/** `RSA PRIVATE KEY`, `OPENSSH PRIVATE KEY`, `PGP PRIVATE KEY BLOCK`, or plain `PRIVATE KEY`. */
const KEY_KIND = '(?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?';
const HEADER = `-----BEGIN ${KEY_KIND}-----`;
const FOOTER = `-----END ${KEY_KIND}-----`;
/** A block's body: anything up to the next armour marker, so no header re-scans another's text. */
const BODY = '(?:(?!-----(?:BEGIN|END) )[\\s\\S])*?';
/** A PGP or encrypted-PEM armour header (`Version: GnuPG v2`, `Proc-Type: 4,ENCRYPTED`). */
const ARMOUR_LINE = '[A-Za-z][A-Za-z0-9-]*:[ \\t](?:[^\\n-]|-(?!----))*\\n';
/** A line or run of key material: base64, long enough that no English word qualifies. */
const MATERIAL = '[A-Za-z0-9+/=]{16,}';

/**
 * A header, then key material, then either the rest of the block to its footer or — for a block cut
 * off early — the material that follows. A header with no material after it is prose about keys
 * ("never print a line starting -----BEGIN …") and holds nothing to protect, so it is stored as
 * written; the `secret_leak` check still flags such a header in a node's *output*.
 */
const PRIVATE_KEY = `${HEADER}\\s*(?:${ARMOUR_LINE}\\s*)*${MATERIAL}(?:${BODY}${FOOTER}|(?:\\s*${MATERIAL})*)`;

/* -------------------------------------------------------------------------- */
/* The label rule                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A label that makes the long token after it a credential. It may be the tail of a longer name —
 * `OPENAI_API_KEY`, `DB_PASSWORD`, `"access_token"` — so it is only required not to follow a letter
 * or a digit (`\b` would refuse it after `_`).
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
 */
export function isCredentialValue(value: string): boolean {
  const pieces = value
    .replace(/=+$/, '')
    .split(/[+/_-]+/)
    .filter((piece) => piece !== '');
  if (pieces.some((piece) => /[A-Za-z]/.test(piece) && /\d/.test(piece))) return true;
  const [only] = pieces;
  return pieces.length === 1 && only !== undefined && /^(?:[a-z]+|[A-Z]+|\d+)$/.test(only);
}

/**
 * Credential shapes, wherever they appear. Each needs a long tail so ordinary prose mentioning
 * "sk-" or "Bearer" does not trip them.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { pattern: /\bghp_[A-Za-z0-9]{20,}/g },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { pattern: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}/g },
  { pattern: /\bBearer\s+[A-Za-z0-9._-]{24,}/g },
  { pattern: new RegExp(PRIVATE_KEY, 'g') },
  { pattern: new RegExp(LABELLED_VALUE, 'dgi'), group: 1, verify: isCredentialValue },
];

/** What a masked secret is replaced with in logs. */
export const REDACTED = '[REDACTED]';

export function isSecretFieldName(name: string): boolean {
  return SECRET_FIELD_NAMES.has(name.toLowerCase());
}

type Span = readonly [start: number, end: number];

/**
 * Every credential span in `value`, found on the original text. `stopAtFirst` is the cheap
 * question `looksLikeSecret` asks.
 */
function secretSpans(value: string, stopAtFirst: boolean): Span[] {
  const spans: Span[] = [];

  for (const { pattern, group = 0, verify } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(value); match !== null; match = pattern.exec(value)) {
      const captured = match[group];
      const at = group === 0 ? match.index : match.indices?.[group]?.[0];
      if (
        captured !== undefined &&
        captured !== '' &&
        at !== undefined &&
        (verify === undefined || verify(captured))
      ) {
        spans.push([at, at + captured.length]);
        if (stopAtFirst) {
          pattern.lastIndex = 0;
          return spans;
        }
      }
    }
  }

  return spans;
}

/** True when the string contains something credential-shaped. */
export function looksLikeSecret(value: string): boolean {
  return secretSpans(value, true).length > 0;
}

/**
 * Replace every credential-shaped run in a string. Every span is found on the original text first
 * and overlapping ones are joined, so masking one run can never cut the label off another and leave
 * its key behind (`Bearer ….token=<key>`).
 */
export function maskSecrets(value: string): string {
  const spans = secretSpans(value, false).sort((a, b) => a[0] - b[0] || b[1] - a[1]);

  let masked = '';
  // Everything before `maskedTo` is already behind a mask; a span that starts inside it (or right
  // at its end) only widens that mask.
  let maskedTo = -1;
  for (const [start, end] of spans) {
    if (start > maskedTo) masked += value.slice(Math.max(maskedTo, 0), start) + REDACTED;
    maskedTo = Math.max(maskedTo, end);
  }
  return masked + value.slice(Math.max(maskedTo, 0));
}
