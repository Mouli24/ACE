import type { Secret } from '@ace/contracts';
import { newId, SecretWriteRejectedError } from '@ace/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NOW, scope } from './fixtures.js';
import { createTempDb, type TempDb } from './temp-db.js';

/*
 * ACE parity P1 (D274) on a real SQLite file: a secret's row — name, description, project scope —
 * and never a value, because the table has no column for one.
 */

let db: TempDb;

beforeEach(() => {
  db = createTempDb();
});

afterEach(() => {
  db.close();
});

const LATER = '2026-10-07T11:00:00.000Z';
/** Key-shaped, and assembled at runtime so no key literal is in the repository (CLAUDE.md §2). */
const KEY = ['sk', '-', 'a1B2'.repeat(8)].join('');

const secret = (overrides: Partial<Secret> = {}): Secret => ({
  name: 'DEPLOY_TOKEN',
  description: 'Deploys staging',
  projectIds: [],
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe('D274 the secrets repository', () => {
  it('creates, reads, lists by name, saves and deletes a row', async () => {
    const repo = db.repository.secrets;
    const projectId = newId();
    const scoped = secret({ name: 'SHOP_TOKEN', projectIds: [projectId] });
    await repo.create(scope, secret());
    await repo.create(scope, scoped);
    await repo.create(scope, secret({ name: 'API_URL', description: '' }));

    expect(await repo.get(scope, 'SHOP_TOKEN')).toEqual(scoped);
    expect(await repo.get(scope, 'MISSING')).toBeNull();
    expect((await repo.list(scope)).map((row) => row.name)).toEqual([
      'API_URL',
      'DEPLOY_TOKEN',
      'SHOP_TOKEN',
    ]);

    const saved = { ...scoped, description: 'Shop only', projectIds: [], updatedAt: LATER };
    expect(await repo.save(scope, saved)).toEqual(saved);
    expect(await repo.get(scope, 'SHOP_TOKEN')).toEqual(saved);

    expect(await repo.delete(scope, 'SHOP_TOKEN')).toBe(true);
    expect(await repo.delete(scope, 'SHOP_TOKEN')).toBe(false);
    expect(await repo.get(scope, 'SHOP_TOKEN')).toBeNull();
  });

  it('refuses a second row of the same name, and saving a row that is not stored', async () => {
    const repo = db.repository.secrets;
    await repo.create(scope, secret());
    await expect(repo.create(scope, secret({ description: 'again' }))).rejects.toThrow();
    await expect(repo.save(scope, secret({ name: 'NOT_STORED' }))).rejects.toThrow(/not stored/);
    expect(await repo.get(scope, 'DEPLOY_TOKEN')).toEqual(secret());
  });

  it('keeps workspaces apart: the same name may exist in each, and neither reads the other', async () => {
    const repo = db.repository.secrets;
    const other = { workspaceId: 'other' };
    await repo.create(scope, secret());
    await repo.create(other, secret({ description: 'theirs' }));
    expect((await repo.get(scope, 'DEPLOY_TOKEN'))?.description).toBe('Deploys staging');
    expect((await repo.get(other, 'DEPLOY_TOKEN'))?.description).toBe('theirs');
    expect(await repo.delete(other, 'DEPLOY_TOKEN')).toBe(true);
    expect(await repo.get(scope, 'DEPLOY_TOKEN')).not.toBeNull();
  });

  it('refuses a credential typed into a description (BR-07)', async () => {
    const repo = db.repository.secrets;
    await expect(
      repo.create(scope, secret({ description: `the key is ${KEY}` })),
    ).rejects.toBeInstanceOf(SecretWriteRejectedError);
    await repo.create(scope, secret());
    await expect(
      repo.save(scope, secret({ description: `the key is ${KEY}` })),
    ).rejects.toBeInstanceOf(SecretWriteRejectedError);
    expect(await repo.list(scope)).toEqual([secret()]);
  });

  it('has no column that could hold a value', () => {
    const columns = (
      db.sqlite.prepare('PRAGMA table_info(secrets)').all() as { name: string }[]
    ).map((column) => column.name);
    expect(columns.sort()).toEqual(
      ['created_at', 'description', 'name', 'project_ids', 'updated_at', 'workspace_id'].sort(),
    );
  });
});
