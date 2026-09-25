import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_GUARDRAIL_POLICY_NAME, defaultGuardrailChecks } from '@ace/contracts';
import { newId } from '@ace/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../db.js';
import { backfillDefaultPolicies } from '../default-policy.js';
import {
  appliedMigrations,
  applyMigrations,
  MIGRATIONS,
  ROUND_3_MIGRATION_ID,
} from '../migrations.js';
import { SqliteRepository } from '../repository.js';

/**
 * The round 3 migration and its backfill (FR-GRD-018).
 *
 * These tests open the database twice on purpose: once with the chain as it stood before round 3,
 * so a project really does predate the migration, and once with the whole chain, which is what a
 * user upgrading an existing ACE install experiences.
 */

const BEFORE_ROUND_3 = MIGRATIONS.slice(
  0,
  MIGRATIONS.findIndex((migration) => migration.id === ROUND_3_MIGRATION_ID),
);

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-migration-'));
  path = join(dir, 'ace.sqlite');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface PolicyRow {
  id: string;
  workspaceId: string;
  projectId: string;
  name: string;
  version: number;
  isProjectDefault: number;
  checks: string;
  createdAt: string;
}

const SELECT_POLICIES = `
  SELECT id, workspace_id AS workspaceId, project_id AS projectId, name, version,
         is_project_default AS isProjectDefault, checks, created_at AS createdAt
    FROM guardrail_policies
   ORDER BY project_id
`;

/** A project written straight into the pre-round-3 schema, with no policy anywhere. */
function insertLegacyProject(
  sqlite: ReturnType<typeof openDatabase>['sqlite'],
  workspaceId: string,
  createdAt: string,
): string {
  const id = newId();
  sqlite
    .prepare(
      `INSERT INTO projects (id, workspace_id, name, folder_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, workspaceId, 'Legacy', 'D:/projects/legacy', createdAt, createdAt);
  return id;
}

describe('FR-GRD-018 The migration backfills a project that existed before it ran', () => {
  it('gives every pre-existing project the §2.2 default policy', () => {
    const before = openDatabase({ path, migrations: BEFORE_ROUND_3 });
    expect(before.appliedMigrations).not.toContain(ROUND_3_MIGRATION_ID);
    const first = insertLegacyProject(before.sqlite, 'local', '2026-09-20T09:00:00.000Z');
    const second = insertLegacyProject(before.sqlite, 'local', '2026-09-21T09:00:00.000Z');
    // A second workspace proves the backfill is not hard-wired to 'local' (BR-18).
    const hosted = insertLegacyProject(before.sqlite, 'other', '2026-09-22T09:00:00.000Z');
    before.sqlite.close();

    const after = openDatabase({ path });
    expect(after.appliedMigrations).toEqual([ROUND_3_MIGRATION_ID]);

    const rows = after.sqlite.prepare(SELECT_POLICIES).all() as PolicyRow[];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.name).toBe(DEFAULT_GUARDRAIL_POLICY_NAME);
      expect(row.version).toBe(1);
      expect(row.isProjectDefault).toBe(1);
      expect(JSON.parse(row.checks)).toHaveLength(defaultGuardrailChecks(newId).length);
    }
    expect(rows.map((row) => row.projectId).sort()).toEqual([first, second, hosted].sort());
    expect(rows.find((row) => row.projectId === hosted)?.workspaceId).toBe('other');
    // The policy has been the project's default since the project existed, so it is dated with it.
    expect(rows.find((row) => row.projectId === first)?.createdAt).toBe('2026-09-20T09:00:00.000Z');

    after.sqlite.close();
  });

  it('reads back through the repository as the project default', async () => {
    const before = openDatabase({ path, migrations: BEFORE_ROUND_3 });
    const projectId = insertLegacyProject(before.sqlite, 'local', '2026-09-20T09:00:00.000Z');
    before.sqlite.close();

    const after = openDatabase({ path });
    const repository = new SqliteRepository(after.db, after.sqlite);

    const policy = await repository.guardrailPolicies.getProjectDefault(
      { workspaceId: 'local' },
      projectId,
    );
    expect(policy?.isProjectDefault).toBe(true);
    expect(policy?.checks.map((check) => `${check.point}/${check.type}/${check.action}`)).toEqual(
      defaultGuardrailChecks(newId).map(
        (check) => `${check.point}/${check.type}/${check.action}`,
      ),
    );

    after.sqlite.close();
  });

  it('adds the round 3 columns to the existing tables without losing a row', () => {
    const before = openDatabase({ path, migrations: BEFORE_ROUND_3 });
    const projectId = insertLegacyProject(before.sqlite, 'local', '2026-09-20T09:00:00.000Z');
    before.sqlite.close();

    const after = openDatabase({ path });
    const project = after.sqlite
      .prepare(`SELECT name, max_cost_per_run_usd AS cap FROM projects WHERE id = ?`)
      .get(projectId) as { name: string; cap: number | null };

    expect(project.name).toBe('Legacy');
    expect(project.cap).toBeNull();

    const nodeRunColumns = (
      after.sqlite.prepare(`PRAGMA table_info(node_runs)`).all() as { name: string }[]
    ).map((column) => column.name);
    expect(nodeRunColumns).toContain('approvals');
    expect(nodeRunColumns).toContain('guardrail_policy');
    expect(nodeRunColumns).toContain('loop_stop');
    expect(nodeRunColumns).toContain('reused_from_node_run_id');

    after.sqlite.close();
  });

  it('is idempotent: a second backfill adds nothing', () => {
    const before = openDatabase({ path, migrations: BEFORE_ROUND_3 });
    insertLegacyProject(before.sqlite, 'local', '2026-09-20T09:00:00.000Z');
    before.sqlite.close();

    const after = openDatabase({ path });
    expect(backfillDefaultPolicies(after.sqlite)).toBe(0);
    expect(
      (after.sqlite.prepare(SELECT_POLICIES).all() as PolicyRow[]).length,
    ).toBe(1);

    after.sqlite.close();
  });

  it('applies exactly once, so reopening an up-to-date database changes nothing', () => {
    const first = openDatabase({ path });
    expect(first.appliedMigrations).toEqual(MIGRATIONS.map((migration) => migration.id));
    first.sqlite.close();

    const again = openDatabase({ path });
    expect(again.appliedMigrations).toEqual([]);
    expect(again.sqlite.prepare(SELECT_POLICIES).all()).toEqual([]);
    again.sqlite.close();
  });

  it('rolls a whole migration back when its data step throws', () => {
    const opened = openDatabase({ path, migrations: BEFORE_ROUND_3 });
    const broken = {
      id: '20260926T130000_broken',
      up: `CREATE TABLE half_written (id TEXT PRIMARY KEY);`,
      seed: () => {
        throw new Error('backfill failed');
      },
    };

    expect(() => applyMigrations(opened.sqlite, [...BEFORE_ROUND_3, broken])).toThrow(
      'backfill failed',
    );

    // The schema change and its data step commit together or not at all.
    expect(() => opened.sqlite.prepare(`SELECT 1 FROM half_written`).all()).toThrow(/no such table/);
    expect(appliedMigrations(opened.sqlite).has(broken.id)).toBe(false);

    opened.sqlite.close();
  });
});
