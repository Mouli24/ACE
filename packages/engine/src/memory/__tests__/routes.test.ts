import { MemoryEntrySchema, MemoryUpdatedPayloadSchema } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { InProcessPubSubStub } from '../../__tests__/pubsub-stub.js';
import { errorCode, routeApp, send } from '../../__tests__/route-app.js';
import { createEventBus } from '../../events/index.js';
import { LOCAL_SCOPE, type EngineEvent } from '../../ports/index.js';
import { createMemoryRoutes } from '../routes.js';
import { createMemoryService } from '../service.js';

/**
 * The memory routes of round 5 §2.9 (FR-MEM-004, TC-MEM-002) over the real memory service on the
 * in-memory repository: a bare `MemoryEntry[]`, delete-one and clear-all at 204 announcing
 * `memory.updated`, an unknown entry 404, and 501 without the service (D121).
 */

const NODE = '01JBXQ8Z9KQ4R7N2VWXYZ0N0DE';

async function harness() {
  const repository = new FakeRepository();
  const bus = createEventBus({
    repository,
    scope: LOCAL_SCOPE,
    pubsub: new InProcessPubSubStub<EngineEvent>(),
  });
  const events: EngineEvent[] = [];
  await bus.subscribe((event) => events.push(event));
  const service = createMemoryService({ scope: LOCAL_SCOPE, repository, bus });
  await service.apply(NODE, [
    { op: 'save', key: 'user_name', value: 'Ada' },
    { op: 'save', key: 'tone', value: 'brief' },
  ]);
  events.length = 0;
  return { app: routeApp(createMemoryRoutes(service)), events };
}

const opsOf = (events: EngineEvent[]) =>
  events
    .filter((event) => event.type === 'memory.updated')
    .map((event) => MemoryUpdatedPayloadSchema.parse(event.payload).ops);

describe('FR-MEM-004 /nodes/:id/memory', () => {
  it('lists the entries oldest first as a bare array', async () => {
    const { app } = await harness();

    const response = await send(app, 'GET', `/nodes/${NODE}/memory`);

    expect(response.status).toBe(200);
    const entries = MemoryEntrySchema.array().parse(await response.json());
    expect(entries.map(({ key, value }) => [key, value])).toEqual([
      ['user_name', 'Ada'],
      ['tone', 'brief'],
    ]);
    expect(
      await (await send(app, 'GET', '/nodes/01JBXQ8Z9KQ4R7N2VWXYZ0ZZZZ/memory')).json(),
    ).toEqual([]);
  });

  it('deletes one entry with 204 and announces it; an unknown entry is 404', async () => {
    const { app, events } = await harness();
    const [first] = MemoryEntrySchema.array().parse(
      await (await send(app, 'GET', `/nodes/${NODE}/memory`)).json(),
    );

    const removed = await send(app, 'DELETE', `/nodes/${NODE}/memory/${first?.id ?? ''}`);

    expect(removed.status).toBe(204);
    expect(await removed.text()).toBe('');
    expect(opsOf(events)).toEqual([[{ op: 'delete', key: 'user_name' }]]);
    const again = await send(app, 'DELETE', `/nodes/${NODE}/memory/${first?.id ?? ''}`);
    expect(again.status).toBe(404);
    expect(await errorCode(again)).toBe('not_found');
  });

  it('clears every entry with 204, one delete op per key, and the list is then empty', async () => {
    const { app, events } = await harness();

    const cleared = await send(app, 'DELETE', `/nodes/${NODE}/memory`);

    expect(cleared.status).toBe(204);
    expect(opsOf(events)).toEqual([
      [
        { op: 'delete', key: 'user_name' },
        { op: 'delete', key: 'tone' },
      ],
    ]);
    expect(await (await send(app, 'GET', `/nodes/${NODE}/memory`)).json()).toEqual([]);
  });

  it('D121 answers 501 on all three without the service', async () => {
    const app = routeApp(createMemoryRoutes(undefined));
    for (const [method, path] of [
      ['GET', `/nodes/${NODE}/memory`],
      ['DELETE', `/nodes/${NODE}/memory/01JBXQ8Z9KQ4R7N2VWXYZ0ZZZZ`],
      ['DELETE', `/nodes/${NODE}/memory`],
    ] as const) {
      const response = await send(app, method, path);
      expect(response.status, `${method} ${path}`).toBe(501);
      expect(await errorCode(response)).toBe('not_implemented');
    }
  });
});
