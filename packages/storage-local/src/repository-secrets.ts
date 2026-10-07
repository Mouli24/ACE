import { SecretSchema, type Secret } from '@ace/contracts';
import type { Scope, SecretRepository } from '@ace/engine';
import { and, asc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type * as schema from './schema.js';
import { secrets } from './schema.js';
import { assertNoSecrets, toJsonColumn } from './secret-guard.js';

type Db = BetterSQLite3Database<typeof schema>;

/**
 * The ACE parity P1 secrets repository (D274): a secret's name, description and project scope.
 *
 * There is no value here to guard — the table has no column for one, and `Secret` no field — but
 * the name and the description are text a person typed, so they go through the secret guard like
 * every other string the store writes: a credential pasted into a description is refused, not kept
 * (BR-07). Every row is parsed through the contract on the way out.
 */

type SecretRow = typeof secrets.$inferSelect;

function toSecret(row: SecretRow): Secret {
  return SecretSchema.parse({
    name: row.name,
    description: row.description,
    projectIds: JSON.parse(row.projectIds),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function columns(secret: Secret) {
  const at = `secret(${secret.name})`;
  assertNoSecrets(secret.name, `${at}.name`);
  assertNoSecrets(secret.description, `${at}.description`);
  return {
    description: secret.description,
    projectIds: toJsonColumn(secret.projectIds, `${at}.projectIds`),
    createdAt: secret.createdAt,
    updatedAt: secret.updatedAt,
  };
}

export function createSecretRepository(db: Db): SecretRepository {
  const inScope = (scope: Scope, name: string) =>
    and(eq(secrets.workspaceId, scope.workspaceId), eq(secrets.name, name));

  return {
    list: async (scope: Scope) =>
      db
        .select()
        .from(secrets)
        .where(eq(secrets.workspaceId, scope.workspaceId))
        .orderBy(asc(secrets.name))
        .all()
        .map(toSecret),

    get: async (scope: Scope, name: string) => {
      const row = db.select().from(secrets).where(inScope(scope, name)).get();
      return row === undefined ? null : toSecret(row);
    },

    /** The primary key refuses a second row of the same name in the workspace. */
    create: async (scope: Scope, secret: Secret) => {
      db.insert(secrets)
        .values({ workspaceId: scope.workspaceId, name: secret.name, ...columns(secret) })
        .run();
      return secret;
    },

    save: async (scope: Scope, secret: Secret) => {
      const { changes } = db
        .update(secrets)
        .set(columns(secret))
        .where(inScope(scope, secret.name))
        .run();
      if (changes === 0) {
        throw new Error(`Secret ${secret.name} is not stored, so it cannot be saved`);
      }
      return secret;
    },

    delete: async (scope: Scope, name: string) =>
      db.delete(secrets).where(inScope(scope, name)).run().changes > 0,
  };
}
