import { GRAPH_OPS_MAX, type GraphOp, type WorkflowGraphResponse } from '@ace/contracts';
import { AceApiError, type AceClient } from '@ace/sdk';
import type { QueryClient } from '@tanstack/react-query';

import { applyOps } from './apply-ops';
import { queryKeys } from './query-keys';

export interface GraphSyncOptions {
  workflowId: string;
  client: AceClient;
  queryClient: QueryClient;
  /** Ops enqueued within this window travel in one request (≤ 100 ms per the round file). */
  debounceMs?: number;
  /** Two 409s in a row on the same batch: the batch is dropped and this is told (FR-WF-005). */
  onConflictUnresolved?: (error: AceApiError) => void;
  /** Any other refusal (400 validation, 501, network): the batch is dropped and this is told. */
  onRejected?: (error: AceApiError) => void;
  /** First wait after the engine is unreachable; doubles up to 15 s. */
  networkRetryMs?: number;
}

/**
 * Autosave for one workflow (FR-WF-004/005, Arch §10.1 "graph edits"):
 *
 * 1. `enqueue` applies the ops to the TanStack cache at once (optimistic) and queues them.
 * 2. After the debounce the queue is sent as one `graph-ops` request with the cached `baseVersion`.
 * 3. Success: cache = engine answer, then any ops queued meanwhile are re-applied on top.
 * 4. 409: refetch, re-apply the in-flight batch and the queue on top, retry that batch once;
 *    a second 409 drops the batch, keeps the queue, and reports the conflict.
 * 5. 400 or anything else: drop the batch, refetch, re-apply the queue, report.
 *
 * The engine owns the version (BR-01): the cache only ever carries a version the engine answered.
 */
export class GraphSync {
  private queue: GraphOp[] = [];
  private inflight: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private idleResolvers: Array<() => void> = [];
  private disposed = false;
  /** Set after a network failure so the next attempt waits instead of hammering. */
  private retryDelayMs: number | undefined;

  constructor(private readonly options: GraphSyncOptions) {}

  private get key() {
    return queryKeys.workflow(this.options.workflowId);
  }

  private read(): WorkflowGraphResponse | undefined {
    return this.options.queryClient.getQueryData<WorkflowGraphResponse>(this.key);
  }

  private write(graph: WorkflowGraphResponse): void {
    this.options.queryClient.setQueryData(this.key, graph);
  }

  private async refetch(): Promise<WorkflowGraphResponse> {
    const fresh = await this.options.client.getWorkflow(this.options.workflowId);
    return fresh;
  }

  /** How many ops are waiting or in flight. */
  get pending(): number {
    return this.queue.length + (this.inflight ? 1 : 0);
  }

  enqueue(ops: readonly GraphOp[]): void {
    if (this.disposed || ops.length === 0) return;
    const current = this.read();
    if (current) this.write(applyOps(current, ops));
    this.queue.push(...ops);
    this.schedule();
  }

  private schedule(delayMs = this.options.debounceMs ?? 100): void {
    if (this.timer || this.inflight) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delayMs);
  }

  /** Send whatever is queued now (also called by the debounce timer). */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.inflight) return this.inflight;
    if (this.queue.length === 0) {
      this.settleIdle();
      return Promise.resolve();
    }
    const batch = this.queue.splice(0, GRAPH_OPS_MAX);
    this.inflight = this.send(batch).finally(() => {
      this.inflight = undefined;
      if (this.queue.length === 0) this.settleIdle();
      else if (this.retryDelayMs !== undefined) this.schedule(this.retryDelayMs);
      else void this.flush();
    });
    return this.inflight;
  }

  /** Resolves once nothing is queued or in flight. */
  whenIdle(): Promise<void> {
    if (!this.inflight && !this.timer && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  private settleIdle(): void {
    if (this.inflight || this.timer || this.queue.length > 0) return;
    const resolvers = this.idleResolvers;
    this.idleResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  private async send(batch: GraphOp[], retried = false): Promise<void> {
    const base = this.read();
    if (!base) return;
    try {
      const res = await this.options.client.applyGraphOps(this.options.workflowId, {
        baseVersion: base.workflow.version,
        ops: batch,
      });
      const fromServer: WorkflowGraphResponse = {
        workflow: { ...base.workflow, version: res.version },
        nodes: res.nodes,
        edges: res.edges,
      };
      this.write(applyOps(fromServer, this.queue));
    } catch (error) {
      const apiError = AceApiError.is(error) ? error : AceApiError.network(error);
      let fresh: WorkflowGraphResponse;
      try {
        fresh = await this.refetch();
        this.retryDelayMs = undefined;
      } catch {
        // the engine is unreachable: keep the optimistic view, the ops stay queued for later
        this.queue.unshift(...batch);
        this.retryDelayMs = Math.min(
          this.retryDelayMs === undefined
            ? (this.options.networkRetryMs ?? 1000)
            : this.retryDelayMs * 2,
          15_000,
        );
        this.options.onRejected?.(apiError);
        return;
      }
      if (apiError.status === 409 && !retried) {
        this.write(applyOps(fresh, [...batch, ...this.queue]));
        await this.send(batch, true);
        return;
      }
      this.write(applyOps(fresh, this.queue));
      if (apiError.status === 409) this.options.onConflictUnresolved?.(apiError);
      else this.options.onRejected?.(apiError);
    }
  }

  /** `workflow.updated` from the socket: refetch when the engine is ahead and we are quiet. */
  async onRemoteVersion(version: number): Promise<void> {
    const current = this.read();
    if (!current || current.workflow.version === version) return;
    if (this.pending > 0 || this.timer) return;
    const fresh = await this.refetch();
    if (this.pending === 0 && !this.timer) this.write(fresh);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
