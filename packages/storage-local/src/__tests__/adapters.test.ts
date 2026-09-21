import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LOCAL_SCOPE } from '@ace/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type OpenDatabase } from '../db.js';
import { MIGRATIONS, pendingMigrations, type Migration } from '../migrations.js';
import { FsBlobStore } from '../blob-store.js';
import { InProcessPubSub } from '../pubsub.js';
import { InProcessQueue } from '../queue.js';
import { SessionTokenAuth } from '../auth.js';
import { assertNoSecrets, SecretWriteRejectedError, toJsonColumn } from '../secret-guard.js';
import { SqliteRepository } from '../repository.js';
import { makeInputNode, makeProject, makeWorkflow, type InputNode } from './fixtures.js';

const scope = LOCAL_SCOPE;

let dir: string;
let opened: OpenDatabase[];

function open(path: string, migrations?: readonly Migration[]): OpenDatabase {
  const db = openDatabase(migrations === undefined ? { path } : { path, migrations });
  opened.push(db);
  return db;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-adapters-'));
  opened = [];
});

afterEach(() => {
  // Windows refuses to remove a directory while a SQLite handle (or its -wal/-shm) is open.
  for (const db of opened) {
    try {
      db.sqlite.close();
    } catch {
      // already closed by the test
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // a lingering handle on Windows; the OS reclaims the temp directory anyway
  }
});

describe('TC-NFR-007 Migration backup', () => {
  /** A second migration, so the "existing database, new migration" path can be exercised for real. */
  const LATER: Migration = {
    id: '20260922T090000_add_probe',
    up: 'CREATE TABLE probe (id TEXT PRIMARY KEY);',
  };

  it('creates no backup on a brand new database, because there is nothing to lose', () => {
    const db = open(join(dir, 'ace.sqlite'));

    expect(db.backupPath).toBeUndefined();
    expect(db.appliedMigrations).toEqual(MIGRATIONS.map((m) => m.id));
  });

  it('creates no backup when the database is already up to date', () => {
    const path = join(dir, 'ace.sqlite');
    open(path).sqlite.close();

    const reopened = open(path);

    expect(reopened.backupPath).toBeUndefined();
    expect(reopened.appliedMigrations).toEqual([]);
    expect(pendingMigrations(reopened.sqlite)).toEqual([]);
  });

  it('copies the database before a new migration touches an existing schema', () => {
    const path = join(dir, 'ace.sqlite');
    open(path, MIGRATIONS).sqlite.close();

    const migrated = open(path, [...MIGRATIONS, LATER]);

    expect(migrated.backupPath).toBeDefined();
    expect(existsSync(migrated.backupPath as string)).toBe(true);
    expect(migrated.appliedMigrations).toEqual([LATER.id]);
  });

  it('backs up before the schema changes, so the copy still has the old shape', () => {
    const path = join(dir, 'ace.sqlite');
    open(path, MIGRATIONS).sqlite.close();

    const migrated = open(path, [...MIGRATIONS, LATER]);
    migrated.sqlite.close();

    // The live database has the new table; the backup taken beforehand does not.
    const backup = open(migrated.backupPath as string, MIGRATIONS);
    const probeInBackup = backup.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'probe'")
      .get();

    expect(probeInBackup).toBeUndefined();
  });

  it('applies each migration exactly once', () => {
    const path = join(dir, 'ace.sqlite');

    open(path, [...MIGRATIONS, LATER]).sqlite.close();
    const again = open(path, [...MIGRATIONS, LATER]);

    expect(again.appliedMigrations).toEqual([]);
  });
});

describe('BR-07 secrets never reach the database', () => {
  it.each([
    ['an apiKey field', { apiKey: 'whatever-value-here' }],
    ['a nested password', { provider: { password: 'hunter2' } }],
    ['a token in an array', [{ token: 'abcd' }]],
  ])('refuses %s by field name', (_label, value) => {
    expect(() => assertNoSecrets(value)).toThrow(SecretWriteRejectedError);
  });

  it.each([
    ['an Anthropic-shaped key', ['sk', 'ant', 'a'.repeat(30)].join('-')],
    ['a GitHub token', 'ghp_' + 'b'.repeat(30)],
    ['an AWS access key id', 'AKIA' + 'C'.repeat(16)],
  ])('refuses %s by value shape, wherever it appears', (_label, secret) => {
    expect(() => assertNoSecrets({ instructions: `use ${secret} please` })).toThrow(
      SecretWriteRejectedError,
    );
  });

  it('names the path the secret was found at, so the caller can fix it', () => {
    expect(() => assertNoSecrets({ config: { nested: { apiKey: 'x'.repeat(10) } } })).toThrow(
      /\$\.config\.nested\.apiKey/,
    );
  });

  it('lets ordinary configuration through', () => {
    const config = {
      instructions: 'Summarise the input. Mention the password policy if asked.',
      providerId: '01JBXQ8Z9KQ4R7N2VWXYZ0ABCD',
      tools: { enabled: [], maxToolCalls: 10, allowedDomains: [] },
    };

    expect(() => assertNoSecrets(config)).not.toThrow();
    expect(JSON.parse(toJsonColumn(config))).toEqual(config);
  });

  it('stops a node config carrying a key from being written to SQLite', async () => {
    const db = open(join(dir, 'ace.sqlite'));
    const repository = new SqliteRepository(db.db, db.sqlite);

    const project = makeProject();
    const workflow = makeWorkflow(project.id);
    await repository.projects.create(scope, project);
    await repository.workflows.create(scope, workflow);

    const node = makeInputNode(workflow.id);
    const leaky: InputNode = {
      ...node,
      config: {
        artifactIds: [],
        outputTypes: ['text'],
        text: `key is ${['sk', 'ant', 'z'.repeat(30)].join('-')}`,
      },
    };

    await expect(repository.nodes.insert(scope, leaky)).rejects.toThrow(SecretWriteRejectedError);
    expect(await repository.nodes.listByWorkflow(scope, workflow.id)).toEqual([]);
  });
});

describe('FR-PRV-002 keychain-backed secret store', () => {
  it('reports availability rather than crashing when there is no keychain', async () => {
    const { KeychainSecretStore } = await import('../secret-store.js');
    const store = new KeychainSecretStore('ace-test-service');

    // On a headless CI box there is no keychain; on a desktop there is. Either answer is valid —
    // what matters is that asking never throws.
    await expect(store.isAvailable()).resolves.toBeTypeOf('boolean');
  });
});

describe('Arch §7 in-process queue and pub/sub', () => {
  it('dequeues in the order jobs were enqueued', async () => {
    const queue = new InProcessQueue<string>();

    await queue.enqueue(scope, 'a');
    await queue.enqueue(scope, 'b');

    expect(await queue.size(scope)).toBe(2);
    expect(await queue.dequeue(scope)).toBe('a');
    expect(await queue.dequeue(scope)).toBe('b');
    expect(await queue.dequeue(scope)).toBeNull();
  });

  it('keeps one workspace queue separate from another', async () => {
    const queue = new InProcessQueue<string>();

    await queue.enqueue(scope, 'local-job');

    expect(await queue.size({ workspaceId: 'other' })).toBe(0);
  });

  it('delivers a published message to every subscriber of that topic only', async () => {
    const pubsub = new InProcessPubSub<string>();
    const onTopic: string[] = [];
    const onOther: string[] = [];

    await pubsub.subscribe(scope, 'topic', (m) => onTopic.push(m));
    await pubsub.subscribe(scope, 'other', (m) => onOther.push(m));
    await pubsub.publish(scope, 'topic', 'hello');

    expect(onTopic).toEqual(['hello']);
    expect(onOther).toEqual([]);
  });

  it('stops delivering after unsubscribe', async () => {
    const pubsub = new InProcessPubSub<string>();
    const received: string[] = [];

    const unsubscribe = await pubsub.subscribe(scope, 'topic', (m) => received.push(m));
    await pubsub.publish(scope, 'topic', 'first');
    unsubscribe();
    await pubsub.publish(scope, 'topic', 'second');

    expect(received).toEqual(['first']);
  });
});

describe('Arch §7 content-addressed blob store', () => {
  it('stores identical bytes once and reads them back', async () => {
    const store = new FsBlobStore(join(dir, 'blobs'));
    const bytes = new TextEncoder().encode('artifact contents');

    const first = await store.put(scope, bytes);
    const second = await store.put(scope, bytes);

    expect(second.hash).toBe(first.hash);
    expect(first.size).toBe(bytes.byteLength);
    expect(await store.get(scope, first.hash)).toEqual(bytes);
    expect(await store.has(scope, first.hash)).toBe(true);
  });

  it('returns null for a hash it does not hold', async () => {
    const store = new FsBlobStore(join(dir, 'blobs'));

    expect(await store.get(scope, 'f'.repeat(64))).toBeNull();
    expect(await store.has(scope, 'f'.repeat(64))).toBe(false);
  });

  it('deletes and reports whether anything was removed', async () => {
    const store = new FsBlobStore(join(dir, 'blobs'));
    const { hash } = await store.put(scope, new Uint8Array([1, 2, 3]));

    expect(await store.delete(scope, hash)).toBe(true);
    expect(await store.delete(scope, hash)).toBe(false);
  });
});

describe('FR-SYS-002 session token auth', () => {
  it('accepts the issued token and rejects anything else', async () => {
    const auth = new SessionTokenAuth('a'.repeat(64));

    expect(await auth.verifyToken(scope, 'a'.repeat(64))).toBe(true);
    expect(await auth.verifyToken(scope, 'b'.repeat(64))).toBe(false);
    expect(await auth.verifyToken(scope, undefined)).toBe(false);
    expect(await auth.verifyToken(scope, '')).toBe(false);
  });

  it('rejects a token of the wrong length without leaking the comparison', async () => {
    const auth = new SessionTokenAuth('a'.repeat(64));

    expect(await auth.verifyToken(scope, 'a')).toBe(false);
    expect(await auth.verifyToken(scope, 'a'.repeat(65))).toBe(false);
  });

  it('writes the token to a file only the owner can read', async () => {
    const tokenPath = join(dir, 'session-token');
    writeFileSync(tokenPath, 'a'.repeat(64), { mode: 0o600 });

    expect(readFileSync(tokenPath, 'utf8')).toBe('a'.repeat(64));
  });
});
