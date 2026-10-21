import type { Node } from '@ace/contracts';

/** JSON with every object's keys sorted, so two equal configs read the same whatever their order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, each: unknown) =>
    each !== null && typeof each === 'object' && !Array.isArray(each)
      ? Object.fromEntries(
          Object.entries(each as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : each,
  );
}

/**
 * [audit L-13] Whether a node's settings differ from the copy its run executed. A run executes its
 * snapshot (BR-04), and Retry re-runs that snapshot, so an edit made since the run started reaches
 * only a new run. Position and name do not change what runs; a node the snapshot does not hold is
 * not this run's, so it has nothing to differ from.
 */
export function nodeChangedSinceRun(current: Node, snapshot: readonly Node[] | undefined): boolean {
  const ran = snapshot?.find((node) => node.id === current.id);
  if (ran === undefined) return false;
  return ran.kind !== current.kind || canonical(ran.config) !== canonical(current.config);
}
