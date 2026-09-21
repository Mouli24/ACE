/**
 * What counts as a secret, defined once (BR-07, NFR-SEC-02, FR-SYS-007).
 *
 * Two places consume this: `packages/storage-local` refuses to *write* a matching value to SQLite,
 * and the engine's logger *masks* one on its way to a log file. Those two answers must never drift
 * apart — a value the database rejects but the log prints is exactly the leak BR-07 exists to stop —
 * so the patterns live here, in the one package both are allowed to import.
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

/**
 * Value shapes that are a credential wherever they appear. Each needs a long tail so ordinary prose
 * mentioning "sk-" or "Bearer" does not trip them.
 */
export const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bghp_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{24,}/g,
];

/** What a masked secret is replaced with in logs. */
export const REDACTED = '[REDACTED]';

export function isSecretFieldName(name: string): boolean {
  return SECRET_FIELD_NAMES.has(name.toLowerCase());
}

/** True when the string contains something credential-shaped. */
export function looksLikeSecret(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

/** Replace every credential-shaped run in a string. */
export function maskSecrets(value: string): string {
  return SECRET_VALUE_PATTERNS.reduce(
    (masked, pattern) => masked.replace(new RegExp(pattern.source, 'g'), REDACTED),
    value,
  );
}
