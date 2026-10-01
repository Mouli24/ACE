import type {
  DataType,
  Edge,
  Id,
  McpServer,
  Model,
  Node,
  NodeKind,
  Part,
  Provider,
  ProviderCheckResult,
  ValidationIssue,
} from '@ace/contracts';

import { validateGraph, type ToolLookup } from '../graph/validate.js';
import { findUnknownPlaceholders } from '../prompts/index.js';

/**
 * Pre-flight (FR-EXE-003, round 2 §2.7, BR-08).
 *
 * Runs before a single token is spent. Every check it can make is made, so the user sees the
 * whole list at once rather than fixing one problem to discover the next; any issue at all means
 * the run is recorded as `BLOCKED` with **zero** `generate()` calls.
 *
 * Provider `check()` is the one thing here that touches the network, and it is deliberately not
 * a generation: knowing the provider answers is what turns "the model might work" into "the run
 * can start".
 */

/**
 * Node kinds the executor can run. The rest are refused until their round lands — `merge` joined in
 * round 3, when the scheduler learned to wait for its inputs (FR-PAR-002).
 */
export const SUPPORTED_NODE_KINDS: readonly NodeKind[] = [
  'input',
  'agent',
  'model',
  'merge',
  'transform',
  'output',
];

export interface PreflightInput {
  nodes: readonly Node[];
  edges: readonly Edge[];
  /** What `StartRunRequest.inputs` supplied, keyed by Input node id. */
  inputs: Record<Id, Part[]>;
  providers: readonly Provider[];
  models: readonly Model[];
  checkProvider: (providerId: Id) => Promise<ProviderCheckResult>;
  /**
   * The data types of the artifacts an Input node attaches (round 4 §2.1), by artifact id — a `.png`
   * is `image`, an `.mp3` `audio`, and so on. Supplied by the gateway from the artifact store; absent
   * (round 2/3 harnesses, a text-only run) the multimodal capability check simply does not run.
   */
  artifactTypesFor?: (artifactIds: readonly Id[]) => Promise<DataType[]>;
  /**
   * The tool registry every agent's `tools.enabled` is checked against (round 4 §2.4, D-069): a name
   * it does not hold is `tool_not_registered` and blocks the run. The run service's `ToolProvider`
   * (`deps.tools`) is exactly this. Absent (round 2/3 harnesses), the check does not run.
   */
  tools?: ToolLookup;
  /** The known MCP servers: a registered tool on an `unreachable` one is `mcp_server_unreachable`. */
  mcpServers?: readonly McpServer[];
}

/** An Input node has something to start from when its config or the request carries content. */
function hasInput(node: Extract<Node, { kind: 'input' }>, supplied: Part[] | undefined): boolean {
  if (node.config.text !== undefined && node.config.text !== '') return true;
  if (node.config.artifactIds.length > 0) return true;
  return supplied !== undefined && supplied.length > 0;
}

export async function preflight(input: PreflightInput): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];

  /*
   * 1. Everything `validate` already knows, including the provider and catalog checks and — given
   *    the registry — the tool checks of round 4 §2.4. Its errors block the run; of its warnings only
   *    `mcp_server_unreachable` is a pre-flight matter (the run starts, and says why a tool may fail).
   */
  issues.push(
    ...validateGraph(input.nodes, input.edges, {
      providers: input.providers,
      models: input.models,
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      ...(input.mcpServers === undefined ? {} : { mcpServers: input.mcpServers }),
    }).filter((issue) => issue.severity === 'error' || issue.code === 'mcp_server_unreachable'),
  );

  const providersById = new Map(input.providers.map((provider) => [provider.id, provider]));

  /* 2. Every provider a node actually uses has to answer, now — not when it was last checked. */
  const used = new Set<Id>();
  for (const node of input.nodes) {
    if (node.kind !== 'agent' && node.kind !== 'model') continue;
    const { providerId } = node.config;
    if (providerId !== undefined && providersById.has(providerId)) used.add(providerId);
  }

  for (const providerId of used) {
    const result = await input.checkProvider(providerId);
    if (result.status === 'CONNECTED') continue;

    const provider = providersById.get(providerId);
    issues.push({
      severity: 'error',
      code: 'provider_unreachable',
      message:
        `Provider "${provider?.name ?? providerId}" is ${result.status}` +
        `${result.message === undefined ? '' : `: ${result.message}`}.`,
    });
  }

  for (const node of input.nodes) {
    /* 3. An Input node with nothing in it has nothing to start from (FR-NODE-011). */
    if (node.kind === 'input' && !hasInput(node, input.inputs[node.id])) {
      issues.push({
        severity: 'error',
        code: 'missing_input',
        message: `"${node.name}" has no text or files to start from.`,
        nodeId: node.id,
      });
    }

    /* 4. A placeholder nobody can fill would reach the model as literal braces (TC-PRM-003). */
    if (node.kind === 'agent') {
      const unknown = findUnknownPlaceholders(node.config.instructions, []);
      if (unknown.length > 0) {
        issues.push({
          severity: 'error',
          code: 'unknown_placeholder',
          message: `"${node.name}" uses ${unknown.map((name) => `{{${name}}}`).join(', ')}, which cannot be resolved.`,
          nodeId: node.id,
        });
      }
    }

    /* 5. Kinds whose executor arrives in a later round (removed as the rounds land). */
    if (!SUPPORTED_NODE_KINDS.includes(node.kind)) {
      issues.push({
        severity: 'error',
        code: 'not_supported_yet',
        message: `"${node.name}" is a ${node.kind} node, which this version cannot run yet.`,
        nodeId: node.id,
      });
    }
  }

  /*
   * 6. Multimodal capability (FR-MM-005, TC-MM-005). A media artifact an Input node attaches — a
   *    PNG, an MP3 — must be a type the model it feeds can read, judged on the artifact's own type
   *    rather than the node's configured `inputTypes` (which `validateGraph` already checks). Any
   *    mismatch is `incompatible_model` **before** a single provider call. First hop only: the
   *    fixtures and TC-MM-005 wire an Input node straight into the model that consumes its media.
   */
  if (input.artifactTypesFor !== undefined) {
    const nodeById = new Map(input.nodes.map((node) => [node.id, node]));
    const isMedia = (type: DataType): boolean =>
      type === 'image' || type === 'audio' || type === 'video' || type === 'file';

    for (const source of input.nodes) {
      if (source.kind !== 'input' || source.config.artifactIds.length === 0) continue;

      const mediaTypes = [
        ...new Set((await input.artifactTypesFor(source.config.artifactIds)).filter(isMedia)),
      ];
      if (mediaTypes.length === 0) continue;

      for (const edge of input.edges) {
        if (edge.kind !== 'data' || edge.from.nodeId !== source.id) continue;
        const target = nodeById.get(edge.to.nodeId);
        if (target === undefined || (target.kind !== 'agent' && target.kind !== 'model')) continue;

        const model = input.models.find(
          (candidate) =>
            candidate.providerId === target.config.providerId &&
            candidate.modelId === target.config.modelId,
        );
        if (model === undefined) continue; // `missing_model`/`unavailable_model` already covers it.

        const unsupported = mediaTypes.filter((type) => !model.inputTypes.includes(type));
        if (unsupported.length > 0) {
          issues.push({
            severity: 'error',
            code: 'incompatible_model',
            message: `"${target.name}" uses "${model.modelId}", which cannot read the ${unsupported.join(
              ', ',
            )} content "${source.name}" attaches.`,
            nodeId: target.id,
          });
        }
      }
    }
  }

  return issues;
}
