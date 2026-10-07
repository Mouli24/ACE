import { describe, expect, it } from 'vitest';

import {
  LOCAL_WORKSPACE_ID,
  type Auth,
  type BlobStore,
  type KeywordIndex,
  type PubSub,
  type Queue,
  type Repository,
  type Sandbox,
  type Scope,
  type SecretStore,
  type VectorIndex,
} from '../ports/index.js';

/**
 * The ports are interfaces, so most of this contract is enforced by `pnpm typecheck` rather than at
 * runtime: each stub below is annotated with its port type, so removing a method, re-typing one, or
 * adding a stray one breaks the build. What is asserted here is the part that does exist at
 * runtime — the local scope constant, and that a stub really is callable through the port shape the
 * engine will depend on.
 */

const scope: Scope = { workspaceId: LOCAL_WORKSPACE_ID };

describe('NFR-PORT-01 port scope', () => {
  it('names the single local workspace `local`', () => {
    expect(LOCAL_WORKSPACE_ID).toBe('local');
  });

  it('carries the workspace on every call, so hosted mode needs no engine change', () => {
    expect(scope).toEqual({ workspaceId: 'local' });
  });
});

describe('Arch §7 Repository', () => {
  it('exposes one typed group per entity plus transaction()', async () => {
    const calls: string[] = [];

    const repo: Repository = {
      transaction: async <T>(fn: (tx: Repository) => Promise<T>) => {
        calls.push('transaction');
        return fn(repo);
      },
      projects: {
        create: async (_s, project) => project,
        get: async () => null,
        list: async () => ({ items: [] }),
        update: async () => null,
        delete: async () => false,
      },
      workflows: {
        create: async (_s, workflow) => workflow,
        get: async () => null,
        listByProject: async () => ({ items: [] }),
        update: async () => null,
        delete: async () => false,
      },
      nodes: {
        listByWorkflow: async () => [],
        getById: async () => null,
        listByProvider: async () => [],
        listByKnowledgeBase: async () => [],
        insert: async () => undefined,
        update: async () => undefined,
        delete: async () => undefined,
        deleteByWorkflow: async () => undefined,
      },
      edges: {
        listByWorkflow: async () => [],
        insert: async () => undefined,
        update: async () => undefined,
        delete: async () => undefined,
        deleteByWorkflow: async () => undefined,
        deleteByNode: async () => undefined,
      },
      events: {
        append: async (_s, event) => ({ ...event, seq: 1 }),
        listAfter: async () => [],
        currentSeq: async () => 0,
      },
      settings: {
        get: async () => {
          throw new Error('not needed for this stub');
        },
        update: async () => {
          throw new Error('not needed for this stub');
        },
      },
      providers: {
        create: async (_s, provider) => provider,
        get: async () => null,
        list: async () => [],
        update: async () => null,
        delete: async () => false,
      },
      models: {
        replaceForProvider: async () => undefined,
        list: async () => [],
        find: async () => null,
        deleteForProvider: async () => undefined,
      },
      priceTables: {
        put: async () => undefined,
        get: async () => null,
        list: async () => [],
      },
      runs: {
        create: async (_s, run) => run,
        get: async () => null,
        listByWorkflow: async () => ({ items: [] }),
        listActive: async () => [],
        update: async () => null,
      },
      nodeRuns: {
        create: async (_s, nodeRun) => nodeRun,
        get: async () => null,
        listByRun: async () => [],
        update: async () => null,
        dailyCostUsd: async () => 0,
      },
      guardrailPolicies: {
        create: async (_s, policy) => policy,
        get: async () => null,
        getVersion: async () => null,
        listByProject: async () => [],
        getProjectDefault: async () => null,
        update: async () => null,
        setDefault: async () => null,
        delete: async () => false,
        nodesUsing: async () => [],
      },
      guardrailVerdicts: {
        append: async (_s, verdict) => verdict,
        listByNodeRun: async () => [],
      },
      approvals: {
        create: async (_s, request) => request,
        get: async () => null,
        findPendingByNodeRun: async () => null,
        listPendingByRun: async () => [],
        listPending: async () => [],
        decide: async () => null,
      },
      artifacts: {
        create: async (_s, artifact) => artifact,
        getById: async () => null,
        getByHash: async () => null,
        list: async () => ({ items: [] }),
        touch: async () => null,
        unreferencedBefore: async () => [],
        delete: async () => false,
      },
      toolCalls: {
        append: async (_s, _runId, call) => call,
        listByNodeRun: async () => [],
        listByRun: async () => [],
      },
      mcpServers: {
        create: async (_s, server) => server,
        get: async () => null,
        list: async () => [],
        updateStatus: async () => null,
        delete: async () => false,
      },
      messages: {
        append: async (_s, message) => message,
        query: async () => ({ items: [] }),
      },
      chatThreads: {
        create: async (_s, thread) => thread,
        get: async () => null,
        listByNode: async () => [],
        touch: async () => null,
        delete: async () => false,
      },
      chatMessages: {
        append: async (_s, message) => message,
        listByThread: async () => [],
      },
    };

    const inside = await repo.transaction(async (tx) => {
      calls.push('body');
      return tx.projects.list(scope, { limit: 50 });
    });

    expect(calls).toEqual(['transaction', 'body']);
    expect(inside).toEqual({ items: [] });
  });
});

describe('Arch §7 remaining ports', () => {
  it('declares a blob store that is content-addressed', async () => {
    const store: BlobStore = {
      put: async (_s, bytes) => ({ hash: 'deadbeef', size: bytes.byteLength }),
      get: async () => null,
      has: async () => false,
      delete: async () => false,
    };

    expect(await store.put(scope, new Uint8Array([1, 2, 3]))).toEqual({
      hash: 'deadbeef',
      size: 3,
    });
  });

  it('declares a secret store that can report itself unavailable', async () => {
    const store: SecretStore = {
      isAvailable: async () => false,
      get: async () => null,
      set: async () => undefined,
      delete: async () => false,
    };

    expect(await store.isAvailable()).toBe(false);
  });

  it('declares a queue and a pub/sub with an unsubscribe handle', async () => {
    const queue: Queue<string> = {
      enqueue: async () => undefined,
      dequeue: async () => null,
      size: async () => 0,
    };

    let unsubscribed = false;
    const pubsub: PubSub<string> = {
      publish: async () => undefined,
      subscribe: async () => () => {
        unsubscribed = true;
      },
    };

    expect(await queue.size(scope)).toBe(0);
    (await pubsub.subscribe(scope, 'topic', () => undefined))();
    expect(unsubscribed).toBe(true);
  });

  it('declares the later-round ports without implementing them', () => {
    const vector: VectorIndex = {
      upsert: async () => undefined,
      query: async () => [],
      deleteByDocument: async () => undefined,
      deleteByKnowledgeBase: async () => undefined,
    };

    const keyword: KeywordIndex = {
      index: async () => undefined,
      search: async () => [],
      deleteByDocument: async () => undefined,
      deleteByKnowledgeBase: async () => undefined,
    };

    const sandbox: Sandbox = {
      run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    };

    expect([vector, keyword, sandbox].every((port) => typeof port === 'object')).toBe(true);
  });

  it('declares an auth port that verifies a session token', async () => {
    const auth: Auth = {
      verifyToken: async (_s, token) => token === 'good',
    };

    expect(await auth.verifyToken(scope, 'good')).toBe(true);
    expect(await auth.verifyToken(scope, 'bad')).toBe(false);
  });
});
