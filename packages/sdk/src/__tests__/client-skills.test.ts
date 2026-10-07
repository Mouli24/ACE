import type { Bundle, BundleFile, Skill } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { AceApiError, createAceClient } from '../index.js';

/** The skills and bundles methods (ACE parity P1, D272, D273). */

const SKILL_ID = '01K6SK00000000000000000002';
const BUNDLE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FB0';
const NOW = '2026-10-07T00:00:00.000Z';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

type Reply = { status?: number; body?: unknown };

/** The recorder of the other client tests: every call kept, replies answered from a queue. */
function recorder(responses: Reply[]) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = init?.body;
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: body === undefined || body === null ? undefined : JSON.parse(String(body)),
    });
    const next = responses.shift() ?? { body: {} };
    const status = next.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(next.body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, client: createAceClient({ baseUrl: 'http://x', token: 't', fetch: fetchImpl }) };
}

const paths = (calls: Call[]): string[] =>
  calls.map((c) => `${c.method} ${c.url.replace('http://x/api/v1', '')}`);

const skill: Skill = {
  id: SKILL_ID,
  name: 'Test first',
  description: 'Write a failing test first.',
  instructions: 'Write a failing test, then make it pass.',
  version: 1,
  source: 'builtin',
  createdAt: NOW,
  updatedAt: NOW,
};

const file: BundleFile = {
  format: 'ace-bundle',
  formatVersion: 1,
  name: 'Docs team',
  skills: [{ name: 'Plain words', instructions: 'Write short sentences.' }],
  mcpServers: [{ name: 'files', transport: 'stdio', command: 'node' }],
};

const bundle: Bundle = {
  id: BUNDLE_ID,
  name: 'Docs team',
  description: '',
  skillIds: [SKILL_ID],
  mcpServers: [{ name: 'files', transport: 'stdio', command: 'node' }],
  createdAt: NOW,
};

describe('ACE parity P1 — skills', () => {
  it('lists, creates, reads, edits, duplicates and deletes skills on their routes', async () => {
    const copy: Skill = { ...skill, id: '01ARZ3NDEKTSV4RRFFQ69G5FC0', name: 'Test first (copy)' };
    const { calls, client } = recorder([
      { body: { items: [skill] } },
      { status: 201, body: { ...skill, source: 'user' } },
      { body: skill },
      { body: { ...skill, source: 'user', version: 2 } },
      { status: 201, body: { ...copy, source: 'user' } },
      { status: 204 },
    ]);

    expect((await client.listSkills()).items).toEqual([skill]);
    expect(
      (await client.createSkill({ name: ' Test first ', instructions: 'Write a test.' })).source,
    ).toBe('user');
    expect(await client.getSkill(SKILL_ID)).toEqual(skill);
    expect((await client.updateSkill(SKILL_ID, { instructions: 'Again.' })).version).toBe(2);
    expect((await client.duplicateSkill(SKILL_ID)).name).toBe('Test first (copy)');
    await expect(client.deleteSkill(SKILL_ID)).resolves.toBeUndefined();

    expect(paths(calls)).toEqual([
      'GET /skills',
      'POST /skills',
      `GET /skills/${SKILL_ID}`,
      `PATCH /skills/${SKILL_ID}`,
      `POST /skills/${SKILL_ID}/duplicate`,
      `DELETE /skills/${SKILL_ID}`,
    ]);
    // The body is the contract's parse: the name is trimmed before it leaves.
    expect(calls[1]!.body).toEqual({ name: 'Test first', instructions: 'Write a test.' });
    expect(calls[3]!.body).toEqual({ instructions: 'Again.' });
    expect(calls[4]!.body).toEqual({});
  });

  it('refuses a body the contract refuses, before any request', async () => {
    const { calls, client } = recorder([]);
    await expect(client.createSkill({ name: '', instructions: 'x' })).rejects.toBeInstanceOf(
      AceApiError,
    );
    await expect(
      client.updateSkill(SKILL_ID, { version: 3 } as unknown as { name: string }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(calls).toEqual([]);
  });

  it('surfaces the engine refusals with their codes', async () => {
    const refusal = (code: string) => ({
      status: 409,
      body: { error: { kind: 'invalid_config', code, message: code, retryable: false } },
    });
    const { client } = recorder([refusal('skill_read_only'), refusal('name_taken')]);
    await expect(client.updateSkill(SKILL_ID, { name: 'x' })).rejects.toMatchObject({
      status: 409,
      code: 'skill_read_only',
    });
    await expect(client.createSkill({ name: 'x', instructions: 'y' })).rejects.toMatchObject({
      code: 'name_taken',
    });
  });

  it('refuses a reply that is not a skill', async () => {
    const { client } = recorder([{ body: { ...skill, source: 'stolen' } }]);
    await expect(client.getSkill(SKILL_ID)).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('ACE parity P1 — bundles (D273)', () => {
  it('imports, lists and deletes bundles on their routes', async () => {
    const { calls, client } = recorder([
      { status: 201, body: bundle },
      { body: { items: [bundle] } },
      { status: 204 },
    ]);

    expect(await client.importBundle(file)).toEqual(bundle);
    expect((await client.listBundles()).items).toEqual([bundle]);
    await expect(client.deleteBundle(BUNDLE_ID)).resolves.toBeUndefined();

    expect(paths(calls)).toEqual([
      'POST /bundles/import',
      'GET /bundles',
      `DELETE /bundles/${BUNDLE_ID}`,
    ]);
    expect(calls[0]!.body).toEqual(file);
  });

  it('checks the file against the bundle format before it leaves', async () => {
    const { calls, client } = recorder([]);
    await expect(
      client.importBundle({ ...file, formatVersion: 2 } as unknown as BundleFile),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(calls).toEqual([]);
  });
});
