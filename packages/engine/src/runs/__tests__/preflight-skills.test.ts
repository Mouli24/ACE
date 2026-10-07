import {
  AgentConfigSchema,
  type Edge,
  type Model,
  type Node,
  type Provider,
  type ProviderCheckResult,
  type SnapshotSkill,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { missingSkillIssues, preflight, type PreflightInput } from '../preflight.js';

/**
 * D272: an agent whose `skillIds` names a skill the run's snapshot did not freeze — never
 * installed, or removed before the run started — is `missing_skill`, an error that blocks the run
 * before any provider call (BR-08). A run snapshotted before skills existed carries no `skills`
 * and is not checked.
 */

const NOW = '2026-10-07T10:00:00.000Z';
const WORKFLOW = '01JBXQ8Z9KQ4R7N2VWXYZ0WKFW';
const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';
const INPUT_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0ABCD';
const WRITER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0EFGH';
const REVIEWER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0RVWR';
const OUTPUT_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0OUTP';
const SKILL_A = '01K6SK00000000000000000001';
const SKILL_B = '01K6SK00000000000000000002';
const SKILL_GONE = '01K6SKGNE00000000000000000';

const port = (nodeId: string, dir: 'in' | 'out') => ({
  id: `${nodeId}:${dir}:text`,
  name: 'text',
  dataType: 'text' as const,
  multi: dir === 'out',
});

const inputNode: Node = {
  id: INPUT_ID,
  workflowId: WORKFLOW,
  kind: 'input',
  name: 'Brief',
  position: { x: 0, y: 0 },
  inputs: [],
  outputs: [port(INPUT_ID, 'out')],
  config: { text: 'write it', artifactIds: [], outputTypes: ['text'] },
};

const outputNode: Node = {
  id: OUTPUT_ID,
  workflowId: WORKFLOW,
  kind: 'output',
  name: 'Result',
  position: { x: 600, y: 0 },
  inputs: [port(OUTPUT_ID, 'in')],
  outputs: [],
  config: {},
};

const agent = (id: string, name: string, skillIds: string[]): Node => ({
  id,
  workflowId: WORKFLOW,
  kind: 'agent',
  name,
  position: { x: 200, y: 0 },
  inputs: [port(id, 'in')],
  outputs: [port(id, 'out')],
  config: AgentConfigSchema.parse({
    providerId: PROVIDER_ID,
    modelId: 'mock-text',
    instructions: 'Write it.',
    inputTypes: ['text'],
    outputTypes: ['text'],
    skillIds,
  }),
});

const edge = (from: string, to: string, id: string): Edge => ({
  id,
  workflowId: WORKFLOW,
  kind: 'data',
  from: { nodeId: from, portId: `${from}:out:text` },
  to: { nodeId: to, portId: `${to}:in:text` },
});

const provider: Provider = {
  id: PROVIDER_ID,
  type: 'mock',
  name: 'Mock',
  keySet: false,
  status: 'CONNECTED',
  concurrency: 20,
  createdAt: NOW,
  updatedAt: NOW,
};

const model: Model = {
  id: '01JBXQ8Z9KQ4R7N2VWXYZ0MDL1',
  providerId: PROVIDER_ID,
  modelId: 'mock-text',
  displayName: 'mock-text',
  inputTypes: ['text'],
  outputTypes: ['text'],
  contextWindow: 200_000,
  supportsTools: false,
  supportsJson: false,
  available: true,
  source: 'discovered',
  lastCheckedAt: NOW,
};

const frozen = (id: string, name: string): SnapshotSkill => ({
  id,
  name,
  version: 1,
  instructions: `Do it the ${name} way.`,
});

const run = (writerSkills: string[], reviewerSkills: string[], skills?: SnapshotSkill[]) =>
  preflight({
    nodes: [
      inputNode,
      agent(WRITER_ID, 'Writer', writerSkills),
      agent(REVIEWER_ID, 'Reviewer', reviewerSkills),
      outputNode,
    ],
    edges: [
      edge(INPUT_ID, WRITER_ID, '01JBXQ8Z9KQ4R7N2VWXYZ0EDG1'),
      edge(WRITER_ID, REVIEWER_ID, '01JBXQ8Z9KQ4R7N2VWXYZ0EDG2'),
      edge(REVIEWER_ID, OUTPUT_ID, '01JBXQ8Z9KQ4R7N2VWXYZ0EDG3'),
    ],
    inputs: {},
    providers: [provider],
    models: [model],
    checkProvider: async (): Promise<ProviderCheckResult> => ({
      status: 'CONNECTED',
      checkedAt: NOW,
    }),
    knowledgeBaseExists: async () => true,
    embeddingProviderOf: async () => undefined,
    ...(skills === undefined ? {} : { skills }),
  } satisfies PreflightInput);

describe('D272 pre-flight refuses an agent whose skill is not installed (missing_skill)', () => {
  it('passes when every skill an agent names was frozen into the snapshot', async () => {
    const issues = await run(
      [SKILL_A],
      [SKILL_A, SKILL_B],
      [frozen(SKILL_A, 'Test first'), frozen(SKILL_B, 'Explain')],
    );
    expect(issues).toEqual([]);
  });

  it('names each agent missing a skill once, as an error on its node', async () => {
    const issues = await run(
      [SKILL_A, SKILL_GONE],
      [SKILL_GONE, '01K6SKGNE00000000000000001'],
      [frozen(SKILL_A, 'Test first')],
    );
    expect(issues).toEqual([
      {
        severity: 'error',
        code: 'missing_skill',
        message: 'Agent "Writer" uses a skill that is not installed.',
        nodeId: WRITER_ID,
      },
      {
        severity: 'error',
        code: 'missing_skill',
        message: 'Agent "Reviewer" uses a skill that is not installed.',
        nodeId: REVIEWER_ID,
      },
    ]);
  });

  it('refuses every named skill when the snapshot froze none of them', async () => {
    const issues = await run([SKILL_A], [], []);
    expect(issues.map((issue) => [issue.code, issue.nodeId])).toEqual([
      ['missing_skill', WRITER_ID],
    ]);
  });

  it('does not check a run snapshotted before skills existed', async () => {
    expect(await run([SKILL_GONE], [SKILL_GONE])).toEqual([]);
  });

  it('ignores nodes that are not agents, and an agent stored before skillIds existed', () => {
    const legacy = agent(WRITER_ID, 'Legacy', []);
    if (legacy.kind !== 'agent') throw new Error('not an agent');
    const { skillIds: _dropped, ...withoutSkills } = legacy.config;
    const stored = { ...legacy, config: withoutSkills } as unknown as Node;
    expect(missingSkillIssues([inputNode, stored], [])).toEqual([]);
  });
});
