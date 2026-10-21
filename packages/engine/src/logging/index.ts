import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import pino, { type Logger } from 'pino';

import { isSecretFieldName, looksLikeSecret, maskSecrets, REDACTED } from '../security/secret-patterns.js';

/**
 * Structured logging (FR-SYS-007, FR-SYS-011, Arch §26).
 *
 * BR-07 is the reason this module is not just `pino()`. Pino's own `redact` option only knows about
 * paths that are declared up front, which cannot catch a key pasted into a free-text message or
 * nested somewhere nobody predicted. Every value is therefore walked and masked on its way out,
 * using the same patterns `packages/storage-local` refuses to persist.
 */

export type { Logger };

const MAX_REDACT_DEPTH = 8;

/**
 * Replace every secret in a log payload: values that look like credentials wherever they appear,
 * any field whose name makes it a secret by definition, and a field *name* that is itself
 * credential-shaped — `{ [key]: true }` prints the key as surely as `{ apiKey: key }` does.
 */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) return value;

  if (typeof value === 'string') {
    return looksLikeSecret(value) ? maskSecrets(value) : value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, depth + 1));
  }

  if (value instanceof Error) return redactError(value, depth);

  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const name = looksLikeSecret(key) ? maskSecrets(key) : key;
      out[name] = isSecretFieldName(key) ? REDACTED : redactSecrets(child, depth + 1);
    }
    return out;
  }

  return value;
}

/**
 * An error as a plain object, every part masked [audit P-9]. `message` and `stack` are not
 * enumerable, so walking an `Error` like any other object logged it as `{}` — and the redaction runs
 * before pino's own error serializer, which then had nothing left to read.
 */
function redactError(error: Error, depth: number): Record<string, unknown> {
  // Its enumerable fields too — a `status`, a `nodeError` — walked like any object's.
  const fields = redactSecrets(Object.fromEntries(Object.entries(error)), depth);
  const { code } = error as { code?: unknown };
  return {
    ...(fields as Record<string, unknown>),
    type: error.name,
    message: redactSecrets(error.message, depth + 1),
    ...(error.stack === undefined ? {} : { stack: redactSecrets(error.stack, depth + 1) }),
    ...(code === undefined ? {} : { code: redactSecrets(code, depth + 1) }),
    ...(error.cause === undefined ? {} : { cause: redactSecrets(error.cause, depth + 1) }),
  };
}

export interface CreateLoggerOptions {
  level?: string;
  /** Where lines go. Defaults to stdout; the server passes a rotating file stream. */
  destination?: { write(line: string): void };
}

/**
 * A JSON logger with redaction wired in. Subsystems take a child logger
 * (`log.child({ subsystem: 'gateway' })`) so every line says where it came from.
 */
export function createLogger({ level = 'info', destination }: CreateLoggerOptions = {}): Logger {
  return pino(
    {
      level,
      base: undefined,
      formatters: {
        // Runs for every line, including those from child loggers.
        log: (object) => redactSecrets(object) as Record<string, unknown>,
      },
      // `err` arrives already serialised and masked by `redactSecrets`; pino's own serializer would
      // re-read it as an error and stamp it `type: "Object"` [audit P-9].
      serializers: { err: (value: unknown) => value },
      hooks: {
        logMethod(args, method) {
          // The message string is not part of `formatters.log`, so mask it separately.
          const masked = args.map((arg) => (typeof arg === 'string' ? maskSecrets(arg) : arg));
          return method.apply(this, masked as typeof args);
        },
      },
    },
    destination as pino.DestinationStream | undefined,
  );
}

/* -------------------------------------------------------------------------- */
/* Rotation and retention (FR-SYS-011)                                         */
/* -------------------------------------------------------------------------- */

const LOG_FILE_PATTERN = /^ace-\d{4}-\d{2}-\d{2}\.log$/;

/** One file per UTC day, which is what makes rotation a matter of opening a new name. */
export function logFileName(when: Date = new Date()): string {
  return `ace-${when.toISOString().slice(0, 10)}.log`;
}

/**
 * Delete engine log files older than `retentionDays` (FR-SYS-011: 14 days by default).
 * Files this engine did not write are left alone. Returns what was removed.
 */
export function pruneOldLogs(directory: string, retentionDays: number): string[] {
  if (!existsSync(directory)) return [];

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const removed: string[] = [];

  for (const name of readdirSync(directory)) {
    if (!LOG_FILE_PATTERN.test(name)) continue;

    const path = join(directory, name);
    if (statSync(path).mtimeMs >= cutoff) continue;

    unlinkSync(path);
    removed.push(path);
  }

  return removed;
}

/** Ensure `<dataDir>/logs` exists and return it. */
export function logDirectory(dataDir: string): string {
  const directory = join(dataDir, 'logs');
  mkdirSync(directory, { recursive: true });
  return directory;
}
