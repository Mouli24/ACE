import {
  AgentConfigSchema,
  RetrievalConfigSchema,
  type Node,
  type Provider,
  type ProviderState,
  type Workflow,
} from '@ace/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createEventBus, type EventBus } from '../events/index.js';
import { createProviderService, type ProviderService } from '../providers/index.js';
import {
  LOCAL_SCOPE,
  type EngineEvent,
  type ProviderAdapter,
  type SecretStore,
} from '../ports/index.js';
import { createLogger } from '../logging/index.js';
import { newId } from '../ids.js';
import { FakeRepository } from './fake-repository.js';
import { InProcessPubSubStub } from './pubsub-stub.js';

const scope = LOCAL_SCOPE;
const NOW = '2026-09-22T10:00:00.000Z';

function makeWorkflow(): Workflow {
  return {
    id: newId(),
    projectId: newId(),
    name: 'Flow',
    version: 0,
    formatVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** An agent node that names a provider — what FR-PRV-005 has to find before a delete. */
function makeAgentNode(workflowId: string, config: { providerId: string }): Node {
  const id = newId();
  return {
    id,
    workflowId,
    kind: 'agent',
    name: 'Agent',
    position: { x: 0, y: 0 },
    inputs: [{ id: `${id}:in:text`, name: 'text', dataType: 'text', multi: false }],
    outputs: [{ id: `${id}:out:text`, name: 'text', dataType: 'text', multi: true }],
    config: AgentConfigSchema.parse({
      providerId: config.providerId,
      modelId: 'mock-text',
      instructions: 'Summarise.',
      inputTypes: ['text'],
      outputTypes: ['text'],
    }),
  };
}

/** An in-memory keychain, so a test can prove what was and was not stored. */
function fakeSecrets(): SecretStore & { entries(): Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries: () => entries,
    isAvailable: async () => true,
    get: async (_s, key) => entries.get(key) ?? null,
    set: async (_s, key, value) => {
      entries.set(key, value);
    },
    delete: async (_s, key) => entries.delete(key),
  };
}

/** A recording adapter whose check result the test chooses. */
function stubAdapter(status: ProviderState, message?: string) {
  const calls = { check: 0, listModels: 0 };
  const adapter: ProviderAdapter = {
    type: 'mock',
    check: async () => {
      calls.check += 1;
      return { status, ...(message === undefined ? {} : { message }), latencyMs: 3 };
    },
    listModels: async () => {
      calls.listModels += 1;
      return [
        {
          modelId: 'mock-text',
          displayName: 'Mock text',
          inputTypes: ['text' as const],
          outputTypes: ['text' as const],
          contextWindow: 200_000,
          supportsTools: false,
          supportsJson: false,
          pricing: { inputPer1k: 0.001, outputPer1k: 0.002, priceTableVersion: 'mock-v1' },
        },
      ];
    },
    // eslint-disable-next-line require-yield
    generate: async function* () {
      throw new Error('not used in these tests');
    },
  };
  return { adapter, calls };
}

interface Harness {
  service: ProviderService;
  repository: FakeRepository;
  secrets: ReturnType<typeof fakeSecrets>;
  bus: EventBus;
  events: EngineEvent[];
  created: (overrides?: Partial<Parameters<ProviderService['create']>[0]>) => Promise<Provider>;
}

let harness: Harness;
let adapterStatus: ProviderState;
let adapterCalls: { check: number; listModels: number };

async function build(): Promise<Harness> {
  const repository = new FakeRepository();
  const secrets = fakeSecrets();
  const pubsub = new InProcessPubSubStub<EngineEvent>();
  const bus = createEventBus({ repository, scope, pubsub, now: () => NOW });
  const events: EngineEvent[] = [];
  await bus.subscribe((event) => events.push(event));

  const stub = stubAdapter(adapterStatus);
  adapterCalls = stub.calls;

  const service = createProviderService({
    repository,
    scope,
    secrets,
    bus,
    logger: createLogger({ level: 'silent', destination: { write: () => undefined } }),
    now: () => NOW,
    factory: {
      create: () => stub.adapter,
      manifestFor: () => [],
      mergeCatalog: (discovered) =>
        discovered.map((m) => ({ ...m, source: 'discovered' as const })),
      detect: async () => ({ ollama: { baseUrl: 'http://127.0.0.1:11434', detected: false } }),
      detectClis: async () => ({ items: [] }),
    },
  });

  return {
    service,
    repository,
    secrets,
    bus,
    events,
    created: (overrides = {}) =>
      service.create({ type: 'mock', name: 'Mock', concurrency: 20, ...overrides }),
  };
}

beforeEach(async () => {
  adapterStatus = 'CONNECTED';
  harness = await build();
});

/* -------------------------------------------------------------------------- */
/* Create, read, update, delete                                                */
/* -------------------------------------------------------------------------- */

describe('TC-PRV-001 every provider type can be added', () => {
  it.each(['anthropic', 'google', 'openai', 'openai_compatible', 'ollama', 'mock'] as const)(
    'adds a %s provider',
    async (type) => {
      const provider = await harness.created({ type, name: type, apiKey: 'a-key' });

      expect(provider.type).toBe(type);
      expect(await harness.service.get(provider.id)).toEqual(provider);
    },
  );

  it('starts a new provider at UNKNOWN until something checks it', async () => {
    expect((await harness.created()).status).toBe('UNKNOWN');
  });

  it('lists providers in the order they were added', async () => {
    await harness.created({ name: 'First' });
    await harness.created({ name: 'Second' });

    expect((await harness.service.list()).map((p) => p.name)).toEqual(['First', 'Second']);
  });
});

describe('TC-PRV-002 the key goes to the keychain and nowhere else', () => {
  it('stores the key in the SecretStore under the provider id', async () => {
    const provider = await harness.created({ apiKey: 'a-real-looking-key' });

    expect([...harness.secrets.entries().values()]).toEqual(['a-real-looking-key']);
    expect([...harness.secrets.entries().keys()][0]).toContain(provider.id);
  });

  it('reports keySet true without ever returning the key', async () => {
    const provider = await harness.created({ apiKey: 'a-real-looking-key' });

    expect(provider.keySet).toBe(true);
    expect(JSON.stringify(provider)).not.toContain('a-real-looking-key');
  });

  it('reports keySet false for a provider that needs no key', async () => {
    expect((await harness.created()).keySet).toBe(false);
  });

  it('derives keySet from the store, not from a stored flag', async () => {
    const provider = await harness.created({ apiKey: 'k' });
    await harness.secrets.delete(scope, [...harness.secrets.entries().keys()][0]!);

    expect((await harness.service.get(provider.id))?.keySet).toBe(false);
  });

  it('never writes the key into the run of repository rows', async () => {
    await harness.created({ apiKey: 'a-real-looking-key' });

    const rows = JSON.stringify(await harness.repository.providers.list(scope));
    expect(rows).not.toContain('a-real-looking-key');
  });
});

describe('FR-PRV-005 editing and rotating', () => {
  it('renames without touching the key', async () => {
    const provider = await harness.created({ apiKey: 'first-key' });

    const updated = await harness.service.update(provider.id, { name: 'Renamed' });

    expect(updated?.name).toBe('Renamed');
    expect([...harness.secrets.entries().values()]).toEqual(['first-key']);
  });

  it('rotates the key when the patch carries one', async () => {
    const provider = await harness.created({ apiKey: 'first-key' });

    await harness.service.update(provider.id, { apiKey: 'second-key' });

    expect([...harness.secrets.entries().values()]).toEqual(['second-key']);
  });

  it('changes the concurrency limit', async () => {
    const provider = await harness.created();

    expect((await harness.service.update(provider.id, { concurrency: 2 }))?.concurrency).toBe(2);
  });

  it('returns null for a provider that is not there', async () => {
    expect(await harness.service.update('01JBXQ8Z9KQ4R7N2VWXYZ0PRVD', { name: 'x' })).toBeNull();
  });
});

describe('TC-PRV-006 removing a provider a node still uses', () => {
  async function withNodeUsing(providerId: string): Promise<void> {
    const workflow = makeWorkflow();
    await harness.repository.workflows.create(scope, workflow);
    await harness.repository.nodes.insert(scope, makeAgentNode(workflow.id, { providerId }));
  }

  it('refuses without confirmation and names the nodes', async () => {
    const provider = await harness.created();
    await withNodeUsing(provider.id);

    const result = await harness.service.remove(provider.id, { confirm: false });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.nodeIds).toHaveLength(1);
    expect(await harness.service.get(provider.id)).not.toBeNull();
  });

  it('removes it with confirmation, leaving the nodes to be flagged by validate', async () => {
    const provider = await harness.created();
    await withNodeUsing(provider.id);

    const result = await harness.service.remove(provider.id, { confirm: true });

    expect(result.ok).toBe(true);
    expect(await harness.service.get(provider.id)).toBeNull();
  });

  it('removes an unused provider without asking', async () => {
    const provider = await harness.created();

    expect((await harness.service.remove(provider.id, { confirm: false })).ok).toBe(true);
  });

  it('takes the key and the catalog with it', async () => {
    const provider = await harness.created({ apiKey: 'k' });
    await harness.service.refreshModels(provider.id);

    await harness.service.remove(provider.id, { confirm: true });

    expect(harness.secrets.entries().size).toBe(0);
    expect(await harness.repository.models.list(scope, {})).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* check()                                                                     */
/* -------------------------------------------------------------------------- */

describe('TC-PRV-003 / TC-PRV-004 checking a provider', () => {
  it('returns the adapter verdict and the time it was taken', async () => {
    const provider = await harness.created();

    const result = await harness.service.check(provider.id);

    expect(result.status).toBe('CONNECTED');
    expect(result.checkedAt).toBe(NOW);
    expect(adapterCalls.check).toBe(1);
  });

  it('stores the verdict on the provider row', async () => {
    adapterStatus = 'AUTH_FAILED';
    harness = await build();
    const provider = await harness.created({ apiKey: 'bad' });

    await harness.service.check(provider.id);

    const stored = await harness.service.get(provider.id);
    expect(stored?.status).toBe('AUTH_FAILED');
    expect(stored?.lastCheckedAt).toBe(NOW);
  });

  it('TC-PRV-005 emits provider.status on the engine scope, so the UI needs no reload', async () => {
    const provider = await harness.created();

    await harness.service.check(provider.id);

    const emitted = harness.events.filter((event) => event.type === 'provider.status');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.payload).toMatchObject({ providerId: provider.id, status: 'CONNECTED' });
    expect(emitted[0]?.workflowId).toBeUndefined();
  });

  it('checks every provider in one pass, which is what the 60 s timer calls', async () => {
    await harness.created({ name: 'One' });
    await harness.created({ name: 'Two' });

    await harness.service.checkAll();

    expect(adapterCalls.check).toBe(2);
    expect(harness.events.filter((e) => e.type === 'provider.status')).toHaveLength(2);
  });

  it('reports a provider that is gone rather than throwing', async () => {
    await expect(harness.service.check('01JBXQ8Z9KQ4R7N2VWXYZ0PRVD')).rejects.toThrow(/not found/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Catalog                                                                     */
/* -------------------------------------------------------------------------- */

describe('TC-MOD-001 refreshing a provider catalog', () => {
  it('stores what the adapter listed, with a row id and a check time', async () => {
    const provider = await harness.created();

    const { models, refreshedAt } = await harness.service.refreshModels(provider.id);

    expect(models).toHaveLength(1);
    expect(models[0]?.modelId).toBe('mock-text');
    expect(models[0]?.providerId).toBe(provider.id);
    expect(models[0]?.source).toBe('discovered');
    expect(models[0]?.available).toBe(true);
    expect(refreshedAt).toBe(NOW);
  });

  it('keeps the row id stable across refreshes, so a node reference survives', async () => {
    const provider = await harness.created();

    const first = await harness.service.refreshModels(provider.id);
    const second = await harness.service.refreshModels(provider.id);

    expect(second.models[0]?.id).toBe(first.models[0]?.id);
  });

  it('FR-OBS-003 freezes the price table version it saw', async () => {
    const provider = await harness.created();
    await harness.service.refreshModels(provider.id);

    expect((await harness.repository.priceTables.get(scope, 'mock-v1'))?.data).toMatchObject({
      'mock-text': { inputPer1k: 0.001, outputPer1k: 0.002 },
    });
  });

  it('TC-MOD-003 lists the catalog through the query filters', async () => {
    const provider = await harness.created();
    await harness.service.refreshModels(provider.id);

    expect(await harness.service.listModels({ inputType: 'text' })).toHaveLength(1);
    expect(await harness.service.listModels({ inputType: 'image' })).toHaveLength(0);
  });
});

describe('FR-PRV-007 local runtime detection', () => {
  it('asks the factory and passes the answer through', async () => {
    expect(await harness.service.detect()).toEqual({
      ollama: { baseUrl: 'http://127.0.0.1:11434', detected: false },
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Concurrency                                                                 */
/* -------------------------------------------------------------------------- */

describe('TC-PRV-009 each provider gets its own concurrency gate', () => {
  it('sizes the gate from the provider row', async () => {
    const provider = await harness.created({ concurrency: 2 });

    expect((await harness.service.semaphoreFor(provider.id)).limit).toBe(2);
  });

  it('hands back the same gate every time, or the limit would mean nothing', async () => {
    const provider = await harness.created({ concurrency: 2 });

    expect(await harness.service.semaphoreFor(provider.id)).toBe(
      await harness.service.semaphoreFor(provider.id),
    );
  });

  it('D-027 hands back one gate to callers that ask at the same moment', async () => {
    // Five agents dispatched together all ask before any lookup has finished. Each used to miss
    // the cache, build its own gate of size 2, and so run unlimited.
    const provider = await harness.created({ concurrency: 2 });

    const gates = await Promise.all(
      Array.from({ length: 5 }, () => harness.service.semaphoreFor(provider.id)),
    );

    expect(new Set(gates).size).toBe(1);
  });

  it('gives two providers two independent gates', async () => {
    const one = await harness.created({ name: 'One', concurrency: 1 });
    const two = await harness.created({ name: 'Two', concurrency: 4 });

    expect(await harness.service.semaphoreFor(one.id)).not.toBe(
      await harness.service.semaphoreFor(two.id),
    );
    expect((await harness.service.semaphoreFor(two.id)).limit).toBe(4);
  });

  it('resizes the gate when the limit is changed', async () => {
    const provider = await harness.created({ concurrency: 4 });
    await harness.service.semaphoreFor(provider.id);

    await harness.service.update(provider.id, { concurrency: 1 });

    expect((await harness.service.semaphoreFor(provider.id)).limit).toBe(1);
  });
});

describe('FR-PRV-004 the scheduled re-check', () => {
  it('runs every 60 s and stops when the engine does', async () => {
    vi.useFakeTimers();
    try {
      const fresh = await build();
      await fresh.service.create({ type: 'mock', name: 'Mock', concurrency: 20 });

      const stop = fresh.service.startPeriodicChecks();
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      stop();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(adapterCalls.check).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('FR-PRV-005 removing a provider a knowledge base embeds with (final-review I5)', () => {
  async function baseEmbeddingWith(providerId: string, name = 'Handbook'): Promise<string> {
    const id = newId();
    await harness.repository.knowledgeBases.insert(scope, {
      id,
      projectId: newId(),
      name,
      embeddingProviderId: providerId,
      embeddingModelId: 'mock-embed',
      chunkSize: 700,
      chunkOverlap: 90,
      documentCount: 0,
      chunkCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
    return id;
  }

  it('refuses without confirmation, naming the bases and the nodes attached to them', async () => {
    const embedder = await harness.created({ name: 'Embedder' });
    const other = await harness.created({ name: 'Other' });
    const kbId = await baseEmbeddingWith(embedder.id);
    const workflow = makeWorkflow();
    await harness.repository.workflows.create(scope, workflow);
    const attached = makeAgentNode(workflow.id, { providerId: other.id });
    await harness.repository.nodes.insert(scope, {
      ...attached,
      config: { ...attached.config, knowledgeBaseIds: [kbId] },
    } as Node);
    const retrieval = {
      id: newId(),
      workflowId: workflow.id,
      kind: 'retrieval',
      name: 'Search',
      position: { x: 0, y: 0 },
      inputs: [],
      outputs: [],
      config: RetrievalConfigSchema.parse({ knowledgeBaseId: kbId }),
    } as Node;
    await harness.repository.nodes.insert(scope, retrieval);
    // Neither attached nor naming the provider: not in the list.
    await harness.repository.nodes.insert(
      scope,
      makeAgentNode(workflow.id, { providerId: other.id }),
    );

    const result = await harness.service.remove(embedder.id, { confirm: false });

    expect(result).toEqual({
      ok: false,
      reason: 'in_use',
      nodeIds: [attached.id, retrieval.id].sort(),
      knowledgeBases: ['Handbook'],
    });
    expect(await harness.service.get(embedder.id)).not.toBeNull();
  });

  it('refuses a base nothing references too, with no node ids', async () => {
    const embedder = await harness.created();
    await baseEmbeddingWith(embedder.id, 'Lonely');

    expect(await harness.service.remove(embedder.id, { confirm: false })).toEqual({
      ok: false,
      reason: 'in_use',
      nodeIds: [],
      knowledgeBases: ['Lonely'],
    });
  });

  it('removes it with confirmation', async () => {
    const embedder = await harness.created();
    await baseEmbeddingWith(embedder.id);

    expect(await harness.service.remove(embedder.id, { confirm: true })).toEqual({ ok: true });
    expect(await harness.service.get(embedder.id)).toBeNull();
  });
});

describe('FR-PRV-008 CLI providers in the service (X1)', () => {
  it('stores the default permission for a CLI provider created without one', async () => {
    const created = await harness.service.create({
      type: 'claude_code',
      name: 'Claude Code',
      concurrency: 1,
    });
    expect(created.cliPermission).toBe('edit_files');
    expect((await harness.service.get(created.id))?.cliPermission).toBe('edit_files');
  });

  it('keeps the permission it was given, and a patch changes it', async () => {
    const created = await harness.service.create({
      type: 'codex_cli',
      name: 'Codex',
      concurrency: 1,
      cliPermission: 'read_only',
    });
    expect(created.cliPermission).toBe('read_only');
    const updated = await harness.service.update(created.id, { cliPermission: 'full_auto' });
    expect(updated?.cliPermission).toBe('full_auto');
  });

  it('gives a non-CLI provider no permission at all', async () => {
    expect(await harness.created()).not.toHaveProperty('cliPermission');
  });

  it('passes the factory’s terminal scan through', async () => {
    expect(await harness.service.detectClis?.()).toEqual({ items: [] });
  });
});
