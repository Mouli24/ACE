import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { SettingsSchema, TimestampSchema, type BackupImportResponse } from '@ace/contracts';
import { LOCAL_SCOPE, type BackupStore, type Scope, type SettingsRepository } from '@ace/engine';
import type BetterSqlite3 from 'better-sqlite3';
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { z } from 'zod';

import { openDatabase } from './db.js';
import { detectVectorExtension, rebuildKeywordIndex, rebuildVectorTables } from './indexes.js';
import { appliedMigrations, MIGRATIONS } from './migrations.js';
import { toJsonColumn } from './secret-guard.js';

/**
 * Backup and restore (round 5 §2.7, FR-SYS-012, TC-SYS-014, F12).
 *
 * **Export** is a zip of four parts: `ace.sqlite`, a `VACUUM INTO` snapshot of the live database
 * (consistent, and compact, without stopping the engine); `blobs/**`, the artifact bytes;
 * `settings.json`, the settings as the API reads them; and `backup.json`, the manifest. Nothing
 * else is read, and no key can be in any of them: keys live in the OS keychain (BR-07), which is
 * not in the data directory, and every JSON column refused one on the way in.
 *
 * **Import** restores in place, so the engine keeps running (F12): it checks the zip is an ACE
 * backup this engine can read before touching anything, opens the backup's database on its own —
 * which migrates it forward — writes a backup of the current data to `<dataDir>/backups/`, copies
 * the blobs, then `ATTACH`es the backup and copies every regular table into the live database in
 * one transaction, keeping the live `dataDir` and `allowedOrigins`, and rebuilds both search
 * indexes. Refusing an import while a run is active is the engine's job, not this store's.
 */

export const BACKUP_KIND = 'ace-backup';
export const BACKUP_FORMAT_VERSION = 1;

/** The four parts of a backup zip. */
export const BACKUP_DATABASE_ENTRY = 'ace.sqlite';
export const BACKUP_MANIFEST_ENTRY = 'backup.json';
export const BACKUP_SETTINGS_ENTRY = 'settings.json';
export const BACKUP_BLOBS_PREFIX = 'blobs/';

/** Where the backup an import takes first is written, under the data directory. */
export const PRE_IMPORT_BACKUP_DIR = 'backups';

const BackupManifestSchema = z.object({
  kind: z.literal(BACKUP_KIND),
  formatVersion: z.literal(BACKUP_FORMAT_VERSION),
  exportedAt: TimestampSchema,
  /** The migrations the exported database had applied — the schema it is at. */
  migrations: z.array(z.string()),
});
export type BackupManifest = z.infer<typeof BackupManifestSchema>;

/**
 * The zip is not an ACE backup this engine can restore. Matched by `name`, as the port documents,
 * so the engine answers it as a validation error without importing this package.
 */
export class BackupFormatError extends Error {
  override readonly name = 'BackupFormatError';
}

export interface BackupStoreDeps {
  /** The live connection — the one the repository uses, so an import is visible to it at once. */
  sqlite: BetterSqlite3.Database;
  dataDir: string;
  blobsDir: string;
  /** Read for `settings.json`. */
  settings: Pick<SettingsRepository, 'get'>;
  scope?: Scope;
  /**
   * Runs a body while no repository transaction is open on the connection, and keeps one from
   * opening meanwhile: `VACUUM INTO` and `ATTACH` both fail inside a transaction. Wire it to
   * `SqliteRepository.exclusive`; the default runs the body directly.
   */
  exclusive?: <T>(fn: () => Promise<T>) => Promise<T>;
  now?: () => Date;
}

/* -------------------------------------------------------------------------- */
/* Reading a zip                                                               */
/* -------------------------------------------------------------------------- */

interface ParsedBackup {
  manifest: BackupManifest;
  database: Uint8Array;
  /** Blob paths relative to the blobs directory, already checked to stay inside it. */
  blobs: [path: string, bytes: Uint8Array][];
}

const SQLITE_HEADER = 'SQLite format 3\u0000';

/** A blob's path inside `blobs/`: plain segments only, so no entry can be written outside it. */
function isSafeBlobPath(path: string): boolean {
  if (path.includes('\\') || path.includes(':') || path.startsWith('/')) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * Everything an import checks before it touches anything: a zip, with a manifest of this kind and
 * format version, from a schema this engine knows (a newer one cannot be migrated backwards), a
 * SQLite database, valid settings, and blob paths that stay inside the blobs directory.
 */
function readBackup(bytes: Uint8Array): ParsedBackup {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new BackupFormatError('The file is not a zip archive, so it is not an ACE backup.');
  }

  const manifestBytes = entries[BACKUP_MANIFEST_ENTRY];
  if (manifestBytes === undefined) {
    throw new BackupFormatError(
      `The zip has no ${BACKUP_MANIFEST_ENTRY}: it is not an ACE backup.`,
    );
  }
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(strFromU8(manifestBytes));
  } catch {
    throw new BackupFormatError(`The zip's ${BACKUP_MANIFEST_ENTRY} is not valid JSON.`);
  }
  const record =
    typeof manifestJson === 'object' && manifestJson !== null
      ? (manifestJson as Record<string, unknown>)
      : {};
  if (record['kind'] !== BACKUP_KIND) {
    throw new BackupFormatError(
      `The zip's ${BACKUP_MANIFEST_ENTRY} is not an ACE backup manifest.`,
    );
  }
  if (record['formatVersion'] !== BACKUP_FORMAT_VERSION) {
    throw new BackupFormatError(
      `The backup's format version ${String(record['formatVersion'])} is not one this ACE reads (${BACKUP_FORMAT_VERSION}).`,
    );
  }
  const manifest = BackupManifestSchema.safeParse(manifestJson);
  if (!manifest.success) {
    throw new BackupFormatError(`The zip's ${BACKUP_MANIFEST_ENTRY} is incomplete or malformed.`);
  }
  const known = new Set(MIGRATIONS.map((migration) => migration.id));
  const unknown = manifest.data.migrations.find((id) => !known.has(id));
  if (unknown !== undefined) {
    throw new BackupFormatError(
      `The backup is from a newer ACE (schema ${unknown}); update ACE before importing it.`,
    );
  }

  const database = entries[BACKUP_DATABASE_ENTRY];
  if (database === undefined || strFromU8(database.subarray(0, 16)) !== SQLITE_HEADER) {
    throw new BackupFormatError(`The backup has no readable ${BACKUP_DATABASE_ENTRY}.`);
  }

  const settingsBytes = entries[BACKUP_SETTINGS_ENTRY];
  let settingsJson: unknown;
  try {
    settingsJson = settingsBytes === undefined ? undefined : JSON.parse(strFromU8(settingsBytes));
  } catch {
    settingsJson = undefined;
  }
  if (!SettingsSchema.safeParse(settingsJson).success) {
    throw new BackupFormatError(`The backup's ${BACKUP_SETTINGS_ENTRY} is missing or invalid.`);
  }

  const blobs: ParsedBackup['blobs'] = [];
  for (const [name, data] of Object.entries(entries)) {
    if (!name.startsWith(BACKUP_BLOBS_PREFIX)) continue;
    const path = name.slice(BACKUP_BLOBS_PREFIX.length);
    if (path === '' || path.endsWith('/')) continue; // a directory entry
    if (!isSafeBlobPath(path)) {
      throw new BackupFormatError(`The backup holds a blob path that leaves its folder: ${name}`);
    }
    blobs.push([path, data]);
  }

  return { manifest: manifest.data, database, blobs };
}

/* -------------------------------------------------------------------------- */
/* Tables                                                                      */
/* -------------------------------------------------------------------------- */

const MIGRATION_LEDGER = '_ace_migrations';

function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

interface MasterRow {
  name: string;
  sql: string | null;
}

/**
 * The regular tables of one schema of the connection: not SQLite's own, not the migration ledger,
 * not a virtual table and not a virtual table's shadow table (`<name>_…`) — the FTS5 index and the
 * sqlite-vec tables are rebuilt from the rows, never copied.
 */
function regularTables(sqlite: BetterSqlite3.Database, schema: string): string[] {
  const rows = sqlite
    .prepare(`SELECT name, sql FROM ${schema}.sqlite_master WHERE type = 'table' ORDER BY name`)
    .all() as MasterRow[];
  const virtual = rows
    .filter((row) => (row.sql ?? '').toUpperCase().startsWith('CREATE VIRTUAL TABLE'))
    .map((row) => row.name);
  return rows
    .map((row) => row.name)
    .filter(
      (name) =>
        !name.startsWith('sqlite_') &&
        name !== MIGRATION_LEDGER &&
        !virtual.some((table) => name === table || name.startsWith(`${table}_`)),
    );
}

function columnsOf(sqlite: BetterSqlite3.Database, schema: string, table: string): string[] {
  return (
    sqlite.prepare(`PRAGMA ${schema}.table_info(${quote(table)})`).all() as { name: string }[]
  ).map((row) => row.name);
}

/**
 * Checks the migrated backup has every table and column the live database copies into — they are
 * the same chain, so this fails only on a tampered file — and that its settings rows are valid.
 */
function checkBackupDatabase(backup: BetterSqlite3.Database, live: BetterSqlite3.Database): void {
  const known = new Set(MIGRATIONS.map((migration) => migration.id));
  const newer = [...appliedMigrations(backup)].find((id) => !known.has(id));
  if (newer !== undefined) {
    throw new BackupFormatError(
      `The backup's database is from a newer ACE (schema ${newer}); update ACE before importing it.`,
    );
  }

  const tables = new Set(regularTables(backup, 'main'));
  for (const table of regularTables(live, 'main')) {
    if (!tables.has(table)) {
      throw new BackupFormatError(`The backup's database has no ${table} table.`);
    }
    const columns = new Set(columnsOf(backup, 'main', table));
    const missing = columnsOf(live, 'main', table).find((column) => !columns.has(column));
    if (missing !== undefined) {
      throw new BackupFormatError(`The backup's ${table} table has no ${missing} column.`);
    }
  }

  for (const row of backup.prepare('SELECT data FROM settings').all() as { data: string }[]) {
    let data: unknown;
    try {
      data = JSON.parse(row.data);
    } catch {
      data = undefined;
    }
    if (!SettingsSchema.safeParse(data).success) {
      throw new BackupFormatError("The backup's stored settings are invalid.");
    }
  }
}

/** The fields an import never takes from the backup: where this engine keeps its data, and who may call it. */
interface KeptSettings {
  dataDir: unknown;
  allowedOrigins: unknown;
}

/**
 * After the copy, each settings row takes the live `dataDir` and `allowedOrigins` back (F12): the
 * backup's describe another machine. A workspace the live database had and the backup did not
 * keeps a row with just those two.
 */
function keepLiveSettings(
  sqlite: BetterSqlite3.Database,
  live: Map<string, KeptSettings>,
  dataDir: string,
): void {
  const rows = sqlite.prepare('SELECT workspace_id, data FROM main.settings').all() as {
    workspace_id: string;
    data: string;
  }[];
  const update = sqlite.prepare('UPDATE main.settings SET data = ? WHERE workspace_id = ?');
  const insert = sqlite.prepare('INSERT INTO main.settings (workspace_id, data) VALUES (?, ?)');

  for (const row of rows) {
    const data = JSON.parse(row.data) as Record<string, unknown>;
    const kept = live.get(row.workspace_id);
    data['dataDir'] = kept?.dataDir ?? dataDir;
    if (kept?.allowedOrigins === undefined) delete data['allowedOrigins'];
    else data['allowedOrigins'] = kept.allowedOrigins;
    update.run(toJsonColumn(data, `settings(${row.workspace_id})`), row.workspace_id);
  }

  const restored = new Set(rows.map((row) => row.workspace_id));
  for (const [workspaceId, kept] of live) {
    if (restored.has(workspaceId)) continue;
    const data = {
      dataDir: kept.dataDir,
      ...(kept.allowedOrigins === undefined ? {} : { allowedOrigins: kept.allowedOrigins }),
    };
    insert.run(workspaceId, toJsonColumn(data, `settings(${workspaceId})`));
  }
}

/* -------------------------------------------------------------------------- */
/* The store                                                                   */
/* -------------------------------------------------------------------------- */

/** Every file under `root`, as `[path with forward slashes, absolute path]`, in a stable order. */
function listFiles(root: string): [string, string][] {
  if (!existsSync(root)) return [];
  const files: [string, string][] = [];
  const walk = (dir: string, prefix: string) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, `${prefix}${entry.name}/`);
      else if (entry.isFile()) files.push([`${prefix}${entry.name}`, path]);
    }
  };
  walk(root, '');
  return files;
}

export function createBackupStore(deps: BackupStoreDeps): BackupStore {
  const { sqlite, dataDir, blobsDir } = deps;
  const scope = deps.scope ?? LOCAL_SCOPE;
  const exclusive = deps.exclusive ?? (<T>(fn: () => Promise<T>) => fn());
  const now = deps.now ?? (() => new Date());

  const exportZip = async (): Promise<Uint8Array> =>
    exclusive(async () => {
      const temp = mkdtempSync(join(tmpdir(), 'ace-export-'));
      try {
        const snapshot = join(temp, BACKUP_DATABASE_ENTRY);
        sqlite.prepare('VACUUM INTO ?').run(snapshot);

        const manifest: BackupManifest = {
          kind: BACKUP_KIND,
          formatVersion: BACKUP_FORMAT_VERSION,
          exportedAt: now().toISOString(),
          migrations: [...appliedMigrations(sqlite)].sort(),
        };
        const files: Zippable = {
          [BACKUP_DATABASE_ENTRY]: readFileSync(snapshot),
          [BACKUP_SETTINGS_ENTRY]: strToU8(JSON.stringify(await deps.settings.get(scope), null, 2)),
          [BACKUP_MANIFEST_ENTRY]: strToU8(JSON.stringify(manifest, null, 2)),
        };
        for (const [path, absolute] of listFiles(blobsDir)) {
          files[`${BACKUP_BLOBS_PREFIX}${path}`] = readFileSync(absolute);
        }
        return zipSync(files);
      } finally {
        removeTemp(temp);
      }
    });

  const writePreImportBackup = async (): Promise<string> => {
    const bytes = await exportZip();
    const dir = join(dataDir, PRE_IMPORT_BACKUP_DIR);
    mkdirSync(dir, { recursive: true });
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    let path = join(dir, `pre-import-${stamp}.zip`);
    for (let n = 2; existsSync(path); n += 1) path = join(dir, `pre-import-${stamp}-${n}.zip`);
    writeFileSync(path, bytes);
    return path;
  };

  /** The copy itself: one transaction over every regular table, then both indexes rebuilt. */
  const copyInto = (backupPath: string): BackupImportResponse['restored'] => {
    const live = new Map<string, KeptSettings>();
    for (const row of sqlite.prepare('SELECT workspace_id, data FROM settings').all() as {
      workspace_id: string;
      data: string;
    }[]) {
      const data = JSON.parse(row.data) as Record<string, unknown>;
      live.set(row.workspace_id, {
        dataDir: data['dataDir'],
        allowedOrigins: data['allowedOrigins'],
      });
    }

    sqlite.prepare('ATTACH DATABASE ? AS ace_import').run(backupPath);
    try {
      const copy = sqlite.transaction(() => {
        for (const table of regularTables(sqlite, 'main')) {
          const columns = columnsOf(sqlite, 'main', table).map(quote).join(', ');
          sqlite.exec(`DELETE FROM main.${quote(table)}`);
          sqlite.exec(
            `INSERT INTO main.${quote(table)} (${columns}) SELECT ${columns} FROM ace_import.${quote(table)}`,
          );
        }
        keepLiveSettings(sqlite, live, dataDir);
        rebuildKeywordIndex(sqlite);
        if (detectVectorExtension(sqlite) === 'sqlite-vec') rebuildVectorTables(sqlite);
      });
      copy.immediate();
    } finally {
      sqlite.exec('DETACH DATABASE ace_import');
    }

    const count = (table: string) =>
      (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    return { projects: count('projects'), runs: count('runs'), artifacts: count('artifacts') };
  };

  return {
    exportZip,
    writePreImportBackup,

    importZip: async (bytes: Uint8Array) => {
      const backup = readBackup(bytes);

      const temp = mkdtempSync(join(tmpdir(), 'ace-import-'));
      try {
        // Opened on its own first: `openDatabase` migrates it forward, and a database that will
        // not open, or does not match, is refused before anything of the live data is touched.
        const backupPath = join(temp, BACKUP_DATABASE_ENTRY);
        writeFileSync(backupPath, backup.database);
        let opened;
        try {
          opened = openDatabase({ path: backupPath, loadVectorExtension: false });
        } catch (error) {
          throw new BackupFormatError(
            `The backup's ${BACKUP_DATABASE_ENTRY} could not be opened: ${(error as Error).message}`,
          );
        }
        try {
          checkBackupDatabase(opened.sqlite, sqlite);
          // A rollback journal, so the attached copy leaves no -wal or -shm behind.
          opened.sqlite.pragma('journal_mode = DELETE');
        } finally {
          opened.sqlite.close();
        }

        await writePreImportBackup();

        // Blobs before rows: they are content-addressed, so one the rows do not use is harmless,
        // while a row whose bytes never arrived would not be.
        for (const [path, data] of backup.blobs) {
          const target = join(blobsDir, ...path.split('/'));
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, data);
        }

        return await exclusive(async () => copyInto(backupPath));
      } finally {
        removeTemp(temp);
      }
    },
  };
}

/**
 * Removes a temp folder without letting a failure there replace the import's own answer: on
 * Windows a file a failed open still holds cannot be deleted yet, and the OS reclaims temp anyway.
 */
function removeTemp(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // left for the OS to reclaim
  }
}
