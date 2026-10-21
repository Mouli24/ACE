import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import {
  defaultGuardrailChecks,
  type Artifact,
  type KbChunk,
  type KnowledgeBase,
  type Run,
} from '@ace/contracts';
import { newId, type BackupStore } from '@ace/engine';
import BetterSqlite3 from 'better-sqlite3';
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BACKUP_FORMAT_VERSION,
  BACKUP_KIND,
  createBackupStore,
  type BackupManifest,
  type BackupStoreDeps,
} from '../backup.js';
import { FsBlobStore } from '../blob-store.js';
import { openDatabase, type OpenDatabase } from '../db.js';
import { MIGRATIONS, ROUND_5_MIGRATION_ID } from '../migrations.js';
import { SqliteRepository } from '../repository.js';
import { KeychainSecretStore } from '../secret-store.js';
import { makeProject, scope } from './fixtures.js';

/**
 * Backup and restore (round 5 §2.7, FR-SYS-012, TC-SYS-014, F12): the export is a zip of a
 * `VACUUM INTO` snapshot, the blobs, the settings and a manifest — never a key — and the import
 * restores in place into the live handle through `ATTACH`, after checking the zip is an ACE backup
 * and writing a backup of what it is about to replace.
 */

interface Engine {
  dataDir: string;
  opened: OpenDatabase;
  repository: SqliteRepository;
  blobs: FsBlobStore;
  backup: BackupStore;
}

let dirs: string[];
let handles: OpenDatabase[];

beforeEach(() => {
  dirs = [];
  handles = [];
});

afterEach(() => {
  for (const handle of handles.reverse()) {
    try {
      handle.sqlite.close();
    } catch {
      // already closed by the test
    }
  }
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // a lingering handle on Windows; the OS reclaims the temp directory anyway
    }
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A data directory as `startEngine` lays it out: `ace.sqlite`, `blobs/`, settings in the DB. */
async function startEngine(name: string, migrations?: typeof MIGRATIONS): Promise<Engine> {
  const dataDir = tempDir(`ace-backup-${name}-`);
  const opened = openDatabase({
    path: join(dataDir, 'ace.sqlite'),
    ...(migrations ? { migrations } : {}),
  });
  handles.push(opened);
  const repository = new SqliteRepository(opened.db, opened.sqlite);
  const blobs = new FsBlobStore(join(dataDir, 'blobs'));
  const backup = createBackupStore({
    sqlite: opened.sqlite,
    dataDir,
    blobsDir: join(dataDir, 'blobs'),
    settings: repository.settings,
    exclusive: (fn) => repository.exclusive(fn),
  });
  return { dataDir, opened, repository, blobs, backup };
}

const NOW = '2026-10-01T10:00:00.000Z';

/** A project with a run, an artifact (bytes in the blob store), and a searchable knowledge base. */
async function seedData(engine: Engine) {
  const project = makeProject({ name: 'Exported' });
  await engine.repository.projects.create(scope, project);
  const run: Run = {
    id: newId(),
    workflowId: newId(),
    projectId: project.id,
    status: 'COMPLETE',
    snapshot: { version: 1, nodes: [], edges: [] },
    inputs: {},
    preflightIssues: [],
    totals: { tokensIn: 1, tokensOut: 2, costUsd: 0.5 },
    startedAt: NOW,
  };
  await engine.repository.runs.create(scope, run);

  const bytes = strToU8('the artifact bytes');
  const blob = await engine.blobs.put(scope, bytes);
  const artifact: Artifact = {
    id: newId(),
    hash: blob.hash,
    mime: 'text/plain',
    name: 'notes.txt',
    size: blob.size,
    createdAt: NOW,
  };
  await engine.repository.artifacts.create(scope, artifact);

  const kb: KnowledgeBase = {
    id: newId(),
    projectId: project.id,
    name: 'Handbook',
    embeddingProviderId: newId(),
    embeddingModelId: 'mock-embed',
    chunkSize: 700,
    chunkOverlap: 90,
    documentCount: 0,
    chunkCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
  await engine.repository.knowledgeBases.insert(scope, kb);
  const documentId = newId();
  const chunk: KbChunk = {
    id: newId(),
    documentId,
    knowledgeBaseId: kb.id,
    ordinal: 0,
    text: 'The zephyrine-protocol-7 governs the gate.',
    tokens: 11,
    source: 'guide.md#gate',
    headings: [],
  };
  await engine.repository.kbChunks.replaceForDocument(scope, documentId, [chunk], [[1, 0, 0]]);

  await engine.repository.settings.update(scope, {
    dataDir: engine.dataDir,
    allowedOrigins: ['http://exporter.test'],
    concurrency: 5,
    theme: 'light',
  });
  return { project, run, artifact, blob, bytes, kb, chunk };
}

/**
 * Every file under a directory, with its size and mtime — what "untouched" is checked against. The
 * WAL index (`-shm`) is shared memory a mere read writes to, so it is not data and is left out.
 */
function snapshotDir(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (!entry.name.endsWith('-shm')) {
        const stats = statSync(path);
        out[relative(root, path)] = `${stats.size}:${stats.mtimeMs}`;
      }
    }
  };
  walk(root);
  return out;
}

function manifest(overrides: Partial<Record<keyof BackupManifest, unknown>> = {}) {
  return strToU8(
    JSON.stringify({
      kind: BACKUP_KIND,
      formatVersion: BACKUP_FORMAT_VERSION,
      exportedAt: NOW,
      migrations: MIGRATIONS.map((migration) => migration.id),
      ...overrides,
    }),
  );
}

describe('TC-SYS-014 backup: the zip holds ace.sqlite, blobs, settings.json, backup.json and no keychain material', () => {
  it('exports the four parts, and no entry carries the key the keychain holds', async () => {
    const engine = await startEngine('export');
    const { blob, bytes } = await seedData(engine);

    // A provider key, in the keychain where keys live (BR-07) — assembled at runtime (CLAUDE.md §2).
    const fakeKey = ['sk', '-', 'ant', '-', 'Zm9vYmFy'.repeat(5)].join('');
    const keychain = new Map<string, string>();
    class FakeEntry {
      constructor(
        private readonly service: string,
        private readonly account: string,
      ) {}
      getPassword(): string {
        return keychain.get(`${this.service}:${this.account}`) ?? '';
      }
      setPassword(value: string): void {
        keychain.set(`${this.service}:${this.account}`, value);
      }
      deletePassword(): boolean {
        return keychain.delete(`${this.service}:${this.account}`);
      }
    }
    const secrets = new KeychainSecretStore('ace-test', async () => FakeEntry as never);
    await secrets.set(scope, 'provider:anthropic', fakeKey);
    expect(await secrets.get(scope, 'provider:anthropic')).toBe(fakeKey);

    const zip = await engine.backup.exportZip();
    const entries = unzipSync(zip);

    expect(Object.keys(entries).sort()).toEqual(
      [
        'ace.sqlite',
        'backup.json',
        `blobs/${scope.workspaceId}/${blob.hash.slice(0, 2)}/${blob.hash}`,
        'settings.json',
      ].sort(),
    );
    expect(
      strFromU8(entries[`blobs/${scope.workspaceId}/${blob.hash.slice(0, 2)}/${blob.hash}`]!),
    ).toBe(strFromU8(bytes));
    expect(strFromU8(entries['ace.sqlite']!.subarray(0, 15))).toBe('SQLite format 3');

    const parsed = JSON.parse(strFromU8(entries['backup.json']!)) as BackupManifest;
    expect(parsed).toEqual({
      kind: 'ace-backup',
      formatVersion: 1,
      exportedAt: expect.any(String),
      migrations: MIGRATIONS.map((migration) => migration.id),
    });
    expect(Number.isNaN(Date.parse(parsed.exportedAt))).toBe(false);
    const settings = JSON.parse(strFromU8(entries['settings.json']!)) as Record<string, unknown>;
    expect(settings).toMatchObject({ dataDir: engine.dataDir, concurrency: 5, theme: 'light' });

    // The deep scan: every byte of every entry, the SQLite snapshot included.
    const needle = Buffer.from(fakeKey, 'utf8');
    for (const [name, data] of Object.entries(entries)) {
      expect(Buffer.from(data).includes(needle), `${name} carries the key`).toBe(false);
    }
    expect(Buffer.from(zip).includes(needle)).toBe(false);
  });

  it('exports a data directory that has no blobs yet', async () => {
    const engine = await startEngine('empty');
    rmSync(join(engine.dataDir, 'blobs'), { recursive: true, force: true });

    const entries = unzipSync(await engine.backup.exportZip());
    expect(Object.keys(entries).sort()).toEqual(['ace.sqlite', 'backup.json', 'settings.json']);
  });

  it('requires the exclusive runner, so the wiring cannot be forgotten', () => {
    // A compile-time check: `tsc` refuses this assignment while `exclusive` is optional.
    type IsRequired<T, K extends keyof T> = Record<never, never> extends Pick<T, K> ? false : true;
    const exclusiveIsRequired: IsRequired<BackupStoreDeps, 'exclusive'> = true;
    expect(exclusiveIsRequired).toBe(true);
  });

  it('waits for an open repository transaction instead of failing VACUUM INTO', async () => {
    const engine = await startEngine('busy');
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const project = makeProject({ name: 'Written while exporting' });
    const writer = engine.repository.transaction(async (tx) => {
      await tx.projects.create(scope, project);
      await held;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // SQLite refuses VACUUM INTO while this transaction is open on the connection — which is what
    // a store wired with a runner that does not wait runs into, and why `exclusive` is required.
    expect(engine.opened.sqlite.inTransaction).toBe(true);
    const unguarded = createBackupStore({
      sqlite: engine.opened.sqlite,
      dataDir: engine.dataDir,
      blobsDir: join(engine.dataDir, 'blobs'),
      settings: engine.repository.settings,
      exclusive: (fn) => fn(),
    });
    await expect(unguarded.exportZip()).rejects.toThrow(/VACUUM/i);

    const exported = engine.backup.exportZip();
    release();
    await writer;
    const entries = unzipSync(await exported);

    // The snapshot was taken after the commit, so it holds the project.
    const file = join(tempDir('ace-backup-snapshot-'), 'from-zip.sqlite');
    writeFileSync(file, entries['ace.sqlite']!);
    const snapshot = new BetterSqlite3(file, { readonly: true });
    expect(snapshot.prepare('SELECT name FROM projects WHERE id = ?').get(project.id)).toEqual({
      name: project.name,
    });
    snapshot.close();
  });
});

describe('TC-SYS-014 import restores rows into a live handle via ATTACH; dataDir is kept', () => {
  it('replaces the live rows, keeps dataDir and allowedOrigins, copies blobs and rebuilds both indexes', async () => {
    const source = await startEngine('source');
    const seeded = await seedData(source);
    const zip = await source.backup.exportZip();

    const target = await startEngine('target');
    await target.repository.settings.update(scope, {
      dataDir: target.dataDir,
      allowedOrigins: ['http://importer.test'],
    });
    const replaced = makeProject({ name: 'Replaced by the import' });
    await target.repository.projects.create(scope, replaced);

    const restored = await target.backup.importZip(zip);

    expect(restored).toEqual({ projects: 1, runs: 1, artifacts: 1 });
    // The same repository, on the same open handle, reads the restored rows: no restart.
    expect(await target.repository.projects.get(scope, seeded.project.id)).toEqual(seeded.project);
    expect(await target.repository.projects.get(scope, replaced.id)).toBeNull();
    expect(await target.repository.runs.get(scope, seeded.run.id)).toMatchObject({
      id: seeded.run.id,
      totals: seeded.run.totals,
    });
    expect(await target.repository.artifacts.getById(scope, seeded.artifact.id)).toEqual(
      seeded.artifact,
    );
    expect(await target.blobs.get(scope, seeded.blob.hash)).toEqual(seeded.bytes);

    const settings = await target.repository.settings.get(scope);
    expect(settings.dataDir).toBe(target.dataDir);
    expect(settings.allowedOrigins).toEqual(['http://importer.test']);
    expect(settings.concurrency).toBe(5);
    expect(settings.theme).toBe('light');

    // Both indexes answer for the restored chunks.
    const keyword = target.repository.keywordIndex;
    expect(
      (await keyword.search(scope, seeded.kb.id, 'zephyrine-protocol-7', 5)).map((m) => m.chunkId),
    ).toEqual([seeded.chunk.id]);
    const vectors = target.repository.vectorIndex;
    expect(vectors.vectorExtension).toBe('sqlite-vec');
    expect((await vectors.query(scope, seeded.kb.id, [1, 0, 0], 5)).map((m) => m.chunkId)).toEqual([
      seeded.chunk.id,
    ]);
    expect((await target.repository.knowledgeBases.get(scope, seeded.kb.id))?.chunkCount).toBe(1);
  });

  it('writes a backup of the data it replaces first, under <dataDir>/backups', async () => {
    const source = await startEngine('source2');
    await seedData(source);
    const zip = await source.backup.exportZip();

    const target = await startEngine('target2');
    const before = makeProject({ name: 'Before the import' });
    await target.repository.projects.create(scope, before);

    await target.backup.importZip(zip);

    const backups = readdirSync(join(target.dataDir, 'backups'));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^pre-import-.+\.zip$/);

    // The pre-import zip is itself an ACE backup that restores what was there.
    const undo = readFileSync(join(target.dataDir, 'backups', backups[0]!));
    expect(JSON.parse(strFromU8(unzipSync(undo)['backup.json']!)).kind).toBe('ace-backup');
    await target.backup.importZip(undo);
    expect(await target.repository.projects.get(scope, before.id)).toEqual(before);
  });

  it('leaves the live database exactly as before when the copy fails part way', async () => {
    const source = await startEngine('source3');
    const seeded = await seedData(source);
    await source.repository.memory.upsert(scope, newId(), 'tone', 'from the backup', NOW, newId);
    // Tampered so the copy fails late: `agent_memory` and `approvals` are replaced before
    // `artifacts` breaks the live unique index on (workspace, hash).
    source.opened.sqlite.exec('DROP INDEX artifacts_hash_idx');
    source.opened.sqlite
      .prepare(
        `INSERT INTO artifacts (id, workspace_id, hash, mime, name, size, created_at)
         VALUES (?, ?, ?, 'text/plain', 'twin.txt', 1, ?)`,
      )
      .run(newId(), scope.workspaceId, seeded.blob.hash, NOW);
    const zip = await source.backup.exportZip();

    const target = await startEngine('target3');
    const live = await seedData(target);
    await target.repository.memory.upsert(scope, newId(), 'tone', 'live memory', NOW, newId);
    const dump = () => {
      const tables = (
        target.opened.sqlite
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table'
               AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'kb_chunks_fts%'
               AND name NOT LIKE 'kb_vectors_vec_%' ORDER BY name`,
          )
          .all() as { name: string }[]
      ).map((row) => row.name);
      return Object.fromEntries(
        tables.map((table) => [
          table,
          target.opened.sqlite.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all(),
        ]),
      );
    };
    const before = dump();

    await expect(target.backup.importZip(zip)).rejects.toThrow(/UNIQUE/);

    expect(dump()).toEqual(before);
    expect(target.opened.sqlite.inTransaction).toBe(false);
    expect(
      (target.opened.sqlite.pragma('database_list') as { name: string }[]).map((db) => db.name),
    ).not.toContain('ace_import');
    // Both indexes still answer for the live chunks.
    expect(
      (
        await target.repository.keywordIndex.search(scope, live.kb.id, 'zephyrine-protocol-7', 5)
      ).map((m) => m.chunkId),
    ).toEqual([live.chunk.id]);
    expect(
      (await target.repository.vectorIndex.query(scope, live.kb.id, [1, 0, 0], 5)).map(
        (m) => m.chunkId,
      ),
    ).toEqual([live.chunk.id]);
  });

  it('M4 runs beforeCopy in the same hold as the copy: a write that arrives meanwhile lands after it', async () => {
    const source = await startEngine('source4');
    await seedData(source);
    const zip = await source.backup.exportZip();

    const target = await startEngine('target4');
    const late = makeProject({ name: 'Arrived during the import' });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const importing = target.backup.importZip(zip, {
      beforeCopy: async () => {
        entered();
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    });
    await inside;
    // Another caller — a run starting, say — writes while the import holds the connection: it has
    // to wait for the copy rather than land before it and be wiped by it.
    const queued = target.repository.projects.create(scope, late);
    await importing;
    await queued;

    expect(await target.repository.projects.get(scope, late.id)).toEqual(late);
  });

  it('M4 a beforeCopy that throws refuses the import with nothing copied', async () => {
    const source = await startEngine('source5');
    const seeded = await seedData(source);
    const zip = await source.backup.exportZip();

    const target = await startEngine('target5');
    const live = makeProject({ name: 'Still here' });
    await target.repository.projects.create(scope, live);

    await expect(
      target.backup.importZip(zip, {
        beforeCopy: async () => {
          throw new Error('a run is active');
        },
      }),
    ).rejects.toThrow('a run is active');

    expect(await target.repository.projects.get(scope, live.id)).toEqual(live);
    expect(await target.repository.projects.get(scope, seeded.project.id)).toBeNull();
  });

  it('answers the path writePreImportBackup wrote', async () => {
    const engine = await startEngine('pre');
    const path = await engine.backup.writePreImportBackup();

    expect(path.startsWith(join(engine.dataDir, 'backups'))).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(Object.keys(unzipSync(readFileSync(path)))).toContain('backup.json');
    // Two in a row never overwrite each other.
    const second = await engine.backup.writePreImportBackup();
    expect(second).not.toBe(path);
    expect(existsSync(path)).toBe(true);
  });
});

describe('FR-SYS-012 refuses a zip that is not an ACE backup, leaving the data dir untouched', () => {
  async function refuses(engine: Engine, bytes: Uint8Array, reason: RegExp): Promise<void> {
    const before = snapshotDir(engine.dataDir);
    const projects = await engine.repository.projects.list(scope, { limit: 50 });

    const error = await engine.backup.importZip(bytes).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('BackupFormatError');
    expect((error as Error).message).toMatch(reason);

    expect(snapshotDir(engine.dataDir)).toEqual(before);
    expect(existsSync(join(engine.dataDir, 'backups'))).toBe(false);
    expect(await engine.repository.projects.list(scope, { limit: 50 })).toEqual(projects);
  }

  it('refuses a zip that unpacks past the cap before inflating it [audit S-9]', async () => {
    const engine = await startEngine('refuse-bomb');
    await seedData(engine);
    const capped = createBackupStore({
      sqlite: engine.opened.sqlite,
      dataDir: engine.dataDir,
      blobsDir: join(engine.dataDir, 'blobs'),
      settings: engine.repository.settings,
      exclusive: (fn) => engine.repository.exclusive(fn),
      maxUnpackedBytes: 4 * 1024 * 1024,
    });
    const good = unzipSync(await engine.backup.exportZip());
    // 8 MB of zeros packs to a few KB: the shape of a zip bomb, at a size a test can afford.
    const bomb = zipSync({ ...good, 'blobs/aa/zeros': new Uint8Array(8 * 1024 * 1024) } as Zippable);
    expect(bomb.byteLength).toBeLessThan(1024 * 1024);

    await refuses({ ...engine, backup: capped }, bomb, /unpacks to more than 4194304 bytes/);
    // Under the cap the same store restores as before.
    await expect(capped.importZip(zipSync(good as Zippable))).resolves.toMatchObject({
      projects: 1,
    });
  });

  it('refuses bytes that are not a zip, and a zip with no manifest', async () => {
    const engine = await startEngine('refuse1');
    await seedData(engine);

    await refuses(engine, strToU8('not a zip at all'), /zip/);
    await refuses(engine, zipSync({ 'readme.txt': strToU8('hello') }), /backup\.json/);
  });

  it('refuses a manifest of another kind, another format version, or a newer schema', async () => {
    const engine = await startEngine('refuse2');
    await seedData(engine);
    const good = unzipSync(await engine.backup.exportZip());
    const withManifest = (bytes: Uint8Array): Uint8Array =>
      zipSync({ ...good, 'backup.json': bytes } as Zippable);

    await refuses(engine, withManifest(strToU8('{ not json')), /backup\.json/);
    await refuses(engine, withManifest(manifest({ kind: 'other-backup' })), /not an ACE backup/);
    await refuses(engine, withManifest(manifest({ formatVersion: 2 })), /format version/);
    await refuses(
      engine,
      withManifest(
        manifest({ migrations: [...MIGRATIONS.map((m) => m.id), '20991231T000000_future'] }),
      ),
      /newer/,
    );
  });

  it('refuses a missing or corrupt database, bad settings, and a blob path that escapes', async () => {
    const engine = await startEngine('refuse3');
    await seedData(engine);
    const good = unzipSync(await engine.backup.exportZip());
    const without = (name: string) => {
      const copy: Zippable = { ...good };
      delete copy[name];
      return zipSync(copy);
    };

    await refuses(engine, without('ace.sqlite'), /ace\.sqlite/);
    await refuses(
      engine,
      zipSync({ ...good, 'ace.sqlite': strToU8('definitely not sqlite') } as Zippable),
      /ace\.sqlite/,
    );
    await refuses(engine, without('settings.json'), /settings\.json/);
    await refuses(
      engine,
      zipSync({ ...good, 'settings.json': strToU8('{"dataDir": 5}') } as Zippable),
      /settings\.json/,
    );
    await refuses(
      engine,
      zipSync({ ...good, 'blobs/../../escape.txt': strToU8('x') } as Zippable),
      /path/,
    );
    await refuses(
      engine,
      zipSync({ ...good, 'backup.json': manifest({ migrations: 'all of them' }) } as Zippable),
      /malformed/,
    );
  });

  it('refuses a database that opens but does not match: a dropped table, bad stored settings', async () => {
    const engine = await startEngine('refuse4');
    await seedData(engine);
    const good = unzipSync(await engine.backup.exportZip());
    /** The backup's database with one statement applied to it, zipped back up. */
    const tampered = (statement: string): Uint8Array => {
      const file = join(tempDir('ace-backup-tamper-'), 'ace.sqlite');
      writeFileSync(file, good['ace.sqlite']!);
      const sqlite = new BetterSqlite3(file);
      sqlite.exec(statement);
      sqlite.close();
      return zipSync({ ...good, 'ace.sqlite': readFileSync(file) } as Zippable);
    };

    await refuses(engine, tampered('DROP TABLE chat_messages'), /no chat_messages table/);
    await refuses(
      engine,
      tampered('ALTER TABLE projects DROP COLUMN max_cost_per_run_usd'),
      /no max_cost_per_run_usd column/,
    );
    await refuses(
      engine,
      tampered(`UPDATE settings SET data = '{"dataDir": 5}'`),
      /stored settings/,
    );
    await refuses(
      engine,
      tampered(
        `INSERT INTO _ace_migrations (id, applied_at) VALUES ('20991231T000000_future', '${NOW}')`,
      ),
      /newer/,
    );
  });
});

describe('FR-SYS-012 a backup from an older schema is migrated forward before the copy', () => {
  it('restores a round 4 backup, with round 5 data steps applied on the way', async () => {
    const BEFORE_ROUND_5 = MIGRATIONS.slice(
      0,
      MIGRATIONS.findIndex((migration) => migration.id === ROUND_5_MIGRATION_ID),
    );
    const old = await startEngine('old', BEFORE_ROUND_5);
    const project = makeProject({ name: 'From round 4' });
    // The repository writes `projects.terminal`, `check_command` and `format_on_save` on create;
    // this install predates those columns, so they are added for the insert and dropped again.
    old.opened.sqlite.exec('ALTER TABLE projects ADD COLUMN terminal TEXT');
    old.opened.sqlite.exec('ALTER TABLE projects ADD COLUMN check_command TEXT');
    old.opened.sqlite.exec('ALTER TABLE projects ADD COLUMN format_on_save INTEGER');
    await old.repository.projects.create(scope, project);
    old.opened.sqlite.exec('ALTER TABLE projects DROP COLUMN format_on_save');
    old.opened.sqlite.exec('ALTER TABLE projects DROP COLUMN check_command');
    old.opened.sqlite.exec('ALTER TABLE projects DROP COLUMN terminal');
    const policy = await old.repository.guardrailPolicies.getProjectDefault(scope, project.id);
    // A round 4 install's default policy had no context-point checks.
    old.opened.sqlite
      .prepare('UPDATE guardrail_policies SET checks = ? WHERE id = ?')
      .run(
        JSON.stringify(defaultGuardrailChecks(newId).filter((check) => check.point !== 'context')),
        policy!.id,
      );
    await old.repository.settings.update(scope, { dataDir: old.dataDir, concurrency: 7 });
    old.opened.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    const zip = zipSync({
      'ace.sqlite': readFileSync(join(old.dataDir, 'ace.sqlite')),
      'settings.json': strToU8(JSON.stringify({ dataDir: old.dataDir })),
      'backup.json': manifest({ migrations: BEFORE_ROUND_5.map((migration) => migration.id) }),
    });

    const target = await startEngine('new');
    const restored = await target.backup.importZip(zip);

    expect(restored).toEqual({ projects: 1, runs: 0, artifacts: 0 });
    expect(await target.repository.projects.get(scope, project.id)).toEqual(project);
    expect((await target.repository.settings.get(scope)).concurrency).toBe(7);
    expect((await target.repository.settings.get(scope)).dataDir).toBe(target.dataDir);
    // DN-2's seed ran on the backup before the copy: the policy arrives as version 2.
    const migrated = await target.repository.guardrailPolicies.getProjectDefault(scope, project.id);
    expect(migrated?.version).toBe(2);
    expect(migrated?.checks.filter((check) => check.point === 'context')).toHaveLength(3);
    expect(await target.repository.knowledgeBases.listByProject(scope, project.id)).toEqual([]);
  });
});
