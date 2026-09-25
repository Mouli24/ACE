import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Generates the round 3 acceptance fixtures (round 3 §4 item 8). Run from the repo root:
 *
 *   node tests/acceptance/fixtures/round-3/generate.mjs
 *
 * Every id is fixed, so a fixture is byte-stable across regenerations and a `git diff` appears
 * only when the fixture genuinely changed. `fixtures-round-3.test.ts` in `packages/providers`
 * parses everything written here against the real contract schemas, so a fixture that drifts out
 * of shape fails in `pnpm test` rather than halfway through an acceptance run.
 */

const OUT = join(process.cwd(), 'tests', 'acceptance', 'fixtures', 'round-3');
mkdirSync(OUT, { recursive: true });

const EXPORTED_AT = '2026-09-26T09:00:00.000Z';

/**
 * Crockford base-32 ULIDs (D21): 26 characters from 0123456789ABCDEFGHJKMNPQRSTVWXYZ with a first
 * character of 0-7. Fixed rather than generated, so the output is byte-stable.
 */
const ULID_REGEX = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

const id = (tag, slot) => {
  const value = `01M3R3${tag}${'0'.repeat(16)}${slot}`;
  // Crockford base-32 has no I, L, O or U, so a tag or slot using one is a broken id and the
  // engine would refuse the whole fixture. Fail here instead, with the id that is wrong.
  if (!ULID_REGEX.test(value)) throw new Error(`"${value}" is not a ULID.`);
  return value;
};

/** Placeholders a harness rewrites once the engine has minted the real ids. See README.md. */
const PROVIDER = id('PV', 'PV');
const PROJECT = id('PJ', 'PJ');
const POLICY = id('PC', 'PC');

const port = (nodeId, dir, name, dataType, multi) => ({
  id: `${nodeId}:${dir}:${name}`,
  name,
  dataType,
  multi,
});

const OUTPUT_TYPES = ['text', 'json', 'image', 'audio', 'video', 'code', 'file'];

const inputNode = (workflowId, nodeId, text, name = 'Input', position = { x: 80, y: 200 }) => ({
  id: nodeId,
  workflowId,
  kind: 'input',
  name,
  position,
  inputs: [],
  outputs: [port(nodeId, 'out', 'text', 'text', true)],
  config: { text, artifactIds: [], outputTypes: ['text'] },
});

const agentNode = (workflowId, nodeId, name, position, overrides = {}) => {
  const inputTypes = overrides.inputTypes ?? ['text'];
  const outputTypes = overrides.outputTypes ?? ['text'];
  return {
    id: nodeId,
    workflowId,
    kind: 'agent',
    name,
    position,
    inputs: inputTypes.map((type) => port(nodeId, 'in', type, type, false)),
    outputs: outputTypes.map((type) => port(nodeId, 'out', type, type, true)),
    config: {
      providerId: PROVIDER,
      modelId: 'mock-text',
      routing: { policy: 'fixed', fallbackModelIds: [] },
      instructions: 'Answer the input in one short paragraph.',
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

const mergeNode = (workflowId, nodeId, mode, name = 'Merge', position = { x: 760, y: 200 }) => ({
  id: nodeId,
  workflowId,
  kind: 'merge',
  name,
  position,
  inputs: [port(nodeId, 'in', 'in', 'text', true), port(nodeId, 'in', 'in_json', 'json', true)],
  outputs: [port(nodeId, 'out', 'out', 'json', true)],
  config: { mode },
});

const outputNode = (workflowId, nodeId, name = 'Output', position = { x: 1080, y: 200 }) => ({
  id: nodeId,
  workflowId,
  kind: 'output',
  name,
  position,
  inputs: OUTPUT_TYPES.map((type) => port(nodeId, 'in', type, type, false)),
  outputs: [],
  config: {},
});

const dataEdge = (workflowId, edgeId, from, fromPort, to, toPort) => ({
  id: edgeId,
  workflowId,
  kind: 'data',
  from: { nodeId: from, portId: `${from}:out:${fromPort}` },
  to: { nodeId: to, portId: `${to}:in:${toPort}` },
});

const loopEdge = (workflowId, edgeId, from, fromPort, to, toPort, loop) => ({
  ...dataEdge(workflowId, edgeId, from, fromPort, to, toPort),
  kind: 'loop',
  loop,
});

/**
 * `REVIEW_CONTRACT_SCHEMA` from `@ace/contracts`, inlined because this generator is plain ESM and
 * cannot import TypeScript. `fixtures-round-3.test.ts` asserts the two are equal, so a change to
 * the contract fails there rather than silently leaving these fixtures behind.
 */
const REVIEW_CONTRACT_SCHEMA = {
  type: 'object',
  required: ['score', 'verdict', 'issues'],
  properties: {
    score: { type: 'number', minimum: 0, maximum: 10 },
    verdict: { type: 'string', enum: ['approved', 'changes_requested'] },
    issues: { type: 'array', items: { type: 'string' } },
  },
};

const write = (file, doc) => {
  writeFileSync(join(OUT, file), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  console.log('wrote', file);
};

const workflow = (name, nodes, edges) => ({
  formatVersion: 1,
  exportedAt: EXPORTED_AT,
  name,
  nodes,
  edges,
});

/* -------------------------------------------------------------------------- */
/* 1 + 2. Review -> Fix loops (FR-PAR-003..007)                                */
/* -------------------------------------------------------------------------- */

/**
 * Input -> Writer -> Reviewer -> Output, with a loop edge from the Reviewer back to the Writer.
 * The Reviewer answers the ReviewContract, so the loop's exit condition reads `verdict` off a real
 * json output — which is what `validateLoopConfig` insists on.
 */
function reviewLoop({ file, name, tag, reviewerModel }) {
  const wf = id(tag, 'WF');
  const input = id(tag, 'NA');
  const writer = id(tag, 'NB');
  const reviewer = id(tag, 'NC');
  const output = id(tag, 'ND');

  write(
    file,
    workflow(
      name,
      [
        inputNode(wf, input, 'Draft a short paragraph on the quarterly result.'),
        agentNode(wf, writer, 'Writer', { x: 400, y: 200 }, {
          modelId: 'mock-text',
          instructions:
            'Write a short paragraph on the input. When the reviewer asks for changes, ' +
            'rewrite it addressing every issue listed.',
        }),
        agentNode(wf, reviewer, 'Reviewer', { x: 760, y: 200 }, {
          modelId: reviewerModel,
          outputTypes: ['json'],
          instructions:
            'Review the draft. Answer with a score out of ten, a verdict and the issues you found.',
          outputContract: { jsonSchema: REVIEW_CONTRACT_SCHEMA },
        }),
        outputNode(wf, output),
      ],
      [
        dataEdge(wf, id(tag, 'EA'), input, 'text', writer, 'text'),
        dataEdge(wf, id(tag, 'EB'), writer, 'text', reviewer, 'text'),
        dataEdge(wf, id(tag, 'EC'), reviewer, 'json', output, 'json'),
        loopEdge(wf, id(tag, 'EZ'), reviewer, 'json', writer, 'text', {
          maxIterations: 3,
          exitCondition: { path: 'verdict', equals: 'approved' },
          onMax: 'continue',
        }),
      ],
    ),
  );
}

/** Approved on the third iteration: the loop ends on its exit condition (TC-PAR-003). */
reviewLoop({
  file: 'review-fix.json',
  name: 'Review and fix',
  tag: 'AA',
  reviewerModel: 'mock-reject-twice',
});

/** Never approved: the loop can only end at `max_iterations`, then `onMax: continue` (TC-PAR-005). */
reviewLoop({
  file: 'review-never.json',
  name: 'Review that never approves',
  tag: 'BB',
  reviewerModel: 'mock-reject-always',
});

/* -------------------------------------------------------------------------- */
/* 3 + 4. Parallel branches into a Merge node (FR-PAR-001, FR-PAR-002)         */
/* -------------------------------------------------------------------------- */

/**
 * Input -> two agents -> Merge -> Writer -> Output.
 *
 * The branches are deliberately unlike each other: the Analyst is `mock-slow` (100 words, 20 ms
 * apart, so two seconds) into the merge's `in` port, and the Scorer is `mock-json` (instant) into
 * its `in_json` port. Two distinct ports, so "ordered by input port order" has something to order;
 * two distinct durations, so `any` has a deterministic winner (the Scorer) while the Analyst still
 * completes and is recorded without feeding the merge.
 */
function parallelMerge({ file, name, tag, mode }) {
  const wf = id(tag, 'WF');
  const input = id(tag, 'NA');
  const analyst = id(tag, 'NB');
  const scorer = id(tag, 'NC');
  const merge = id(tag, 'ND');
  const writer = id(tag, 'NE');
  const output = id(tag, 'NF');

  write(
    file,
    workflow(
      name,
      [
        inputNode(wf, input, 'Assess the quarterly result from both angles.'),
        agentNode(wf, analyst, 'Analyst', { x: 400, y: 80 }, {
          modelId: 'mock-slow',
          instructions: 'Analyse the input at length.',
        }),
        agentNode(wf, scorer, 'Scorer', { x: 400, y: 320 }, {
          modelId: 'mock-json',
          outputTypes: ['json'],
          instructions: 'Score the input and answer as json.',
        }),
        mergeNode(wf, merge, mode),
        agentNode(wf, writer, 'Writer', { x: 1080, y: 200 }, {
          modelId: 'mock-text',
          inputTypes: ['json'],
          instructions: 'Write one paragraph from the merged inputs.',
        }),
        outputNode(wf, output, 'Output', { x: 1400, y: 200 }),
      ],
      [
        dataEdge(wf, id(tag, 'EA'), input, 'text', analyst, 'text'),
        dataEdge(wf, id(tag, 'EB'), input, 'text', scorer, 'text'),
        dataEdge(wf, id(tag, 'EC'), analyst, 'text', merge, 'in'),
        dataEdge(wf, id(tag, 'ED'), scorer, 'json', merge, 'in_json'),
        dataEdge(wf, id(tag, 'EE'), merge, 'out', writer, 'json'),
        dataEdge(wf, id(tag, 'EF'), writer, 'text', output, 'text'),
      ],
    ),
  );
}

parallelMerge({ file: 'parallel-merge-all.json', name: 'Parallel merge (all)', tag: 'CC', mode: 'all' });
parallelMerge({ file: 'parallel-merge-any.json', name: 'Parallel merge (any)', tag: 'DD', mode: 'any' });

/* -------------------------------------------------------------------------- */
/* 5 + 6. Errors and retries (FR-ERR-005, FR-ERR-006)                          */
/* -------------------------------------------------------------------------- */

/**
 * `mock-429-then-ok` is rate-limited on its first two attempts. `retries: 2` allows attempts 2 and
 * 3, so the node completes automatically on attempt 3 and nobody presses Retry (TC-ERR-005).
 */
{
  const tag = 'EE';
  const wf = id(tag, 'WF');
  const input = id(tag, 'NA');
  const agent = id(tag, 'NB');
  const output = id(tag, 'NC');

  write(
    'retry-429.json',
    workflow(
      'Retry after rate limiting',
      [
        inputNode(wf, input, 'Summarise the quarterly result.'),
        agentNode(wf, agent, 'Summariser', { x: 400, y: 200 }, {
          modelId: 'mock-429-then-ok',
          execution: { temperature: 0.7, maxTokens: 4096, timeoutMs: 120000, retries: 2 },
        }),
        outputNode(wf, output, 'Output', { x: 760, y: 200 }),
      ],
      [
        dataEdge(wf, id(tag, 'EA'), input, 'text', agent, 'text'),
        dataEdge(wf, id(tag, 'EB'), agent, 'text', output, 'text'),
      ],
    ),
  );
}

/**
 * An auth failure is never retried (Arch §28), and the node after it goes BLOCKED rather than
 * FAILED (FR-ERR-006) — which is why there is a second agent downstream to look at.
 */
{
  const tag = 'FF';
  const wf = id(tag, 'WF');
  const input = id(tag, 'NA');
  const gate = id(tag, 'NB');
  const after = id(tag, 'NC');
  const output = id(tag, 'ND');

  write(
    'auth-401.json',
    workflow(
      'Auth failure blocks downstream',
      [
        inputNode(wf, input, 'Summarise the quarterly result.'),
        agentNode(wf, gate, 'Gatekeeper', { x: 400, y: 200 }, { modelId: 'mock-401' }),
        agentNode(wf, after, 'Downstream', { x: 760, y: 200 }, {
          modelId: 'mock-text',
          instructions: 'Tidy up whatever the Gatekeeper produced.',
        }),
        outputNode(wf, output, 'Output', { x: 1080, y: 200 }),
      ],
      [
        dataEdge(wf, id(tag, 'EA'), input, 'text', gate, 'text'),
        dataEdge(wf, id(tag, 'EB'), gate, 'text', after, 'text'),
        dataEdge(wf, id(tag, 'EC'), after, 'text', output, 'text'),
      ],
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* 7 + 8 + 9. Guardrails and budgets (FR-GRD-008, FR-GRD-010, FR-GRD-013)      */
/* -------------------------------------------------------------------------- */

/**
 * An output `pii` check at `ask_user`: the node goes WAITING with an approval card (TC-GRD-008/009).
 *
 * The Writer is on `mock-json`, which echoes its input — that is how the email address in the
 * Input node actually reaches the *output*, where the check runs. `mock-text` would ignore the
 * instruction, because a deterministic mock answers from a word list and not from what it is told.
 *
 * The policy itself cannot live in this file: `WorkflowExport` has no field for one. It ships
 * beside it as `pii-ask.policy.json`, a `CreateGuardrailPolicyRequest` the harness POSTs first.
 */
{
  const tag = 'GG';
  const wf = id(tag, 'WF');
  const input = id(tag, 'NA');
  const writer = id(tag, 'NB');
  const output = id(tag, 'NC');

  write(
    'pii-ask.json',
    workflow(
      'PII asks before it leaves',
      [
        inputNode(
          wf,
          input,
          'Confirm the handover and send it to dana.ellis@example.com when it is ready.',
        ),
        agentNode(wf, writer, 'Writer', { x: 400, y: 200 }, {
          modelId: 'mock-json',
          outputTypes: ['json'],
          instructions:
            'Confirm the handover. Repeat the email address you were given, in full, so the ' +
            'reader knows where it went.',
          guardrailPolicyId: POLICY,
        }),
        outputNode(wf, output, 'Output', { x: 760, y: 200 }),
      ],
      [
        dataEdge(wf, id(tag, 'EA'), input, 'text', writer, 'text'),
        dataEdge(wf, id(tag, 'EB'), writer, 'json', output, 'json'),
      ],
    ),
  );

  write('pii-ask.policy.json', {
    projectId: PROJECT,
    name: 'Ask before PII leaves a node',
    checks: [
      {
        id: id('PC', 'CA'),
        point: 'output',
        type: 'pii',
        action: 'ask_user',
        enabled: true,
        params: {},
      },
    ],
  });
}

/**
 * `mock-leak` puts a credential-shaped string in its output, which the default policy's output
 * `secret_leak block` must catch (TC-GRD-010). No sidecar: the default policy is created with
 * every project (FR-GRD-018), so this fixture is the workflow and nothing else.
 */
{
  const tag = 'HH';
  const wf = id(tag, 'WF');
  const input = id(tag, 'NA');
  const agent = id(tag, 'NB');
  const output = id(tag, 'NC');

  write(
    'leak.json',
    workflow(
      'Leaked key',
      [
        inputNode(wf, input, 'Explain how to authenticate against the internal service.'),
        agentNode(wf, agent, 'Helper', { x: 400, y: 200 }, { modelId: 'mock-leak' }),
        outputNode(wf, output, 'Output', { x: 760, y: 200 }),
      ],
      [
        dataEdge(wf, id(tag, 'EA'), input, 'text', agent, 'text'),
        dataEdge(wf, id(tag, 'EB'), agent, 'text', output, 'text'),
      ],
    ),
  );
}

/**
 * A run cap of $0.01 against the mock price table (`outputPer1k` 0.002, `inputPer1k` 0.001).
 *
 * The Drafter is capped at 2048 tokens, so even the most pessimistic projection of it
 * (2048 x 0.003 / 1000 = $0.0061) stays under the cap and its two seconds of `mock-slow` really
 * run. The Editor asks for 20000 tokens, so the cheapest projection of it ($0.02) is already over
 * — the run halts `budget_exceeded` mid-run rather than at pre-flight (§2.3, FR-GRD-008).
 *
 * The cap itself is not a `WorkflowExport` field: it ships beside this file as
 * `budget-cap.project.json`, an `UpdateProjectRequest` the harness PATCHes onto the project.
 */
{
  const tag = 'JJ';
  const wf = id(tag, 'WF');
  const input = id(tag, 'NA');
  const drafter = id(tag, 'NB');
  const editor = id(tag, 'NC');
  const output = id(tag, 'ND');

  write(
    'budget-cap.json',
    workflow(
      'Budget cap',
      [
        inputNode(wf, input, 'Write and then edit a long answer on the quarterly result.'),
        agentNode(wf, drafter, 'Drafter', { x: 400, y: 200 }, {
          modelId: 'mock-slow',
          instructions: 'Write a long answer, slowly.',
          execution: { temperature: 0.7, maxTokens: 2048, timeoutMs: 120000, retries: 2 },
        }),
        agentNode(wf, editor, 'Editor', { x: 760, y: 200 }, {
          modelId: 'mock-slow',
          instructions: 'Edit the draft at length.',
          execution: { temperature: 0.7, maxTokens: 20000, timeoutMs: 120000, retries: 2 },
        }),
        outputNode(wf, output, 'Output', { x: 1080, y: 200 }),
      ],
      [
        dataEdge(wf, id(tag, 'EA'), input, 'text', drafter, 'text'),
        dataEdge(wf, id(tag, 'EB'), drafter, 'text', editor, 'text'),
        dataEdge(wf, id(tag, 'EC'), editor, 'text', output, 'text'),
      ],
    ),
  );

  write('budget-cap.project.json', { maxCostPerRunUsd: 0.01 });
}
