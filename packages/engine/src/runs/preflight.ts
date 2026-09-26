import type {
  Edge,
  Id,
  Model,
  Node,
  NodeKind,
  Part,
  Provider,
  ProviderCheckResult,
  ValidationIssue,
} from '@ace/contracts';

import { validateGraph } from '../graph/validate.js';
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
}

/** An Input node has something to start from when its config or the request carries content. */
function hasInput(node: Extract<Node, { kind: 'input' }>, supplied: Part[] | undefined): boolean {
  if (node.config.text !== undefined && node.config.text !== '') return true;
  if (node.config.artifactIds.length > 0) return true;
  return supplied !== undefined && supplied.length > 0;
}

export async function preflight(input: PreflightInput): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];

  /* 1. Everything `validate` already knows, including the provider and catalog checks. */
  issues.push(
    ...validateGraph(input.nodes, input.edges, {
      providers: input.providers,
      models: input.models,
    }).filter((issue) => issue.severity === 'error'),
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

  return issues;
}
