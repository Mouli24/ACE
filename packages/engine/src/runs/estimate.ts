import {
  loopBody,
  providerGroup,
  type CostRange,
  type Edge,
  type EstimateBudget,
  type Id,
  type Model,
  type ModelPricing,
  type Node,
  type NodeEstimate,
  type Provider,
  type Workflow,
  type WorkflowEstimate,
} from "@ace/contracts";

import { estimateTokens } from "../envelopes/index.js";
import { UNPRICED_TABLE, estimateCostUsd } from "./cost.js";

/**
 * Cost before you run (PG-4.3). A pure read of the graph and the catalogue: no provider is called
 * and nothing is written.
 *
 * Per Agent or Model node:
 *
 * - **min** — the prompt that is already known (system base, the node's instructions, the text of
 *   the Input nodes that feed it directly) at input prices, and no output.
 * - **max** — that prompt plus the most its reads can bring (each upstream model node's whole
 *   `maxTokens`, an Input's text, an Agent's whole context budget), and its own whole `maxTokens` of
 *   output, for every call it may make: one per tool round it is allowed (`maxToolCalls` + 1 when it
 *   has tools) and one per loop iteration of a loop it sits in. Retries are not counted.
 *
 * The cost rule is `usageFor`'s (D359, PG-1.4): a local model is $0 by rule, so is the test
 * provider without a price; an unpriced remote model, a node with no model chosen, or a model the
 * catalogue does not hold is **unknown** and adds nothing to the sums.
 */

/** What the system base and the output contract add to every prompt, roughly (Arch §12.5). */
export const PROMPT_OVERHEAD_TOKENS = 200;

/** The engine's own estimate, characters ÷ 4 (Arch §24). */
const tokensOf = (text: string | undefined): number =>
  text === undefined ? 0 : estimateTokens(text);

function isModelNode(
  node: Node,
): node is Extract<Node, { kind: "agent" | "model" }> {
  return node.kind === "agent" || node.kind === "model";
}

/** How many times each node may run once over the loops it sits in (FR-CON-003). */
function iterationsByNode(edges: readonly Edge[]): Map<Id, number> {
  const times = new Map<Id, number>();
  for (const edge of edges) {
    if (edge.kind !== "loop" || edge.loop === undefined) continue;
    for (const nodeId of loopBody(edge, edges)) {
      times.set(nodeId, (times.get(nodeId) ?? 1) * edge.loop.maxIterations);
    }
  }
  return times;
}

export interface EstimateInput {
  workflow: Pick<Workflow, "id" | "version">;
  nodes: readonly Node[];
  edges: readonly Edge[];
  catalog: readonly Model[];
  providers: readonly Pick<Provider, "id" | "type" | "baseUrl">[];
  budget: EstimateBudget;
}

export function estimateWorkflow(input: EstimateInput): WorkflowEstimate {
  const nodeById = new Map(input.nodes.map((node) => [node.id, node]));
  const providerById = new Map(
    input.providers.map((provider) => [provider.id, provider]),
  );
  const iterations = iterationsByNode(input.edges);

  const upstreamOf = (nodeId: Id): Node[] =>
    input.edges
      .filter((edge) => edge.kind === "data" && edge.to.nodeId === nodeId)
      .flatMap((edge) => {
        const from = nodeById.get(edge.from.nodeId);
        return from === undefined ? [] : [from];
      });

  const nodes: NodeEstimate[] = [];
  for (const node of input.nodes) {
    if (!isModelNode(node)) continue;
    const config = node.config;
    const cap =
      config.execution.maxCostUsd === undefined ||
      config.execution.maxCostUsd === null
        ? {}
        : { maxCostUsd: config.execution.maxCostUsd };
    const unknown = (reason: NodeEstimate["reason"]): NodeEstimate => ({
      nodeId: node.id,
      minUsd: 0,
      maxUsd: 0,
      unknown: true,
      ...(reason === undefined ? {} : { reason }),
      ...cap,
    });
    const free: NodeEstimate = {
      nodeId: node.id,
      minUsd: 0,
      maxUsd: 0,
      unknown: false,
      free: true,
      ...cap,
    };

    if (
      config.providerId === undefined ||
      config.modelId === undefined ||
      config.modelId === ""
    ) {
      nodes.push(unknown("no_model"));
      continue;
    }
    const provider = providerById.get(config.providerId);
    if (provider === undefined) {
      nodes.push(unknown("model_missing"));
      continue;
    }
    const group = providerGroup(provider);
    if (group === "local") {
      nodes.push(free);
      continue;
    }
    const row = input.catalog.find(
      (model) =>
        model.providerId === config.providerId &&
        model.modelId === config.modelId,
    );
    const pricing: ModelPricing | undefined = row?.pricing;
    const noPrice =
      pricing === undefined || pricing.priceTableVersion === UNPRICED_TABLE;
    if (noPrice) {
      if (group === "mock") nodes.push(free);
      else
        nodes.push(unknown(row === undefined ? "model_missing" : "unpriced"));
      continue;
    }

    const agent = node.kind === "agent" ? node.config : undefined;
    const ownText =
      node.kind === "agent"
        ? node.config.instructions
        : node.config.systemPrompt;
    const upstream = upstreamOf(node.id);
    const inputText = upstream.reduce(
      (sum, from) =>
        from.kind === "input" ? sum + tokensOf(from.config.text) : sum,
      0,
    );
    const minIn = PROMPT_OVERHEAD_TOKENS + tokensOf(ownText) + inputText;
    const readsMax = upstream.reduce(
      (sum, from) =>
        isModelNode(from) ? sum + from.config.execution.maxTokens : sum,
      0,
    );
    const contextMax =
      agent === undefined ? 0 : agent.contextPolicy.budgetTokens;
    const maxIn = minIn + readsMax + contextMax;
    const maxOut = config.execution.maxTokens;
    const toolRounds =
      agent !== undefined && agent.tools.enabled.length > 0
        ? agent.tools.maxToolCalls + 1
        : 1;
    const calls = toolRounds * (iterations.get(node.id) ?? 1);

    nodes.push({
      nodeId: node.id,
      minUsd: estimateCostUsd(minIn, 0, pricing),
      maxUsd: calls * estimateCostUsd(maxIn, maxOut, pricing),
      unknown: false,
      ...cap,
    });
  }

  const total: CostRange = nodes.reduce<CostRange>(
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
