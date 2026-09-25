import type { Id } from '@ace/contracts';

/**
 * The handle between a control request and the scheduler driving the run (FR-CTL-001..003).
 *
 * `POST /runs/:id/pause` arrives on the gateway thread; the run it is about is a loop inside
 * `drive()`. The gate is the only thing the two share: the HTTP side flips a flag, the loop reads
 * it before each dispatch, and nothing else about the scheduler is reachable from a route handler.
 *
 * Three states, not two. A paused gate still holds its in-flight nodes — "RUNNING nodes finish"
 * (FR-CTL-001) — while a stopped gate has aborted their signal. And an aborted gate remembers
 * *why*: a stop halts the run `stopped`, a shutdown halts it `shutdown`, and FR-ERR-007 turns on
 * that distinction being kept.
 */

export type AbortCause = 'stopped' | 'shutdown';

export interface RunGate {
  readonly runId: Id;
  /** Handed to every `generate()` for this run, so an abort closes every provider stream. */
  readonly signal: AbortSignal;

  isPaused(): boolean;
  isAborted(): boolean;
  /** Why the signal was aborted, or `undefined` while it has not been. */
  abortCause(): AbortCause | undefined;

  /** FR-CTL-001: no new dispatch. In-flight nodes are left alone. */
  pause(): void;
  /** FR-CTL-002: dispatch continues from where it stopped. */
  resume(): void;
  /** FR-CTL-003: abort every in-flight `generate()` now. */
  stop(): void;
  /** FR-SYS-008: the engine is going down; the run halts `shutdown`, which is not a failure. */
  shutdown(): void;

  /**
   * Awaited by the scheduler before it dispatches. Resolves `true` when the run may dispatch and
   * `false` when it was aborted — while paused it simply does not resolve, which is exactly what
   * "no new nodes start" means.
   */
  waitUntilDispatchable(): Promise<boolean>;

  /** Registers a node as in flight; call the returned function when it is done. */
  track(nodeId: Id): () => void;
  inFlightNodeIds(): Id[];
  /** Resolves once nothing is in flight — what `stop` waits on before it writes the run row. */
  idle(): Promise<void>;
}

export function createRunGate(runId: Id): RunGate {
  const controller = new AbortController();
  let paused = false;
  let cause: AbortCause | undefined;

  /** Everyone waiting for the pause to lift or for the run to be aborted. */
  let waiters: (() => void)[] = [];
  /** Everyone waiting for the last in-flight node. */
  let idleWaiters: (() => void)[] = [];

  /** Node ids in flight, with a count: the same node can be in flight twice across iterations. */
  const inFlight = new Map<Id, number>();

  function wake(): void {
    const woken = waiters;
    waiters = [];
    for (const resolve of woken) resolve();
  }

  function wakeIdle(): void {
    if (inFlight.size > 0) return;
    const woken = idleWaiters;
    idleWaiters = [];
    for (const resolve of woken) resolve();
  }

  function abort(next: AbortCause): void {
    if (cause !== undefined) return;
    cause = next;
    paused = false;
    controller.abort();
    wake();
  }

  return {
    runId,
    signal: controller.signal,

    isPaused: () => paused,
    isAborted: () => cause !== undefined,
    abortCause: () => cause,

    pause() {
      if (cause !== undefined) return;
      paused = true;
    },

    resume() {
      if (cause !== undefined || !paused) return;
      paused = false;
      wake();
    },

    stop: () => abort('stopped'),
    shutdown: () => abort('shutdown'),

    async waitUntilDispatchable() {
      while (paused && cause === undefined) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      return cause === undefined;
    },

    track(nodeId) {
      inFlight.set(nodeId, (inFlight.get(nodeId) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const count = (inFlight.get(nodeId) ?? 1) - 1;
        if (count <= 0) inFlight.delete(nodeId);
        else inFlight.set(nodeId, count);
        wakeIdle();
      };
    },

    inFlightNodeIds: () => [...inFlight.keys()],

    async idle() {
      while (inFlight.size > 0) {
        await new Promise<void>((resolve) => idleWaiters.push(resolve));
      }
    },
  };
}

export interface RunGateRegistry {
  /** Registers a gate and returns the function that removes it again. */
  register(gate: RunGate): () => void;
  get(runId: Id): RunGate | undefined;
  runIds(): Id[];
  /** Every gate: what `shutdown()` walks (FR-SYS-008). */
  all(): RunGate[];
}

/**
 * Which runs this process is driving. One map, owned by the composition root and read by both the
 * scheduler (which registers) and the controls (which look up).
 */
export function createRunGateRegistry(): RunGateRegistry {
  const gates = new Map<Id, RunGate>();

  return {
    register(gate) {
      gates.set(gate.runId, gate);
      return () => {
        if (gates.get(gate.runId) === gate) gates.delete(gate.runId);
      };
    },
    get: (runId) => gates.get(runId),
    runIds: () => [...gates.keys()],
    all: () => [...gates.values()],
  };
}
