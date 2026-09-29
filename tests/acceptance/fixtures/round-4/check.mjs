import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { WorkflowExportSchema } from '@ace/contracts';

/**
 * Validates the round 4 acceptance fixtures against the contract that has to load them. Run it after
 * building the one package it imports:
 *
 *   pnpm --filter @ace/contracts build
 *   node tests/acceptance/fixtures/round-4/check.mjs
 *
 * Round 3 keeps the equivalent as a vitest inside `packages/providers` (`fixtures-round-3.test.ts`),
 * where it rides `pnpm test` and imports `MOCK_MODELS` straight from the adapter. That package is out
 * of this task's scope, so round 4's check is a standalone script instead — same invariant (every
 * fixture parses as a `WorkflowExport`, and names only a model the mock adapter is known to have) —
 * and the model list below is a copy of the adapter's round-2/round-4 ids rather than an import of
 * them. The authoritative "every model exists in the adapter" assertion belongs beside `MOCK_MODELS`
 * in `packages/providers`; adding a `fixtures-round-4.test.ts` there (one file, the round-3 twin) is
 * the follow-up that puts this check on `pnpm test`. A malformed fixture fails here in a second
 * rather than as a confusing 400 partway through an acceptance run.
 *
 * Exit 0 = all good; exit 1 = a fixture is wrong, with the reason printed.
 */

/**
 * The mock adapter's model ids these fixtures use — round 2's `mock-text` plus round 4's nine
 * additions (round 4 §2.6, D216). Kept in step with `MOCK_MODELS` in `packages/providers`.
 */
const KNOWN_MOCK_MODELS = [
  'mock-text',
  'mock-tool',
  'mock-tool-loop',
  'mock-destructive',
  'mock-http',
  'mock-search',
  'mock-mcp',
  'mock-vision',
  'mock-media',
  'mock-chat',
];

const DIR = fileURLToPath(new URL('.', import.meta.url));
const read = (file) => JSON.parse(readFileSync(`${DIR}${file}`, 'utf8'));

/** The eleven workflows round 4 §4 item 6 lists, and nothing else. */
const WORKFLOW_FIXTURES = [
  'vision.json',
  'media.json',
  'tools-echo.json',
  'tools-loop.json',
  'destructive.json',
  'http-allowed.json',
  'http-denied.json',
  'search.json',
  'mcp.json',
  'chat-french.json',
  'injection-delete.json',
];

const PLACEHOLDER_PROVIDER = '01M4R4PV0000000000000000PV';
const PLACEHOLDER_PNG = '01M4R4AR0000000000000000AR';

/** What each fixture's one agent (or, for vision, its named agents) must enable and run. */
const EXPECTATIONS = {
  'vision.json': { models: ['mock-vision', 'mock-text'] },
  'media.json': { models: ['mock-media'] },
  'tools-echo.json': { models: ['mock-tool'], enabled: ['echo'] },
  'tools-loop.json': { models: ['mock-tool-loop'], enabled: ['echo'], maxToolCalls: 5 },
  'destructive.json': { models: ['mock-destructive'], enabled: ['sandbox_delete'] },
  'http-allowed.json': { models: ['mock-http'], enabled: ['http_request'], allowedDomainsNonEmpty: true },
  'http-denied.json': { models: ['mock-http'], enabled: ['http_request'], allowedDomainsEmpty: true },
  'search.json': { models: ['mock-search'], enabled: ['web_search', 'web_fetch'] },
  'mcp.json': { models: ['mock-mcp'], enabledPrefix: '__ACE_MCP' },
  'chat-french.json': { models: ['mock-chat'] },
  'injection-delete.json': { models: ['mock-destructive'], enabled: ['sandbox_delete'] },
};

const KNOWN_MODELS = new Set(KNOWN_MOCK_MODELS);

const failures = [];
const fail = (file, message) => failures.push(`${file}: ${message}`);

const agentsOf = (doc) => doc.nodes.filter((node) => node.kind === 'agent');

/* The directory holds exactly the eleven fixtures, plus the scripts and README this task ships. */
const jsonOnDisk = readdirSync(DIR)
  .filter((file) => file.endsWith('.json'))
  .sort();
const expected = [...WORKFLOW_FIXTURES].sort();
if (JSON.stringify(jsonOnDisk) !== JSON.stringify(expected)) {
  fail('(directory)', `.json files are ${jsonOnDisk.join(', ')}; expected ${expected.join(', ')}`);
}

for (const file of WORKFLOW_FIXTURES) {
  const parsed = WorkflowExportSchema.safeParse(read(file));
  if (!parsed.success) {
    fail(file, `does not parse as a WorkflowExport: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
    continue;
  }
  const doc = parsed.data;
  const agents = agentsOf(doc);
  const want = EXPECTATIONS[file];

  if (agents.length === 0) fail(file, 'has no agent node');

  // Every agent points at the rewritable provider placeholder and a model the mock adapter has.
  for (const agent of agents) {
    if (agent.config.providerId !== PLACEHOLDER_PROVIDER) {
      fail(file, `${agent.name} providerId is ${agent.config.providerId}, not the placeholder`);
    }
    if (!KNOWN_MODELS.has(agent.config.modelId)) {
      fail(file, `${agent.name} uses ${agent.config.modelId}, which the mock adapter does not have`);
    }
  }

  // The models this fixture is supposed to exercise are all present.
  const modelIds = agents.map((agent) => agent.config.modelId);
  for (const model of want.models) {
    if (!modelIds.includes(model)) fail(file, `expected a ${model} agent, found ${modelIds.join(', ')}`);
  }

  // Every edge wires to a port that exists.
  const ports = new Set(doc.nodes.flatMap((node) => [...node.inputs, ...node.outputs]).map((p) => p.id));
  for (const edge of doc.edges) {
    if (!ports.has(edge.from.portId)) fail(file, `edge ${edge.id} leaves a port that does not exist`);
    if (!ports.has(edge.to.portId)) fail(file, `edge ${edge.id} enters a port that does not exist`);
  }

  // The tool-shaped expectations: which tools an agent enables, and its call ceiling / allow-list.
  const toolAgent = agents.find((agent) => agent.config.tools.enabled.length > 0) ?? agents[0];
  const enabled = toolAgent.config.tools.enabled;
  if (want.enabled) {
    for (const name of want.enabled) {
      if (!enabled.includes(name)) fail(file, `${toolAgent.name} should enable ${name}, has ${enabled.join(', ') || '(none)'}`);
    }
  }
  if (want.enabledPrefix && !enabled.some((name) => name.startsWith(want.enabledPrefix))) {
    fail(file, `${toolAgent.name} should enable a ${want.enabledPrefix}* tool, has ${enabled.join(', ') || '(none)'}`);
  }
  if (want.maxToolCalls !== undefined && toolAgent.config.tools.maxToolCalls !== want.maxToolCalls) {
    fail(file, `${toolAgent.name} maxToolCalls is ${toolAgent.config.tools.maxToolCalls}, expected ${want.maxToolCalls}`);
  }
  if (want.allowedDomainsNonEmpty && toolAgent.config.tools.allowedDomains.length === 0) {
    fail(file, `${toolAgent.name} should list an allowed domain`);
  }
  if (want.allowedDomainsEmpty && toolAgent.config.tools.allowedDomains.length !== 0) {
    fail(file, `${toolAgent.name} should have an empty allow-list, has ${toolAgent.config.tools.allowedDomains.join(', ')}`);
  }
}

// The vision fixture attaches the rewritable PNG placeholder to its Input node.
{
  const doc = WorkflowExportSchema.parse(read('vision.json'));
  const input = doc.nodes.find((node) => node.kind === 'input');
  if (!input || input.config.artifactIds.length !== 1 || input.config.artifactIds[0] !== PLACEHOLDER_PNG) {
    fail('vision.json', `Input node should attach exactly the PNG placeholder ${PLACEHOLDER_PNG}`);
  }
}

if (failures.length > 0) {
  console.error(`FAIL — ${failures.length} problem(s):`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}

console.log(`OK — ${WORKFLOW_FIXTURES.length} fixtures parse as WorkflowExport and name only mock models the adapter has.`);
