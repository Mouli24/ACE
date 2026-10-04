import type { Id, MemoryEntry, MemoryOp } from '@ace/contracts';

import type { EventBus } from '../events/index.js';
import { notFound } from '../gateway/errors.js';
import { newId } from '../ids.js';
import type { MemoryRepository, Repository, Scope } from '../ports/index.js';
import { maskMemoryValue } from './ops.js';

/**
 * Agent memory (FR-MEM-001..004, round 5 §2.2, Arch §12.8): the key/value facts one agent node
 * keeps between runs. Every change announces itself with `memory.updated` — an engine-family event
 * (D230), so it carries no workflow or run — which an open Memory tab keeps by `nodeId`.
 */
export interface MemoryService {
  /** Oldest first — the order entries are injected in. */
  list(nodeId: Id): Promise<MemoryEntry[]>;
  /** Saves and deletes in order; emits one `memory.updated` carrying the ops when there are any. */
  apply(nodeId: Id, ops: readonly MemoryOp[]): Promise<void>;
  /** 404 when the node has no such entry; emits the entry's `delete` op. */
  deleteEntry(nodeId: Id, entryId: Id): Promise<void>;
  /** Removes everything; emits one `delete` op per key. */
  clear(nodeId: Id): Promise<void>;
  /** Stamps `lastUsedAt` on entries that went into an envelope. */
  markUsed(ids: readonly Id[]): Promise<void>;
}

export interface MemoryServiceDeps {
  scope: Scope;
  repository: Repository;
  bus: EventBus;
  now?: () => string;
  nextId?: () => Id;
}

export function createMemoryService(deps: MemoryServiceDeps): MemoryService {
  const { scope, bus } = deps;
  const now = deps.now ?? ((): string => new Date().toISOString());
  const nextId = deps.nextId ?? newId;

  const repo = (): MemoryRepository => {
    const memory = deps.repository.memory;
    if (memory === undefined) {
      throw new Error(
        'Agent memory needs a repository with a memory store, and this one has none.',
      );
    }
    return memory;
  };

  const announce = async (nodeId: Id, ops: MemoryOp[]): Promise<void> => {
    if (ops.length === 0) return;
    await bus.emit({ type: 'memory.updated', payload: { nodeId, ops } });
  };

  return {
    list: async (nodeId) => repo().list(scope, nodeId),

    async apply(nodeId, ops) {
      const memory = repo();
      const applied: MemoryOp[] = [];
      for (const op of ops) {
        if (op.op === 'save') {
          const value = maskMemoryValue(op.value);
          await memory.upsert(scope, nodeId, op.key, value, now(), nextId);
          applied.push({ op: 'save', key: op.key, value });
        } else {
          await memory.deleteKey(scope, nodeId, op.key);
          applied.push(op);
        }
      }
      await announce(nodeId, applied);
    },

    async deleteEntry(nodeId, entryId) {
      const removed = await repo().deleteEntry(scope, nodeId, entryId);
      if (removed === null) throw notFound('Memory entry');
      await announce(nodeId, [{ op: 'delete', key: removed.key }]);
    },

    async clear(nodeId) {
      const removed = await repo().clear(scope, nodeId);
      await announce(
        nodeId,
        removed.map((entry): MemoryOp => ({ op: 'delete', key: entry.key })),
      );
    },

    markUsed: async (ids) => {
      if (ids.length > 0) await repo().markUsed(scope, ids, now());
    },
  };
}
