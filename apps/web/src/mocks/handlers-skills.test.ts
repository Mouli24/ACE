import type { BundleFile } from '@ace/contracts';
import { createAceClient, type AceApiError } from '@ace/sdk';
import { setupServer } from 'msw/node';

import { BUILTIN_SKILL_IDS, BUILTIN_SKILLS } from './builtin-skills';
import { MockDb } from './db';
import { createHandlers } from './handlers';
import { createRound4Handlers } from './handlers-round4';
import { createSkillHandlers } from './handlers-skills';

/**
 * The ACE parity P1 MSW seam (D272, D273): the mock skills engine answered through the real SDK,
 * so every reply is parsed with the contract schema the engine must also satisfy.
 */

const db = new MockDb({ persist: false });
const server = setupServer(
  ...createSkillHandlers(db),
  ...createRound4Handlers(db),
  ...createHandlers(db),
);
const client = createAceClient({
  baseUrl: 'http://mock.local',
  token: 'mock',
  fetch: (input, init) => globalThis.fetch(input, init),
});

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
beforeEach(() => db.reset());

async function failure(promise: Promise<unknown>): Promise<AceApiError> {
  try {
    await promise;
  } catch (error) {
    return error as AceApiError;
  }
  throw new Error('expected the call to fail');
}

const file: BundleFile = {
  format: 'ace-bundle',
  formatVersion: 1,
  name: 'Docs team',
  description: 'How the docs team writes.',
  skills: [
    { name: 'Plain words', instructions: 'Write short sentences.' },
    { name: 'Test first', instructions: 'Our own take.' },
  ],
  mcpServers: [{ name: 'files', transport: 'stdio', command: 'node', args: ['files.js'] }],
};

describe('D272 mock skills', () => {
  it('starts with the same five built-ins the engine ships, listed first', async () => {
    const { items } = await client.listSkills();
    expect(items.map((skill) => skill.id).sort()).toEqual(Object.values(BUILTIN_SKILL_IDS).sort());
    expect(items).toEqual(
      [...BUILTIN_SKILLS].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())),
    );

    await client.createSkill({ name: 'Aardvark', instructions: 'First by name.' });
    const after = (await client.listSkills()).items.map((skill) => skill.source);
    expect(after).toEqual(['builtin', 'builtin', 'builtin', 'builtin', 'builtin', 'user']);
  });

  it('creates, edits with the version rule, duplicates and deletes a user skill', async () => {
    const skill = await client.createSkill({ name: 'Plain words', instructions: 'Short.' });
    expect(skill).toMatchObject({ source: 'user', version: 1, description: '' });

    expect((await client.updateSkill(skill.id, { description: 'For docs.' })).version).toBe(1);
    expect((await client.updateSkill(skill.id, { instructions: 'Shorter.' })).version).toBe(2);
    expect(await client.getSkill(skill.id)).toMatchObject({ instructions: 'Shorter.' });

    expect((await client.duplicateSkill(skill.id)).name).toBe('Plain words (copy)');
    expect((await client.duplicateSkill(skill.id)).name).toBe('Plain words (copy 2)');

    await client.deleteSkill(skill.id);
    expect((await failure(client.getSkill(skill.id))).code).toBe('not_found');
  });

  it('refuses a taken name and any change to a built-in', async () => {
    expect(
      (await failure(client.createSkill({ name: 'test FIRST', instructions: 'x' }))).code,
    ).toBe('name_taken');
    const builtin = BUILTIN_SKILL_IDS.testFirst;
    const edit = await failure(client.updateSkill(builtin, { name: 'Mine' }));
    expect([edit.status, edit.code]).toEqual([409, 'skill_read_only']);
    expect((await failure(client.deleteSkill(builtin))).code).toBe('skill_read_only');
    expect((await client.duplicateSkill(builtin)).source).toBe('user');
  });
});

describe('D273 mock bundles', () => {
  it('installs the skills, records the plugins unconnected, and removes both with the bundle', async () => {
    const bundle = await client.importBundle(file);
    expect(bundle).toMatchObject({
      name: 'Docs team',
      description: 'How the docs team writes.',
      mcpServers: file.mcpServers,
    });
    const installed = await Promise.all(bundle.skillIds.map((id) => client.getSkill(id)));
    expect(installed.map((skill) => [skill.name, skill.source, skill.bundleId])).toEqual([
      ['Plain words', 'bundle', bundle.id],
      ['Test first (Docs team)', 'bundle', bundle.id],
    ]);
    expect((await client.listMcpServers()).items).toEqual([]);
    expect((await client.listBundles()).items).toEqual([bundle]);

    await client.deleteBundle(bundle.id);
    expect((await client.listBundles()).items).toEqual([]);
    const names = (await client.listSkills()).items.map((skill) => skill.name);
    expect(names).not.toContain('Plain words');
    expect(names).toContain('Test first');
    expect((await failure(client.deleteBundle(bundle.id))).code).toBe('not_found');
  });

  it('names another format version as such', async () => {
    const response = await fetch('http://mock.local/api/v1/bundles/import', {
      method: 'POST',
      headers: { authorization: 'Bearer mock', 'content-type': 'application/json' },
      body: JSON.stringify({ ...file, formatVersion: 2 }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'unsupported_format_version',
    );
  });

  it('answers 401 without a token, as every engine route does', async () => {
    const response = await fetch('http://mock.local/api/v1/skills');
    expect(response.status).toBe(401);
  });
});
