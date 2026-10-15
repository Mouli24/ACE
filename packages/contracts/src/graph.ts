import { z } from 'zod';

import { DataTypeSchema, EdgeKindSchema, RoutingPolicySchema, type DataType } from './enums.js';

/* -------------------------------------------------------------------------- */
/* Primitives (round 1 §2.4)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Crockford base-32 ULID: 26 characters, the alphabet without I, L, O and U, and a first
 * character of 0-7 so the 48-bit timestamp cannot overflow. D21 makes the format part of the
 * contract so an id that drifts fails at the seam rather than three rounds later.
 */
export const ULID_REGEX = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export const IdSchema = z.string().regex(ULID_REGEX, 'must be a ULID');
export type Id = z.infer<typeof IdSchema>;

/** ISO-8601 instant, with `Z` or an explicit offset. */
export const TimestampSchema = z.iso.datetime({ offset: true });
export type Timestamp = z.infer<typeof TimestampSchema>;

/** The one workflow format version round 1 writes and reads (§2.4, §2.7). */
export const FORMAT_VERSION = 1;
export const FormatVersionSchema = z.literal(FORMAT_VERSION);

export const EntityNameSchema = z.string().min(1).max(120);
export const NodeNameSchema = z.string().min(1).max(80);

/* -------------------------------------------------------------------------- */
/* Project and workflow                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A spending cap in USD (round 3 §2.3). A set cap is above zero. A PATCH removes it with `null`,
 * and a record reads `null` — like absence — as no cap, so a patch can be merged into the record
 * it patches as it is (D72).
 */
export const BudgetUsdSchema = z.number().positive();

/**
 * D301: how far a project trusts its terminal (design §6.3). `on` runs any command a person types
 * and the project's scripts; `scripts` runs only the root package.json scripts; `off` runs nothing.
 * Absent reads as `on`, so a project stored before Forge needs no backfill.
 */
export const TERMINAL_TRUST_LEVELS = ['on', 'scripts', 'off'] as const;
export const TerminalTrustSchema = z.enum(TERMINAL_TRUST_LEVELS);
export type TerminalTrust = z.infer<typeof TerminalTrustSchema>;
export const DEFAULT_TERMINAL_TRUST: TerminalTrust = 'on';

/**
 * Forge's Run checks (design §6.4): the command a project's checks run as, such as
 * `pnpm tsc --noEmit`. Under trust `scripts` it must name a package.json script.
 */
export const CheckCommandSchema = z.string().min(1).max(1000);

export const ProjectSchema = z.object({
  id: IdSchema,
  name: EntityNameSchema,
  folderPath: z.string(),
  lastOpenedAt: TimestampSchema.optional(),
  /** A run that would cost more halts `budget_exceeded` (round 3 §2.3, FR-GRD-008). */
  maxCostPerRunUsd: BudgetUsdSchema.nullable().optional(),
  /** D301: absent is `on`. */
  terminal: TerminalTrustSchema.optional(),
  /**
   * Forge's Run checks: absent means none is set, and Run checks asks for one. A PATCH removes it
   * with `null`, and a record reads `null` like absence, so a patch merges into the record as it
   * is — the way D72 reads a removed budget.
   */
  checkCommand: CheckCommandSchema.nullable().optional(),
  /** Forge formats the active editor's file before saving it. Absent is `false`. */
  formatOnSave: z.boolean().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

export const WorkflowSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  name: EntityNameSchema,
  version: z.number().int().min(0),
  formatVersion: FormatVersionSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Workflow = z.infer<typeof WorkflowSchema>;

/* -------------------------------------------------------------------------- */
/* Ports and positions                                                         */
/* -------------------------------------------------------------------------- */

/** `multi: true` means the port accepts many edges into it (§2.4). */
export const PortSchema = z.object({
  id: z.string(),
  name: z.string(),
  dataType: DataTypeSchema,
  multi: z.boolean(),
});
export type Port = z.infer<typeof PortSchema>;

export const PositionSchema = z.object({ x: z.number(), y: z.number() });
export type Position = z.infer<typeof PositionSchema>;

/** Port ids are stable and derived: `<nodeId>:in:<name>` / `<nodeId>:out:<name>` (§2.4). */
export const PORT_ID_REGEX = /^[0-7][0-9A-HJKMNP-TV-Z]{25}:(in|out):[A-Za-z0-9_]+$/;
export const PortIdSchema = z.string().regex(PORT_ID_REGEX, 'must be <nodeId>:in|out:<name>');

export function portId(nodeId: Id, direction: 'in' | 'out', name: string): string {
  return `${nodeId}:${direction}:${name}`;
}

/* -------------------------------------------------------------------------- */
/* Execution settings and node configuration (§2.4)                            */
/* -------------------------------------------------------------------------- */

export const DEFAULT_EXECUTION_SETTINGS = {
  temperature: 0.7,
  maxTokens: 4096,
  timeoutMs: 120_000,
  retries: 2,
} as const;

export const ExecutionSettingsSchema = z.object({
  temperature: z.number().min(0).max(2).default(DEFAULT_EXECUTION_SETTINGS.temperature),
  maxTokens: z.number().int().min(1).max(200_000).default(DEFAULT_EXECUTION_SETTINGS.maxTokens),
  timeoutMs: z.number().int().min(1000).max(600_000).default(DEFAULT_EXECUTION_SETTINGS.timeoutMs),
  retries: z.number().int().min(0).max(5).default(DEFAULT_EXECUTION_SETTINGS.retries),
});
export type ExecutionSettings = z.infer<typeof ExecutionSettingsSchema>;

export const DEFAULT_CONTEXT_POLICY = { budgetTokens: 4000 } as const;
export const DEFAULT_AGENT_MEMORY = { enabled: false } as const;
export const DEFAULT_MAX_TOOL_CALLS = 10;

/**
 * Defaults that contain arrays are built by a factory, not shared as one frozen literal: a Zod
 * `.default(value)` hands every parse the same reference, so two agent configs would otherwise
 * share one `fallbackModelIds` array.
 */
export const defaultExecutionSettings = (): ExecutionSettings => ({ ...DEFAULT_EXECUTION_SETTINGS });

export const defaultRouting = () => ({
  policy: 'fixed' as const,
  fallbackModelIds: [] as string[],
});

export const defaultAgentTools = () => ({
  enabled: [] as string[],
  maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
  allowedDomains: [] as string[],
});

export const AgentConfigSchema = z.object({
  providerId: IdSchema.optional(),
  modelId: z.string().optional(),
  routing: z
    .object({
      policy: RoutingPolicySchema,
      fallbackModelIds: z.array(z.string()),
    })
    .default(defaultRouting),
  instructions: z.string(),
  inputTypes: z.array(DataTypeSchema),
  outputTypes: z.array(DataTypeSchema),
  outputContract: z
    .object({ jsonSchema: z.record(z.string(), z.unknown()).optional() })
    .optional(),
  execution: ExecutionSettingsSchema.default(defaultExecutionSettings),
  contextPolicy: z
    .object({ budgetTokens: z.number().int().min(256).max(200_000) })
    .default(DEFAULT_CONTEXT_POLICY),
  guardrailPolicyId: IdSchema.optional(),
  tools: z
    .object({
      enabled: z.array(z.string()),
      maxToolCalls: z.number().int().min(0).max(50),
      allowedDomains: z.array(z.string()),
    })
    .default(defaultAgentTools),
  knowledgeBaseIds: z.array(IdSchema).default(() => []),
  memory: z.object({ enabled: z.boolean() }).default(DEFAULT_AGENT_MEMORY),
  skillIds: z.array(IdSchema).default(() => []),
  /**
   * This Agent is the workflow's Brain (D304): at most one per workflow, always `@brain`. It hears
   * the human's unaddressed messages and a digest of the envelopes routed in a run.
   */
  brain: z.boolean().optional(),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

/**
 * D353 (PG-2.1, X4): a JSON schema implies JSON output. A node's output types with its schema taken
 * into account — `outputTypes ⊇ ['json']` whenever a `jsonSchema` is set. The one rule the
 * executor, the envelope contract and the loop check all read, so they never disagree.
 */
export function outputTypesWithSchema(
  outputTypes: readonly DataType[],
  jsonSchema: Record<string, unknown> | undefined,
): DataType[] {
  if (jsonSchema === undefined || outputTypes.includes('json')) return [...outputTypes];
  return [...outputTypes, 'json'];
}

/**
 * D353: an Agent or Model config's effective output types (see `outputTypesWithSchema`). A Model
 * config has no output contract, so its types stand as written.
 */
export function effectiveOutputTypes(config: {
  readonly outputTypes: readonly DataType[];
  readonly outputContract?: { readonly jsonSchema?: Record<string, unknown> | undefined } | undefined;
}): DataType[] {
  return outputTypesWithSchema(config.outputTypes, config.outputContract?.jsonSchema);
}

/** The `outputContract.jsonSchema` an agent config carries, read from any node's config. */
export function outputSchemaOf(config: unknown): Record<string, unknown> | undefined {
  if (typeof config !== 'object' || config === null) return undefined;
  const contract = (config as { outputContract?: unknown }).outputContract;
  if (typeof contract !== 'object' || contract === null) return undefined;
  const schema = (contract as { jsonSchema?: unknown }).jsonSchema;
  return typeof schema === 'object' && schema !== null && !Array.isArray(schema)
    ? (schema as Record<string, unknown>)
    : undefined;
}

/**
 * Whether a node produces a json output (D353): a json output port, or an output contract whose
 * schema makes the answer JSON whatever ports it shows.
 */
export function hasJsonOutput(node: {
  readonly outputs: readonly Pick<Port, 'dataType'>[];
  readonly config?: unknown;
}): boolean {
  return (
    node.outputs.some((port) => port.dataType === 'json') ||
    outputSchemaOf(node.config) !== undefined
  );
}

export const InputConfigSchema = z.object({
  text: z.string().optional(),
  artifactIds: z.array(IdSchema),
  outputTypes: z.array(DataTypeSchema),
});
export type InputConfig = z.infer<typeof InputConfigSchema>;

export const OutputConfigSchema = z.object({});
export type OutputConfig = z.infer<typeof OutputConfigSchema>;

export const ModelConfigSchema = z.object({
  providerId: IdSchema.optional(),
  modelId: z.string().optional(),
  systemPrompt: z.string().optional(),
  inputTypes: z.array(DataTypeSchema),
  outputTypes: z.array(DataTypeSchema),
  execution: ExecutionSettingsSchema.default(defaultExecutionSettings),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const MERGE_MODES = ['all', 'any'] as const;
export const MergeConfigSchema = z.object({ mode: z.enum(MERGE_MODES) });
export type MergeConfig = z.infer<typeof MergeConfigSchema>;

export const TRANSFORM_OPS = ['template', 'extract_json_field', 'join'] as const;
export const TransformConfigSchema = z.object({
  op: z.enum(TRANSFORM_OPS),
  template: z.string().optional(),
  path: z.string().optional(),
  separator: z.string().optional(),
});
export type TransformConfig = z.infer<typeof TransformConfigSchema>;

/**
 * How a knowledge base is searched (round 5 §2.1), shared by `SearchRequest` and the Retrieval
 * node's config (§2.4). Declared here rather than in `knowledge.ts` because that module imports
 * this one, and one definition is what keeps the node and the search from drifting.
 */
export const SEARCH_MODES = ['hybrid', 'vector', 'keyword'] as const;
export const SearchModeSchema = z.enum(SEARCH_MODES);
export type SearchMode = z.infer<typeof SearchModeSchema>;
export const DEFAULT_SEARCH_MODE: SearchMode = 'hybrid';

/** How many hits a search returns (§2.1, §2.4). */
export const SEARCH_K_MIN = 1;
export const SEARCH_K_MAX = 20;
export const DEFAULT_SEARCH_K = 5;
export const SearchKSchema = z.number().int().min(SEARCH_K_MIN).max(SEARCH_K_MAX);

/**
 * Round 5 §2.4. A missing `knowledgeBaseId` is pre-flight's `missing_knowledge_base`, not a parse
 * error, so a Retrieval node can be dropped on the Canvas before its base is chosen. Without a
 * `mode` the node searches the way a search does by default, `hybrid`.
 */
export const RetrievalConfigSchema = z.object({
  knowledgeBaseId: IdSchema.optional(),
  k: SearchKSchema.default(DEFAULT_SEARCH_K),
  mode: SearchModeSchema.optional(),
});
export type RetrievalConfig = z.infer<typeof RetrievalConfigSchema>;

export const GuardrailNodeConfigSchema = z.object({ policyId: IdSchema.optional() });
export type GuardrailNodeConfig = z.infer<typeof GuardrailNodeConfigSchema>;

export const CustomConfigSchema = z.object({ customNodeId: IdSchema.optional() });
export type CustomConfig = z.infer<typeof CustomConfigSchema>;

/** The union §2.4 calls `NodeConfig` — selected by the node's `kind`, never self-describing. */
export const NodeConfigSchema = z.union([
  InputConfigSchema,
  OutputConfigSchema,
  AgentConfigSchema,
  ModelConfigSchema,
  MergeConfigSchema,
  TransformConfigSchema,
  RetrievalConfigSchema,
  GuardrailNodeConfigSchema,
  CustomConfigSchema,
]);
export type NodeConfig = z.infer<typeof NodeConfigSchema>;

/** The config schema that belongs to one node kind. */
export const NODE_CONFIG_SCHEMA_BY_KIND = {
  input: InputConfigSchema,
  output: OutputConfigSchema,
  agent: AgentConfigSchema,
  model: ModelConfigSchema,
  merge: MergeConfigSchema,
  transform: TransformConfigSchema,
  retrieval: RetrievalConfigSchema,
  guardrail: GuardrailNodeConfigSchema,
  custom: CustomConfigSchema,
} as const;

/* -------------------------------------------------------------------------- */
/* Node and edge                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A node's Domain handle (D308): how a human message or an envelope addresses it. Optional — absent,
 * it defaults to a slug of the name (`rosterFor`). The pattern is `HANDLE_REGEX` in `domain.ts`,
 * repeated here because that module imports this one.
 */
export const NodeHandleSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/, 'a handle is a lowercase letter, then letters, digits or hyphens (32 at most)');

const nodeBase = {
  id: IdSchema,
  workflowId: IdSchema,
  name: NodeNameSchema,
  handle: NodeHandleSchema.optional(),
  position: PositionSchema,
  inputs: z.array(PortSchema),
  outputs: z.array(PortSchema),
};

/** `config` is discriminated by `kind` (§2.4), so the node itself is the discriminated union. */
export const NodeSchema = z.discriminatedUnion('kind', [
  z.object({ ...nodeBase, kind: z.literal('input'), config: InputConfigSchema }),
  z.object({ ...nodeBase, kind: z.literal('output'), config: OutputConfigSchema }),
  z.object({ ...nodeBase, kind: z.literal('agent'), config: AgentConfigSchema }),
  z.object({ ...nodeBase, kind: z.literal('model'), config: ModelConfigSchema }),
  z.object({ ...nodeBase, kind: z.literal('merge'), config: MergeConfigSchema }),
  z.object({ ...nodeBase, kind: z.literal('transform'), config: TransformConfigSchema }),
  z.object({ ...nodeBase, kind: z.literal('retrieval'), config: RetrievalConfigSchema }),
  z.object({ ...nodeBase, kind: z.literal('guardrail'), config: GuardrailNodeConfigSchema }),
  z.object({ ...nodeBase, kind: z.literal('custom'), config: CustomConfigSchema }),
]);
export type Node = z.infer<typeof NodeSchema>;

export const LOOP_ON_MAX = ['continue', 'fail'] as const;

const MAX_ITERATIONS_MESSAGE = 'must be a whole number from 1 to 50';

/**
 * What round 1 declared, worded for the loop edge editor (NFR-USE-03). The exit path grammar is
 * checked by `validateLoopConfig` when an edge is written, not here, so an edge stored before
 * round 3 still loads (NFR-VER-01, D73).
 */
export const LoopConfigSchema = z.object({
  maxIterations: z
    .number({ error: MAX_ITERATIONS_MESSAGE })
    .int(MAX_ITERATIONS_MESSAGE)
    .min(1, MAX_ITERATIONS_MESSAGE)
    .max(50, MAX_ITERATIONS_MESSAGE),
  exitCondition: z.object({
    path: z.string(),
    equals: z.union([z.string(), z.number(), z.boolean()], {
      error: 'must be a string, a number or true/false',
    }),
  }),
  onMax: z.enum(LOOP_ON_MAX, { error: 'must be continue or fail' }),
});
export type LoopConfig = z.infer<typeof LoopConfigSchema>;

/**
 * A dotted path into a node's json output: `verdict`, `review.verdict`, `issues.0` or `issues[0]`.
 * A subset of what the engine's path reader resolves — no leading index, no dashed or non-ASCII
 * keys, no JSONPath `$.` — so a path the editor accepts is always one the loop can read
 * (§2.4, D73).
 */
export const DOTTED_PATH_REGEX = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+|\[\d+\])*$/;
export const DottedPathSchema = z
  .string()
  .regex(DOTTED_PATH_REGEX, 'must be a dotted path such as verdict or review.issues.0');

/** A loop edge's config on the way in: `LoopConfig`, with an exit path the engine can read. */
const LoopEdgeConfigSchema = LoopConfigSchema.extend({
  exitCondition: LoopConfigSchema.shape.exitCondition.extend({ path: DottedPathSchema }),
});

/** Why a loop ended, recorded on its last iteration's node run as `loopStop` (§2.4, FR-GRD-009). */
export const LOOP_STOP_REASONS = ['exit_condition', 'max_iterations', 'repeated_output'] as const;
export const LoopStopReasonSchema = z.enum(LOOP_STOP_REASONS);
export type LoopStopReason = z.infer<typeof LoopStopReasonSchema>;

const EdgeEndpointSchema = z.object({ nodeId: IdSchema, portId: PortIdSchema });
export type EdgeEndpoint = z.infer<typeof EdgeEndpointSchema>;

export const EdgeSchema = z.object({
  id: IdSchema,
  workflowId: IdSchema,
  kind: EdgeKindSchema,
  from: EdgeEndpointSchema,
  to: EdgeEndpointSchema,
  loop: LoopConfigSchema.optional(),
});
export type Edge = z.infer<typeof EdgeSchema>;

/* -------------------------------------------------------------------------- */
/* Loop edges (round 3 §2.4, FR-CON-003, FR-CON-007, BR-05)                    */
/* -------------------------------------------------------------------------- */

/** Why `validateLoopConfig` refused an edge. Each is also a validation issue code. */
export const LOOP_REFUSAL_CODES = [
  'loop_config_missing',
  'loop_config_on_data_edge',
  'invalid_loop_config',
  'loop_source_not_json',
  'loop_target_not_upstream',
  'loop_bodies_overlap',
] as const;
export type LoopRefusalCode = (typeof LOOP_REFUSAL_CODES)[number];

export type LoopConfigCheck =
  | { ok: true }
  | { ok: false; code: LoopRefusalCode; reason: string };

/**
 * What `validateLoopConfig` reads of a graph: node outputs, which way the data edges run, and the
 * other loop edges.
 */
export interface LoopGraph {
  /** `config` is read only for an output contract's schema, which makes a node's answer JSON (D353). */
  nodes: readonly (Pick<Node, 'id' | 'name' | 'outputs'> & { config?: unknown })[];
  edges: readonly Pick<Edge, 'id' | 'kind' | 'from' | 'to'>[];
}

const refuse = (code: LoopRefusalCode, reason: string): LoopConfigCheck => ({
  ok: false,
  code,
  reason,
});

/** True when a path of data edges runs from `from` to `to`. Loop edges never count (BR-05). */
function reaches(from: Id, to: Id, edges: LoopGraph['edges']): boolean {
  const next = new Map<Id, Id[]>();
  for (const edge of edges) {
    if (edge.kind !== 'data') continue;
    next.set(edge.from.nodeId, [...(next.get(edge.from.nodeId) ?? []), edge.to.nodeId]);
  }

  const seen = new Set<Id>();
  const queue = [...(next.get(from) ?? [])];
  for (let i = 0; i < queue.length; i += 1) {
    const id = queue[i];
    if (id === undefined || seen.has(id)) continue;
    if (id === to) return true;
    seen.add(id);
    queue.push(...(next.get(id) ?? []));
  }
  return false;
}

/** Every node reachable from `start` along `next`, `start` included. */
function walk(start: Id, next: ReadonlyMap<Id, readonly Id[]>): Set<Id> {
  const seen = new Set<Id>([start]);
  const queue: Id[] = [start];
  // The queue grows while it is read, so this visits every reachable node once, breadth first.
  for (const current of queue) {
    for (const id of next.get(current) ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push(id);
    }
  }
  return seen;
}

/**
 * The nodes a loop edge repeats: every node on a data path from its target back to its source,
 * both included. One definition, so the engine's scheduler and the Canvas agree on what an
 * iteration re-runs (D84).
 */
export function loopBody(edge: Pick<Edge, 'from' | 'to'>, edges: LoopGraph['edges']): Set<Id> {
  const forward = new Map<Id, Id[]>();
  const backward = new Map<Id, Id[]>();
  for (const each of edges) {
    if (each.kind !== 'data') continue;
    forward.set(each.from.nodeId, [...(forward.get(each.from.nodeId) ?? []), each.to.nodeId]);
    backward.set(each.to.nodeId, [...(backward.get(each.to.nodeId) ?? []), each.from.nodeId]);
  }

  const fromTarget = walk(edge.to.nodeId, forward);
  const toSource = walk(edge.from.nodeId, backward);
  return new Set([...fromTarget].filter((id) => toSource.has(id)));
}

/**
 * Decide whether an edge may exist as drawn, as far as loops are concerned (§2.4). Pure — the
 * engine's graph-ops and the Canvas's loop edge editor must reach the same verdict.
 *
 * A loop edge carries a loop config whose exit path is a dotted path, starts at a node with a json
 * output for that path to read, and leads back to a node strictly upstream along data edges — so
 * never onto itself. No node may sit in two loop bodies, because a node run has one iteration
 * number to count with (D84). A data edge carries no loop config at all.
 *
 * `isConnectionAllowed` does not apply to a loop edge (D73). It is not a data connection: its
 * target's inputs are already fed, and the §1 demo's Reviewer sends json back into the Writer's
 * text input. The loop edge re-queues its target for the next iteration instead.
 */
export function validateLoopConfig(
  edge: Pick<Edge, 'id' | 'kind' | 'from' | 'to' | 'loop'>,
  graph: LoopGraph,
): LoopConfigCheck {
  if (edge.kind !== 'loop') {
    return edge.loop === undefined
      ? { ok: true }
      : refuse(
          'loop_config_on_data_edge',
          'A data edge cannot carry a loop config — make it a loop edge instead.',
        );
  }

  if (edge.loop === undefined) {
    return refuse(
      'loop_config_missing',
      'A loop edge needs max iterations, an exit condition and what to do at the maximum.',
    );
  }

  const parsed = LoopEdgeConfigSchema.safeParse(edge.loop);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const where = issue.path.length === 0 ? 'config' : issue.path.map(String).join('.');
      return `${where}: ${issue.message}`;
    });
    return refuse('invalid_loop_config', `Loop ${problems.join('; ')}.`);
  }

  const source = graph.nodes.find((node) => node.id === edge.from.nodeId);
  // D353: a schema on the source makes its answer JSON, so a Review→Fix loop needs no json port.
  if (source === undefined || !hasJsonOutput(source)) {
    const name = source === undefined ? 'The loop source' : `"${source.name}"`;
    return refuse(
      'loop_source_not_json',
      `${name} has no json output for the loop's exit condition to read.`,
    );
  }

  if (!reaches(edge.to.nodeId, edge.from.nodeId, graph.edges)) {
    return refuse(
      'loop_target_not_upstream',
      `A loop edge must lead back to a node upstream of "${source.name}".`,
    );
  }

  const body = loopBody(edge, graph.edges);
  for (const other of graph.edges) {
    if (other.kind !== 'loop' || other.id === edge.id) continue;
    const shared = [...loopBody(other, graph.edges)].filter((id) => body.has(id));
    if (shared.length === 0) continue;

    const names = shared
      .map((id) => `"${graph.nodes.find((node) => node.id === id)?.name ?? id}"`)
      .join(', ');
    return refuse(
      'loop_bodies_overlap',
      `This loop would repeat ${names}, which another loop already repeats; ` +
        'a node can belong to one loop only.',
    );
  }

  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* The standard review contract (round 3 §2.4, FR-PAR-004, FR-PAR-007)         */
/* -------------------------------------------------------------------------- */

export const REVIEW_VERDICTS = ['approved', 'changes_requested'] as const;
export const REVIEW_SCORE_MIN = 0;
export const REVIEW_SCORE_MAX = 10;

/**
 * `ReviewContract`. Extra keys are allowed: `mock-reject-twice` echoes its prompt beside these.
 */
export const ReviewContractSchema = z.object({
  score: z.number().min(REVIEW_SCORE_MIN).max(REVIEW_SCORE_MAX),
  verdict: z.enum(REVIEW_VERDICTS),
  issues: z.array(z.string()),
});
export type ReviewContract = z.infer<typeof ReviewContractSchema>;

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/**
 * `ReviewContract` as a JSON Schema, ready to drop into an agent's `outputContract.jsonSchema`, so
 * a review is checked by `validateAgainstContract` like any other output (FR-PAR-007) and a loop
 * can exit on `verdict` (FR-PAR-004). Written in the D53 subset plus `minimum`/`maximum` (D74), and
 * frozen all the way down: one agent's contract can never change it for the next.
 */
export const REVIEW_CONTRACT_SCHEMA = deepFreeze({
  type: 'object',
  required: ['score', 'verdict', 'issues'],
  properties: {
    score: { type: 'number', minimum: REVIEW_SCORE_MIN, maximum: REVIEW_SCORE_MAX },
    verdict: { type: 'string', enum: [...REVIEW_VERDICTS] },
    issues: { type: 'array', items: { type: 'string' } },
  },
} as const);

/* -------------------------------------------------------------------------- */
/* Port derivation (FR-NODE-006, §2.4)                                         */
/* -------------------------------------------------------------------------- */

/** Distributes `Pick` over the node union so `kind` still narrows `config`. */
type DistributivePick<T, K extends keyof T> = T extends unknown ? Pick<T, K> : never;

/** What `derivePorts` needs: a node, or a node about to be created (which has no ports yet). */
export type NodePortSource = DistributivePick<Node, 'id' | 'kind' | 'config'>;

export interface DerivedPorts {
  inputs: Port[];
  outputs: Port[];
}

/** The types an `output` node accepts, in the order §2.4 lists them. */
export const OUTPUT_NODE_INPUT_TYPES = [
  'text',
  'json',
  'image',
  'audio',
  'video',
  'code',
  'file',
] as const satisfies readonly DataType[];

function inPort(nodeId: Id, name: string, dataType: DataType, multi: boolean): Port {
  return { id: portId(nodeId, 'in', name), name, dataType, multi };
}

/** Output ports feed many edges (D22, FR-CON-005 fan-out), so they are always `multi: true`. */
function outPort(nodeId: Id, name: string, dataType: DataType): Port {
  return { id: portId(nodeId, 'out', name), name, dataType, multi: true };
}

const TRANSFORM_PORTS = {
  template: { in: { dataType: 'json', multi: false }, out: 'text' },
  extract_json_field: { in: { dataType: 'json', multi: false }, out: 'json' },
  join: { in: { dataType: 'text', multi: true }, out: 'text' },
} as const satisfies Record<
  (typeof TRANSFORM_OPS)[number],
  { in: { dataType: DataType; multi: boolean }; out: DataType }
>;

/**
 * Derive a node's ports from its kind and config (FR-NODE-006). Pure: same config in, same ports
 * out, byte for byte. Port names are the data type for type-derived ports (D18), which keeps a
 * port id stable when `outputTypes` is reordered or an earlier entry is removed.
 *
 * `guardrail` and `custom` get no ports until the round that defines them (D19); `retrieval` got
 * its two in round 5 (§2.4).
 */
export function derivePorts(node: NodePortSource): DerivedPorts {
  const { id } = node;

  switch (node.kind) {
    case 'input':
      return {
        inputs: [],
        outputs: node.config.outputTypes.map((t) => outPort(id, t, t)),
      };

    case 'output':
      return {
        inputs: OUTPUT_NODE_INPUT_TYPES.map((t) => inPort(id, t, t, false)),
        outputs: [],
      };

    case 'agent':
    case 'model':
      return {
        inputs: node.config.inputTypes.map((t) => inPort(id, t, t, false)),
        outputs: node.config.outputTypes.map((t) => outPort(id, t, t)),
      };

    case 'merge':
      return {
        inputs: [inPort(id, 'in', 'text', true), inPort(id, 'in_json', 'json', true)],
        outputs: [outPort(id, 'out', 'json')],
      };

    case 'transform': {
      const spec = TRANSFORM_PORTS[node.config.op];
      return {
        inputs: [inPort(id, 'in', spec.in.dataType, spec.in.multi)],
        outputs: [outPort(id, 'out', spec.out)],
      };
    }

    /* Round 5 §2.4: one text query in, `{ hits: SearchHit[] }` out as json (FR-RAG-006). */
    case 'retrieval':
      return {
        inputs: [inPort(id, 'query', 'text', false)],
        outputs: [outPort(id, 'out', 'json')],
      };

    case 'guardrail':
    case 'custom':
      return { inputs: [], outputs: [] };
  }
}
