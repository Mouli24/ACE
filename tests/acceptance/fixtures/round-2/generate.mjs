import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Generates the round 2 acceptance fixtures (§4 item 13). Run from the repo root.
 * Every id is fixed, so a fixture is byte-stable across regenerations.
 */

const ROOT = process.cwd();
const OUT = join(ROOT, 'tests', 'acceptance', 'fixtures', 'round-2');
mkdirSync(OUT, { recursive: true });

const EXPORTED_AT = '2026-09-22T12:00:00.000Z';

/**
 * Every id here is a real Crockford ULID (D21): 26 characters from 0123456789ABCDEFGHJKMNPQRSTVWXYZ
 * with a first character of 0-7. They are fixed rather than generated so a fixture is byte-stable.
 */
const id = (tag, slot) => `01M3R2${tag}${'0'.repeat(16)}${slot}`;

/** The harness rewrites this to the real mock provider id after it creates one. */
const PROVIDER = id('PV', 'PV');

const wf = (tag) => id(tag, 'WF');
const nid = (tag, slot) => id(tag, slot);

const port = (nodeId, dir, name, dataType, multi) => ({
  id: `${nodeId}:${dir}:${name}`,
  name,
  dataType,
  multi,
});

const inputNode = (workflowId, id, text, name = 'Input') => ({
  id,
  workflowId,
  kind: 'input',
  name,
  position: { x: 80, y: 120 },
  inputs: [],
  outputs: [port(id, 'out', 'text', 'text', true)],
  config: { text, artifactIds: [], outputTypes: ['text'] },
});

const agentNode = (workflowId, id, overrides = {}, name = 'Agent') => {
  const inputTypes = overrides.inputTypes ?? ['text'];
  const outputTypes = overrides.outputTypes ?? ['text'];
  return {
    id,
    workflowId,
    kind: 'agent',
    name,
    position: { x: 400, y: 120 },
    inputs: inputTypes.map((type) => port(id, 'in', type, type, false)),
    outputs: outputTypes.map((type) => port(id, 'out', type, type, true)),
    config: {
      providerId: PROVIDER,
      modelId: 'mock-text',
      routing: { policy: 'fixed', fallbackModelIds: [] },
      instructions: 'Summarise the input in one short paragraph.',
      inputTypes,
      outputTypes,
      execution: { temperature: 0.7, maxTokens: 4096, timeoutMs: 120000, retries: 2 },
      contextPolicy: { budgetTokens: 4000 },
      tools: { enabled: [], maxToolCalls: 10, allowedDomains: [] },
      knowledgeBaseIds: [],
      memory: { enabled: false },
      skillIds: [],
      ...overrides,
    },
  };
};

const outputNode = (workflowId, id, name = 'Output') => ({
  id,
  workflowId,
  kind: 'output',
  name,
  position: { x: 720, y: 120 },
  inputs: ['text', 'json', 'image', 'audio', 'video', 'code', 'file'].map((type) =>
    port(id, 'in', type, type, false),
  ),
  outputs: [],
  config: {},
});

const edge = (workflowId, id, from, fromType, to, toType) => ({
  id,
  workflowId,
  kind: 'data',
  from: { nodeId: from, portId: `${from}:out:${fromType}` },
  to: { nodeId: to, portId: `${to}:in:${toType}` },
});

function linear({ file, name, tag, inputText, agentOverrides }) {
  const workflowId = wf(tag);
  const input = nid(tag, 'NA');
  const agent = nid(tag, 'NB');
  const output = nid(tag, 'NC');
  const agentOutputType = agentOverrides?.outputTypes?.[0] ?? 'text';

  const doc = {
    formatVersion: 1,
    exportedAt: EXPORTED_AT,
    name,
    nodes: [
      inputNode(workflowId, input, inputText),
      agentNode(workflowId, agent, agentOverrides ?? {}),
      outputNode(workflowId, output),
    ],
    edges: [
      edge(workflowId, nid(tag, 'EA'), input, 'text', agent, 'text'),
      edge(workflowId, nid(tag, 'EB'), agent, agentOutputType, output, agentOutputType),
    ],
  };

  writeFileSync(join(OUT, file), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  console.log('wrote', file);
}

/* 1. Input -> Agent[mock-text] -> Output. The happy path of the §1 demo script. */
linear({
  file: 'linear-mock.json',
  name: 'Linear mock',
  tag: 'AA',
  inputText: 'Summarise the quarterly brief for the board.',
});

/* 2. Primary mock-503, fallback mock-text: the run completes on the second model (TC-RTR-002). */
linear({
  file: 'fallback.json',
  name: 'Fallback chain',
  tag: 'BB',
  inputText: 'Summarise the quarterly brief for the board.',
  agentOverrides: {
    modelId: 'mock-503',
    routing: { policy: 'fallback', fallbackModelIds: ['mock-text'] },
  },
});

/* 3. mock-bad-json against a JSON contract: CONTRACT_VIOLATION, not RUN_FAILED (TC-EXE-005). */
linear({
  file: 'contract-violation.json',
  name: 'Contract violation',
  tag: 'CC',
  inputText: 'Review this and answer as JSON.',
  agentOverrides: {
    modelId: 'mock-bad-json',
    outputTypes: ['json'],
    outputContract: {
      jsonSchema: {
        type: 'object',
        required: ['verdict', 'score'],
        properties: {
          verdict: { type: 'string', enum: ['approved', 'changes_requested'] },
          score: { type: 'integer' },
        },
      },
    },
  },
});

/* 4. A 50k-token input against a 4000-token budget (TC-EXE-006). */
linear({
  file: 'budget.json',
  name: 'Budget',
  tag: 'DD',
  // ~50k tokens at the engine's chars/4 estimate.
  inputText: 'lorem ipsum dolor sit amet '.repeat(7500),
  agentOverrides: { contextPolicy: { budgetTokens: 4000 } },
});

/* 5. mock-slow: 100 words 20 ms apart, for the streaming and reconnect tests. */
linear({
  file: 'slow.json',
  name: 'Slow stream',
  tag: 'EE',
  inputText: 'Write a long answer, slowly.',
  agentOverrides: { modelId: 'mock-slow' },
});
