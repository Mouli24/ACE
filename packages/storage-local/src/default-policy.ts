import {
  DEFAULT_GUARDRAIL_POLICY_NAME,
  DEFAULT_POLICY_MAX_TOOL_CALLS,
  PREVIOUS_POLICY_MAX_TOOL_CALLS,
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

/** A stored JSON column, or `undefined` when it no longer parses — the schema then refuses it. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
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

/**
 * DN-2 (round 5 §2.3, FR-GRD-004): every policy whose latest version has no `context`-point check
 * gets one more version, its checks followed by the three context checks of
 * `defaultGuardrailChecks` with fresh ids. Answers how many policies it versioned.
 *
 * A policy is versioned, never edited, for the reason a PATCH is (FR-GRD-001, BR-04): a node run
 * that recorded `{ id, version }` must still resolve to the checks it ran against. The new row
 * keeps the policy's `created_at` and name, takes the default flag when the old row had it — the
 * flag is cleared first so the partial unique index has room — and is stamped with the migration's
 * clock, as a PATCH is stamped with its own. A policy with even one context check was edited by
 * someone after C5 and is theirs: it is left alone. A stored policy that no longer parses is left
 * alone too, rather than failing the migration and with it every start of the engine; it was
 * already unreadable through `toPolicy`.
 *
 * Idempotent like the backfill above: once a policy carries the context checks it is skipped.
 */
export function appendContextChecks(
  sqlite: BetterSqlite3.Database,
  at: Timestamp = new Date().toISOString(),
  ids: () => Id = newId,
): number {
  const latest = sqlite
    .prepare(
      `SELECT g.id AS id, g.workspace_id AS workspaceId, g.project_id AS projectId, g.name AS name,
              g.version AS version, g.is_project_default AS isProjectDefault, g.checks AS checks,
              g.created_at AS createdAt, g.updated_at AS updatedAt
         FROM guardrail_policies g
        WHERE g.version = (SELECT MAX(v.version) FROM guardrail_policies v WHERE v.id = g.id)
        ORDER BY g.id`,
    )
    .all() as {
    id: string;
    workspaceId: string;
    projectId: string;
    name: string;
    version: number;
    isProjectDefault: number;
    checks: string;
    createdAt: string;
    updatedAt: string;
  }[];

  const clearDefault = sqlite.prepare(
    `UPDATE guardrail_policies SET is_project_default = 0 WHERE id = ? AND version = ?`,
  );
  const insert = sqlite.prepare(INSERT_POLICY);
  let versioned = 0;

  for (const row of latest) {
    const current = GuardrailPolicySchema.safeParse({
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      version: row.version,
      isProjectDefault: row.isProjectDefault === 1,
      checks: parseJson(row.checks),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
    if (!current.success) continue;
    if (current.data.checks.some((check) => check.point === 'context')) continue;

    const next = GuardrailPolicySchema.parse({
      ...current.data,
      version: current.data.version + 1,
      checks: [
        ...current.data.checks,
        ...defaultGuardrailChecks(ids).filter((check) => check.point === 'context'),
      ],
      updatedAt: at,
    });

    if (next.isProjectDefault) clearDefault.run(row.id, row.version);
    insert.run(
      next.id,
      row.workspaceId,
      next.projectId,
      next.name,
      next.version,
      next.isProjectDefault ? 1 : 0,
      JSON.stringify(next.checks),
      next.createdAt,
      next.updatedAt,
    );
    versioned += 1;
  }

  return versioned;
}

/**
 * D375 (agentic nodes): every policy still holding the seeded default's `max_tool_calls` cap of 25
 * gets one more version with it at 200 — the cap a node working in the project folder needs; its
 * own Max turns and token budget bound it. Answers how many policies it versioned.
 *
 * Only the seeded default is raised: a policy named "Default" whose `max_tool_calls` check still
 * reads exactly `{ max: 25 }`. A policy someone renamed, or whose cap they set to anything else, is
 * theirs and left alone. Versioned, never edited, for the reason `appendContextChecks` is (BR-04);
 * the new version keeps every other check, its id and its default flag. Idempotent: once raised, a
 * policy no longer matches.
 */
export function raiseDefaultToolCallCap(
  sqlite: BetterSqlite3.Database,
  at: Timestamp = new Date().toISOString(),
): number {
  const latest = sqlite
    .prepare(
      `SELECT g.id AS id, g.workspace_id AS workspaceId, g.project_id AS projectId, g.name AS name,
              g.version AS version, g.is_project_default AS isProjectDefault, g.checks AS checks,
              g.created_at AS createdAt, g.updated_at AS updatedAt
         FROM guardrail_policies g
        WHERE g.version = (SELECT MAX(v.version) FROM guardrail_policies v WHERE v.id = g.id)
        ORDER BY g.id`,
    )
    .all() as {
    id: string;
    workspaceId: string;
    projectId: string;
    name: string;
    version: number;
    isProjectDefault: number;
    checks: string;
    createdAt: string;
    updatedAt: string;
  }[];

  const clearDefault = sqlite.prepare(
    `UPDATE guardrail_policies SET is_project_default = 0 WHERE id = ? AND version = ?`,
  );
  const insert = sqlite.prepare(INSERT_POLICY);
  let versioned = 0;

  for (const row of latest) {
    if (row.name !== DEFAULT_GUARDRAIL_POLICY_NAME) continue;
    const current = GuardrailPolicySchema.safeParse({
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      version: row.version,
      isProjectDefault: row.isProjectDefault === 1,
      checks: parseJson(row.checks),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
    if (!current.success) continue;

    const seeded = (check: (typeof current.data.checks)[number]): boolean =>
      check.point === 'loop' &&
      check.type === 'max_tool_calls' &&
      Object.keys(check.params).length === 1 &&
      check.params['max'] === PREVIOUS_POLICY_MAX_TOOL_CALLS;
    if (!current.data.checks.some(seeded)) continue;

    const next = GuardrailPolicySchema.parse({
      ...current.data,
      version: current.data.version + 1,
      checks: current.data.checks.map((check) =>
        seeded(check) ? { ...check, params: { max: DEFAULT_POLICY_MAX_TOOL_CALLS } } : check,
      ),
      updatedAt: at,
    });

    if (next.isProjectDefault) clearDefault.run(row.id, row.version);
    insert.run(
      next.id,
      row.workspaceId,
      next.projectId,
      next.name,
      next.version,
      next.isProjectDefault ? 1 : 0,
      JSON.stringify(next.checks),
      next.createdAt,
      next.updatedAt,
    );
    versioned += 1;
  }

  return versioned;
}
