import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  HealthResponseSchema,
  WorkflowExportSchema,
  WorkflowGraphResponseSchema,
  WsServerFrameSchema,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { authHeaders } from './engine.js';

/**
 * A smoke test for the harness itself.
 *
 * Its job is to fail loudly if `pnpm test:acceptance` is not actually talking to a real engine, so
 * that when Mouli's `round-1/mouli-tests-arhant.test.ts` lands she can trust the fixture the suite
 * hands her. It also keeps the suite non-empty until then.
 */

const url = process.env['ACE_URL'] as string;
const wsUrl = process.env['ACE_WS_URL'] as string;
const token = process.env['ACE_TOKEN'] as string;

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../fixtures/round-1/${name}`, import.meta.url)), 'utf8'),
  );

describe('acceptance harness', () => {
  it('exposes a real engine through ACE_URL and ACE_TOKEN', async () => {
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const response = await fetch(`${url}/api/v1/health`, { headers: authHeaders(token) });

    expect(response.status).toBe(200);
    expect(HealthResponseSchema.parse(await response.json())).toMatchObject({ db: 'ok' });
  });

  it('runs against a temp database, not the developer own data folder', () => {
    expect(process.env['ACE_DATA_DIR']).toContain('ace-acceptance-');
  });

  it('still enforces the token (FR-SYS-002)', async () => {
    expect((await fetch(`${url}/api/v1/health`)).status).toBe(401);
  });

  it('serves a WebSocket that greets a good token', async () => {
    const socket = new WebSocket(`${wsUrl}?token=${token}`);
    const hello = await new Promise<unknown>((resolve, reject) => {
      socket.on('message', (data) => resolve(JSON.parse(String(data))));
      socket.on('error', reject);
    });
    socket.close();

    expect(WsServerFrameSchema.parse(hello).type).toBe('hello');
  });
});

describe('round-1 fixtures', () => {
  it('linear.json is a valid WorkflowExport of Input -> Agent -> Output', () => {
    const parsed = WorkflowExportSchema.parse(fixture('linear.json'));

    expect(parsed.nodes.map((n) => n.kind)).toEqual(['input', 'agent', 'output']);
    expect(parsed.edges).toHaveLength(2);
  });

  it('imports into a real engine, which is the point of shipping it', async () => {
    const project = (await (
      await fetch(`${url}/api/v1/projects`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ name: 'Fixture check' }),
      })
    ).json()) as { id: string };

    const response = await fetch(`${url}/api/v1/projects/${project.id}/workflows/import`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(fixture('linear.json')),
    });

    expect(response.status).toBe(201);
    const imported = WorkflowGraphResponseSchema.parse(await response.json());
    expect(imported.nodes).toHaveLength(3);
    expect(imported.edges).toHaveLength(2);
  });

  it('validates clean apart from the model to pick, so it is usable as a starting point', async () => {
    const project = (await (
      await fetch(`${url}/api/v1/projects`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ name: 'Fixture validate' }),
      })
    ).json()) as { id: string };

    const imported = WorkflowGraphResponseSchema.parse(
      await (
        await fetch(`${url}/api/v1/projects/${project.id}/workflows/import`, {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify(fixture('linear.json')),
        })
      ).json(),
    );

    const { issues } = (await (
      await fetch(`${url}/api/v1/workflows/${imported.workflow.id}/validate`, {
        method: 'POST',
        headers: authHeaders(token),
      })
    ).json()) as { issues: { severity: string; code: string }[] };

    // Round-1 fixtures predate providers, and from round 2 a node with no model is an error (§2.5).
    // D358 names a node with no provider at all `missing_provider` (it was `missing_model` before).
    // That is the only thing a harness has to fill in; anything else would be a broken fixture.
    const errors = issues.filter((i) => i.severity === 'error');
    expect(errors.map((i) => i.code).filter((code) => code !== 'missing_provider')).toEqual([]);
  });
});
