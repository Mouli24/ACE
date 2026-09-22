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
  {
    id: '20260922T120000_round_2_providers_and_runs',
    up: `
      CREATE TABLE providers (
        id              TEXT PRIMARY KEY,
        workspace_id    TEXT NOT NULL,
        type            TEXT NOT NULL,
        name            TEXT NOT NULL,
        base_url        TEXT,
        key_set         INTEGER NOT NULL,
        status          TEXT NOT NULL,
        status_message  TEXT,
        last_checked_at TEXT,
        concurrency     INTEGER NOT NULL,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX providers_workspace_idx ON providers (workspace_id, id);

      CREATE TABLE models (
        id              TEXT PRIMARY KEY,
        workspace_id    TEXT NOT NULL,
        provider_id     TEXT NOT NULL,
        model_id        TEXT NOT NULL,
        display_name    TEXT NOT NULL,
        input_types     TEXT NOT NULL,
        output_types    TEXT NOT NULL,
        context_window  INTEGER NOT NULL,
        supports_tools  INTEGER NOT NULL,
        supports_json   INTEGER NOT NULL,
        available       INTEGER NOT NULL,
        source          TEXT NOT NULL,
        last_checked_at TEXT NOT NULL,
        pricing         TEXT
      );
      CREATE INDEX models_provider_idx ON models (workspace_id, provider_id, model_id);

      CREATE TABLE price_tables (
        workspace_id TEXT NOT NULL,
        version      TEXT NOT NULL,
        data         TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (workspace_id, version)
      );

      CREATE TABLE runs (
        id               TEXT PRIMARY KEY,
        workspace_id     TEXT NOT NULL,
        workflow_id      TEXT NOT NULL,
        project_id       TEXT NOT NULL,
        status           TEXT NOT NULL,
        halt_reason      TEXT,
        snapshot         TEXT NOT NULL,
        inputs           TEXT NOT NULL,
        preflight_issues TEXT NOT NULL,
        totals           TEXT NOT NULL,
        started_at       TEXT NOT NULL,
        ended_at         TEXT,
        duration_ms      INTEGER,
        final_output     TEXT
      );
      CREATE INDEX runs_workflow_idx ON runs (workspace_id, workflow_id, id);
      CREATE INDEX runs_status_idx ON runs (workspace_id, status);

      CREATE TABLE node_runs (
        id              TEXT PRIMARY KEY,
        workspace_id    TEXT NOT NULL,
        run_id          TEXT NOT NULL,
        node_id         TEXT NOT NULL,
        iteration       INTEGER NOT NULL,
        attempt         INTEGER NOT NULL,
        status          TEXT NOT NULL,
        failure_reason  TEXT,
        error           TEXT,
        model_used      TEXT,
        input_envelopes TEXT NOT NULL,
        output          TEXT,
        prompt          TEXT,
        usage           TEXT NOT NULL,
        verdicts        TEXT NOT NULL,
        tool_calls      TEXT NOT NULL,
        started_at      TEXT,
        ended_at        TEXT,
        duration_ms     INTEGER
      );
      CREATE INDEX node_runs_run_idx ON node_runs (workspace_id, run_id, id);
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
