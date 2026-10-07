import { BundleSchema, SkillSchema, type Bundle, type Id, type Skill } from '@ace/contracts';
import type { BundleRepository, Scope, SkillRepository } from '@ace/engine';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type * as schema from './schema.js';
import { bundles, skills } from './schema.js';
import { assertNoSecrets, toJsonColumn } from './secret-guard.js';

type Db = BetterSQLite3Database<typeof schema>;

/**
 * The ACE parity P1 repositories (D272, D273): installed skills and imported bundles.
 *
 * Split out of `repository.ts`, one feature's worth of tables per file, as the task repositories
 * are. Every row is parsed through its contract on the way out, so a row that drifted fails on read.
 * Every record is walked by the secret guard on the way in: a skill's instructions and a bundle's
 * plugin definitions are text a person (or a shared file) wrote, and a credential in either is
 * refused, as everywhere else in the store (BR-07).
 */

type SkillRow = typeof skills.$inferSelect;
type BundleRow = typeof bundles.$inferSelect;

function toSkill(row: SkillRow): Skill {
  return SkillSchema.parse({
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    version: row.version,
    source: row.source,
    ...(row.bundleId === null ? {} : { bundleId: row.bundleId }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function toBundle(row: BundleRow): Bundle {
  return BundleSchema.parse({
    id: row.id,
    name: row.name,
    description: row.description,
    skillIds: JSON.parse(row.skillIds),
    mcpServers: JSON.parse(row.mcpServers),
    createdAt: row.createdAt,
  });
}

function skillColumns(skill: Skill) {
  assertNoSecrets(skill, `skill(${skill.id})`);
  return {
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    version: skill.version,
    source: skill.source,
    bundleId: skill.bundleId ?? null,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  };
}

/** `save` replaces a row that exists; a missing one is a caller's bug, not a silent no-op. */
function assertSaved(changes: number, what: string, id: Id): void {
  if (changes === 0) throw new Error(`${what} ${id} is not stored, so it cannot be saved`);
}

/* -------------------------------------------------------------------------- */
/* Skills (D272)                                                               */
/* -------------------------------------------------------------------------- */

export function createSkillRepository(db: Db): SkillRepository {
  const inScope = (scope: Scope, ...conditions: (SQL | undefined)[]) =>
    and(eq(skills.workspaceId, scope.workspaceId), ...conditions);

  return {
    create: async (scope: Scope, skill: Skill) => {
      db.insert(skills)
        .values({ id: skill.id, workspaceId: scope.workspaceId, ...skillColumns(skill) })
        .run();
      return skill;
    },

    get: async (scope: Scope, id: Id) => {
      const row = db
        .select()
        .from(skills)
        .where(inScope(scope, eq(skills.id, id)))
        .get();
      return row === undefined ? null : toSkill(row);
    },

    /** `lower()` on both sides: the comparison `skills_name_idx` makes, so the two agree. */
    getByName: async (scope: Scope, name: string) => {
      const row = db
        .select()
        .from(skills)
        .where(inScope(scope, sql`lower(${skills.name}) = lower(${name})`))
        .get();
      return row === undefined ? null : toSkill(row);
    },

    list: async (scope: Scope) =>
      db
        .select()
        .from(skills)
        .where(inScope(scope))
        .orderBy(
          sql`CASE WHEN ${skills.source} = 'builtin' THEN 0 ELSE 1 END`,
          sql`lower(${skills.name})`,
          asc(skills.id),
        )
        .all()
        .map(toSkill),

    save: async (scope: Scope, skill: Skill) => {
      const { changes } = db
        .update(skills)
        .set(skillColumns(skill))
        .where(inScope(scope, eq(skills.id, skill.id)))
        .run();
      assertSaved(changes, 'Skill', skill.id);
      return skill;
    },

    delete: async (scope: Scope, id: Id) =>
      db
        .delete(skills)
        .where(inScope(scope, eq(skills.id, id)))
        .run().changes > 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Bundles (D273)                                                              */
/* -------------------------------------------------------------------------- */

export function createBundleRepository(db: Db): BundleRepository {
  const inScope = (scope: Scope, ...conditions: (SQL | undefined)[]) =>
    and(eq(bundles.workspaceId, scope.workspaceId), ...conditions);

  return {
    create: async (scope: Scope, bundle: Bundle) => {
      assertNoSecrets(
        { name: bundle.name, description: bundle.description },
        `bundle(${bundle.id})`,
      );
      db.insert(bundles)
        .values({
          id: bundle.id,
          workspaceId: scope.workspaceId,
          name: bundle.name,
          description: bundle.description,
          skillIds: toJsonColumn(bundle.skillIds, `bundle(${bundle.id}).skillIds`),
          mcpServers: toJsonColumn(bundle.mcpServers, `bundle(${bundle.id}).mcpServers`),
          createdAt: bundle.createdAt,
        })
        .run();
      return bundle;
    },

    get: async (scope: Scope, id: Id) => {
      const row = db
        .select()
        .from(bundles)
        .where(inScope(scope, eq(bundles.id, id)))
        .get();
      return row === undefined ? null : toBundle(row);
    },

    /** Oldest first; ids are monotonic, so they break a tie in the same millisecond. */
    list: async (scope: Scope) =>
      db
        .select()
        .from(bundles)
        .where(inScope(scope))
        .orderBy(asc(bundles.createdAt), asc(bundles.id))
        .all()
        .map(toBundle),

    delete: async (scope: Scope, id: Id) =>
      db
        .delete(bundles)
        .where(inScope(scope, eq(bundles.id, id)))
        .run().changes > 0,
  };
}
