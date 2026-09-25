import { portId, validateLoopConfig, type LoopConfig, type LoopGraph } from '@ace/contracts';

import { PROBE_LOOP_CONFIG } from './can-be-loop-edge';

/**
 * Inline validation for the loop editor (FR-CON-007, TC-CON-007).
 *
 * The bounds are never re-derived here: every field is checked by handing the contract's own
 * `validateLoopConfig` a config that is known-good except for the one field under test, on a probe
 * graph that satisfies its structural rules. Whatever comes back can only be about that field, and
 * the message shown is the contract's own — so the editor and a 400 from the engine say the same
 * thing (NFR-USE-03).
 */

const PROBE_SOURCE = 'probe-source';
const PROBE_TARGET = 'probe-target';

/** A source with a json output, and a data path from the loop's target back to it. */
const PROBE_GRAPH: LoopGraph = {
  nodes: [
    {
      id: PROBE_SOURCE,
      name: 'source',
      outputs: [
        {
          id: portId(PROBE_SOURCE, 'out', 'json'),
          name: 'json',
          dataType: 'json',
          multi: true,
        },
      ],
    },
    { id: PROBE_TARGET, name: 'target', outputs: [] },
  ],
  edges: [
    {
      id: 'probe-data',
      kind: 'data',
      from: { nodeId: PROBE_TARGET, portId: portId(PROBE_TARGET, 'out', 'json') },
      to: { nodeId: PROBE_SOURCE, portId: portId(PROBE_SOURCE, 'in', 'json') },
    },
  ],
};

/**
 * The contract's complaint about `config`, or `undefined` when it accepts it. Only the config is
 * ever wrong on the probe graph, so a structural refusal cannot reach the editor.
 */
function problem(config: LoopConfig): string | undefined {
  const check = validateLoopConfig(
    {
      id: 'probe',
      kind: 'loop',
      from: { nodeId: PROBE_SOURCE, portId: portId(PROBE_SOURCE, 'out', 'json') },
      to: { nodeId: PROBE_TARGET, portId: portId(PROBE_TARGET, 'in', 'json') },
      loop: config,
    },
    PROBE_GRAPH,
  );
  if (check.ok || check.code !== 'invalid_loop_config') return undefined;
  // `Loop <field>: <message>.` — one field varies, so the tail is that field's message.
  const reason = check.reason.replace(/^Loop /, '').replace(/\.$/, '');
  const colon = reason.lastIndexOf(': ');
  return colon === -1 ? reason : reason.slice(colon + 2);
}

/** What the exit value a user typed is compared as (`LoopConfig.exitCondition.equals`). */
export type ExitValueKind = 'true/false' | 'number' | 'text';

/**
 * How the editor reads a typed exit value, which is also what the hint under the field says. The
 * contract's `equals` is `string | number | boolean`, and a run compares the value at the exit path
 * against it, so the three readings have to be told apart somewhere: `true` and `false` are the
 * booleans, anything that survives a round trip through `Number` is that number, and the rest is
 * text.
 */
export function readExitValue(raw: string): string | number | boolean {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed !== '' && String(Number(trimmed)) === trimmed) return Number(trimmed);
  return raw;
}

export function exitValueKind(raw: string): ExitValueKind {
  const value = readExitValue(raw);
  if (typeof value === 'boolean') return 'true/false';
  if (typeof value === 'number') return 'number';
  return 'text';
}

/** A number the contract can refuse: an empty or unreadable box is `NaN`, never a silent 0. */
export function readMaxIterations(raw: string): number {
  return raw.trim() === '' ? Number.NaN : Number(raw);
}

export interface LoopDraft {
  maxIterations: string;
  path: string;
  equals: string;
  onMax: LoopConfig['onMax'];
}

export interface LoopFieldErrors {
  maxIterations?: string;
  path?: string;
  equals?: string;
}

/** Every inline error in the draft. Empty means the draft is savable as `toLoopConfig` returns it. */
export function loopFieldErrors(draft: LoopDraft): LoopFieldErrors {
  const errors: LoopFieldErrors = {};

  const maxIterations = problem({
    ...PROBE_LOOP_CONFIG,
    maxIterations: readMaxIterations(draft.maxIterations),
  });
  if (maxIterations !== undefined) errors.maxIterations = maxIterations;

  const path = problem({
    ...PROBE_LOOP_CONFIG,
    exitCondition: { ...PROBE_LOOP_CONFIG.exitCondition, path: draft.path },
  });
  if (path !== undefined) errors.path = path;

  const equals = problem({
    ...PROBE_LOOP_CONFIG,
    exitCondition: { ...PROBE_LOOP_CONFIG.exitCondition, equals: readExitValue(draft.equals) },
  });
  if (equals !== undefined) errors.equals = equals;

  return errors;
}

/** The draft as a `LoopConfig`, or `undefined` while any field is refused — so nothing is saved. */
export function toLoopConfig(draft: LoopDraft): LoopConfig | undefined {
  if (Object.keys(loopFieldErrors(draft)).length > 0) return undefined;
  return {
    maxIterations: readMaxIterations(draft.maxIterations),
    exitCondition: { path: draft.path, equals: readExitValue(draft.equals) },
    onMax: draft.onMax,
  };
}

export function toLoopDraft(config: LoopConfig): LoopDraft {
  return {
    maxIterations: String(config.maxIterations),
    path: config.exitCondition.path,
    equals: String(config.exitCondition.equals),
    onMax: config.onMax,
  };
}
