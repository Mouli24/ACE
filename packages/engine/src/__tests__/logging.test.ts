import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLogger, logFileName, pruneOldLogs, redactSecrets } from '../logging/index.js';

let dir: string;

/** Assembled at runtime: a key-shaped literal in the repo is itself banned (CLAUDE.md §2). */
const FAKE_ANTHROPIC_KEY = ['sk', 'ant', 'a'.repeat(32)].join('-');
const FAKE_GITHUB_TOKEN = 'ghp_' + 'b'.repeat(36);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-logs-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Capture what the logger actually serialises, which is what would land in a log file. */
function captureLines(fn: (log: ReturnType<typeof createLogger>) => void): string[] {
  const lines: string[] = [];
  const log = createLogger({
    level: 'info',
    destination: { write: (line: string) => lines.push(line) },
  });
  fn(log);
  return lines;
}

describe('FR-SYS-007 no secrets in logs', () => {
  it('masks a provider key passed as a field value', () => {
    const [line] = captureLines((log) => log.info({ apiKey: FAKE_ANTHROPIC_KEY }, 'provider added'));

    expect(line).toBeDefined();
    expect(line).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(line).toContain('[REDACTED]');
  });

  it('masks a key buried inside a message string', () => {
    const [line] = captureLines((log) => log.info(`calling provider with ${FAKE_ANTHROPIC_KEY}`));

    expect(line).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(line).toContain('[REDACTED]');
  });

  it('masks a key nested deep inside an object', () => {
    const [line] = captureLines((log) =>
      log.info({ request: { headers: { authorization: `Bearer ${'c'.repeat(40)}` } } }, 'request'),
    );

    expect(line).not.toContain('c'.repeat(40));
    expect(line).toContain('[REDACTED]');
  });

  it('masks a key inside an array', () => {
    const [line] = captureLines((log) => log.info({ keys: [FAKE_GITHUB_TOKEN] }, 'tokens'));

    expect(line).not.toContain(FAKE_GITHUB_TOKEN);
  });

  it('redacts a field that is a secret by name even when its value looks harmless', () => {
    const [line] = captureLines((log) => log.info({ password: 'hunter2' }, 'login'));

    expect(line).not.toContain('hunter2');
  });

  it('leaves ordinary log content alone', () => {
    const [line] = captureLines((log) =>
      log.info({ workflowId: '01JBXQ8Z9KQ4R7N2VWXYZ0ABCD', version: 4 }, 'workflow.updated'),
    );

    expect(line).toContain('01JBXQ8Z9KQ4R7N2VWXYZ0ABCD');
    expect(line).toContain('workflow.updated');
    expect(line).not.toContain('[REDACTED]');
  });

  it('redacts recursively without losing the surrounding structure', () => {
    const redacted = redactSecrets({
      nodeId: '01JBXQ8Z9KQ4R7N2VWXYZ0ABCD',
      config: { apiKey: FAKE_ANTHROPIC_KEY, temperature: 0.7 },
    }) as { nodeId: string; config: { apiKey: string; temperature: number } };

    expect(redacted.nodeId).toBe('01JBXQ8Z9KQ4R7N2VWXYZ0ABCD');
    expect(redacted.config.temperature).toBe(0.7);
    expect(redacted.config.apiKey).toBe('[REDACTED]');
  });
});

describe('audit P-9 a logged error keeps what it says', () => {
  it('serialises an Error as its type, message, stack, code and cause, not {}', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
      code: 'ECONNREFUSED',
    });
    const error = new TypeError('fetch failed', { cause });

    const redacted = redactSecrets({ err: error }) as { err: Record<string, unknown> };

    expect(redacted.err).toMatchObject({
      type: 'TypeError',
      message: 'fetch failed',
      cause: { type: 'Error', code: 'ECONNREFUSED', message: cause.message },
    });
    expect(redacted.err['stack']).toContain('fetch failed');
  });

  it('masks a key in the message, the stack and the cause', () => {
    const error = new Error(`refused ${FAKE_ANTHROPIC_KEY}`, {
      cause: new Error(`also ${FAKE_GITHUB_TOKEN}`),
    });

    const [line] = captureLines((log) => log.warn({ err: error }, 'call failed'));

    expect(line).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(line).not.toContain(FAKE_GITHUB_TOKEN);
    const parsed = JSON.parse(line as string) as { err: Record<string, unknown> };
    expect(parsed.err['type']).toBe('Error');
    expect(parsed.err['message']).toContain('[REDACTED]');
    expect(parsed.err['stack']).toContain('[REDACTED]');
  });

  it('keeps an error’s own fields, masked like any object’s', () => {
    const error = Object.assign(new Error('nope'), { status: 401, apiKey: 'hunter2' });

    const redacted = redactSecrets(error) as Record<string, unknown>;

    expect(redacted['status']).toBe(401);
    expect(redacted['apiKey']).toBe('[REDACTED]');
  });
});

describe('FR-SYS-007 child logger per subsystem', () => {
  it('tags every line with the subsystem that wrote it', () => {
    const lines = captureLines((log) => {
      log.child({ subsystem: 'gateway' }).info('started');
      log.child({ subsystem: 'graph' }).info('applied');
    });

    expect(lines[0]).toContain('gateway');
    expect(lines[1]).toContain('graph');
  });

  it('still redacts through a child logger', () => {
    const lines = captureLines((log) =>
      log.child({ subsystem: 'providers' }).info({ apiKey: FAKE_ANTHROPIC_KEY }, 'configured'),
    );

    expect(lines[0]).not.toContain(FAKE_ANTHROPIC_KEY);
  });

  it('writes JSON, one object per line', () => {
    const [line] = captureLines((log) => log.info({ a: 1 }, 'hello'));

    expect(() => JSON.parse(line as string)).not.toThrow();
    expect(JSON.parse(line as string)).toMatchObject({ a: 1, msg: 'hello' });
  });
});

describe('FR-SYS-011 log rotation and retention', () => {
  it('names a log file by its date, so rotation is one file per day', () => {
    expect(logFileName(new Date('2026-09-21T23:59:00.000Z'))).toBe('ace-2026-09-21.log');
  });

  it('removes log files older than the retention window and keeps the rest', () => {
    const old = join(dir, 'ace-2020-01-01.log');
    const recent = join(dir, logFileName(new Date()));
    writeFileSync(old, 'old\n');
    writeFileSync(recent, 'recent\n');

    const ancient = new Date('2020-01-01T00:00:00.000Z');
    utimesSync(old, ancient, ancient);

    const removed = pruneOldLogs(dir, 14);

    expect(removed).toEqual([old]);
    expect(readdirSync(dir)).toEqual([logFileName(new Date())]);
    expect(readFileSync(recent, 'utf8')).toBe('recent\n');
  });

  it('leaves files that are not ours alone', () => {
    const notOurs = join(dir, 'something-else.txt');
    writeFileSync(notOurs, 'keep me');
    const ancient = new Date('2020-01-01T00:00:00.000Z');
    utimesSync(notOurs, ancient, ancient);

    expect(pruneOldLogs(dir, 14)).toEqual([]);
    expect(readdirSync(dir)).toContain('something-else.txt');
  });

  it('does not fall over when the log directory does not exist yet', () => {
    expect(pruneOldLogs(join(dir, 'missing'), 14)).toEqual([]);
  });
});
