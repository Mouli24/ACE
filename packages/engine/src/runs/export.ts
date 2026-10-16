import {
  FORMAT_VERSION,
  RunExportSchema,
  type Event,
  type Id,
  type NodeRun,
  type Part,
  type Run,
  type RunExport,
} from '@ace/contracts';

import { maskSecrets } from '../security/secret-patterns.js';

/**
 * The run export bundle (PG-5.5, FR-BEN-005, TC-BEN-004): `GET /runs/:id/export?anonymise=1`.
 *
 * Plain form: the run record, every node run, each node's final output and the run's event log,
 * every string through the secret mask (BR-07) — the rows already are, the mask is applied again so
 * the bundle never depends on that.
 *
 * Anonymised form, for blind judging: node names become "Node 1".."Node n" in snapshot order;
 * every provider and model id or name is removed — any key ending in `providerId` or `modelId`,
 * `modelUsed`, `providerName`, `providerType`, and a routing's `fallbackModelIds` emptied — and
 * every string that still spells one of them (a prompt, an event message) has it rewritten as
 * "[provider]" or "[model]".
 */

export interface RunExportInput {
  run: Run;
  nodeRuns: readonly NodeRun[];
  events: readonly Event[];
  anonymise: boolean;
  /** Every provider row, so its name and id can be scrubbed from free text. */
  providers: readonly { id: Id; name: string }[];
  /** Every catalog row, so a model id or display name can be scrubbed from free text. */
  models: readonly { modelId: string; displayName?: string; resolvedModelId?: string }[];
  now: () => string;
}

/** The latest COMPLETED node run of each node — last iteration, then last attempt. */
function finalOutputs(nodeRuns: readonly NodeRun[]): Record<Id, Part[]> {
  const best = new Map<Id, NodeRun>();
  for (const row of nodeRuns) {
    if (row.status !== 'COMPLETED' || row.output === undefined) continue;
    const current = best.get(row.nodeId);
    if (
      current === undefined ||
      row.iteration > current.iteration ||
      (row.iteration === current.iteration && row.attempt > current.attempt)
    ) {
      best.set(row.nodeId, row);
    }
  }
  return Object.fromEntries([...best].map(([nodeId, row]) => [nodeId, row.output ?? []]));
}

/** Keys an anonymised export drops wherever they appear. */
function isIdentifyingKey(key: string): boolean {
  return (
    /providerid$/i.test(key) ||
    /modelid$/i.test(key) ||
    key === 'modelUsed' ||
    key === 'providerName' ||
    key === 'providerType' ||
    key === 'modelName'
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Rewrite {
  pattern: RegExp;
  replacement: string;
}

/**
 * One rewrite per spelled name, longest first so "gpt-4o-mini" goes before "gpt-4o". A name that
 * starts or ends with a word character only matches as a whole word; a name of fewer than three
 * characters is replaced only when it is the whole string, so "A" never eats every "a".
 */
function rewritesFor(names: ReadonlyMap<string, string>): {
  exact: Map<string, string>;
  inText: Rewrite[];
} {
  const exact = new Map<string, string>();
  const inText: Rewrite[] = [];
  const sorted = [...names].sort((a, b) => b[0].length - a[0].length);
  for (const [name, replacement] of sorted) {
    const trimmed = name.trim();
    if (trimmed === '') continue;
    exact.set(trimmed, replacement);
    if (trimmed.length < 3) continue;
    const start = /^\w/.test(trimmed) ? '\\b' : '';
    const end = /\w$/.test(trimmed) ? '\\b' : '';
    inText.push({
      pattern: new RegExp(`${start}${escapeRegExp(trimmed)}${end}`, 'g'),
      replacement,
    });
  }
  return { exact, inText };
}

/**
 * Keys whose string values are the engine's own vocabulary or references — an event `type`, a
 * state, an id, a timestamp, a data type — never free text. A node called "output" must not turn
 * `node.output` into `node.Node 3`, so these are masked but never rewritten.
 */
const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  'type',
  'status',
  'kind',
  'code',
  'id',
  'mime',
  'language',
  'version',
  'failureReason',
  'haltReason',
  'blockedReason',
  'trust',
  'policy',
  'trigger',
  'addressing',
  'deliveryMode',
  'severity',
  'action',
  'point',
  'role',
  'source',
  'costSource',
  'formatVersion',
  'inputTypes',
  'outputTypes',
  'enabledTools',
  'allowedActions',
]);

function isStructuralKey(key: string): boolean {
  return STRUCTURAL_KEYS.has(key) || /Ids?$/.test(key) || /At$/.test(key);
}

function transform(
  value: unknown,
  rewriteString: (text: string) => string,
  anonymise: boolean,
  structural = false,
): unknown {
  if (typeof value === 'string') return structural ? maskSecrets(value) : rewriteString(value);
  if (Array.isArray(value)) {
    return value.map((item) => transform(item, rewriteString, anonymise, structural));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (anonymise && isIdentifyingKey(key)) continue;
      if (anonymise && key === 'fallbackModelIds') {
        out[key] = [];
        continue;
      }
      out[key] = transform(item, rewriteString, anonymise, isStructuralKey(key));
    }
    return out;
  }
  return value;
}

export function buildRunExport(input: RunExportInput): RunExport {
  const { run, anonymise } = input;
  const nodeRuns = [...input.nodeRuns];
  const events = [...input.events].sort((a, b) => a.seq - b.seq);

  const bundle = {
    formatVersion: FORMAT_VERSION,
    exportedAt: input.now(),
    anonymised: anonymise,
    run,
    nodeRuns,
    outputs: finalOutputs(nodeRuns),
    events,
  };

  let rewriteString = (text: string): string => maskSecrets(text);

  if (anonymise) {
    const names = new Map<string, string>();
    // Providers and models first, so a node named after its model still becomes "Node n" below.
    for (const provider of input.providers) {
      names.set(provider.name, '[provider]');
      names.set(provider.id, '[provider]');
    }
    for (const model of input.models) {
      names.set(model.modelId, '[model]');
      if (model.displayName !== undefined) names.set(model.displayName, '[model]');
      if (model.resolvedModelId !== undefined) names.set(model.resolvedModelId, '[model]');
    }
    for (const row of nodeRuns) {
      if (row.modelUsed === undefined) continue;
      names.set(row.modelUsed.providerId, '[provider]');
      names.set(row.modelUsed.modelId, '[model]');
      if (row.modelUsed.resolvedModelId !== undefined) {
        names.set(row.modelUsed.resolvedModelId, '[model]');
      }
    }
    run.snapshot.nodes.forEach((node, index) => names.set(node.name, `Node ${index + 1}`));

    const { exact, inText } = rewritesFor(names);
    rewriteString = (text: string): string => {
      const whole = exact.get(text.trim());
      if (whole !== undefined) return whole;
      let out = text;
      for (const { pattern, replacement } of inText) out = out.replace(pattern, replacement);
      return maskSecrets(out);
    };
  }

  return RunExportSchema.parse(transform(bundle, rewriteString, anonymise));
}
