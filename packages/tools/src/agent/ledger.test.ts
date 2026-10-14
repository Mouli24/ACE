import { describe, expect, it } from 'vitest';

import { contentHash, createReadLedger } from './ledger.js';

describe('FR-TOOL-008 read ledger (agentic nodes, read-before-edit)', () => {
  it('hashes text and bytes alike as sha256 hex', () => {
    expect(contentHash('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(contentHash(Buffer.from('abc', 'utf8'))).toBe(contentHash('abc'));
  });

  it('answers what each node last saw, and nothing for a file it never read', () => {
    const ledger = createReadLedger();
    ledger.record('a', '/p/x.ts', 'h1');
    expect(ledger.seen('a', '/p/x.ts')).toBe('h1');
    expect(ledger.seen('b', '/p/x.ts')).toBeUndefined();
    expect(ledger.seen('a', '/p/y.ts')).toBeUndefined();
    ledger.record('a', '/p/x.ts', 'h2');
    expect(ledger.seen('a', '/p/x.ts')).toBe('h2');
  });

  it('keys paths case-insensitively on Windows only', () => {
    const win = createReadLedger({ platform: 'win32' });
    win.record('a', 'C:\\P\\X.ts', 'h');
    expect(win.seen('a', 'c:\\p\\x.TS')).toBe('h');
    const posix = createReadLedger({ platform: 'linux' });
    posix.record('a', '/p/X.ts', 'h');
    expect(posix.seen('a', '/p/x.ts')).toBeUndefined();
  });
});
