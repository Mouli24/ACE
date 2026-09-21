import type { Queue, Scope } from '@ace/engine';

/**
 * In-process FIFO job queue (Arch §7 local adapter; BullMQ when hosted).
 * Wired now, first used by the scheduler in round 2.
 */
export class InProcessQueue<TJob> implements Queue<TJob> {
  readonly #byWorkspace = new Map<string, TJob[]>();

  async enqueue(scope: Scope, job: TJob): Promise<void> {
    this.#queueFor(scope).push(job);
  }

  async dequeue(scope: Scope): Promise<TJob | null> {
    return this.#queueFor(scope).shift() ?? null;
  }

  async size(scope: Scope): Promise<number> {
    return this.#queueFor(scope).length;
  }

  #queueFor(scope: Scope): TJob[] {
    let queue = this.#byWorkspace.get(scope.workspaceId);
    if (queue === undefined) {
      queue = [];
      this.#byWorkspace.set(scope.workspaceId, queue);
    }
    return queue;
  }
}
