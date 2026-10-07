import type { Bundle, Skill } from '@ace/contracts';
import { newId, SecretWriteRejectedError } from '@ace/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scope } from './fixtures.js';
import { createTempDb, type TempDb } from './temp-db.js';

/**
 * The ACE parity P1 repositories (D272, D273) on a real SQLite file: installed skills and imported
 * bundles.
 */

let db: TempDb;

beforeEach(() => {
  db = createTempDb();
});

afterEach(() => {
  db.close();
});

const AT = '2026-10-07T10:00:00.000Z';
const LATER = '2026-10-07T11:00:00.000Z';
const other = { workspaceId: 'other' };
/** Key-shaped, and assembled at runtime so no key literal is in the repository (CLAUDE.md §2). */
const KEY = ['sk', '-', 'a1B2'.repeat(8)].join('');

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: newId(),
    name: 'Test first',
    description: 'Write the failing test before the change.',
    instructions: 'Write a test that fails, then make it pass.',
    version: 1,
    source: 'user',
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function makeBundle(overrides: Partial<Bundle> = {}): Bundle {
  return {
    id: newId(),
    name: 'Web team',
    description: 'How the web team works.',
    skillIds: [newId(), newId()],
    mcpServers: [
      { name: 'files', transport: 'stdio', command: 'node', args: ['server.js', '--stdio'] },
      { name: 'search', transport: 'http', url: 'http://127.0.0.1:8000/mcp' },
    ],
    createdAt: AT,
    ...overrides,
  };
}

describe('D272 SkillRepository', () => {
  it('round-trips a skill with every field, and a bundle skill its bundle id', async () => {
    const user = makeSkill();
    const bundled = makeSkill({ name: 'Review', source: 'bundle', bundleId: newId(), version: 3 });
    await db.repository.skills.create(scope, user);
    await db.repository.skills.create(scope, bundled);

    expect(await db.repository.skills.get(scope, user.id)).toEqual(user);
    expect(await db.repository.skills.get(scope, bundled.id)).toEqual(bundled);
    expect(await db.repository.skills.get(scope, newId())).toBeNull();
  });

  it('finds a skill by name whatever its case, and only in its own workspace', async () => {
    const skill = makeSkill({ name: 'Small, safe changes' });
    await db.repository.skills.create(scope, skill);

    expect(await db.repository.skills.getByName(scope, 'small, SAFE changes')).toEqual(skill);
    expect(await db.repository.skills.getByName(scope, 'Small safe changes')).toBeNull();
    expect(await db.repository.skills.getByName(other, 'Small, safe changes')).toBeNull();
    expect(await db.repository.skills.get(other, skill.id)).toBeNull();
  });

  it('lists built-in skills first, then the rest by name whatever its case', async () => {
    const zed = makeSkill({ name: 'zed' });
    const alpha = makeSkill({ name: 'Alpha' });
    const builtinB = makeSkill({ name: 'Security review', source: 'builtin' });
    const builtinA = makeSkill({ name: 'Explain the change', source: 'builtin' });
    const beta = makeSkill({ name: 'beta', source: 'bundle', bundleId: newId() });
    for (const skill of [zed, alpha, builtinB, builtinA, beta]) {
      await db.repository.skills.create(scope, skill);
    }
    await db.repository.skills.create(other, makeSkill({ name: 'Elsewhere' }));

    expect((await db.repository.skills.list(scope)).map((skill) => skill.name)).toEqual([
      'Explain the change',
      'Security review',
      'Alpha',
      'beta',
      'zed',
    ]);
  });

  it('refuses a second skill with the same name in any case (the unique index)', async () => {
    await db.repository.skills.create(scope, makeSkill({ name: 'Test first' }));
    await expect(
      db.repository.skills.create(scope, makeSkill({ name: 'TEST FIRST' })),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    // Another workspace has its own names.
    await expect(
      db.repository.skills.create(other, makeSkill({ name: 'Test first' })),
    ).resolves.toBeDefined();
  });

  it('saves a changed skill in place and refuses to save one that is not stored', async () => {
    const skill = makeSkill();
    await db.repository.skills.create(scope, skill);
    const edited: Skill = {
      ...skill,
      name: 'Test first, always',
      instructions: 'Always write the failing test first.',
      version: 2,
      updatedAt: LATER,
    };
    expect(await db.repository.skills.save(scope, edited)).toEqual(edited);
    expect(await db.repository.skills.get(scope, skill.id)).toEqual(edited);

    await expect(db.repository.skills.save(scope, makeSkill({ name: 'Ghost' }))).rejects.toThrow(
      /not stored/,
    );
    await expect(db.repository.skills.save(other, edited)).rejects.toThrow(/not stored/);
  });

  it('deletes a skill once, and only in its own workspace', async () => {
    const skill = makeSkill();
    await db.repository.skills.create(scope, skill);
    expect(await db.repository.skills.delete(other, skill.id)).toBe(false);
    expect(await db.repository.skills.delete(scope, skill.id)).toBe(true);
    expect(await db.repository.skills.delete(scope, skill.id)).toBe(false);
    expect(await db.repository.skills.get(scope, skill.id)).toBeNull();
  });

  it('BR-07 refuses instructions that carry a credential, naming the field', async () => {
    const skill = makeSkill({ instructions: `Call the API with ${KEY}.` });
    const write = db.repository.skills.create(scope, skill);
    await expect(write).rejects.toBeInstanceOf(SecretWriteRejectedError);
    await expect(write).rejects.toMatchObject({ path: `skill(${skill.id}).instructions` });
    expect(await db.repository.skills.list(scope)).toEqual([]);
  });
});

describe('D273 BundleRepository', () => {
  it('round-trips a bundle with its skill ids and plugin definitions as named', async () => {
    const bundle = makeBundle();
    await db.repository.bundles.create(scope, bundle);
    expect(await db.repository.bundles.get(scope, bundle.id)).toEqual(bundle);
    expect(await db.repository.bundles.get(other, bundle.id)).toBeNull();

    const empty = makeBundle({ name: 'Empty', description: '', skillIds: [], mcpServers: [] });
    await db.repository.bundles.create(scope, empty);
    expect(await db.repository.bundles.get(scope, empty.id)).toEqual(empty);
  });

  it('lists bundles oldest first, in their own workspace', async () => {
    const second = makeBundle({ name: 'Second', createdAt: LATER });
    const first = makeBundle({ name: 'First', createdAt: AT });
    await db.repository.bundles.create(scope, second);
    await db.repository.bundles.create(scope, first);
    await db.repository.bundles.create(other, makeBundle({ name: 'Elsewhere' }));

    expect((await db.repository.bundles.list(scope)).map((bundle) => bundle.name)).toEqual([
      'First',
      'Second',
    ]);
  });

  it('deletes a bundle once', async () => {
    const bundle = makeBundle();
    await db.repository.bundles.create(scope, bundle);
    expect(await db.repository.bundles.delete(scope, bundle.id)).toBe(true);
    expect(await db.repository.bundles.delete(scope, bundle.id)).toBe(false);
    expect(await db.repository.bundles.list(scope)).toEqual([]);
  });

  it('BR-07 refuses a plugin definition that carries a credential', async () => {
    const bundle = makeBundle({
      mcpServers: [{ name: 'leaky', transport: 'stdio', command: 'node', args: ['--key', KEY] }],
    });
    const write = db.repository.bundles.create(scope, bundle);
    await expect(write).rejects.toBeInstanceOf(SecretWriteRejectedError);
    await expect(write).rejects.toMatchObject({
      path: `bundle(${bundle.id}).mcpServers[0].args[1]`,
    });
    expect(await db.repository.bundles.list(scope)).toEqual([]);
  });

  it('NFR-REL-02 an import written in one transaction rolls back whole', async () => {
    const skill = makeSkill({ source: 'bundle' });
    const bundle = makeBundle({ skillIds: [skill.id] });
    await expect(
      db.repository.transaction(async (tx) => {
        await tx.skills!.create(scope, { ...skill, bundleId: bundle.id });
        await tx.bundles!.create(scope, bundle);
        throw new Error('the import failed half way');
      }),
    ).rejects.toThrow('half way');

    expect(await db.repository.skills.list(scope)).toEqual([]);
    expect(await db.repository.bundles.list(scope)).toEqual([]);
  });
});
