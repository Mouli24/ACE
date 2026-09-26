import type BetterSqlite3 from 'better-sqlite3';

import { backfillDefaultPolicies } from './default-policy.js';

/** Named so a test can apply the chain up to, but not including, round 3 (FR-GRD-018). */
export const ROUND_3_MIGRATION_ID = '20260926T120000_round_3_guardrails_approvals_and_budgets';

/**
 * Round 3's second migration in this package, and the reason it is a second one: the guardrails
 * migration above is written and tested, and rule 5 of CLAUDE.md §3.4 is that a migration is never
 * edited — a correction is a new migration. D104 preferred one migration per round per package, and
 * this is the exception that proves the older rule wins when the two disagree (D170).
 *
 * Named so a test can apply the chain up to, but not including, the run columns.
 */
export const ROUND_3_RUN_COLUMNS_MIGRATION_ID =
  '20260926T140000_round_3_run_controls_and_budget_halt';

/**
 * Forward-only migrations. Once a migration is on `main` it is never edited — a correction is a new
 * migration (CLAUDE.md §3.4 rule 5). Ids are timestamped so they apply in the order they were
 * written.
 */
export interface Migration {
  id: string;
  up: string;
  /**
   * An optional data step, run in the same transaction immediately after `up`.
   *
   * Some backfills cannot be written as SQL: the round 3 default policy needs fresh ULIDs and the
   * check list from `@ace/contracts`, and retyping that list as a SQL literal is exactly the second
   * copy that drifts. A function keeps one definition and still commits with the schema change, so
   * a database is never left with the new tables but not the rows they require.
   */
  seed?: (sqlite: BetterSqlite3.Database) => void;
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
  {
    id: ROUND_3_MIGRATION_ID,
    up: `
      -- One row per policy version: a PATCH inserts version + 1 and never rewrites what came
      -- before it, so the policy id and version a node run recorded still resolve years later
      -- (FR-GRD-001, FR-GRD-002, Arch 13.4, BR-04).
      CREATE TABLE guardrail_policies (
        id                 TEXT NOT NULL,
        workspace_id       TEXT NOT NULL,
        project_id         TEXT NOT NULL,
        name               TEXT NOT NULL,
        version            INTEGER NOT NULL,
        is_project_default INTEGER NOT NULL,
        checks             TEXT NOT NULL,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        PRIMARY KEY (id, version)
      );
      CREATE INDEX guardrail_policies_project_idx
        ON guardrail_policies (workspace_id, project_id, id);
      -- One default per project is a constraint, not a convention (FR-GRD-018). Only the latest
      -- version of the default policy carries the flag, which is what keeps this index unique while
      -- the table holds every version.
      CREATE UNIQUE INDEX guardrail_policies_default_idx
        ON guardrail_policies (workspace_id, project_id) WHERE is_project_default = 1;

      -- No value column, ever: a verdict records the types it redacted, never the text (FR-GRD-014).
      CREATE TABLE guardrail_verdicts (
        id             TEXT PRIMARY KEY,
        workspace_id   TEXT NOT NULL,
        node_run_id    TEXT NOT NULL,
        point          TEXT NOT NULL,
        check_type     TEXT NOT NULL,
        action         TEXT NOT NULL,
        passed         INTEGER NOT NULL,
        reason         TEXT NOT NULL,
        redacted_types TEXT,
        at             TEXT NOT NULL
      );
      CREATE INDEX guardrail_verdicts_node_run_idx
        ON guardrail_verdicts (workspace_id, node_run_id, id);

      CREATE TABLE approvals (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        run_id       TEXT NOT NULL,
        node_run_id  TEXT NOT NULL,
        node_id      TEXT NOT NULL,
        node_name    TEXT NOT NULL,
        point        TEXT NOT NULL,
        check_type   TEXT NOT NULL,
        reason       TEXT NOT NULL,
        preview      TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        decision     TEXT,
        note         TEXT,
        decided_at   TEXT
      );
      CREATE INDEX approvals_run_idx ON approvals (workspace_id, run_id, decision);
      CREATE INDEX approvals_node_run_idx ON approvals (workspace_id, node_run_id, decision);

      -- Round 3 §2.3: the per-run cost cap the budget check compares against.
      ALTER TABLE projects ADD COLUMN max_cost_per_run_usd REAL;

      -- Round 3 additions to NodeRun (§2.1, §2.2, §2.4).
      ALTER TABLE node_runs ADD COLUMN approvals TEXT;
      ALTER TABLE node_runs ADD COLUMN guardrail_policy TEXT;
      ALTER TABLE node_runs ADD COLUMN loop_stop TEXT;
      ALTER TABLE node_runs ADD COLUMN reused_from_node_run_id TEXT;
      CREATE INDEX node_runs_started_idx ON node_runs (workspace_id, started_at);
    `,
    /** Every project that existed before this migration gets the §2.2 default (FR-GRD-018). */
    seed: (sqlite) => {
      backfillDefaultPolicies(sqlite);
    },
  },
  {
    id: ROUND_3_RUN_COLUMNS_MIGRATION_ID,
    up: `
      -- Round 3 additions to Run. The contract, the port and the scheduler all carry these four
      -- since C3; the table did not, so every write of them was silently dropped and
      -- 'GET /runs/:id' answered 'allowedActions: undefined' (FR-CTL-002, FR-CTL-004, FR-CTL-006,
      -- FR-GRD-008).
      --
      -- No backfill and no data step. A run that predates this migration reads the four as NULL,
      -- which 'toRun' leaves absent, and that is the honest answer: 'allowedActions' is the engine's
      -- record of what it allowed at the time, 'paused_at' and the other two are events that either
      -- happened or did not. Inventing 'allowedRunActions(status)' for a finished run would be
      -- writing history the engine never wrote (BR-04). 'Run.allowedActions' is optional exactly so
      -- that an old row stays valid (D71).
      ALTER TABLE runs ADD COLUMN paused_at TEXT;
      ALTER TABLE runs ADD COLUMN allowed_actions TEXT;
      ALTER TABLE runs ADD COLUMN budget_halt TEXT;
      ALTER TABLE runs ADD COLUMN restarted_from_run_id TEXT;
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
      // The data step commits with the schema change, so the tables and the rows they require can
      // never be half applied.
      migration.seed?.(sqlite);
      sqlite
        .prepare('INSERT INTO _ace_migrations (id, applied_at) VALUES (?, ?)')
        .run(migration.id, new Date().toISOString());
    });
    run();
  }

  return pending.map((migration) => migration.id);
}
