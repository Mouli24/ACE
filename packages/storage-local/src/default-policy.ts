import {
  DEFAULT_GUARDRAIL_POLICY_NAME,
  defaultGuardrailChecks,
  GuardrailPolicySchema,
  type GuardrailPolicy,
  type Id,
  type Timestamp,
} from '@ace/contracts';
import { newId } from '@ace/engine';
import type BetterSqlite3 from 'better-sqlite3';

/**
 * The policy every project gets (FR-GRD-018, D10).
 *
 * The check list itself is `defaultGuardrailChecks` in `@ace/contracts` — the one definition the
 * engine, this migration and the web app's mocks all read, so none of them can drift from §2.2.
 * This module only wraps it in a policy row: version 1, named "Default", flagged as the project
 * default.
 *
 * Two callers need it and both go through here: the round 3 migration, which backfills every
 * project that existed before it ran, and `projects.create`, which writes the policy in the same
 * transaction as the project so a project can never exist without one.
 */
export function buildDefaultPolicy(
  projectId: Id,
  at: Timestamp,
  ids: () => Id = newId,
): GuardrailPolicy {
  return GuardrailPolicySchema.parse({
    id: ids(),
    projectId,
    name: DEFAULT_GUARDRAIL_POLICY_NAME,
    version: 1,
    isProjectDefault: true,
    checks: defaultGuardrailChecks(ids),
    createdAt: at,
    updatedAt: at,
  });
}

/** The columns of `guardrail_policies`, in the order the raw inserts below bind them. */
const INSERT_POLICY = `
  INSERT INTO guardrail_policies
    (id, workspace_id, project_id, name, version, is_project_default, checks, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Gives every project without a default policy one, and answers how many it created.
 *
 * Written against `better-sqlite3` rather than Drizzle because the migration runner has only the
 * raw connection, and it is idempotent — the `NOT EXISTS` test means re-running it on a database
 * that already has its defaults is a no-op, which is what makes it safe to call from a migration
 * that may be replayed on a restored backup.
 */
export function backfillDefaultPolicies(sqlite: BetterSqlite3.Database): number {
  const rows = sqlite
    .prepare(
      `SELECT p.id AS id, p.workspace_id AS workspaceId, p.created_at AS createdAt
         FROM projects p
        WHERE NOT EXISTS (
                SELECT 1 FROM guardrail_policies g
                 WHERE g.workspace_id = p.workspace_id
                   AND g.project_id = p.id
                   AND g.is_project_default = 1
              )
        ORDER BY p.id`,
    )
    .all() as { id: string; workspaceId: string; createdAt: string }[];

  const insert = sqlite.prepare(INSERT_POLICY);

  for (const row of rows) {
    // Dated with the project: the default policy has applied for as long as the project has
    // existed, and stamping it with the migration's own clock would misreport that.
    const policy = buildDefaultPolicy(row.id, row.createdAt);
    insert.run(
      policy.id,
      row.workspaceId,
      policy.projectId,
      policy.name,
      policy.version,
      1,
      JSON.stringify(policy.checks),
      policy.createdAt,
      policy.updatedAt,
    );
  }

  return rows.length;
}
