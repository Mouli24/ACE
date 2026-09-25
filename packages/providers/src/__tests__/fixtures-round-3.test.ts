import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CreateGuardrailPolicyRequestSchema,
  REVIEW_CONTRACT_SCHEMA,
  UpdateProjectRequestSchema,
  WorkflowExportSchema,
  validateLoopConfig,
  type Edge,
  type Node,
  type WorkflowExport,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { MOCK_MODELS } from '../adapters/mock.js';

/**
 * The round 3 acceptance fixtures, checked against the contract that has to load them.
 *
 * This lives in `packages/providers` because the fixtures' whole purpose is to exercise mock
 * models: the invariant worth protecting is that every model they name is a model this adapter
 * really has, which is a claim only this package can make. Parsing them against
 * `WorkflowExportSchema` here as well means a malformed fixture fails in `pnpm test`, in a second,
 * rather than as a confusing 400 partway through `pnpm test:acceptance`.
 *
 * Regenerate the fixtures with `node tests/acceptance/fixtures/round-3/generate.mjs`.
 */

const DIR = fileURLToPath(new URL('../../../../tests/acceptance/fixtures/round-3/', import.meta.url));

const read = (file: string): unknown => JSON.parse(readFileSync(`${DIR}${file}`, 'utf8'));

/** The fixtures round 3 §4 item 8 asks for, and nothing else. */
const WORKFLOW_FIXTURES = [
  'review-fix.json',
  'review-never.json',
  'parallel-merge-all.json',
  'parallel-merge-any.json',
  'retry-429.json',
  'auth-401.json',
  'pii-ask.json',
  'leak.json',
  'budget-cap.json',
] as const;

const SIDECARS = ['pii-ask.policy.json', 'budget-cap.project.json'] as const;

const PLACEHOLDER_PROVIDER = '01M3R3PV0000000000000000PV';

const workflow = (file: string): WorkflowExport => WorkflowExportSchema.parse(read(file));

const agents = (doc: WorkflowExport): Extract<Node, { kind: 'agent' }>[] =>
  doc.nodes.filter((node): node is Extract<Node, { kind: 'agent' }> => node.kind === 'agent');

const nodeNamed = (doc: WorkflowExport, name: string): Node => {
  const found = doc.nodes.find((node) => node.name === name);
  if (found === undefined) throw new Error(`No node named "${name}".`);
  return found;
};

const loopEdges = (doc: WorkflowExport): Edge[] => doc.edges.filter((edge) => edge.kind === 'loop');

/* -------------------------------------------------------------------------- */
/* Every fixture is a WorkflowExport the engine can import                     */
/* -------------------------------------------------------------------------- */

describe('round 3 fixtures parse as the contract they claim to be', () => {
  it('is exactly the nine workflows §4 item 8 lists, plus their two sidecars', () => {
    const onDisk = readdirSync(DIR)
      .filter((file) => file.endsWith('.json'))
      .sort();

    expect(onDisk).toEqual([...WORKFLOW_FIXTURES, ...SIDECARS].sort());
  });

  it.each(WORKFLOW_FIXTURES)('%s parses as a WorkflowExport', (file) => {
    expect(WorkflowExportSchema.safeParse(read(file)).success).toBe(true);
  });

  it.each(WORKFLOW_FIXTURES)('%s names the placeholder provider on every agent', (file) => {
    const providerIds = agents(workflow(file)).map((node) => node.config.providerId);

    expect(providerIds.length).toBeGreaterThan(0);
    expect(new Set(providerIds)).toEqual(new Set([PLACEHOLDER_PROVIDER]));
  });

  it.each(WORKFLOW_FIXTURES)('%s only asks for models the mock provider has', (file) => {
    const known = new Set(MOCK_MODELS.map((model) => model.modelId));

    for (const node of agents(workflow(file))) {
      expect(known, `${file}: ${node.name}`).toContain(node.config.modelId);
      for (const fallback of node.config.routing.fallbackModelIds) {
        expect(known, `${file}: ${node.name} fallback`).toContain(fallback);
      }
    }
  });

  it.each(WORKFLOW_FIXTURES)('%s wires every edge to a port that exists', (file) => {
    const doc = workflow(file);
    const ports = new Set(doc.nodes.flatMap((node) => [...node.inputs, ...node.outputs]).map((p) => p.id));

    for (const edge of doc.edges) {
      expect(ports, `${file}: ${edge.id} from`).toContain(edge.from.portId);
      expect(ports, `${file}: ${edge.id} to`).toContain(edge.to.portId);
    }
  });

  it('pii-ask.policy.json parses as a CreateGuardrailPolicyRequest', () => {
    const parsed = CreateGuardrailPolicyRequestSchema.parse(read('pii-ask.policy.json'));

    expect(parsed.checks).toHaveLength(1);
    expect(parsed.checks[0]).toMatchObject({ point: 'output', type: 'pii', action: 'ask_user' });
  });

  it('budget-cap.project.json parses as an UpdateProjectRequest with the $0.01 cap', () => {
    expect(UpdateProjectRequestSchema.parse(read('budget-cap.project.json'))).toEqual({
      maxCostPerRunUsd: 0.01,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The loop fixtures (FR-CON-007, FR-PAR-003..007)                             */
/* -------------------------------------------------------------------------- */

describe('FR-CON-007 validateLoopConfig accepts the review loops as drawn', () => {
  it.each(['review-fix.json', 'review-never.json'])('%s has one loop edge it accepts', (file) => {
    const doc = workflow(file);
    const loops = loopEdges(doc);

    expect(loops).toHaveLength(1);
    expect(validateLoopConfig(loops[0]!, doc)).toEqual({ ok: true });
  });

  it('review-fix.json loops the Reviewer back into the Writer, max 3, exit on approval', () => {
    const doc = workflow('review-fix.json');
    const loop = loopEdges(doc)[0]!;

    expect(loop.from.nodeId).toBe(nodeNamed(doc, 'Reviewer').id);
    expect(loop.to.nodeId).toBe(nodeNamed(doc, 'Writer').id);
    expect(loop.loop).toEqual({
      maxIterations: 3,
      exitCondition: { path: 'verdict', equals: 'approved' },
      onMax: 'continue',
    });
  });

  it('gives the Reviewer REVIEW_CONTRACT_SCHEMA itself, not a copy that has drifted', () => {
    for (const file of ['review-fix.json', 'review-never.json']) {
      const reviewer = nodeNamed(workflow(file), 'Reviewer');
      if (reviewer.kind !== 'agent') throw new Error('The Reviewer must be an agent node.');

      expect(reviewer.config.outputContract?.jsonSchema, file).toEqual(REVIEW_CONTRACT_SCHEMA);
      expect(reviewer.config.outputTypes, file).toEqual(['json']);
    }
  });

  it('puts the reviewers on the two models whose verdicts differ', () => {
    const modelOf = (file: string): string | undefined => {
      const reviewer = nodeNamed(workflow(file), 'Reviewer');
      return reviewer.kind === 'agent' ? reviewer.config.modelId : undefined;
    };

    expect(modelOf('review-fix.json')).toBe('mock-reject-twice');
    expect(modelOf('review-never.json')).toBe('mock-reject-always');
  });

  it.each(WORKFLOW_FIXTURES)('%s carries no loop config on a data edge', (file) => {
    const doc = workflow(file);

    for (const edge of doc.edges.filter((each) => each.kind === 'data')) {
      expect(validateLoopConfig(edge, doc), `${file}: ${edge.id}`).toEqual({ ok: true });
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The merge fixtures (FR-PAR-001, FR-PAR-002)                                 */
/* -------------------------------------------------------------------------- */

describe('FR-PAR-002 the merge fixtures differ only in their mode', () => {
  const modeOf = (file: string): string | undefined => {
    const merge = nodeNamed(workflow(file), 'Merge');
    return merge.kind === 'merge' ? merge.config.mode : undefined;
  };

  it('is all in one and any in the other', () => {
    expect(modeOf('parallel-merge-all.json')).toBe('all');
    expect(modeOf('parallel-merge-any.json')).toBe('any');
  });

  it('feeds the merge from two branches on two different ports, so the order is defined', () => {
    const doc = workflow('parallel-merge-all.json');
    const merge = nodeNamed(doc, 'Merge');
    const into = doc.edges.filter((edge) => edge.to.nodeId === merge.id);

    expect(into).toHaveLength(2);
    expect(new Set(into.map((edge) => edge.to.portId)).size).toBe(2);
    expect(new Set(into.map((edge) => edge.from.nodeId))).toEqual(
      new Set([nodeNamed(doc, 'Analyst').id, nodeNamed(doc, 'Scorer').id]),
    );
  });

  it('makes one branch slow and the other instant, so any has a deterministic winner', () => {
    for (const file of ['parallel-merge-all.json', 'parallel-merge-any.json']) {
      const doc = workflow(file);
      const modelOf = (name: string): string | undefined => {
        const node = nodeNamed(doc, name);
        return node.kind === 'agent' ? node.config.modelId : undefined;
      };

      expect(modelOf('Analyst'), file).toBe('mock-slow');
      expect(modelOf('Scorer'), file).toBe('mock-json');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Errors, guardrails and budgets                                              */
/* -------------------------------------------------------------------------- */

describe('the error, guardrail and budget fixtures are set up to do what they claim', () => {
  it('retry-429.json allows the two retries attempt 3 needs', () => {
    const agent = nodeNamed(workflow('retry-429.json'), 'Summariser');
    if (agent.kind !== 'agent') throw new Error('The Summariser must be an agent node.');

    expect(agent.config.modelId).toBe('mock-429-then-ok');
    expect(agent.config.execution.retries).toBeGreaterThanOrEqual(2);
    expect(agent.config.routing.fallbackModelIds).toEqual([]);
  });

  it('auth-401.json puts a node downstream of the failure, so BLOCKED has something to show', () => {
    const doc = workflow('auth-401.json');
    const gate = nodeNamed(doc, 'Gatekeeper');
    if (gate.kind !== 'agent') throw new Error('The Gatekeeper must be an agent node.');

    expect(gate.config.modelId).toBe('mock-401');
    expect(gate.config.routing.fallbackModelIds).toEqual([]);
    expect(doc.edges.some((edge) => edge.from.nodeId === gate.id)).toBe(true);
  });

  it('pii-ask.json puts the email in the input of a model that echoes it back out', () => {
    const doc = workflow('pii-ask.json');
    const input = nodeNamed(doc, 'Input');
    const writer = nodeNamed(doc, 'Writer');
    if (input.kind !== 'input' || writer.kind !== 'agent') throw new Error('Wrong node kinds.');

    // `mock-json` answers `{ echo: <input>, ... }`, which is the only way a deterministic mock
    // gets an address into its *output*, where the check runs.
    expect(writer.config.modelId).toBe('mock-json');
    expect(input.config.text).toMatch(/[\w.]+@[\w.]+\.\w+/);
    expect(writer.config.guardrailPolicyId).toBeDefined();
  });

  it('leak.json leans on the default policy alone, with no override', () => {
    const agent = nodeNamed(workflow('leak.json'), 'Helper');
    if (agent.kind !== 'agent') throw new Error('The Helper must be an agent node.');

    expect(agent.config.modelId).toBe('mock-leak');
    expect(agent.config.guardrailPolicyId).toBeUndefined();
  });

  it('budget-cap.json runs a node under the cap before the one that breaks it', () => {
    const doc = workflow('budget-cap.json');
    const tokensOf = (name: string): number => {
      const node = nodeNamed(doc, name);
      if (node.kind !== 'agent') throw new Error(`${name} must be an agent node.`);
      expect(node.config.modelId).toBe('mock-slow');
      return node.config.execution.maxTokens;
    };

    const cap = 0.01;
    // The mock price table: inputPer1k 0.001, outputPer1k 0.002 (§2.6).
    const dearest = (tokens: number): number => (tokens * 0.003) / 1000;
    const cheapest = (tokens: number): number => (tokens * 0.001) / 1000;

    expect(dearest(tokensOf('Drafter'))).toBeLessThan(cap);
    expect(cheapest(tokensOf('Editor'))).toBeGreaterThan(cap);
  });
});
