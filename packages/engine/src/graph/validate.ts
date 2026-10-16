import {
  ExecutionSettingsSchema,
  capabilityGaps,
  isCliProviderType,
  isConnectionAllowed,
  validateOrderEdge,
  type DataType,
  type Edge,
  type McpServer,
  type Model,
  type Node,
  type Port,
  type Provider,
  type ToolDefinition,
  type ValidationIssue,
} from '@ace/contracts';

import { findCycle } from './cycles.js';

/**
 * What `validate` needs to know beyond the graph itself (round 2 §2.5).
 *
 * Optional: a caller with no catalog to hand — an import, a test — still gets every structural
 * check. When it is supplied, the provider and model checks of FR-PRV-005 and FR-MOD-005 run too.
 */
export interface ValidationContext {
  providers?: readonly Provider[];
  models?: readonly Model[];
  /**
   * The tool registry — built-ins plus connected MCP servers' tools (round 4 §2.4). When supplied,
   * every agent's `tools.enabled` is checked against it (`tool_not_registered`). The engine may not
   * import `@ace/tools`, so this is the narrow view the gateway binds the real registry to; the run
   * executor's `ToolProvider` satisfies it as it is.
   */
  tools?: ToolLookup;
  /** The known MCP servers, for `mcp_server_unreachable` (§2.4). Read only when `tools` is given. */
  mcpServers?: readonly McpServer[];
}

/** The part of the tool registry validation reads: a name → the registered tool's definition. */
export interface ToolLookup {
  get(name: string): { readonly definition: ToolDefinition } | undefined;
}

/**
 * Round 4 §2.4 (D-069): the tool issues of one agent. An enabled name the registry does not hold is
 * `tool_not_registered` — an error, because the model would be offered a tool that cannot run (the
 * usual cause: its MCP server was removed). A registered tool whose MCP server is known and
 * `unreachable` is `mcp_server_unreachable` — a warning, because the run can go ahead and only that
 * tool's calls would fail.
 */
function toolIssues(
  node: Extract<Node, { kind: 'agent' }>,
  tools: ToolLookup,
  mcpServers: readonly McpServer[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const name of node.config.tools.enabled) {
    const registered = tools.get(name);
    if (registered === undefined) {
      issues.push({
        severity: 'error',
        code: 'tool_not_registered',
        message: `"${node.name}" enables the tool "${name}", which is no longer registered — was its MCP server removed?`,
        nodeId: node.id,
      });
      continue;
    }

    const serverId = registered.definition.mcpServerId;
    const server =
      serverId === undefined ? undefined : mcpServers.find((candidate) => candidate.id === serverId);
    if (server?.status === 'unreachable') {
      issues.push({
        severity: 'warning',
        code: 'mcp_server_unreachable',
        message: `"${node.name}" enables "${name}", but its MCP server "${server.name}" is unreachable, so calls to it will fail.`,
        nodeId: node.id,
      });
    }
  }
  return issues;
}

/**
 * A node that works toward a goal of its own (D285): an Agent, or a bare Model node, as opposed to
 * the plumbing kinds that only reshape what they are handed.
 */
export function isGoalDriven(node: Node): node is Extract<Node, { kind: 'agent' | 'model' }> {
  return node.kind === 'agent' || node.kind === 'model';
}

/** What a goal-driven node is asked to achieve — an Agent's instructions, a Model's system prompt. */
export function goalOf(node: Node): string {
  if (node.kind === 'agent') return node.config.instructions.trim();
  if (node.kind === 'model') return (node.config.systemPrompt ?? '').trim();
  return '';
}

/** Does this model cover everything the node needs to read and produce? */
function covers(model: Model, inputTypes: DataType[], outputTypes: DataType[]): boolean {
  return (
    inputTypes.every((type) => model.inputTypes.includes(type)) &&
    outputTypes.every((type) => model.outputTypes.includes(type))
  );
}

/**
 * `POST /workflows/:id/validate` (FR-WF-006, TC-WF-006), using the §2.5 codes.
 *
 * From round 2 `missing_model` is an **error**, not a warning: a run cannot start without one,
 * and round 1's own note said this is where that changes. From round 3 a loop edge is legal and
 * `loop_not_supported` is no longer raised — its own rules are `validateLoopConfig`'s, enforced
 * where the edge is written rather than re-judged here (§2.4, FR-CON-007).
 */
export function validateGraph(
  nodes: readonly Node[],
  edges: readonly Edge[],
  context: ValidationContext = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const providersById = new Map((context.providers ?? []).map((p) => [p.id, p]));
  const hasCatalog = context.models !== undefined;

  /*
   * D285: a run starts from an Input node or from a goal-driven node — an Agent or Model with no
   * data edge into it, which begins from its own goal. It no longer needs an Output node to end:
   * without one the run is COMPLETE once every node nothing is downstream of has completed, so
   * `no_output_node` is not raised any more (the code stays in the contract, NFR-VER-01).
   */
  const fed = new Set(edges.filter((edge) => edge.kind === 'data').map((edge) => edge.to.nodeId));
  const startsFromGoal = (node: Node): boolean => isGoalDriven(node) && !fed.has(node.id);

  if (!nodes.some((node) => node.kind === 'input' || startsFromGoal(node))) {
    issues.push({
      severity: 'error',
      code: 'no_input_node',
      message: 'This workflow has nothing to start from yet — add an Agent node and give it a goal.',
    });
  }

  const incoming = new Set(edges.map((edge) => edge.to.portId));

  for (const node of nodes) {
    // A node with input ports needs at least one of them connected; which particular port is
    // required depends on the node kind, and no round-1 kind requires a specific one. A
    // goal-driven node is the exception: with nothing upstream it starts from its goal (D285).
    if (
      !isGoalDriven(node) &&
      node.inputs.length > 0 &&
      !node.inputs.some((port) => incoming.has(port.id))
    ) {
      issues.push({
        severity: 'error',
        code: 'unconnected_required_input',
        message: `"${node.name}" has no incoming connection, so it would never receive anything.`,
        nodeId: node.id,
      });
    }

    if (startsFromGoal(node) && goalOf(node) === '') {
      issues.push({
        severity: 'error',
        code: 'missing_input',
        message: `"${node.name}" has no goal yet — say what it should achieve.`,
        nodeId: node.id,
      });
    }

    if (node.kind === 'agent' || node.kind === 'model') {
      const { providerId, modelId } = node.config;

      if (providerId === undefined || providerId === '') {
        // PG-1.3 (D358): no provider chosen yet — its own issue, so the card can ask for one.
        issues.push({
          severity: 'error',
          code: 'missing_provider',
          message: `"${node.name}" has no provider chosen yet — choose a provider and a model.`,
          nodeId: node.id,
        });
      } else if (modelId === undefined || modelId === '') {
        issues.push({
          severity: 'error',
          code: 'missing_model',
          message: `"${node.name}" has a provider but no model chosen yet.`,
          nodeId: node.id,
        });
      } else if (context.providers !== undefined && !providersById.has(providerId)) {
        // FR-PRV-005: the provider was removed with confirmation and these are the nodes it left.
        issues.push({
          severity: 'error',
          code: 'provider_missing',
          message: `"${node.name}" uses a provider that no longer exists.`,
          nodeId: node.id,
        });
      } else if (hasCatalog) {
        const model = (context.models ?? []).find(
          (candidate) => candidate.providerId === providerId && candidate.modelId === modelId,
        );

        if (model === undefined || !model.available) {
          // FR-MOD-005 / TC-MOD-004: name the node and the model, so the fix is obvious.
          issues.push({
            severity: 'error',
            code: 'unavailable_model',
            message: `"${node.name}" uses "${modelId}", which is not available on its provider.`,
            nodeId: node.id,
          });
        } else if (!covers(model, node.config.inputTypes, node.config.outputTypes)) {
          issues.push({
            severity: 'error',
            code: 'incompatible_model',
            message: `"${modelId}" cannot handle the data types "${node.name}" is configured for.`,
            nodeId: node.id,
          });
        }

        // D353 (PG-2.1): a schema or tools the model cannot honour is an error, never a silent drop.
        if (node.kind === 'agent' && model !== undefined && model.available) {
          const provider = providersById.get(providerId);
          const cli = provider !== undefined && isCliProviderType(provider.type);
          for (const gap of capabilityGaps(node.config, model, cli)) {
            issues.push({
              severity: 'error',
              code: gap.code,
              message: `"${node.name}": ${gap.reason}`,
              nodeId: node.id,
            });
          }
        }
      }

      const execution = ExecutionSettingsSchema.safeParse(node.config.execution);
      if (!execution.success) {
        issues.push({
          severity: 'error',
          code: 'invalid_execution_setting',
          message: `"${node.name}" has an execution setting outside its allowed range.`,
          nodeId: node.id,
        });
      }
    }

    if (node.kind === 'agent' && context.tools !== undefined) {
      issues.push(...toolIssues(node, context.tools, context.mcpServers ?? []));
    }
  }

  const portsById = new Map<string, { port: Port; node: Node }>();
  for (const node of nodes) {
    for (const port of [...node.inputs, ...node.outputs]) portsById.set(port.id, { port, node });
  }

  // Loop edges do not occupy an input port (D73), so they are not counted against one: the loop
  // back into a Writer's single text input must not make the brief look like a second connection.
  const edgesIntoPort = new Map<string, number>();
  for (const edge of edges) {
    if (edge.kind !== 'data') continue;
    edgesIntoPort.set(edge.to.portId, (edgesIntoPort.get(edge.to.portId) ?? 0) + 1);
  }

  for (const edge of edges) {
    // From round 3 a loop edge is legal (FR-CON-003, FR-CON-007). Its own rules were checked by
    // `validateLoopConfig` when it was written, and `isConnectionAllowed` never applied to it.
    if (edge.kind === 'loop') continue;
    // D373: an order edge carries no data, so no port typing — only its own rules.
    if (edge.kind === 'order') {
      const check = validateOrderEdge(edge, { nodes, edges });
      // A cycle is reported once, below, for the whole graph.
      if (!check.ok && check.code !== 'cycle') {
        issues.push({
          severity: 'error',
          code: check.code,
          message: check.reason,
          edgeId: edge.id,
        });
      }
      continue;
    }

    const source = portsById.get(edge.from.portId);
    const target = portsById.get(edge.to.portId);
    if (source === undefined || target === undefined) continue;

    const check = isConnectionAllowed(
      source.port,
      target.port,
      (edgesIntoPort.get(edge.to.portId) ?? 1) - 1,
    );
    if (!check.ok) {
      issues.push({
        severity: 'error',
        code: check.code,
        message: check.reason,
        edgeId: edge.id,
      });
    }
  }

  const cycle = findCycle(edges);
  if (cycle !== null) {
    issues.push({
      severity: 'error',
      code: 'cycle',
      message: `These nodes form a cycle: ${cycle.join(' -> ')}. Only a loop edge may close one.`,
    });
  }

  return issues;
}
