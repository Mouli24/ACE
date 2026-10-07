import {
  BundleListResponseSchema,
  BundleSchema,
  SkillListResponseSchema,
  SkillSchema,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { errorCode, routeApp, send } from '../../__tests__/route-app.js';
import { BUILTIN_SKILL_IDS } from '../builtin.js';
import { createSkillRoutes } from '../routes.js';
import { createSkillHarness } from './harness.js';

/** The skill and bundle routes (ACE parity P1, D272, D273) in the contract shapes. */

async function app() {
  const h = createSkillHarness();
  await h.service.ensureBuiltinSkills();
  return { ...h, app: routeApp(createSkillRoutes(h.service)) };
}

const bundleFile = {
  format: 'ace-bundle',
  formatVersion: 1,
  name: 'Docs team',
  skills: [{ name: 'Plain words', instructions: 'Write short sentences.' }],
  mcpServers: [{ name: 'files', transport: 'stdio', command: 'node' }],
};

describe('ACE parity P1 — skill routes', () => {
  it('answers 501 when the engine was built without skills', async () => {
    const bare = routeApp(createSkillRoutes(undefined));
    for (const [method, path] of [
      ['GET', '/skills'],
      ['POST', '/skills'],
      ['GET', '/bundles'],
      ['POST', '/bundles/import'],
    ] as const) {
      const response = await send(bare, method, path, method === 'POST' ? {} : undefined);
      expect(response.status, `${method} ${path}`).toBe(501);
      expect(await errorCode(response)).toBe('not_implemented');
    }
  });

  it('lists, creates, reads, edits, duplicates and deletes skills', async () => {
    const { app: api } = await app();

    const list = SkillListResponseSchema.parse(await (await send(api, 'GET', '/skills')).json());
    expect(list.items).toHaveLength(5);
    expect(list.items.every((skill) => skill.source === 'builtin')).toBe(true);

    const created = await send(api, 'POST', '/skills', {
      name: 'Plain words',
      instructions: '  Write short sentences.  ',
    });
    expect(created.status).toBe(201);
    const skill = SkillSchema.parse(await created.json());
    expect(skill).toMatchObject({
      source: 'user',
      version: 1,
      instructions: 'Write short sentences.',
    });

    const read = await send(api, 'GET', `/skills/${skill.id}`);
    expect(SkillSchema.parse(await read.json())).toEqual(skill);

    const patched = await send(api, 'PATCH', `/skills/${skill.id}`, { instructions: 'Be brief.' });
    expect(patched.status).toBe(200);
    expect(SkillSchema.parse(await patched.json())).toMatchObject({ version: 2 });

    const copy = await send(api, 'POST', `/skills/${skill.id}/duplicate`);
    expect(copy.status).toBe(201);
    expect(SkillSchema.parse(await copy.json()).name).toBe('Plain words (copy)');

    const deleted = await send(api, 'DELETE', `/skills/${skill.id}`);
    expect(deleted.status).toBe(204);
    expect((await send(api, 'GET', `/skills/${skill.id}`)).status).toBe(404);
  });

  it('answers the refusals with their codes and statuses', async () => {
    const { app: api } = await app();
    const builtin = BUILTIN_SKILL_IDS.securityReview;

    const edit = await send(api, 'PATCH', `/skills/${builtin}`, { name: 'Mine' });
    expect([edit.status, await errorCode(edit)]).toEqual([409, 'skill_read_only']);

    const remove = await send(api, 'DELETE', `/skills/${builtin}`);
    expect([remove.status, await errorCode(remove)]).toEqual([409, 'skill_read_only']);

    const taken = await send(api, 'POST', '/skills', {
      name: 'security REVIEW',
      instructions: 'x',
    });
    expect([taken.status, await errorCode(taken)]).toEqual([409, 'name_taken']);

    const empty = await send(api, 'POST', '/skills', { name: '  ', instructions: 'x' });
    expect([empty.status, await errorCode(empty)]).toEqual([400, 'validation_failed']);

    const stray = await send(api, 'PATCH', `/skills/${builtin}`, { version: 9 });
    expect([stray.status, await errorCode(stray)]).toEqual([400, 'validation_failed']);

    const notJson = await send(api, 'POST', '/skills', '{"name": "x"');
    expect([notJson.status, await errorCode(notJson)]).toEqual([400, 'validation_failed']);

    const dupBody = await send(api, 'POST', `/skills/${builtin}/duplicate`, { name: 'x' });
    expect([dupBody.status, await errorCode(dupBody)]).toEqual([400, 'validation_failed']);

    const unknown = await send(api, 'GET', '/skills/01K6TEST999999999999999999');
    expect([unknown.status, await errorCode(unknown)]).toEqual([404, 'not_found']);
  });
});

describe('ACE parity P1 — bundle routes (D273)', () => {
  it('imports a bundle (201), lists it and deletes it with its skills (204)', async () => {
    const { app: api } = await app();

    const imported = await send(api, 'POST', '/bundles/import', bundleFile);
    expect(imported.status).toBe(201);
    const bundle = BundleSchema.parse(await imported.json());
    expect(bundle.mcpServers).toEqual(bundleFile.mcpServers);

    const listed = BundleListResponseSchema.parse(
      await (await send(api, 'GET', '/bundles')).json(),
    );
    expect(listed.items).toEqual([bundle]);
    const skills = SkillListResponseSchema.parse(await (await send(api, 'GET', '/skills')).json());
    expect(skills.items.map((skill) => skill.name)).toContain('Plain words');

    expect((await send(api, 'DELETE', `/bundles/${bundle.id}`)).status).toBe(204);
    const after = SkillListResponseSchema.parse(await (await send(api, 'GET', '/skills')).json());
    expect(after.items.map((skill) => skill.name)).not.toContain('Plain words');
    expect((await send(api, 'DELETE', `/bundles/${bundle.id}`)).status).toBe(404);
  });

  it('names another format version, and refuses a file that is not a bundle', async () => {
    const { app: api } = await app();

    const future = await send(api, 'POST', '/bundles/import', { ...bundleFile, formatVersion: 2 });
    expect([future.status, await errorCode(future)]).toEqual([400, 'unsupported_format_version']);

    const workflow = await send(api, 'POST', '/bundles/import', { formatVersion: 1, nodes: [] });
    expect([workflow.status, await errorCode(workflow)]).toEqual([400, 'validation_failed']);

    // A plugin definition the MCP contract refuses (stdio with no command) refuses the file.
    const broken = await send(api, 'POST', '/bundles/import', {
      ...bundleFile,
      mcpServers: [{ name: 'files', transport: 'stdio' }],
    });
    expect([broken.status, await errorCode(broken)]).toEqual([400, 'validation_failed']);
    expect(
      BundleListResponseSchema.parse(await (await send(api, 'GET', '/bundles')).json()),
    ).toEqual({ items: [] });
  });
});
