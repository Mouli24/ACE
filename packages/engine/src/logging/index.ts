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
 * and any field whose name makes it a secret by definition.
 */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) return value;

  if (typeof value === 'string') {
    return looksLikeSecret(value) ? maskSecrets(value) : value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, depth + 1));
  }

  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = isSecretFieldName(key) ? REDACTED : redactSecrets(child, depth + 1);
    }
    return out;
  }

  return value;
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
