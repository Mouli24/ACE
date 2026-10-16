import {
  loopBody,
  providerGroup,
  type CostRange,
  type Edge,
  type EstimateBudget,
  type Model,
  type Node,
  type NodeEstimate,
  type Provider,
  type Workflow,
  type WorkflowEstimate,
} from '@ace/contracts';

/**
 * `POST /workflows/:id/estimate` for the mock engine (PG-4.3), with the engine's rules
 * (`packages/engine/src/runs/estimate.ts`): min is the known prompt at input prices, max every call's
 * whole `maxTokens` plus what its reads and context can bring, times tool rounds and loop
 * iterations; local is $0, the test provider without a price $0, an unpriced remote model or a node
 * with no model unknown.
 */

const OVERHEAD = 200;
const tokens = (text: string | undefined): number => (text ? Math.ceil(text.length / 4) : 0);
const cost = (tokensIn: number, tokensOut: number, model: Model): number =>
  model.pricing === undefined
    ? 0
    : (tokensIn / 1000) * model.pricing.inputPer1k + (tokensOut / 1000) * model.pricing.outputPer1k;

export function estimateMockWorkflow(input: {
  workflow: Workflow;
  nodes: readonly Node[];
  edges: readonly Edge[];
  models: readonly Model[];
  providers: readonly Provider[];
  budget: EstimateBudget;
}): WorkflowEstimate {
  const byId = new Map(input.nodes.map((node) => [node.id, node]));
  const times = new Map<string, number>();
  for (const edge of input.edges) {
    if (edge.kind !== 'loop' || edge.loop === undefined) continue;
    for (const id of loopBody(edge, input.edges))
      times.set(id, (times.get(id) ?? 1) * edge.loop.maxIterations);
  }

  const nodes: NodeEstimate[] = [];
  for (const node of input.nodes) {
    if (node.kind !== 'agent' && node.kind !== 'model') continue;
    const config = node.config;
    const capUsd = config.execution.maxCostUsd;
    const cap = capUsd === undefined || capUsd === null ? {} : { maxCostUsd: capUsd };
    const base = { nodeId: node.id, minUsd: 0, maxUsd: 0, ...cap };
    const provider = input.providers.find((p) => p.id === config.providerId);
    if (!config.providerId || !config.modelId) {
      nodes.push({ ...base, unknown: true, reason: 'no_model' });
      continue;
    }
    if (provider === undefined) {
      nodes.push({ ...base, unknown: true, reason: 'model_missing' });
      continue;
    }
    const group = providerGroup(provider);
    const model = input.models.find(
      (m) => m.providerId === config.providerId && m.modelId === config.modelId,
    );
    if (group === 'local' || (group === 'mock' && model?.pricing === undefined)) {
      nodes.push({ ...base, unknown: false, free: true });
      continue;
    }
    if (model?.pricing === undefined || model.pricing.priceTableVersion === 'unpriced') {
      nodes.push({ ...base, unknown: true, reason: model ? 'unpriced' : 'model_missing' });
      continue;
    }
    const upstream = input.edges
      .filter((edge) => edge.kind === 'data' && edge.to.nodeId === node.id)
      .map((edge) => byId.get(edge.from.nodeId))
      .filter((from): from is Node => from !== undefined);
    const own = node.kind === 'agent' ? node.config.instructions : node.config.systemPrompt;
    const inputText = upstream.reduce(
      (sum, from) => (from.kind === 'input' ? sum + tokens(from.config.text) : sum),
      0,
    );
    const minIn = OVERHEAD + tokens(own) + inputText;
    const reads = upstream.reduce(
      (sum, from) =>
        from.kind === 'agent' || from.kind === 'model'
          ? sum + from.config.execution.maxTokens
          : sum,
      0,
    );
    const context = node.kind === 'agent' ? node.config.contextPolicy.budgetTokens : 0;
    const rounds =
      node.kind === 'agent' && node.config.tools.enabled.length > 0
        ? node.config.tools.maxToolCalls + 1
        : 1;
    const calls = rounds * (times.get(node.id) ?? 1);
    nodes.push({
      ...base,
      unknown: false,
      minUsd: cost(minIn, 0, model),
      maxUsd: calls * cost(minIn + reads + context, config.execution.maxTokens, model),
    });
  }

  const total = nodes.reduce<CostRange>(
    (sum, each) => ({
      minUsd: sum.minUsd + each.minUsd,
      maxUsd: sum.maxUsd + each.maxUsd,
      unknown: sum.unknown || each.unknown,
    }),
    { minUsd: 0, maxUsd: 0, unknown: false },
  );
  return {
    workflowId: input.workflow.id,
    workflowVersion: input.workflow.version,
    nodes,
    total,
    budget: input.budget,
  };
}
