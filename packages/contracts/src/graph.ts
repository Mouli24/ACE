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

const EntityNameSchema = z.string().min(1).max(120);
const NodeNameSchema = z.string().min(1).max(80);

/* -------------------------------------------------------------------------- */
/* Project and workflow                                                        */
/* -------------------------------------------------------------------------- */

export const ProjectSchema = z.object({
  id: IdSchema,
  name: EntityNameSchema,
  folderPath: z.string(),
  lastOpenedAt: TimestampSchema.optional(),
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
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

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

export const RetrievalConfigSchema = z.object({
  knowledgeBaseId: IdSchema.optional(),
  k: z.number().int().min(1).max(20),
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

const nodeBase = {
  id: IdSchema,
  workflowId: IdSchema,
  name: NodeNameSchema,
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
export const LoopConfigSchema = z.object({
  maxIterations: z.number().int().min(1).max(50),
  exitCondition: z.object({
    path: z.string(),
    equals: z.union([z.string(), z.number(), z.boolean()]),
  }),
  onMax: z.enum(LOOP_ON_MAX),
});
export type LoopConfig = z.infer<typeof LoopConfigSchema>;

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
 * `retrieval`, `guardrail` and `custom` get no ports until the round that defines them (D19).
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

    case 'retrieval':
    case 'guardrail':
    case 'custom':
      return { inputs: [], outputs: [] };
  }
}
