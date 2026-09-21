import type { Scope } from './scope.js';

/**
 * Background jobs (Arch §7: in-process locally, BullMQ when hosted).
 * Wired now, first used by the scheduler in round 2.
 */
export interface Queue<TJob> {
  enqueue(scope: Scope, job: TJob): Promise<void>;
  dequeue(scope: Scope): Promise<TJob | null>;
  size(scope: Scope): Promise<number>;
}
