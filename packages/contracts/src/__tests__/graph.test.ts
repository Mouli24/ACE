import { describe, expect, it } from 'vitest';

import {
  AgentConfigSchema,
  DEFAULT_EXECUTION_SETTINGS,
  EdgeSchema,
  ExecutionSettingsSchema,
  IdSchema,
  LoopConfigSchema,
  NodeSchema,
  ProjectSchema,
  RetrievalConfigSchema,
  TimestampSchema,
  WorkflowSchema,
} from '../graph.js';
import { EDGE_ID, NODE_A, NODE_B, NOW, PROJECT_ID, WORKFLOW_ID } from './fixtures.js';

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
