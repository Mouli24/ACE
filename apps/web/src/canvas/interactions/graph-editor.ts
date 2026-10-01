import type { GraphOp } from '@ace/contracts';

import {
  canApply,
  inverseOps,
  reflects,
  useHistoryStore,
  type GraphState,
  type HistoryEntry,
} from './history';

/** What the editor needs from autosave: the same two calls the Canvas already uses. */
export interface SyncLike {
  enqueue(ops: readonly GraphOp[]): void;
  whenIdle(): Promise<void>;
}

export interface GraphEditorOptions {
  workflowId: string;
  sync: SyncLike;
  /** The graph as the Canvas shows it now (the optimistic cache). */
  read(): GraphState | undefined;
  /** Tell the operator why an undo or redo step was skipped or dropped. */
  notify(message: string, description?: string): void;
}

export interface GraphEditor {
  /** A user edit: recorded as one undo step, then sent through autosave. */
  edit(ops: readonly GraphOp[], label: string): void;
  undo(): void;
  redo(): void;
}

/**
 * Undo and redo that never touch the graph themselves (FR-CAN-009, BR-01): every step is a batch of
 * graph-ops replayed through `GraphSync.enqueue`, so it travels with `baseVersion` like any other
 * edit and the engine stays the source of truth.
 *
 * - `edit` derives the inverse from the graph *before* the edit — the only moment it is knowable.
 * - A step whose targets are gone (a remote change removed the node) is skipped and dropped.
 * - Once autosave settles, a step the cache does not reflect (the engine refused it, or a 409 could
 *   not be resolved) is dropped too: replaying it again would fail the same way.
 */
export function createGraphEditor(options: GraphEditorOptions): GraphEditor {
  const { workflowId, sync, read, notify } = options;
  const store = () => useHistoryStore.getState();
  /** Bumped on every send: a later edit to the same nodes would make the check below misfire. */
  let generation = 0;
  const send = (ops: readonly GraphOp[]) => {
    generation += 1;
    sync.enqueue(ops);
  };

  const replay = (entry: HistoryEntry, ops: GraphOp[], verb: 'Undo' | 'Redo') => {
    const before = read();
    if (!before || !canApply(before, ops)) {
      store().discard(workflowId, entry);
      notify(
        `${verb} skipped: “${entry.label}” no longer applies.`,
        'The workflow changed since that edit.',
      );
      return;
    }
    send(ops);
    const sent = generation;
    void sync.whenIdle().then(() => {
      if (generation !== sent) return;
      const after = read();
      if (after && reflects(before, ops, after)) return;
      store().discard(workflowId, entry);
      notify(`${verb} of “${entry.label}” was not saved and has been dropped.`);
    });
  };

  return {
    edit(ops, label) {
      if (ops.length === 0) return;
      const before = read();
      if (before) {
        store().record(workflowId, { label, do: [...ops], undo: inverseOps(before, ops) });
      }
      send(ops);
    },
    undo() {
      const entry = store().takeUndo(workflowId);
      if (entry) replay(entry, entry.undo, 'Undo');
    },
    redo() {
      const entry = store().takeRedo(workflowId);
      if (entry) replay(entry, entry.do, 'Redo');
    },
  };
}
