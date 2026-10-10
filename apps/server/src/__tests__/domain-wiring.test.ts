import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DomainUsageSnapshotSchema, RunSchema, type Event } from '@ace/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createProject,
  graphBuilder,
  importWorkflow,
  mockProvider,
  startRound5Engine,
  until,
  type Round5Engine,
} from './round5-harness.js';

/*
 * Domain wired into the real engine (D309, D323): a run started from Domain parks instead of
 * completing, a message to one of its nodes runs that node and what it feeds, the server's parse
 * refuses a bad address, and End completes the run. Mock provider, temp data dir, no env vars.
 */

let e: Round5Engine;
beforeEach(async () => {
  e = await startRound5Engine();
});
afterEach(async () => {
  await e.stop();
});

const eventsOf = async (runId: string): Promise<Event[]> =>
  (await e.get(`/runs/${runId}/events`)) as Event[];
const count = async (runId: string, type: string): Promise<number> =>
  (await eventsOf(runId)).filter((event) => event.type === type).length;

describe('Domain through the HTTP API', () => {
  it('parks, takes a message, refuses a bad address, and ends COMPLETE', async () => {
    const providerId = await mockProvider(e);
    const projectId = await createProject(e, 'Domain');
    const graph = graphBuilder('Team');
    const agent = (name: string) =>
      graph.add('agent', name, {
        providerId,
        modelId: 'mock-text',
        instructions: `You are ${name}.`,
        inputTypes: ['text'],
        outputTypes: ['text'],
      });
    const writer = agent('Writer');
    const review = agent('Review');
    graph.connect(writer, review);
    const imported = await importWorkflow(e, projectId, graph.export());

    const started = RunSchema.parse(
      await e.post(`/workflows/${imported.workflow.id}/runs`, {
        goal: 'A tagline for ACE',
        domain: { stayOpen: true },
      }),
    );
    expect(started.allowedActions).toContain('end');
    await until('the run to park', async () =>
      (await count(started.id, 'run.parked')) >= 1 ? true : undefined,
    );
    expect(RunSchema.parse(await e.get(`/runs/${started.id}`)).status).toBe('RUNNING');

    const sent = await e.api(`/runs/${started.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text: 'Writer, make it shorter' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(sent.status).toBe(201);
    await until('the run to park again', async () =>
      (await count(started.id, 'run.parked')) >= 2 ? true : undefined,
    );
    const states = (await eventsOf(started.id))
      .filter((event) => event.type === 'instruction.state')
      .map((event) => (event.payload as { state: string }).state);
    expect(states).toEqual(['PENDING', 'DELIVERED', 'DONE']);

    const bad = await e.api(`/runs/${started.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text: '@nobody hello' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(bad.status).toBe(400);

    const ended = RunSchema.parse(await e.post(`/runs/${started.id}/end`));
    expect(ended.status).toBe('COMPLETE');
    const after = await e.api(`/runs/${started.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text: 'Writer, one more' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(after.status).toBe(409);
  }, 30_000);

  it('manual routing holds the handoff until the human approves it over HTTP', async () => {
    const providerId = await mockProvider(e);
    const projectId = await createProject(e, 'Domain routing');
    const graph = graphBuilder('Routed');
    const agent = (name: string) =>
      graph.add('agent', name, {
        providerId,
        modelId: 'mock-text',
        instructions: `You are ${name}.`,
        inputTypes: ['text'],
        outputTypes: ['text'],
      });
    const writer = agent('Writer');
    const review = agent('Review');
    graph.connect(writer, review);
    const imported = await importWorkflow(e, projectId, graph.export());

    const started = RunSchema.parse(
      await e.post(`/workflows/${imported.workflow.id}/runs`, { domain: { routing: 'manual' } }),
    );
    const held = await until('the handoff to be held', async () =>
      (await eventsOf(started.id)).find(
        (event) =>
          event.type === 'envelope.routed' &&
          (event.payload as { decision: string }).decision === 'HELD',
      ),
    );
    const { envelopeId } = held.payload as { envelopeId: string };

    const route = (body: unknown) =>
      e.api(`/runs/${started.id}/envelopes/${envelopeId}/route`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      });
    const approved = await route({ decision: 'approve' });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual({ envelopeId, routing: 'FORWARDED' });

    // The review runs on it, its own handoff has nowhere to go, and the run completes.
    await until('the run to complete', async () =>
      RunSchema.parse(await e.get(`/runs/${started.id}`)).status === 'COMPLETE' ? true : undefined,
    );
    expect((await route({ decision: 'approve' })).status).toBe(409);
  }, 30_000);

  it('serves the usage snapshot, takes a budget, and ships an empty ace.pricing.json', async () => {
    const pricingFile = join(e.dir, 'ace.pricing.json');
    expect(existsSync(pricingFile)).toBe(true);
    expect(JSON.parse(readFileSync(pricingFile, 'utf8'))).toEqual({ models: [] });

    const providerId = await mockProvider(e);
    const projectId = await createProject(e, 'Domain usage');
    const graph = graphBuilder('Spend');
    const agent = (name: string) =>
      graph.add('agent', name, {
        providerId,
        modelId: 'mock-text',
        instructions: `You are ${name}.`,
        inputTypes: ['text'],
        outputTypes: ['text'],
      });
    graph.connect(agent('Writer'), agent('Review'));
    const imported = await importWorkflow(e, projectId, graph.export());
    const started = RunSchema.parse(
      await e.post(`/workflows/${imported.workflow.id}/runs`, { domain: { stayOpen: true } }),
    );
    await until('the run to park', async () =>
      (await count(started.id, 'run.parked')) >= 1 ? true : undefined,
    );

    const put = await e.api(`/runs/${started.id}/budget`, {
      method: 'PUT',
      body: JSON.stringify({ limit: 1_000_000 }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(put.status).toBe(200);
    const usage = DomainUsageSnapshotSchema.parse(await e.get(`/runs/${started.id}/usage`));
    expect(usage.budget).toMatchObject({ limit: 1_000_000, level: 'OK' });
    expect(usage.perNode.map((node) => node.handle).sort()).toEqual(['review', 'writer']);
    // The mock provider reports what it used; nothing is priced, so the cost is unknown, not 0.
    expect(usage.perNode.every((node) => node.source === 'reported')).toBe(true);
    expect(usage.costEst).toBeNull();

    RunSchema.parse(await e.post(`/runs/${started.id}/end`));
  }, 30_000);
});
