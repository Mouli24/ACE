import { describe, expect, it } from 'vitest';

import type { DataType } from '../enums.js';
import { validateAgainstContract } from '../envelope.js';
import {
  AgentConfigSchema,
  BudgetUsdSchema,
  DEFAULT_EXECUTION_SETTINGS,
  DOTTED_PATH_REGEX,
  DottedPathSchema,
  EdgeSchema,
  ExecutionSettingsSchema,
  IdSchema,
  LOOP_STOP_REASONS,
  LoopConfigSchema,
  LoopStopReasonSchema,
  NodeSchema,
  ProjectSchema,
  REVIEW_CONTRACT_SCHEMA,
  REVIEW_VERDICTS,
  RetrievalConfigSchema,
  ReviewContractSchema,
  TimestampSchema,
  WorkflowSchema,
  validateLoopConfig,
  type AgentConfig,
  type Port,
} from '../graph.js';
import { isConnectionAllowed } from '../validation.js';
import {
  EDGE_ID,
  EDGE_ID_2,
  EDGE_ID_3,
  LOOP_EDGE_ID,
  NODE_A,
  NODE_B,
  NODE_C,
  NODE_D,
  NODE_E,
  NOW,
  PROJECT_ID,
  WORKFLOW_ID,
} from './fixtures.js';

describe('D21 Id is a ULID', () => {
  it('accepts a well-formed ULID', () => {
    expect(IdSchema.parse(NODE_A)).toBe(NODE_A);
  });

  it.each([
    ['too short', '01JBXQ8Z9KQ4R7N2VWXYZ0ABC'],
    ['too long', '01JBXQ8Z9KQ4R7N2VWXYZ0ABCDE'],
    ['lowercase', '01jbxq8z9kq4r7n2vwxyz0abcd'],
    ['excluded letter I', '01JBXQ8Z9KQ4R7N2VWXYZ0ABCI'],
    ['excluded letter U', '01JBXQ8Z9KQ4R7N2VWXYZ0ABCU'],
    ['timestamp overflow', '81JBXQ8Z9KQ4R7N2VWXYZ0ABCD'],
    ['readable id', 'node-1'],
    ['empty', ''],
  ])('rejects %s', (_label, value) => {
    expect(IdSchema.safeParse(value).success).toBe(false);
  });
});

describe('FR-SYS-006 Timestamp is ISO-8601', () => {
  it('accepts a UTC instant and an offset instant', () => {
    expect(TimestampSchema.safeParse(NOW).success).toBe(true);
    expect(TimestampSchema.safeParse('2026-09-21T15:30:00+05:30').success).toBe(true);
  });

  it('rejects a non-timestamp', () => {
    expect(TimestampSchema.safeParse('yesterday').success).toBe(false);
  });
});

describe('FR-PRJ-001 Project entity', () => {
  const project = {
    id: PROJECT_ID,
    name: 'Demo',
    folderPath: 'D:/projects/demo',
    createdAt: NOW,
    updatedAt: NOW,
  };

  it('accepts a project without lastOpenedAt', () => {
    expect(ProjectSchema.parse(project)).toEqual(project);
  });

  it.each([
    ['empty name', ''],
    ['name over 120 chars', 'x'.repeat(121)],
  ])('rejects %s', (_label, name) => {
    expect(ProjectSchema.safeParse({ ...project, name }).success).toBe(false);
  });

  it('accepts a name of exactly 120 chars', () => {
    expect(ProjectSchema.safeParse({ ...project, name: 'x'.repeat(120) }).success).toBe(true);
  });
});

describe('FR-GRD-008 a project can cap what one run may cost', () => {
  const project = {
    id: PROJECT_ID,
    name: 'Demo',
    folderPath: 'D:/projects/demo',
    createdAt: NOW,
    updatedAt: NOW,
  };

  it('takes a cap in USD, or none at all — absent, or null once removed (D72)', () => {
    expect(ProjectSchema.parse({ ...project, maxCostPerRunUsd: 0.01 }).maxCostPerRunUsd).toBe(0.01);
    expect(ProjectSchema.parse(project).maxCostPerRunUsd).toBeUndefined();
    expect(ProjectSchema.parse({ ...project, maxCostPerRunUsd: null }).maxCostPerRunUsd).toBeNull();
  });

  it.each([0, -0.01, Infinity])('refuses a cap of %s — a set cap is above zero (D72)', (cap) => {
    expect(ProjectSchema.safeParse({ ...project, maxCostPerRunUsd: cap }).success).toBe(false);
    expect(BudgetUsdSchema.safeParse(cap).success).toBe(false);
  });
});

describe('FR-WF-001 Workflow entity', () => {
  const workflow = {
    id: WORKFLOW_ID,
    projectId: PROJECT_ID,
    name: 'Flow 1',
    version: 0,
    formatVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };

  it('accepts version 0 and formatVersion 1', () => {
    expect(WorkflowSchema.parse(workflow)).toEqual(workflow);
  });

  it('rejects a negative version', () => {
    expect(WorkflowSchema.safeParse({ ...workflow, version: -1 }).success).toBe(false);
  });

  it('rejects a formatVersion other than 1', () => {
    expect(WorkflowSchema.safeParse({ ...workflow, formatVersion: 2 }).success).toBe(false);
  });
});

describe('TC-NODE-006 Out-of-range setting', () => {
  it('rejects temperature 5', () => {
    const result = ExecutionSettingsSchema.safeParse({
      ...DEFAULT_EXECUTION_SETTINGS,
      temperature: 5,
    });
    expect(result.success).toBe(false);
  });

  it.each([
    ['temperature below 0', { temperature: -0.1 }],
    ['temperature above 2', { temperature: 2.1 }],
    ['maxTokens 0', { maxTokens: 0 }],
    ['maxTokens above 200000', { maxTokens: 200_001 }],
    ['fractional maxTokens', { maxTokens: 10.5 }],
    ['timeoutMs below 1000', { timeoutMs: 999 }],
    ['timeoutMs above 600000', { timeoutMs: 600_001 }],
    ['retries above 5', { retries: 6 }],
    ['retries below 0', { retries: -1 }],
  ])('rejects %s', (_label, patch) => {
    expect(
      ExecutionSettingsSchema.safeParse({ ...DEFAULT_EXECUTION_SETTINGS, ...patch }).success,
    ).toBe(false);
  });

  it.each([
    ['temperature 0', { temperature: 0 }],
    ['temperature 2', { temperature: 2 }],
    ['maxTokens 1', { maxTokens: 1 }],
    ['timeoutMs 1000', { timeoutMs: 1000 }],
    ['retries 0', { retries: 0 }],
    ['retries 5', { retries: 5 }],
  ])('accepts the boundary value %s', (_label, patch) => {
    expect(
      ExecutionSettingsSchema.safeParse({ ...DEFAULT_EXECUTION_SETTINGS, ...patch }).success,
    ).toBe(true);
  });

  it('fills the §2.4 defaults when no execution setting is given', () => {
    expect(ExecutionSettingsSchema.parse({})).toEqual({
      temperature: 0.7,
      maxTokens: 4096,
      timeoutMs: 120_000,
      retries: 2,
    });
  });
});

describe('FR-NODE-007 AgentConfig defaults', () => {
  const minimal = { instructions: 'Summarise', inputTypes: ['text'], outputTypes: ['text'] };

  it('fills every default §2.4 states', () => {
    expect(AgentConfigSchema.parse(minimal)).toEqual({
      instructions: 'Summarise',
      inputTypes: ['text'],
      outputTypes: ['text'],
      routing: { policy: 'fixed', fallbackModelIds: [] },
      execution: { temperature: 0.7, maxTokens: 4096, timeoutMs: 120_000, retries: 2 },
      contextPolicy: { budgetTokens: 4000 },
      tools: { enabled: [], maxToolCalls: 10, allowedDomains: [] },
      knowledgeBaseIds: [],
      memory: { enabled: false },
      skillIds: [],
    });
  });

  it.each([
    ['budgetTokens below 256', 255],
    ['budgetTokens above 200000', 200_001],
  ])('rejects %s', (_label, budgetTokens) => {
    expect(AgentConfigSchema.safeParse({ ...minimal, contextPolicy: { budgetTokens } }).success).toBe(
      false,
    );
  });

  it('rejects maxToolCalls above 50', () => {
    expect(
      AgentConfigSchema.safeParse({
        ...minimal,
        tools: { enabled: [], maxToolCalls: 51, allowedDomains: [] },
      }).success,
    ).toBe(false);
  });
});

describe('FR-NODE-006 Node entity is discriminated by kind', () => {
  const base = {
    id: NODE_A,
    workflowId: WORKFLOW_ID,
    name: 'Agent',
    position: { x: 10, y: 20 },
    inputs: [],
    outputs: [],
  };

  it('accepts a merge node with a §2.4 merge config', () => {
    const node = { ...base, kind: 'merge', config: { mode: 'all' } };
    expect(NodeSchema.parse(node)).toEqual(node);
  });

  it('rejects a merge node carrying a transform config', () => {
    expect(NodeSchema.safeParse({ ...base, kind: 'merge', config: { op: 'join' } }).success).toBe(
      false,
    );
  });

  it('rejects an unknown merge mode', () => {
    expect(NodeSchema.safeParse({ ...base, kind: 'merge', config: { mode: 'both' } }).success).toBe(
      false,
    );
  });

  it('rejects a name longer than 80 chars', () => {
    expect(
      NodeSchema.safeParse({ ...base, name: 'x'.repeat(81), kind: 'output', config: {} }).success,
    ).toBe(false);
  });

  it('rejects retrieval k above 20', () => {
    expect(RetrievalConfigSchema.safeParse({ k: 21 }).success).toBe(false);
    expect(RetrievalConfigSchema.safeParse({ k: 20 }).success).toBe(true);
  });
});

describe('FR-CON-001 Edge entity', () => {
  const edge = {
    id: EDGE_ID,
    workflowId: WORKFLOW_ID,
    kind: 'data',
    from: { nodeId: NODE_A, portId: NODE_A + ':out:text' },
    to: { nodeId: NODE_B, portId: NODE_B + ':in:text' },
  };

  it('accepts a data edge between two derived ports', () => {
    expect(EdgeSchema.parse(edge)).toEqual(edge);
  });

  it('rejects a port id that is not <nodeId>:in|out:<name>', () => {
    expect(EdgeSchema.safeParse({ ...edge, to: { nodeId: NODE_B, portId: 'in:text' } }).success).toBe(
      false,
    );
  });
});

describe('FR-CON-007 LoopConfig bounds', () => {
  const loop = {
    maxIterations: 3,
    exitCondition: { path: '$.done', equals: true },
    onMax: 'continue',
  };

  it('accepts 1..50 iterations', () => {
    expect(LoopConfigSchema.safeParse({ ...loop, maxIterations: 1 }).success).toBe(true);
    expect(LoopConfigSchema.safeParse({ ...loop, maxIterations: 50 }).success).toBe(true);
  });

  it.each([
    ['0 iterations', 0],
    ['51 iterations', 51],
  ])('rejects %s', (_label, maxIterations) => {
    expect(LoopConfigSchema.safeParse({ ...loop, maxIterations }).success).toBe(false);
  });

  it('accepts a string, number or boolean exit value', () => {
    for (const equals of ['done', 7, false]) {
      expect(
        LoopConfigSchema.safeParse({ ...loop, exitCondition: { path: '$.x', equals } }).success,
      ).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Loop edges (round 3 §2.4)                                                   */
/* -------------------------------------------------------------------------- */

const loopConfig = {
  maxIterations: 3,
  exitCondition: { path: 'verdict', equals: 'approved' },
  onMax: 'continue' as const,
};

const port = (nodeId: string, direction: 'in' | 'out', dataType: DataType): Port => ({
  id: `${nodeId}:${direction}:${dataType}`,
  name: dataType,
  dataType,
  multi: direction === 'out',
});

const graphNode = (id: string, name: string, outputs: DataType[]) => ({
  id,
  name,
  outputs: outputs.map((type) => port(id, 'out', type)),
});

const dataEdge = (id: string, from: string, fromType: DataType, to: string, toType: DataType) => ({
  id,
  workflowId: WORKFLOW_ID,
  kind: 'data' as const,
  from: { nodeId: from, portId: `${from}:out:${fromType}` },
  to: { nodeId: to, portId: `${to}:in:${toType}` },
});

/** The §1 demo: Brief → Writer → Reviewer → Publish, and a loop edge Reviewer → Writer. */
const brief = graphNode(NODE_A, 'Brief', ['text']);
const writer = graphNode(NODE_B, 'Writer', ['text']);
const reviewer = graphNode(NODE_C, 'Reviewer', ['json']);
const publish = graphNode(NODE_D, 'Publish', []);

const demo = {
  nodes: [brief, writer, reviewer, publish],
  edges: [
    dataEdge(EDGE_ID, NODE_A, 'text', NODE_B, 'text'),
    dataEdge(EDGE_ID_2, NODE_B, 'text', NODE_C, 'text'),
    dataEdge(EDGE_ID_3, NODE_C, 'json', NODE_D, 'json'),
  ],
};

const backEdge = {
  id: LOOP_EDGE_ID,
  workflowId: WORKFLOW_ID,
  kind: 'loop' as const,
  from: { nodeId: NODE_C, portId: `${NODE_C}:out:json` },
  to: { nodeId: NODE_B, portId: `${NODE_B}:in:text` },
  loop: loopConfig,
};

describe('FR-PAR-004 the exit condition reads a dotted path into the json output', () => {
  it.each(['verdict', 'review.verdict', 'issues.0', 'issues[0]', 'a.b[2].c', 'a[0][1]', 'score_2'])(
    'accepts %s',
    (path) => {
      expect(DottedPathSchema.safeParse(path).success).toBe(true);
    },
  );

  it.each(['', '$.verdict', '.verdict', 'verdict.', 'a..b', 'a b', 'a[x]', 'review-verdict'])(
    'refuses %j',
    (path) => {
      expect(DottedPathSchema.safeParse(path).success).toBe(false);
    },
  );

  it('uses one grammar, exported for the loop edge editor', () => {
    expect(DOTTED_PATH_REGEX.test('review.issues[0]')).toBe(true);
    expect(DOTTED_PATH_REGEX.test('$.review')).toBe(false);
  });

  it('is checked on the way in, so an edge stored before round 3 still loads (NFR-VER-01)', () => {
    const stored = { ...loopConfig, exitCondition: { path: '$.verdict', equals: 'approved' } };

    expect(LoopConfigSchema.safeParse(stored).success).toBe(true);
    expect(validateLoopConfig({ ...backEdge, loop: stored }, demo)).toMatchObject({ ok: false });
  });
});

describe('FR-PAR-003 FR-GRD-009 loop stop reasons', () => {
  it('declares the three reasons §2.4 records on the last iteration', () => {
    expect([...LOOP_STOP_REASONS]).toEqual(['exit_condition', 'max_iterations', 'repeated_output']);
    expect(LoopStopReasonSchema.safeParse('timeout').success).toBe(false);
  });
});

describe('FR-CON-007 validateLoopConfig', () => {
  it('accepts the Review→Fix loop of the §1 demo script', () => {
    expect(validateLoopConfig(backEdge, demo)).toEqual({ ok: true });
  });

  it('does not hold a loop edge to the data connection rule', () => {
    // The Writer's only input is already fed by the Brief, and json is not text: as a data edge
    // this would be refused twice over. A loop edge re-queues the Writer instead (§2.4).
    const writerInput = { ...port(NODE_B, 'in', 'text'), multi: false };

    expect(isConnectionAllowed(port(NODE_C, 'out', 'json'), writerInput, 1).ok).toBe(false);
    expect(validateLoopConfig(backEdge, demo)).toEqual({ ok: true });
  });

  it.each([0, 51])('TC-CON-007 refuses %i iterations', (maxIterations) => {
    expect(
      validateLoopConfig({ ...backEdge, loop: { ...loopConfig, maxIterations } }, demo),
    ).toMatchObject({ ok: false, code: 'invalid_loop_config' });
  });

  it.each([1, 50])('accepts %i iterations', (maxIterations) => {
    expect(
      validateLoopConfig({ ...backEdge, loop: { ...loopConfig, maxIterations } }, demo),
    ).toEqual({ ok: true });
  });

  it('refuses a loop edge that carries no loop config', () => {
    const { loop: _loop, ...bare } = backEdge;

    expect(validateLoopConfig(bare, demo)).toMatchObject({
      ok: false,
      code: 'loop_config_missing',
    });
  });

  it('refuses a loop config on a data edge', () => {
    const plain = dataEdge(EDGE_ID, NODE_A, 'text', NODE_B, 'text');

    expect(validateLoopConfig({ ...plain, loop: loopConfig }, demo)).toMatchObject({
      ok: false,
      code: 'loop_config_on_data_edge',
    });
  });

  it('has nothing to say about a plain data edge', () => {
    expect(validateLoopConfig(dataEdge(EDGE_ID, NODE_A, 'text', NODE_B, 'text'), demo)).toEqual({
      ok: true,
    });
  });

  it('refuses an exit path that is not a dotted path', () => {
    const jsonPath = { ...loopConfig, exitCondition: { path: '$.verdict', equals: 'approved' } };
    const result = validateLoopConfig({ ...backEdge, loop: jsonPath }, demo);

    expect(result).toMatchObject({ ok: false, code: 'invalid_loop_config' });
    expect(result.ok ? '' : result.reason).toContain('exitCondition.path');
  });

  it('refuses a source with no json output for the exit condition to read, naming it', () => {
    const textReviewer = graphNode(NODE_C, 'Reviewer', ['text']);
    const result = validateLoopConfig(
      { ...backEdge, from: { nodeId: NODE_C, portId: `${NODE_C}:out:text` } },
      { ...demo, nodes: [brief, writer, textReviewer, publish] },
    );

    expect(result).toMatchObject({ ok: false, code: 'loop_source_not_json' });
    expect(result.ok ? '' : result.reason).toContain('Reviewer');
  });

  it('refuses a target downstream of the source', () => {
    const forward = { ...backEdge, to: { nodeId: NODE_D, portId: `${NODE_D}:in:json` } };

    expect(validateLoopConfig(forward, demo)).toMatchObject({
      ok: false,
      code: 'loop_target_not_upstream',
    });
  });

  it('refuses a node looping onto itself', () => {
    const self = { ...backEdge, to: { nodeId: NODE_C, portId: `${NODE_C}:in:text` } };

    expect(validateLoopConfig(self, demo)).toMatchObject({
      ok: false,
      code: 'loop_target_not_upstream',
    });
  });

  it('finds the target however many data edges back it is', () => {
    const editor = graphNode(NODE_E, 'Editor', ['text']);
    const longer = {
      nodes: [brief, writer, editor, reviewer],
      edges: [
        dataEdge(EDGE_ID, NODE_A, 'text', NODE_B, 'text'),
        dataEdge(EDGE_ID_2, NODE_B, 'text', NODE_E, 'text'),
        dataEdge(EDGE_ID_3, NODE_E, 'text', NODE_C, 'text'),
      ],
    };

    expect(validateLoopConfig(backEdge, longer)).toEqual({ ok: true });
  });

  it('only counts data edges as the way upstream', () => {
    const onlyLoops = {
      nodes: [writer, reviewer],
      edges: [
        {
          ...backEdge,
          id: EDGE_ID_2,
          from: { nodeId: NODE_B, portId: `${NODE_B}:out:text` },
          to: { nodeId: NODE_C, portId: `${NODE_C}:in:text` },
        },
      ],
    };

    expect(validateLoopConfig(backEdge, onlyLoops)).toMatchObject({
      ok: false,
      code: 'loop_target_not_upstream',
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The standard review contract (round 3 §2.4)                                 */
/* -------------------------------------------------------------------------- */

describe('FR-PAR-007 the standard review contract', () => {
  const review = { score: 8, verdict: 'approved', issues: [] };
  const reviewed = (value: unknown) =>
    validateAgainstContract([{ type: 'json', value }], {
      outputTypes: ['json'],
      jsonSchema: REVIEW_CONTRACT_SCHEMA,
    });

  it('has a score, a verdict and a list of issues', () => {
    expect([...REVIEW_VERDICTS]).toEqual(['approved', 'changes_requested']);
    expect(ReviewContractSchema.parse(review)).toEqual(review);
    expect(reviewed(review)).toEqual({ ok: true });
  });

  it.each([0, 10, 7.5])('accepts a score of %s', (score) => {
    expect(ReviewContractSchema.safeParse({ ...review, score }).success).toBe(true);
    expect(reviewed({ ...review, score })).toEqual({ ok: true });
  });

  it.each([-1, 10.5, 11])('refuses a score of %s — scores run from 0 to 10', (score) => {
    expect(ReviewContractSchema.safeParse({ ...review, score }).success).toBe(false);
    expect(reviewed({ ...review, score }).ok).toBe(false);
  });

  it('TC-PAR-008 a review with no verdict violates the contract', () => {
    const { verdict: _verdict, ...noVerdict } = review;
    const result = reviewed(noVerdict);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain('verdict');
    expect(ReviewContractSchema.safeParse(noVerdict).success).toBe(false);
  });

  it('refuses a verdict other than approved or changes_requested', () => {
    expect(ReviewContractSchema.safeParse({ ...review, verdict: 'maybe' }).success).toBe(false);
    expect(reviewed({ ...review, verdict: 'maybe' }).ok).toBe(false);
  });

  it('refuses issues that are not text', () => {
    expect(ReviewContractSchema.safeParse({ ...review, issues: [3] }).success).toBe(false);
    expect(reviewed({ ...review, issues: [3] }).ok).toBe(false);
  });

  it('accepts what mock-reject-twice returns, prompt echo and all', () => {
    const fromMock = {
      echo: '## System',
      verdict: 'changes_requested',
      score: 4,
      issues: ['tighten the argument'],
    };

    expect(reviewed(fromMock)).toEqual({ ok: true });
    expect(ReviewContractSchema.safeParse(fromMock).success).toBe(true);
  });

  it('fits an agent output contract as it is', () => {
    // Typed, so `tsc` proves the frozen schema is assignable where the config panel puts it.
    const outputContract: AgentConfig['outputContract'] = { jsonSchema: REVIEW_CONTRACT_SCHEMA };
    const agent = AgentConfigSchema.parse({
      instructions: 'Review the draft',
      inputTypes: ['text'],
      outputTypes: ['json'],
      outputContract,
    });

    expect(agent.outputContract?.jsonSchema).toEqual(REVIEW_CONTRACT_SCHEMA);
  });

  it('is frozen, so filling one agent contract can never change it for the next', () => {
    expect(Object.isFrozen(REVIEW_CONTRACT_SCHEMA)).toBe(true);
    expect(Object.isFrozen(REVIEW_CONTRACT_SCHEMA.required)).toBe(true);
    expect(Object.isFrozen(REVIEW_CONTRACT_SCHEMA.properties)).toBe(true);
    expect(Object.isFrozen(REVIEW_CONTRACT_SCHEMA.properties.score)).toBe(true);
    expect(Object.isFrozen(REVIEW_CONTRACT_SCHEMA.properties.verdict.enum)).toBe(true);
  });
});
