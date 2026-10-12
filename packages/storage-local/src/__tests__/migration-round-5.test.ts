import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultGuardrailChecks, type GuardrailCheck, type Project } from '@ace/contracts';
import { newId } from '@ace/engine';
import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../db.js';
import {
  MIGRATIONS,
  ROUND_5_MIGRATION_ID,
  X1_CLI_PROVIDERS_MIGRATION_ID,
  type Migration,
  CHAT_SESSIONS_CLI_MODELS_MIGRATION_ID,
  FORGE_TERMINAL_MIGRATION_ID,
} from '../migrations.js';
import { SqliteRepository } from '../repository.js';
import { makeProject, scope } from './fixtures.js';

/**
 * The round 5 migration (Arch §15.3, §21.3): knowledge bases, documents, chunks, vectors, the FTS5
 * index, agent memory, the summary cache, three `node_runs` columns — and DN-2's data step, which
 * gives every policy that predates the context point its three context checks as a new version.
 *
 * Like the round 4 test, it opens the database twice on purpose: once with the chain as it stood
 * before round 5, so an existing install really predates the new tables, then with the whole chain.
 */

const BEFORE_ROUND_5 = MIGRATIONS.slice(
  0,
  MIGRATIONS.findIndex((migration) => migration.id === ROUND_5_MIGRATION_ID),
);

const NEW_TABLES = [
  'knowledge_bases',
  'kb_documents',
  'kb_chunks',
  'kb_vectors',
  'kb_chunks_fts',
  'agent_memory',
  'summary_cache',
];

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-migration-5-'));
  path = join(dir, 'ace.sqlite');
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // a lingering handle on Windows; the OS reclaims the temp directory anyway
  }
});

/**
 * Creates a project on a database that predates the forge-terminal migration. The repository now
 * writes `projects.terminal` on create, so the column is added for the insert and dropped again,
 * which leaves the database as an install of that age really was (and the later migration free to
 * add it).
 */
async function createProjectBeforeTerminal(
  repository: SqliteRepository,
  sqlite: BetterSqlite3.Database,
  project: Project,
): Promise<void> {
  sqlite.exec('ALTER TABLE projects ADD COLUMN terminal TEXT');
  await repository.projects.create(scope, project);
  sqlite.exec('ALTER TABLE projects DROP COLUMN terminal');
}

function tableNames(sqlite: BetterSqlite3.Database): string[] {
  return (
    sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as {
      name: string;
    }[]
  ).map((row) => row.name);
}

function columnsOf(sqlite: BetterSqlite3.Database, table: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (row) => row.name,
  );
}

interface PolicyRow {
  id: string;
  version: number;
  is_project_default: number;
  checks: string;
  created_at: string;
  updated_at: string;
}

function policyRows(sqlite: BetterSqlite3.Database, id: string): PolicyRow[] {
  return sqlite
    .prepare(
      `SELECT id, version, is_project_default, checks, created_at, updated_at
         FROM guardrail_policies WHERE id = ? ORDER BY version`,
    )
    .all(id) as PolicyRow[];
}

/** The checks a policy written before round 5 had: every default check but the context ones. */
const preContextChecks = (): GuardrailCheck[] =>
  defaultGuardrailChecks(newId).filter((check) => check.point !== 'context');

describe('Arch §15.3 migration applies on a round-4 database and is recorded', () => {
  it('adds the round 5 tables and columns, and records the migration', () => {
    const before = openDatabase({ path, migrations: BEFORE_ROUND_5 });
    expect(before.appliedMigrations).not.toContain(ROUND_5_MIGRATION_ID);
    for (const table of NEW_TABLES) expect(tableNames(before.sqlite)).not.toContain(table);
    before.sqlite.close();

    const after = openDatabase({ path });
    expect(after.appliedMigrations).toEqual([
      ROUND_5_MIGRATION_ID,
      X1_CLI_PROVIDERS_MIGRATION_ID,
      CHAT_SESSIONS_CLI_MODELS_MIGRATION_ID,
      FORGE_TERMINAL_MIGRATION_ID,
    ]);
    for (const table of NEW_TABLES) expect(tableNames(after.sqlite)).toContain(table);
    expect(columnsOf(after.sqlite, 'node_runs')).toEqual(
      expect.arrayContaining(['sources', 'dropped_sources', 'memory_ops']),
    );
    expect(columnsOf(after.sqlite, 'guardrail_verdicts')).toContain('stripped_types');

    const ledger = after.sqlite
      .prepare('SELECT id FROM _ace_migrations WHERE id = ?')
      .get(ROUND_5_MIGRATION_ID);
    expect(ledger).toEqual({ id: ROUND_5_MIGRATION_ID });
    after.sqlite.close();
  });

  it('keeps every row written before it, and reads them through the repository', async () => {
    const before = openDatabase({ path, migrations: BEFORE_ROUND_5 });
    const project = makeProject();
    await createProjectBeforeTerminal(
      new SqliteRepository(before.db, before.sqlite),
      before.sqlite,
      project,
    );
    before.sqlite.close();

    const after = openDatabase({ path });
    const repository = new SqliteRepository(after.db, after.sqlite);
    expect(await repository.projects.get(scope, project.id)).toEqual(project);
    expect(await repository.knowledgeBases.listByProject(scope, project.id)).toEqual([]);
    after.sqlite.close();
  });

  it('applies exactly once, so reopening an up-to-date database changes nothing', () => {
    const first = openDatabase({ path });
    expect(first.appliedMigrations).toEqual(MIGRATIONS.map((migration) => migration.id));
    first.sqlite.close();

    const again = openDatabase({ path });
    expect(again.appliedMigrations).toEqual([]);
    again.sqlite.close();
  });

  it('sorts after every earlier migration, and only X1, chat-sessions and forge-terminal follow it', () => {
    const ids = MIGRATIONS.map((migration) => migration.id);
    expect(ids.indexOf(ROUND_5_MIGRATION_ID)).toBe(ids.length - 4);
    expect(ids.slice(-3)).toEqual([
      X1_CLI_PROVIDERS_MIGRATION_ID,
      CHAT_SESSIONS_CLI_MODELS_MIGRATION_ID,
      FORGE_TERMINAL_MIGRATION_ID,
    ]);
    expect([...ids].sort()).toEqual(ids);
    expect(ROUND_5_MIGRATION_ID).toBe('20261001T120000_round_5_knowledge_memory_usage');
  });
});

describe('FR-GRD-004 DN-2 the context-check seed writes version+1 only for policies without context checks', () => {
  it('appends the three context checks as a new version and moves the default flag to it', async () => {
    const before = openDatabase({ path, migrations: BEFORE_ROUND_5 });
    const repository = new SqliteRepository(before.db, before.sqlite);
    const project = makeProject();
    await createProjectBeforeTerminal(repository, before.sqlite, project);
    const policy = await repository.guardrailPolicies.getProjectDefault(scope, project.id);
    if (policy === null) throw new Error('the project has no default policy');
    // A round 4 install wrote its default policy without the context point.
    const oldChecks = preContextChecks();
    before.sqlite
      .prepare('UPDATE guardrail_policies SET checks = ? WHERE id = ?')
      .run(JSON.stringify(oldChecks), policy.id);
    before.sqlite.close();

    const after = openDatabase({ path });
    const rows = policyRows(after.sqlite, policy.id);
    expect(rows.map((row) => [row.version, row.is_project_default])).toEqual([
      [1, 0],
      [2, 1],
    ]);
    // Version 1 is history: untouched (BR-04, FR-GRD-001).
    expect(JSON.parse(rows[0]!.checks)).toEqual(oldChecks);

    const next = JSON.parse(rows[1]!.checks) as GuardrailCheck[];
    expect(next.slice(0, oldChecks.length)).toEqual(oldChecks);
    const added = next.slice(oldChecks.length);
    const expected = defaultGuardrailChecks(newId).filter((check) => check.point === 'context');
    expect(
      added.map(({ point, type, action, enabled, params }) => ({
        point,
        type,
        action,
        enabled,
        params,
      })),
    ).toEqual(
      expected.map(({ point, type, action, enabled, params }) => ({
        point,
        type,
        action,
        enabled,
        params,
      })),
    );
    // Fresh ids: none shared with the checks already on the policy.
    const ids = new Set(next.map((check) => check.id));
    expect(ids.size).toBe(next.length);
    expect(rows[1]!.created_at).toBe(rows[0]!.created_at);

    const upgraded = new SqliteRepository(after.db, after.sqlite);
    const read = await upgraded.guardrailPolicies.getProjectDefault(scope, project.id);
    expect(read?.version).toBe(2);
    expect(read?.checks.filter((check) => check.point === 'context')).toHaveLength(3);
    after.sqlite.close();
  });

  it('leaves a policy that already has a context check alone', async () => {
    const before = openDatabase({ path, migrations: BEFORE_ROUND_5 });
    const repository = new SqliteRepository(before.db, before.sqlite);
    const project = makeProject();
    await createProjectBeforeTerminal(repository, before.sqlite, project);
    const policy = await repository.guardrailPolicies.getProjectDefault(scope, project.id);
    if (policy === null) throw new Error('the project has no default policy');
    const withOneContextCheck = [
      ...preContextChecks(),
      ...defaultGuardrailChecks(newId).filter((check) => check.type === 'untrusted_tagging'),
    ];
    before.sqlite
      .prepare('UPDATE guardrail_policies SET checks = ? WHERE id = ?')
      .run(JSON.stringify(withOneContextCheck), policy.id);
    before.sqlite.close();

    const after = openDatabase({ path });
    const rows = policyRows(after.sqlite, policy.id);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.checks)).toEqual(withOneContextCheck);
    after.sqlite.close();
  });

  it('versions the latest row of a policy with history, and only a policy that lacks the point', async () => {
    const before = openDatabase({ path, migrations: BEFORE_ROUND_5 });
    const repository = new SqliteRepository(before.db, before.sqlite);
    const project = makeProject();
    await createProjectBeforeTerminal(repository, before.sqlite, project);
    const custom = {
      id: newId(),
      projectId: project.id,
      name: 'Strict',
      version: 1,
      isProjectDefault: false,
      checks: preContextChecks(),
      createdAt: project.createdAt,
      updatedAt: project.createdAt,
    };
    await repository.guardrailPolicies.create(scope, custom);
    await repository.guardrailPolicies.update(scope, custom.id, {
      version: 2,
      name: 'Stricter',
      updatedAt: project.createdAt,
    });
    before.sqlite.close();

    const after = openDatabase({ path });
    const rows = policyRows(after.sqlite, custom.id);
    expect(rows.map((row) => [row.version, row.is_project_default])).toEqual([
      [1, 0],
      [2, 0],
      [3, 0],
    ]);
    const upgraded = new SqliteRepository(after.db, after.sqlite);
    const latest = await upgraded.guardrailPolicies.get(scope, custom.id);
    expect(latest?.name).toBe('Stricter');
    expect(latest?.checks.filter((check) => check.point === 'context')).toHaveLength(3);
    // The project's own default was created with today's checks, so it needed nothing.
    const defaultPolicy = await upgraded.guardrailPolicies.getProjectDefault(scope, project.id);
    expect(defaultPolicy?.version).toBe(1);
    after.sqlite.close();
  });

  it('rolls the seed back with the schema when it throws (D99)', () => {
    const throwing: Migration = {
      ...MIGRATIONS.at(-1)!,
      seed: () => {
        throw new Error('seed failed');
      },
    };
    const before = openDatabase({ path, migrations: BEFORE_ROUND_5 });
    before.sqlite.close();

    expect(() => openDatabase({ path, migrations: [...BEFORE_ROUND_5, throwing] })).toThrow(
      'seed failed',
    );
    const reopened = openDatabase({ path, migrations: BEFORE_ROUND_5 });
    expect(tableNames(reopened.sqlite)).not.toContain('knowledge_bases');
    reopened.sqlite.close();
  });
});
