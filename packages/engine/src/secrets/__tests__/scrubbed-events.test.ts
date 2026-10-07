import { describe, expect, it } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { InProcessPubSubStub } from '../../__tests__/pubsub-stub.js';
import { createEventBus } from '../../events/index.js';
import { newId } from '../../ids.js';
import { LOCAL_SCOPE, type EngineEvent, type SecretStore } from '../../ports/index.js';
import { createSecretService, eventScrubber } from '../index.js';

/*
 * ACE parity P1 (D274): an exact secret value is scrubbed from every persisted event — a CLI agent
 * that prints its token, or a tool call that carries it, is stored and delivered as
 * `[SECRET:<NAME>]`, never as the value.
 */

const scope = LOCAL_SCOPE;
const VALUE = 'fake-event-value-0001';

async function setUp() {
  const repository = new FakeRepository();
  const entries = new Map<string, string>();
  const store: SecretStore = {
    isAvailable: async () => true,
    get: async (_s, key) => entries.get(key) ?? null,
    set: async (_s, key, value) => {
      entries.set(key, value);
    },
    delete: async (_s, key) => entries.delete(key),
  };
  const secrets = createSecretService({ repository, scope, store });
  await secrets.create({ name: 'DEPLOY_TOKEN', value: VALUE });
  const bus = createEventBus({
    repository,
    scope,
    pubsub: new InProcessPubSubStub<EngineEvent>(),
    scrub: eventScrubber(secrets.scrubber()),
  });
  const delivered: EngineEvent[] = [];
  await bus.subscribe((event) => delivered.push(event));
  return { repository, bus, delivered };
}

describe('D274 events are stored and delivered scrubbed', () => {
  it('scrubs a node.output and a tool.call payload before they are persisted', async () => {
    const { repository, bus, delivered } = await setUp();
    const runId = newId();
    const workflowId = newId();

    await bus.emit({
      type: 'node.output',
      workflowId,
      runId,
      payload: {
        runId,
        output: [{ type: 'text', text: `The token is ${VALUE}.` }],
        usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 },
      },
    });
    await bus.emit({
      type: 'tool.call',
      workflowId,
      runId,
      payload: {
        runId,
        call: { name: 'cli_bash', args: { command: `deploy --token ${VALUE}` }, status: 'ok' },
      },
    });

    const stored = await repository.events.listAfter(scope, 0, { runIds: [runId] });
    expect(stored).toHaveLength(2);
    expect(JSON.stringify(stored)).not.toContain(VALUE);
    expect(stored[0]?.payload).toMatchObject({
      output: [{ type: 'text', text: 'The token is [SECRET:DEPLOY_TOKEN].' }],
    });
    expect(stored[1]?.payload).toMatchObject({
      call: { args: { command: 'deploy --token [SECRET:DEPLOY_TOKEN]' } },
    });
    // What a live client receives is the stored row, scrubbed the same way.
    expect(JSON.stringify(delivered)).not.toContain(VALUE);
    expect(delivered.map((event) => event.seq)).toEqual(stored.map((event) => event.seq));
  });

  it('scrubs a transient token frame too, and leaves an event with no secret untouched', async () => {
    const { bus, delivered } = await setUp();
    const runId = newId();
    await bus.emitTransient({ type: 'node.token', runId, payload: { runId, delta: VALUE } });
    const clean = await bus.emit({ type: 'run.started', runId, payload: { runId, note: 'go' } });

    expect(delivered[0]?.payload).toEqual({ runId, delta: '[SECRET:DEPLOY_TOKEN]' });
    expect(clean.payload).toEqual({ runId, note: 'go' });
  });
});
