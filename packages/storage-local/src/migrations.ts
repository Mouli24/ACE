import type BetterSqlite3 from 'better-sqlite3';

/**
 * Forward-only migrations. Once a migration is on `main` it is never edited — a correction is a new
 * migration (CLAUDE.md §3.4 rule 5). Ids are timestamped so they apply in the order they were
 * written.
 */
export interface Migration {
  id: string;
  up: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: '20260921T120000_initial_schema',
    up: `
      CREATE TABLE projects (
        id            TEXT PRIMARY KEY,
        workspace_id  TEXT NOT NULL,
        name          TEXT NOT NULL,
        folder_path   TEXT NOT NULL,
        last_opened_at TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX projects_workspace_idx ON projects (workspace_id, id);

      CREATE TABLE workflows (
        id             TEXT PRIMARY KEY,
        workspace_id   TEXT NOT NULL,
        project_id     TEXT NOT NULL,
        name           TEXT NOT NULL,
        version        INTEGER NOT NULL,
        format_version INTEGER NOT NULL,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
      CREATE INDEX workflows_project_idx ON workflows (workspace_id, project_id, id);

      CREATE TABLE nodes (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        workflow_id  TEXT NOT NULL,
        kind         TEXT NOT NULL,
        name         TEXT NOT NULL,
        position_x   REAL NOT NULL,
        position_y   REAL NOT NULL,
        inputs       TEXT NOT NULL,
        outputs      TEXT NOT NULL,
        config       TEXT NOT NULL
      );
      CREATE INDEX nodes_workflow_idx ON nodes (workspace_id, workflow_id, id);

      CREATE TABLE edges (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        workflow_id  TEXT NOT NULL,
        kind         TEXT NOT NULL,
        from_node_id TEXT NOT NULL,
        from_port_id TEXT NOT NULL,
        to_node_id   TEXT NOT NULL,
        to_port_id   TEXT NOT NULL,
        loop         TEXT
      );
      CREATE INDEX edges_workflow_idx ON edges (workspace_id, workflow_id, id);
      CREATE INDEX edges_from_idx ON edges (workspace_id, from_node_id);
      CREATE INDEX edges_to_idx ON edges (workspace_id, to_node_id);

      CREATE TABLE events (
        seq          INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        type         TEXT NOT NULL,
        workflow_id  TEXT,
        run_id       TEXT,
        payload      TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX events_workflow_idx ON events (workspace_id, workflow_id, seq);
      CREATE INDEX events_seq_idx ON events (workspace_id, seq);

      CREATE TABLE settings (
        workspace_id TEXT PRIMARY KEY,
        data         TEXT NOT NULL
      );
    `,
  },
];

const MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS _ace_migrations (
    id         TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
`;

export function appliedMigrations(sqlite: BetterSqlite3.Database): Set<string> {
  sqlite.exec(MIGRATIONS_TABLE);
  const rows = sqlite.prepare('SELECT id FROM _ace_migrations').all() as { id: string }[];
  return new Set(rows.map((row) => row.id));
}

export function pendingMigrations(
  sqlite: BetterSqlite3.Database,
  migrations: readonly Migration[] = MIGRATIONS,
): Migration[] {
  const applied = appliedMigrations(sqlite);
  return migrations.filter((migration) => !applied.has(migration.id));
}

/**
 * Applies the pending migrations, each in its own transaction so a failure leaves the database on
 * the last migration that succeeded rather than half way through one.
 */
export function applyMigrations(
  sqlite: BetterSqlite3.Database,
  migrations: readonly Migration[] = MIGRATIONS,
): string[] {
  const pending = pendingMigrations(sqlite, migrations);

  for (const migration of pending) {
    const run = sqlite.transaction(() => {
      sqlite.exec(migration.up);
      sqlite
        .prepare('INSERT INTO _ace_migrations (id, applied_at) VALUES (?, ?)')
        .run(migration.id, new Date().toISOString());
    });
    run();
  }

  return pending.map((migration) => migration.id);
}
