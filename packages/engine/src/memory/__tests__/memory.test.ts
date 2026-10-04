import {
  MEMORY_OUTPUT_FIELD,
  MEMORY_PROMPT_HEADING,
  MemoryUpdatedPayloadSchema,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { InProcessPubSubStub } from '../../__tests__/pubsub-stub.js';
import { createEventBus } from '../../events/index.js';
import { assemblePrompt } from '../../prompts/index.js';
import { LOCAL_SCOPE, type EngineEvent, type Repository } from '../../ports/index.js';
import { extractMemoryOps } from '../ops.js';
import { createMemoryService } from '../service.js';

const NODE = '01JBXQ8Z9KQ4R7N2VWXYZ0N0DE';
const OTHER_NODE = '01JBXQ8Z9KQ4R7N2VWXYZ0N0DF';
const KEY_SHAPED = ['sk', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('-');

let tick = 0;
const clock = (): string => new Date(Date.UTC(2026, 9, 1, 0, 0, tick++)).toISOString();

function setup() {
  const repository = new FakeRepository();
  const bus = createEventBus({
    repository,
    scope: LOCAL_SCOPE,
    pubsub: new InProcessPubSubStub<EngineEvent>(),
    now: clock,
  });
  const events: EngineEvent[] = [];
  void bus.subscribe((event) => events.push(event));
  let n = 0;
  const service = createMemoryService({
    scope: LOCAL_SCOPE,
    repository,
    bus,
    now: clock,
    nextId: () => `01JBXQ8Z9KQ4R7N2VWXYZ0M${String(n++).padStart(3, '0')}`,
  });
  const updates = (): EngineEvent[] => events.filter((event) => event.type === 'memory.updated');
  return { repository, service, updates };
}

describe('extractMemoryOps', () => {
  it('strips __memory before the contract sees it', () => {
    const out = extractMemoryOps({
      answer: 'Hello, Ada.',
      [MEMORY_OUTPUT_FIELD]: [{ op: 'save', key: 'user_name', value: 'Ada' }],
    });
    expect(out.value).toEqual({ answer: 'Hello, Ada.' });
    expect(out.ops).toEqual([{ op: 'save', key: 'user_name', value: 'Ada' }]);
    expect(out.invalid).toBeUndefined();
  });

  it('an invalid op list is ignored with a reason, and the answer still validates', () => {
    const out = extractMemoryOps({
      answer: 'ok',
      [MEMORY_OUTPUT_FIELD]: [{ op: 'save', key: 'k' }],
    });
    expect(out.value).toEqual({ answer: 'ok' });
    expect(out.ops).toEqual([]);
    expect(out.invalid).toContain(MEMORY_OUTPUT_FIELD);
  });

  it('a non-array __memory is invalid too, and values without the field pass through', () => {
    expect(extractMemoryOps({ [MEMORY_OUTPUT_FIELD]: 'nope' }).invalid).toBeDefined();
    const plain = { answer: 1 };
    expect(extractMemoryOps(plain)).toEqual({ value: plain, ops: [] });
    expect(extractMemoryOps('text')).toEqual({ value: 'text', ops: [] });
    expect(extractMemoryOps(null)).toEqual({ value: null, ops: [] });
    expect(extractMemoryOps([1])).toEqual({ value: [1], ops: [] });
  });
});

describe('MemoryService', () => {
  it('TC-MEM-001 a save is applied and the entry appears in list', async () => {
    const { service } = setup();
    await service.apply(NODE, [{ op: 'save', key: 'user_name', value: 'Ada' }]);
    const entries = await service.list(NODE);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ nodeId: NODE, key: 'user_name', value: 'Ada' });
    await service.apply(NODE, [{ op: 'save', key: 'user_name', value: 'Grace' }]);
    expect((await service.list(NODE)).map((e) => e.value)).toEqual(['Grace']);
  });

  it('memory.updated carries the ops, with no workflow or run', async () => {
    const { service, updates } = setup();
    const ops = [
      { op: 'save', key: 'a', value: '1' },
      { op: 'delete', key: 'a' },
    ] as const;
    await service.apply(NODE, ops);
    const [event] = updates();
    expect(event!.workflowId).toBeUndefined();
    expect(event!.runId).toBeUndefined();
    expect(MemoryUpdatedPayloadSchema.parse(event!.payload)).toEqual({ nodeId: NODE, ops });
  });

  it('applying no ops emits nothing', async () => {
    const { service, updates } = setup();
    await service.apply(NODE, []);
    expect(updates()).toHaveLength(0);
  });

  it('TC-MEM-002 clear emits one delete per key and leaves list empty', async () => {
    const { service, updates } = setup();
    await service.apply(NODE, [
      { op: 'save', key: 'a', value: '1' },
      { op: 'save', key: 'b', value: '2' },
    ]);
    await service.apply(OTHER_NODE, [{ op: 'save', key: 'z', value: '9' }]);
    await service.clear(NODE);
    expect(await service.list(NODE)).toEqual([]);
    expect(await service.list(OTHER_NODE)).toHaveLength(1);
    const last = updates().at(-1)!;
    expect(last.payload).toEqual({
      nodeId: NODE,
      ops: [
        { op: 'delete', key: 'a' },
        { op: 'delete', key: 'b' },
      ],
    });
  });

  it('clearing an empty memory emits nothing', async () => {
    const { service, updates } = setup();
    await service.clear(NODE);
    expect(updates()).toHaveLength(0);
  });

  it('deleted entries never reappear', async () => {
    const { service, updates } = setup();
    await service.apply(NODE, [
      { op: 'save', key: 'a', value: '1' },
      { op: 'save', key: 'b', value: '2' },
    ]);
    const [a] = await service.list(NODE);
    await service.deleteEntry(NODE, a!.id);
    await service.apply(NODE, [{ op: 'save', key: 'c', value: '3' }]);
    expect((await service.list(NODE)).map((e) => e.key)).toEqual(['b', 'c']);
    expect(updates().some((e) => JSON.stringify(e.payload).includes('"delete","key":"a"'))).toBe(
      true,
    );
    await service.apply(NODE, [{ op: 'delete', key: 'b' }]);
    expect((await service.list(NODE)).map((e) => e.key)).toEqual(['c']);
  });

  it("deleting an unknown entry, or another node's, is a 404 and emits nothing", async () => {
    const { service, updates } = setup();
    await service.apply(OTHER_NODE, [{ op: 'save', key: 'a', value: '1' }]);
    const [entry] = await service.list(OTHER_NODE);
    await expect(service.deleteEntry(NODE, entry!.id)).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
    expect(updates()).toHaveLength(1);
  });

  it('markUsed stamps lastUsedAt', async () => {
    const { service } = setup();
    await service.apply(NODE, [{ op: 'save', key: 'a', value: '1' }]);
    const [entry] = await service.list(NODE);
    await service.markUsed([]);
    await service.markUsed([entry!.id]);
    expect((await service.list(NODE))[0]!.lastUsedAt).toBeDefined();
  });

  it('a key-shaped value is stored masked instead of throwing (D86)', async () => {
    const { service, updates } = setup();
    await service.apply(NODE, [{ op: 'save', key: 'k', value: `my key is ${KEY_SHAPED}` }]);
    const [entry] = await service.list(NODE);
    expect(entry!.value).not.toContain(KEY_SHAPED);
    expect(entry!.value).toContain('[REDACTED]');
    expect(JSON.stringify(updates()[0]!.payload)).not.toContain(KEY_SHAPED);
  });

  it('masking never pushes a value past the contract maximum', async () => {
    const { service } = setup();
    await service.apply(NODE, [
      { op: 'save', key: 'k', value: `${KEY_SHAPED}${'x'.repeat(1990)}` },
    ]);
    expect((await service.list(NODE))[0]!.value.length).toBeLessThanOrEqual(2000);
  });

  it('fails clearly when the repository has no memory store', async () => {
    const repository = new FakeRepository();
    const bare = Object.create(repository, { memory: { value: undefined } }) as Repository;
    const bus = createEventBus({
      repository,
      scope: LOCAL_SCOPE,
      pubsub: new InProcessPubSubStub<EngineEvent>(),
      now: clock,
    });
    const service = createMemoryService({ scope: LOCAL_SCOPE, repository: bare, bus });
    await expect(service.list(NODE)).rejects.toThrow(/memory store/);
  });
});

describe('the memory prompt block', () => {
  const base = {
    instructions: 'Do the thing.',
    envelopes: [],
    contract: { outputTypes: ['text' as const] },
    iteration: 1,
  };

  it('the memory block is appended only when memory.enabled', () => {
    const off = assemblePrompt(base);
    expect(off.text).not.toContain(MEMORY_PROMPT_HEADING);
    expect(assemblePrompt({ ...base, memoryInstructions: false }).text).toBe(off.text);

    const on = assemblePrompt({ ...base, memoryInstructions: true });
    expect(on.text).toContain(MEMORY_PROMPT_HEADING);
    expect(on.text).toContain(MEMORY_OUTPUT_FIELD);
    const instructions = on.text.indexOf('## Instructions');
    const heading = on.text.indexOf(MEMORY_PROMPT_HEADING);
    expect(heading).toBeGreaterThan(instructions);
    expect(heading).toBeLessThan(on.text.indexOf('## Skills'));
  });
});
