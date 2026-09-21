import {
  ExecutionSettingsSchema,
  isConnectionAllowed,
  type Edge,
  type Node,
  type Port,
  type ValidationIssue,
} from '@ace/contracts';

import { findCycle } from './cycles.js';

/**
 * `POST /workflows/:id/validate` (FR-WF-006, TC-WF-006), using the §2.5 codes.
 *
 * Round 1 reports `missing_model` as a warning; from round 2 it becomes an error, because a run
 * cannot start without one. `loop_not_supported` exists only while loop edges are refused.
 */
export function validateGraph(nodes: readonly Node[], edges: readonly Edge[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

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
      if (node.config.modelId === undefined || node.config.modelId === '') {
        issues.push({
          severity: 'warning',
          code: 'missing_model',
          message: `"${node.name}" has no model chosen yet.`,
          nodeId: node.id,
        });
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
