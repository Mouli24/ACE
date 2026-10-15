import { createHash } from 'node:crypto';

import {
  AgentConfigSchema,
  OUTPUT_NODE_INPUT_TYPES,
  derivePorts,
  portId,
  type BenchModelRef,
  type BenchTask,
  type DataType,
  type Edge,
  type Id,
  type Model,
  type Node,
  type Part,
  type RunSnapshot,
} from '@ace/contracts';

/**
 * Arm B and the fairness rules of ACE Bench (PG-5.6, `ace-bench-plan.md` "Concepts").
 *
 * Pure functions: the bench service reads the workflow and the catalog, these turn them into the
 * snapshots each arm runs.
 */

/** JSON with object keys sorted at every depth, so equal values always hash equal. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** FR-BEN-002: the hash a frozen task keeps — over exactly what a run of it reads. */
export function taskContentHash(task: Pick<BenchTask, 'name' | 'prompt' | 'inputs' | 'rubric'>) {
  return sha256(
    canonicalJson({
      name: task.name,
      prompt: task.prompt,
      inputs: task.inputs,
      rubric: task.rubric,
    }),
  );
}

/**
 * Arch §14: bench runs force **Fixed** routing — no fallback, no cost or latency picks — so the
 * model each node was configured with is the model that answers, in both arms.
 */
export function forceFixedRouting(nodes: readonly Node[]): Node[] {
  return nodes.map((node) =>
    node.kind === 'agent'
      ? {
          ...node,
          config: { ...node.config, routing: { policy: 'fixed', fallbackModelIds: [] } },
        }
      : node,
  );
}

/** The models arm A's agent and model nodes name, in graph order, without repeats. */
export function modelsOf(nodes: readonly Node[]): BenchModelRef[] {
  const seen = new Set<string>();
  const refs: BenchModelRef[] = [];
  for (const node of nodes) {
    if (node.kind !== 'agent' && node.kind !== 'model') continue;
    const { providerId, modelId } = node.config;
    if (providerId === undefined || modelId === undefined || modelId === '') continue;
    const key = `${providerId}\u0000${modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ providerId, modelId });
  }
  return refs;
}

/**
 * "A's strongest model" (owner's answer 1): among the models arm A uses, the one the catalog prices
 * highest per token (input + output per 1k) — price is the one capability signal every provider's
 * catalog carries — then the larger context window, then tool support. A model missing from the
 * catalog ranks last; with no catalog rows at all, the first model A names.
 */
export function strongestModel(
  nodes: readonly Node[],
  catalog: readonly Model[],
): BenchModelRef | undefined {
  const refs = modelsOf(nodes);
  if (refs.length === 0) return undefined;

  const rowOf = (ref: BenchModelRef) =>
    catalog.find((model) => model.providerId === ref.providerId && model.modelId === ref.modelId);
  const rank = (ref: BenchModelRef): [number, number, number, number] => {
    const row = rowOf(ref);
    if (row === undefined) return [0, -1, -1, 0];
    const price = row.pricing === undefined ? -1 : row.pricing.inputPer1k + row.pricing.outputPer1k;
    return [1, price, row.contextWindow, row.supportsTools ? 1 : 0];
  };

  let best = refs[0]!;
  let bestRank = rank(best);
  for (const ref of refs.slice(1)) {
    const candidate = rank(ref);
    for (let i = 0; i < candidate.length; i += 1) {
      if (candidate[i]! === bestRank[i]!) continue;
      if (candidate[i]! > bestRank[i]!) {
        best = ref;
        bestRank = candidate;
      }
      break;
    }
  }
  return best;
}

/** What every arm-B agent is told: the task is in its input, and it works alone. */
export const BASELINE_INSTRUCTIONS =
  'You are working alone. Complete the task given in your input in full, using the tools you ' +
  'have when they help. Answer with the finished result.';

const TEXT: DataType = 'text';

/** The data types a run's Input node must hand on: A's Input types, every task's parts, and text. */
function inputTypesFor(nodes: readonly Node[], tasks: readonly BenchTask[]): DataType[] {
  const types = new Set<DataType>([TEXT]);
  for (const node of nodes) {
    if (node.kind === 'input') for (const type of node.config.outputTypes) types.add(type);
  }
  for (const task of tasks) for (const part of task.inputs) types.add(part.type);
  return [...types];
}

/** What arm A hands its Output nodes: the data types of the edges that reach them. */
function outputTypesFor(nodes: readonly Node[], edges: readonly Edge[]): DataType[] {
  const outputs = new Set(nodes.filter((node) => node.kind === 'output').map((node) => node.id));
  const types = new Set<DataType>();
  for (const edge of edges) {
    if (edge.kind !== 'data' || !outputs.has(edge.to.nodeId)) continue;
    const source = nodes.find((node) => node.id === edge.from.nodeId);
    const port = source?.outputs.find((candidate) => candidate.id === edge.from.portId);
    if (
      port !== undefined &&
      (OUTPUT_NODE_INPUT_TYPES as readonly string[]).includes(port.dataType)
    )
      types.add(port.dataType);
  }
  return types.size === 0 ? [TEXT] : [...types];
}

/**
 * Arm B (the plan's "Concepts"): Input → one Agent → Output, never saved as a workflow. The Agent
 * runs on `model`, with the union of every tool arm A's agents enable (the largest tool-call
 * allowance and every allowed domain among them), the most generous token and time limits arm A
 * gives any agent, and no policy of its own — so A's project policy, and with it A's budget caps,
 * applies to it exactly as to A. `workflowId` is A's, so the run belongs to the same project.
 */
export function baselineSnapshot(input: {
  armA: RunSnapshot;
  tasks: readonly BenchTask[];
  model: BenchModelRef;
  workflowId: Id;
  newId: () => Id;
}): RunSnapshot {
  const { armA, model, workflowId, newId } = input;
  const agents = armA.nodes.filter((node) => node.kind === 'agent');

  const enabled = new Set<string>();
  const domains = new Set<string>();
  let maxToolCalls = 0;
  let maxTokens = 0;
  let timeoutMs = 0;
  for (const agent of agents) {
    for (const tool of agent.config.tools.enabled) enabled.add(tool);
    for (const domain of agent.config.tools.allowedDomains) domains.add(domain);
    maxToolCalls = Math.max(maxToolCalls, agent.config.tools.maxToolCalls);
    maxTokens = Math.max(maxTokens, agent.config.execution.maxTokens);
    timeoutMs = Math.max(timeoutMs, agent.config.execution.timeoutMs);
  }

  const inputTypes = inputTypesFor(armA.nodes, input.tasks);
  const outputTypes = outputTypesFor(armA.nodes, armA.edges);

  const build = <N extends Node>(draft: Omit<N, 'inputs' | 'outputs'>): N => {
    const ports = derivePorts(draft as Parameters<typeof derivePorts>[0]);
    return { ...draft, inputs: ports.inputs, outputs: ports.outputs } as N;
  };

  const inputNode = build<Extract<Node, { kind: 'input' }>>({
    id: newId(),
    workflowId,
    name: 'Task',
    position: { x: 80, y: 80 },
    kind: 'input',
    config: { artifactIds: [], outputTypes: inputTypes },
  });
  const agentNode = build<Extract<Node, { kind: 'agent' }>>({
    id: newId(),
    workflowId,
    name: 'Baseline',
    position: { x: 400, y: 80 },
    kind: 'agent',
    config: AgentConfigSchema.parse({
      providerId: model.providerId,
      modelId: model.modelId,
      routing: { policy: 'fixed', fallbackModelIds: [] },
      instructions: BASELINE_INSTRUCTIONS,
      inputTypes,
      outputTypes,
      ...(maxTokens > 0 || timeoutMs > 0
        ? {
            execution: {
              ...(maxTokens > 0 ? { maxTokens } : {}),
              ...(timeoutMs > 0 ? { timeoutMs } : {}),
            },
          }
        : {}),
      tools: {
        enabled: [...enabled],
        maxToolCalls: enabled.size === 0 ? 0 : Math.max(maxToolCalls, 1),
        allowedDomains: [...domains],
      },
    }),
  });
  const outputNode = build<Extract<Node, { kind: 'output' }>>({
    id: newId(),
    workflowId,
    name: 'Result',
    position: { x: 720, y: 80 },
    kind: 'output',
    config: {},
  });

  const edge = (from: Node, to: Node, type: DataType): Edge => ({
    id: newId(),
    workflowId,
    kind: 'data',
    from: { nodeId: from.id, portId: portId(from.id, 'out', type) },
    to: { nodeId: to.id, portId: portId(to.id, 'in', type) },
  });

  return {
    version: armA.version,
    nodes: [inputNode, agentNode, outputNode],
    edges: [
      ...inputTypes.map((type) => edge(inputNode, agentNode, type)),
      ...outputTypes.map((type) => edge(agentNode, outputNode, type)),
    ],
  };
}

/** Same inputs in both arms: every Input node reads the task's prompt, then its input parts. */
export function runInputsFor(snapshot: RunSnapshot, task: BenchTask): Record<Id, Part[]> {
  const parts: Part[] = [{ type: 'text', text: task.prompt }, ...task.inputs];
  return Object.fromEntries(
    snapshot.nodes
      .filter((node) => node.kind === 'input')
      .map((node): [Id, Part[]] => [node.id, parts.map((part) => ({ ...part }))]),
  );
}
