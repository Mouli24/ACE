import { SkillSchema, type BundleFile, type Skill } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { HttpError } from '../../gateway/errors.js';
import { BUILTIN_SKILL_IDS, BUILTIN_SKILLS, BUILTIN_SKILLS_AT } from '../builtin.js';
import { createSkillService, skillRepositories } from '../service.js';
import { createSkillHarness, SKILL_TEST_NOW } from './harness.js';

/**
 * The skills library (ACE parity P1, D272, D273, FR-SKL-001..003): CRUD with read-only built-ins,
 * unique names and the version rule, duplicates, the built-ins at start, and bundle import and
 * removal — which installs skills and connects nothing.
 */

const LATER = '2026-10-07T11:00:00.000Z';

/** The refusal's `code`, or a failure if the call did not throw an `HttpError`. */
async function refusal(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    if (error instanceof HttpError) return error.code;
    throw error;
  }
  throw new Error('expected a refusal');
}

const bundleFile = (overrides: Partial<BundleFile> = {}): BundleFile => ({
  format: 'ace-bundle',
  formatVersion: 1,
  name: 'Web team',
  description: 'How the web team works.',
  skills: [
    { name: 'Accessible forms', instructions: 'Every input has a label.' },
    { name: 'Test first', description: 'Our take.', instructions: 'Write the story test first.' },
  ],
  mcpServers: [
    { name: 'files', transport: 'stdio', command: 'node', args: ['files.js'] },
    { name: 'search', transport: 'http', url: 'http://127.0.0.1:8000/mcp' },
  ],
  ...overrides,
});

describe('FR-SKL-001 D272 built-in skills', () => {
  it('ships five read-only skills with fixed, valid ids and useful instructions', () => {
    expect(BUILTIN_SKILLS.map((skill) => skill.name)).toEqual([
      'Small, safe changes',
      'Test first',
      'Explain the change',
      "Follow the codebase's style",
      'Security review',
    ]);
    expect(BUILTIN_SKILLS.map((skill) => skill.id)).toEqual(Object.values(BUILTIN_SKILL_IDS));
    for (const skill of BUILTIN_SKILLS) {
      expect(SkillSchema.parse(skill)).toEqual(skill);
      expect(skill).toMatchObject({ source: 'builtin', version: 1, createdAt: BUILTIN_SKILLS_AT });
      expect(skill.description.length).toBeGreaterThan(10);
      expect(skill.instructions.split('\n').length).toBeGreaterThanOrEqual(5);
    }
  });

  it('inserts the missing built-ins at start, once', async () => {
    const h = createSkillHarness();
    const inserted = await h.service.ensureBuiltinSkills();
    expect(inserted.map((skill) => skill.id)).toEqual(Object.values(BUILTIN_SKILL_IDS));
    expect(await h.service.list()).toEqual(
      [...BUILTIN_SKILLS].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())),
    );

    expect(await h.service.ensureBuiltinSkills()).toEqual([]);
    expect(await h.service.list()).toHaveLength(5);
  });

  it('puts back only the ones that are missing', async () => {
    const h = createSkillHarness();
    await h.service.ensureBuiltinSkills();
    h.repos.skillRows.delete(BUILTIN_SKILL_IDS.securityReview);

    const inserted = await h.service.ensureBuiltinSkills();
    expect(inserted.map((skill) => skill.name)).toEqual(['Security review']);
  });

  it('leaves a user skill that already has a built-in name alone', async () => {
    const h = createSkillHarness();
    const mine = await h.service.create({ name: 'test FIRST', instructions: 'My own way.' });

    const inserted = await h.service.ensureBuiltinSkills();
    expect(inserted.map((skill) => skill.name)).not.toContain('Test first');
    expect(await h.service.get(mine.id)).toEqual(mine);
    expect(h.repos.skillRows.has(BUILTIN_SKILL_IDS.testFirst)).toBe(false);
  });

  it('replaces a stored built-in an older release wrote, keeping when it arrived', async () => {
    const h = createSkillHarness();
    await h.service.ensureBuiltinSkills();
    const shipped = BUILTIN_SKILLS[1]!;
    h.repos.skillRows.set(shipped.id, {
      ...shipped,
      version: 0,
      instructions: 'Old text.',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    expect(await h.service.ensureBuiltinSkills()).toEqual([]);
    expect(await h.service.get(shipped.id)).toEqual({
      ...shipped,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('refuses to edit or delete a built-in (skill_read_only) but duplicates it as a user skill', async () => {
    const h = createSkillHarness();
    await h.service.ensureBuiltinSkills();
    const id = BUILTIN_SKILL_IDS.testFirst;

    expect(await refusal(h.service.update(id, { instructions: 'Mine now.' }))).toBe(
      'skill_read_only',
    );
    expect(await refusal(h.service.remove(id))).toBe('skill_read_only');
    expect((await h.service.get(id)).instructions).toBe(BUILTIN_SKILLS[1]!.instructions);

    const copy = await h.service.duplicate(id);
    expect(copy).toMatchObject({
      name: 'Test first (copy)',
      description: BUILTIN_SKILLS[1]!.description,
      instructions: BUILTIN_SKILLS[1]!.instructions,
      source: 'user',
      version: 1,
      createdAt: SKILL_TEST_NOW,
      updatedAt: SKILL_TEST_NOW,
    });
    expect(copy.bundleId).toBeUndefined();
    expect(copy.id).not.toBe(id);
  });
});

describe('FR-SKL-002 D272 user skills', () => {
  it('creates a user skill at version 1, with an empty description by default', async () => {
    const h = createSkillHarness();
    const skill = await h.service.create({ name: 'Plain words', instructions: 'Write simply.' });
    expect(skill).toEqual({
      id: skill.id,
      name: 'Plain words',
      description: '',
      instructions: 'Write simply.',
      version: 1,
      source: 'user',
      createdAt: SKILL_TEST_NOW,
      updatedAt: SKILL_TEST_NOW,
    });
    expect(SkillSchema.parse(skill)).toEqual(skill);
    expect(await h.service.get(skill.id)).toEqual(skill);
  });

  it('refuses a name another skill has, whatever its case (name_taken)', async () => {
    const h = createSkillHarness();
    await h.service.ensureBuiltinSkills();
    expect(await refusal(h.service.create({ name: 'SECURITY review', instructions: 'x' }))).toBe(
      'name_taken',
    );
    const other = await h.service.create({ name: 'Mine', instructions: 'x' });
    expect(await refusal(h.service.update(other.id, { name: 'test first' }))).toBe('name_taken');
  });

  it('bumps the version when the name or the instructions change, not the description', async () => {
    const h = createSkillHarness();
    const skill = await h.service.create({ name: 'Plain words', instructions: 'Write simply.' });
    h.tick(LATER);

    const described = await h.service.update(skill.id, { description: 'For docs.' });
    expect(described).toMatchObject({ version: 1, description: 'For docs.', updatedAt: LATER });

    const renamed = await h.service.update(skill.id, { name: 'Plain English' });
    expect(renamed.version).toBe(2);

    const rewritten = await h.service.update(skill.id, { instructions: 'Short sentences.' });
    expect(rewritten).toMatchObject({ version: 3, instructions: 'Short sentences.' });

    // Its own name in another case is not "taken" by itself, and is a change.
    const recased = await h.service.update(skill.id, { name: 'PLAIN English' });
    expect(recased).toMatchObject({ name: 'PLAIN English', version: 4 });
    expect(await h.service.get(skill.id)).toEqual(recased);
  });

  it('answers a patch that changes nothing with the skill as it was', async () => {
    const h = createSkillHarness();
    const skill = await h.service.create({ name: 'Same', instructions: 'Same.' });
    h.tick(LATER);
    expect(await h.service.update(skill.id, { name: 'Same', instructions: 'Same.' })).toEqual(
      skill,
    );
    expect(await h.service.update(skill.id, {})).toEqual(skill);
  });

  it('deletes a user skill; an unknown id is not_found everywhere', async () => {
    const h = createSkillHarness();
    const skill = await h.service.create({ name: 'Gone soon', instructions: 'x' });
    await h.service.remove(skill.id);
    expect(await h.service.list()).toEqual([]);

    const unknown = '01K6TEST999999999999999999';
    expect(await refusal(h.service.get(unknown))).toBe('not_found');
    expect(await refusal(h.service.update(unknown, { name: 'x' }))).toBe('not_found');
    expect(await refusal(h.service.remove(unknown))).toBe('not_found');
    expect(await refusal(h.service.duplicate(unknown))).toBe('not_found');
    expect(await refusal(h.service.removeBundle(unknown))).toBe('not_found');
  });

  it('numbers duplicates when "(copy)" is taken, and keeps a long name within the limit', async () => {
    const h = createSkillHarness();
    const skill = await h.service.create({ name: 'Review', instructions: 'Look closely.' });
    const names: string[] = [];
    for (let i = 0; i < 3; i += 1) names.push((await h.service.duplicate(skill.id)).name);
    expect(names).toEqual(['Review (copy)', 'Review (copy 2)', 'Review (copy 3)']);

    const long = await h.service.create({ name: 'x'.repeat(80), instructions: 'Long.' });
    const copy = await h.service.duplicate(long.id);
    expect(copy.name).toBe(`${'x'.repeat(73)} (copy)`);
    expect(copy.name).toHaveLength(80);
  });
});

describe('FR-SKL-003 D273 bundles install skills and connect nothing', () => {
  it('creates one bundle skill per skill and records the plugin definitions as named', async () => {
    const h = createSkillHarness();
    await h.service.ensureBuiltinSkills();

    const bundle = await h.service.importBundle(bundleFile());
    expect(bundle).toEqual({
      id: bundle.id,
      name: 'Web team',
      description: 'How the web team works.',
      skillIds: bundle.skillIds,
      mcpServers: bundleFile().mcpServers,
      createdAt: SKILL_TEST_NOW,
    });
    expect(bundle.skillIds).toHaveLength(2);

    const installed = await Promise.all(bundle.skillIds.map((id) => h.service.get(id)));
    expect(installed).toEqual([
      expect.objectContaining({
        name: 'Accessible forms',
        description: '',
        instructions: 'Every input has a label.',
        source: 'bundle',
        bundleId: bundle.id,
        version: 1,
      }),
      // "Test first" is a built-in's name: the bundle's copy says where it came from.
      expect.objectContaining({
        name: 'Test first (Web team)',
        description: 'Our take.',
        source: 'bundle',
        bundleId: bundle.id,
      }),
    ]);
    expect(await h.service.listBundles()).toEqual([bundle]);
    // Installing is not connecting (D273): no MCP server row was written.
    expect(await h.repository.mcpServers.list({ workspaceId: 'local' })).toEqual([]);
  });

  it('numbers a clash that the bundle name alone does not settle', async () => {
    const h = createSkillHarness();
    await h.service.create({ name: 'Lint', instructions: 'x' });
    await h.service.create({ name: 'Lint (Tools)', instructions: 'x' });
    const bundle = await h.service.importBundle(
      bundleFile({ name: 'Tools', skills: [{ name: 'lint', instructions: 'Run the linter.' }] }),
    );
    expect((await h.service.get(bundle.skillIds[0]!)).name).toBe('lint (Tools 2)');
  });

  it('shortens a long bundle name inside the suffix so the skill name stays within the limit', async () => {
    const h = createSkillHarness();
    await h.service.create({ name: 'Lint', instructions: 'x' });
    const name = 'A very long bundle name that goes on and on past forty characters';
    const bundle = await h.service.importBundle(
      bundleFile({ name, skills: [{ name: 'Lint', instructions: 'Run it.' }] }),
    );
    const skill = await h.service.get(bundle.skillIds[0]!);
    expect(skill.name.length).toBeLessThanOrEqual(80);
    expect(skill.name).toBe('Lint (A very long bundle name that goes on an…)');
  });

  it('imports a bundle with no description and no plugins', async () => {
    const h = createSkillHarness();
    const { description: _description, mcpServers: _servers, ...rest } = bundleFile();
    const bundle = await h.service.importBundle({ ...rest, skills: [] });
    expect(bundle).toMatchObject({ description: '', skillIds: [], mcpServers: [] });
  });

  it('rolls an import back whole when a skill cannot be stored', async () => {
    const h = createSkillHarness();
    await h.service.create({ name: 'Kept', instructions: 'x' });
    const before = h.repos.snapshot();

    // The second skill of the file fails to store, after the first one was written.
    const create = h.repos.skills.create;
    let calls = 0;
    h.repos.skills.create = async (scope, skill) => {
      calls += 1;
      if (calls === 2) h.repos.failNextSkillCreate = true;
      return create(scope, skill);
    };

    await expect(h.service.importBundle(bundleFile())).rejects.toThrow('refused');
    expect(h.repos.snapshot()).toEqual(before);
  });

  it('removes a bundle with its bundle skills, and keeps everything else', async () => {
    const h = createSkillHarness();
    await h.service.ensureBuiltinSkills();
    const mine = await h.service.create({ name: 'Mine', instructions: 'x' });
    const kept = await h.service.importBundle(bundleFile({ name: 'Kept' }));
    const bundle = await h.service.importBundle(
      bundleFile({ name: 'Gone', skills: [{ name: 'Temporary', instructions: 'x' }] }),
    );

    await h.service.removeBundle(bundle.id);
    expect(await h.service.listBundles()).toEqual([kept]);
    const names = (await h.service.list()).map((skill: Skill) => skill.name);
    expect(names).not.toContain('Temporary');
    expect(names).toEqual(expect.arrayContaining(['Mine', 'Accessible forms', 'Test first']));
    expect(await h.service.get(mine.id)).toEqual(mine);
  });

  it('removes a bundle whose skills the user already deleted one by one', async () => {
    const h = createSkillHarness();
    const bundle = await h.service.importBundle(bundleFile());
    for (const id of bundle.skillIds) await h.service.remove(id);
    await h.service.removeBundle(bundle.id);
    expect(await h.service.listBundles()).toEqual([]);
  });
});

describe('D218 a store without skill storage', () => {
  it('fails clearly when the service is built on it', () => {
    const repository = new FakeRepository();
    expect(() => skillRepositories(repository)).toThrow(/no skill storage/);
    expect(() => createSkillService({ repository, scope: { workspaceId: 'local' } })).toThrow(
      /no skill storage/,
    );
  });
});
