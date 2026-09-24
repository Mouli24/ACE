import {
  ExecutionSettingsSchema,
  isConnectionAllowed,
  type DataType,
  type Edge,
  type Model,
  type Node,
  type Port,
  type Provider,
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
 * and round 1's own note said this is where that changes. `loop_not_supported` exists only while
 * loop edges are refused.
 */
export function validateGraph(
  nodes: readonly Node[],
  edges: readonly Edge[],
  context: ValidationContext = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const providersById = new Map((context.providers ?? []).map((p) => [p.id, p]));
  const hasCatalog = context.models !== undefined;

  if (!nodes.some((node) => node.kind === 'input')) {
    issues.push({
      severity: 'error',
      code: 'no_input_node',
      message: 'This workflow has no Input node, so a run would have nothing to start from.',
    });
  }

  if (!nodes.some((node) => node.kind === 'output')) {
    issues.push({
      severity: 'error',
      code: 'no_output_node',
      message: 'This workflow has no Output node, so a run would never be able to complete.',
    });
  }

  const incoming = new Set(edges.map((edge) => edge.to.portId));

  for (const node of nodes) {
    // A node with input ports needs at least one of them connected; which particular port is
    // required depends on the node kind, and no round-1 kind requires a specific one.
    if (node.inputs.length > 0 && !node.inputs.some((port) => incoming.has(port.id))) {
      issues.push({
        severity: 'error',
        code: 'unconnected_required_input',
        message: `"${node.name}" has no incoming connection, so it would never receive anything.`,
        nodeId: node.id,
      });
    }

    if (node.kind === 'agent' || node.kind === 'model') {
      const { providerId, modelId } = node.config;

      if (modelId === undefined || modelId === '' || providerId === undefined) {
        issues.push({
          severity: 'error',
          code: 'missing_model',
          message: `"${node.name}" has no provider and model chosen yet.`,
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
  }

  const portsById = new Map<string, { port: Port; node: Node }>();
  for (const node of nodes) {
    for (const port of [...node.inputs, ...node.outputs]) portsById.set(port.id, { port, node });
  }

  const edgesIntoPort = new Map<string, number>();
  for (const edge of edges) {
    edgesIntoPort.set(edge.to.portId, (edgesIntoPort.get(edge.to.portId) ?? 0) + 1);
  }

  for (const edge of edges) {
    if (edge.kind === 'loop') {
      issues.push({
        severity: 'error',
        code: 'loop_not_supported',
        message: 'Loop edges are not supported yet.',
        edgeId: edge.id,
      });
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
