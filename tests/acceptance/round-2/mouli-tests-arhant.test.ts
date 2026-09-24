import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  type Envelope,
  type Model,
  type NodeRun,
  type Part,
  type Provider,
  type Run,
  type WorkflowExport,
} from '@ace/contracts';
import { RunEventBuffer, createAceClient, type AceClient } from '@ace/sdk';
import WebSocket from 'ws';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Round 2 cross-test: Mouli verifying Arhant's A2 engine
 * (`docs/team-prompts/02-round-2-providers-execution.md` §7.2).
 *
 * Everything drives the **real engine** over HTTP and WebSocket through `@ace/sdk`, the way the web
 * app does — the engine from `global-setup.ts`, a temp database, the mock provider, no env vars and
 * no keys. Where a check needs to watch a run happen, it folds the frames with the same
 * `RunEventBuffer` the UI uses, so what this asserts is what a user would see.
 */

const url = process.env['ACE_URL'] as string;
const wsUrl = process.env['ACE_WS_URL'] as string;
const token = process.env['ACE_TOKEN'] as string;
const dataDir = process.env['ACE_DATA_DIR'] as string;

const client: AceClient = createAceClient({ baseUrl: url, token });

const FIXTURES = join(process.cwd(), 'tests', 'acceptance', 'fixtures', 'round-2');
/** Every agent node in a fixture names this placeholder; the harness rewrites it (fixtures README). */
const PLACEHOLDER_PROVIDER = '01M3R2PV0000000000000000PV';

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

let projectId: string;
/** The one mock provider every fixture is rewritten onto. */
let mockProviderId: string;

async function createMockProvider(name: string, extra: Record<string, unknown> = {}) {
  return client.createProvider({ type: 'mock', name, ...extra } as never);
}

/**
 * Load a fixture, point its agents at a real provider, import it, and answer the workflow id.
 * `patch` edits the export before import, which is how a scenario changes a model or a budget
 * without needing a fixture of its own.
 */
async function importFixture(
  file: string,
  options: { providerId?: string; patch?: (exported: WorkflowExport) => void } = {},
): Promise<{ workflowId: string; nodes: WorkflowExport['nodes'] }> {
  const exported = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')) as WorkflowExport;
  for (const node of exported.nodes) {
    const config = node.config as { providerId?: string };
    if (config.providerId === PLACEHOLDER_PROVIDER) {
      config.providerId = options.providerId ?? mockProviderId;
    }
  }
  options.patch?.(exported);
  const imported = await client.importWorkflow(projectId, exported);
  return { workflowId: imported.workflow.id, nodes: imported.nodes };
}

/** `GET /runs/:id` until it is no longer RUNNING, so a check reads a settled run. */
async function settled(runId: string, timeoutMs = 30_000): Promise<Run> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await client.getRun(runId);
    if (run.status !== 'RUNNING' && run.status !== 'PREFLIGHT') return run;
    if (Date.now() > deadline)
      throw new Error(`run ${runId} still ${run.status} after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function runFixture(
  file: string,
  options: Parameters<typeof importFixture>[1] = {},
): Promise<{ run: Run; workflowId: string; nodeRuns: NodeRun[] }> {
  const { workflowId } = await importFixture(file, options);
  const started = await client.startRun(workflowId, {});
  const run = await settled(started.id);
  return { run, workflowId, nodeRuns: await client.listNodeRuns(run.id) };
}

/** A socket already subscribed to a workflow, folding frames the way the UI does. */
async function watch(workflowId: string): Promise<{
  buffer: RunEventBuffer;
  frames: Array<{ type: string; seq?: number }>;
  socket: WebSocket;
  close: () => void;
}> {
  const socket = new WebSocket(`${wsUrl}?token=${token}`);
  const buffer = new RunEventBuffer();
  const frames: Array<{ type: string; seq?: number }> = [];
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  socket.on('message', (raw) => {
    const frame = JSON.parse(String(raw)) as { type: string; seq?: number };
    frames.push(frame);
    buffer.apply(frame as never);
  });
  socket.send(
    JSON.stringify({ type: 'subscribe', payload: { scope: 'workflow', id: workflowId } }),
  );
  return { buffer, frames, socket, close: () => socket.close() };
}

const until = async (predicate: () => boolean, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** Chars/4, the engine's own token estimate (round 2 §4 item 8). */
const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

const partText = (part: Part): string =>
  part.type === 'text' ? part.text : part.type === 'code' ? part.text : JSON.stringify(part);

beforeAll(async () => {
  const project = await client.createProject({ name: 'Round 2 cross-test' });
  projectId = project.id;
  const provider = await createMockProvider('Mock');
  mockProviderId = provider.id;
  // D-024: a new provider's catalogue is empty until this is asked for. Kept explicit rather than
  // hidden in a helper, because it is the workaround for an open defect, not the intended flow.
  await client.refreshModels(mockProviderId);
});

/* -------------------------------------------------------------------------- */
/* Providers and the catalog                                                   */
/* -------------------------------------------------------------------------- */

describe('TC-PRV-002 a key is stored, never returned', () => {
  it('reports keySet and keeps the key out of the body, the DB and the logs', async () => {
    /* Assembled at runtime: a key-shaped literal in a repository file is what the lint rule (and
       CLAUDE.md §2) exists to stop, and the redaction path is exercised just as well by this. */
    const secret = ['sk', 'ant', 'crosstest', '9f2b41d7c6'].join('-');
    const keyed = await client.createProvider({
      type: 'anthropic',
      name: 'Keyed',
      apiKey: secret,
    } as never);

    expect(keyed.keySet).toBe(true);
    expect(JSON.stringify(keyed)).not.toContain(secret);

    const listed = (await client.listProviders()).items.find((p: Provider) => p.id === keyed.id);
    expect(listed?.keySet).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(secret);

    // TC-SYS-008: not in the database file, not in any log the engine wrote (BR-07).
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else files.push(path);
      }
    };
    walk(dataDir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(readFileSync(file, 'latin1').includes(secret), `${file} contains the key`).toBe(false);
    }
  });
});

async function checkedStatus(
  name: string,
  input: { apiKey?: string; baseUrl?: string },
): Promise<string> {
  const provider = await client.createProvider({
    type: input.apiKey === undefined ? 'openai_compatible' : 'mock',
    name,
    ...input,
  } as never);
  const result = await client.checkProvider(provider.id);
  // The row keeps what the check found, so a screen that never called check still shows it.
  expect((await client.getProvider(provider.id)).status).toBe(result.status);
  return result.status;
}

describe('TC-PRV-003/004 a check maps to the right provider state', () => {
  it('an unreachable baseUrl is UNREACHABLE', async () => {
    expect(
      await checkedStatus('check-unreachable', { baseUrl: 'http://unreachable.local:9' }),
    ).toBe('UNREACHABLE');
  });

  it('a healthy mock provider is CONNECTED', async () => {
    const result = await client.checkProvider(mockProviderId);
    expect(result.status).toBe('CONNECTED');
    expect(result.checkedAt).toBeTruthy();
  });

  // D-025, fixed in #17: each mock provider now checks against its own row (§2.6).
  it('D-025: apiKey "bad" answers AUTH_FAILED', async () => {
    expect(await checkedStatus('check-bad', { apiKey: 'bad' })).toBe('AUTH_FAILED');
  });

  it('D-025: apiKey "ratelimited" answers RATE_LIMITED', async () => {
    expect(await checkedStatus('check-ratelimited', { apiKey: 'ratelimited' })).toBe(
      'RATE_LIMITED',
    );
  });
});

describe('TC-MOD-001/002/003 the catalog is discovered, sourced and filterable', () => {
  it('lists the mock models, and a manifest-only provider says source: manifest', async () => {
    const mock = (await client.listModels({ providerId: mockProviderId })).items;
    expect(mock.map((m: Model) => m.modelId)).toContain('mock-text');
    expect(mock.every((m: Model) => m.providerId === mockProviderId)).toBe(true);

    const anthropic = await client.createProvider({
      type: 'anthropic',
      name: 'Manifest',
      apiKey: ['sk', 'ant', 'manifest', 'only'].join('-'),
    } as never);
    await client.refreshModels(anthropic.id);
    const manifest = (await client.listModels({ providerId: anthropic.id })).items;

    expect(manifest.length).toBeGreaterThan(0);
    // FR-MOD-002: no listing is reachable in a test, so the shipped manifest is what shows up.
    expect(manifest.some((m: Model) => m.source === 'manifest')).toBe(true);
  });

  it('narrows by data type and by availability, as the config panel does', async () => {
    const images = (await client.listModels({ providerId: mockProviderId, inputType: 'image' }))
      .items;
    expect(images.length).toBeGreaterThan(0);
    expect(images.every((m: Model) => m.inputTypes.includes('image'))).toBe(true);
    expect(images.map((m: Model) => m.modelId)).not.toContain('mock-text');

    const available = (await client.listModels({ providerId: mockProviderId, available: true }))
      .items;
    expect(available.every((m: Model) => m.available)).toBe(true);
    const all = (await client.listModels({ providerId: mockProviderId })).items;
    expect(available.length).toBeLessThanOrEqual(all.length);
  });

  it('answers GET /providers as { items }, like every other collection (D64)', async () => {
    const page = await client.listProviders();
    expect(Array.isArray(page.items)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Running a workflow                                                         */
/* -------------------------------------------------------------------------- */

describe('TC-EXE-001 the demo workflow runs to COMPLETE', () => {
  it('produces the agent’s text as the Output node’s final output', async () => {
    const { run, nodeRuns } = await runFixture('linear-mock.json');

    expect(run.status).toBe('COMPLETE');
    expect(run.haltReason).toBeUndefined();

    const agentRun = nodeRuns.find((r) => r.modelUsed?.modelId === 'mock-text');
    expect(agentRun?.status).toBe('COMPLETED');
    const agentText = (agentRun?.output ?? []).map(partText).join('');
    expect(agentText.length).toBeGreaterThan(0);

    const outputNode = run.snapshot.nodes.find((n) => n.kind === 'output');
    const finalParts = run.finalOutput?.[outputNode?.id ?? ''] ?? [];
    expect(finalParts.map(partText).join('')).toBe(agentText);
  });
});

describe('TC-EXE-002 a run executes its snapshot, not the live graph', () => {
  it('runs a node deleted mid-run, and the snapshot still holds it', async () => {
    const { workflowId } = await importFixture('slow.json');
    const graph = await client.getWorkflow(workflowId);
    const agent = graph.nodes.find((n) => n.kind === 'agent');
    const started = await client.startRun(workflowId, {});

    // Delete the node the run is executing, through the same graph-ops the Canvas uses (BR-04).
    await client.applyGraphOps(workflowId, {
      baseVersion: graph.workflow.version,
      ops: [{ op: 'delete_node', nodeId: agent?.id as string }],
    });

    const run = await settled(started.id);
    const nodeRuns = await client.listNodeRuns(run.id);

    expect(run.status).toBe('COMPLETE');
    expect(run.snapshot.nodes.map((n) => n.id)).toContain(agent?.id);
    expect(nodeRuns.some((r) => r.nodeId === agent?.id && r.status === 'COMPLETED')).toBe(true);
    // And the live graph really did lose it.
    const after = await client.getWorkflow(workflowId);
    expect(after.nodes.map((n) => n.id)).not.toContain(agent?.id);
  });
});

describe('TC-EXE-003 pre-flight refuses a run without calling a provider', () => {
  it('blocks a run whose provider is unreachable, and records it', async () => {
    const unreachable = await client.createProvider({
      type: 'openai_compatible',
      name: 'Nothing listening',
      baseUrl: 'http://unreachable.local:9',
    } as never);
    const { workflowId } = await importFixture('linear-mock.json', {
      providerId: unreachable.id,
    });

    const run = await client.startRun(workflowId, {});

    // 201 with a recorded BLOCKED run, and no node ever reached the provider (BR-08).
    expect(run.status).toBe('BLOCKED');
    expect(run.preflightIssues.length).toBeGreaterThan(0);
    expect(await client.listNodeRuns(run.id)).toHaveLength(0);
    expect(run.totals.tokensIn + run.totals.tokensOut).toBe(0);
  });

  it('blocks an agent with no model, naming the node (TC-NODE-007)', async () => {
    const { workflowId } = await importFixture('linear-mock.json', {
      patch: (exported) => {
        for (const node of exported.nodes) {
          if (node.kind === 'agent') delete (node.config as { modelId?: string }).modelId;
        }
      },
    });

    const run = await client.startRun(workflowId, {});

    expect(run.status).toBe('BLOCKED');
    const named = run.preflightIssues.find((issue) => issue.nodeId !== undefined);
    expect(named?.message).toMatch(/agent/i);
  });
});

describe('TC-EXE-005 a contract violation is its own failure, not a run failure', () => {
  it('fails the node CONTRACT_VIOLATION with an agent error, and halts the run', async () => {
    const { run, nodeRuns } = await runFixture('contract-violation.json');

    const failed = nodeRuns.find((r) => r.status === 'FAILED');
    // BR-03: these three are never merged.
    expect(failed?.failureReason).toBe('CONTRACT_VIOLATION');
    expect(failed?.error?.kind).toBe('agent');
    expect(run.status).toBe('HALTED');
    expect(run.haltReason).toBe('failure');
  });
});

describe('TC-EXE-006 an envelope never exceeds its budget', () => {
  it('summarises a 50k-token input down to the 4000-token budget', async () => {
    const { nodeRuns } = await runFixture('budget.json');

    const envelopes = nodeRuns.flatMap((r) => r.inputEnvelopes);
    expect(envelopes.length).toBeGreaterThan(0);

    for (const envelope of envelopes as Envelope[]) {
      const readsText = envelope.reads.map(partText).join('');
      const contextText = [
        envelope.context.summary ?? '',
        ...(envelope.context.retrieved ?? []).map((chunk) => JSON.stringify(chunk)),
      ].join('');
      expect(estimateTokens(readsText + contextText)).toBeLessThanOrEqual(
        envelope.context.budgetTokens,
      );
      // BR-13: model-generated or user-supplied content travels labelled untrusted.
      expect(envelope.context.trust).toBeDefined();
    }
    expect(envelopes.some((e) => e.context.summary !== undefined)).toBe(true);
  });
});

describe('TC-RTR-002/003 the fallback chain is walked, and exhaustion is a provider failure', () => {
  it('completes through the fallback and says viaFallback', async () => {
    const { run, nodeRuns } = await runFixture('fallback.json');

    expect(run.status).toBe('COMPLETE');
    const agentRun = nodeRuns.find((r) => r.modelUsed !== undefined);
    expect(agentRun?.status).toBe('COMPLETED');
    expect(agentRun?.modelUsed?.viaFallback).toBe(true);
    expect(agentRun?.modelUsed?.modelId).not.toBe('mock-503');
  });

  it('fails RUN_FAILED with a provider error when every model in the chain 503s', async () => {
    const { run, nodeRuns } = await runFixture('fallback.json', {
      patch: (exported) => {
        for (const node of exported.nodes) {
          const config = node.config as {
            modelId?: string;
            routing?: { policy: string; fallbackModelIds: string[] };
          };
          if (config.routing) config.routing.fallbackModelIds = ['mock-503'];
        }
      },
    });

    const failed = nodeRuns.find((r) => r.status === 'FAILED');
    expect(failed?.failureReason).toBe('RUN_FAILED');
    expect(failed?.error?.kind).toBe('provider');
    expect(run.status).toBe('HALTED');
  });
});

describe('TC-EXE-010/011 a failed Output path halts, and the history is newest first', () => {
  it('halts when the Output node’s agent cannot answer', async () => {
    const { run } = await runFixture('fallback.json', {
      patch: (exported) => {
        for (const node of exported.nodes) {
          const config = node.config as {
            modelId?: string;
            routing?: { fallbackModelIds: string[] };
          };
          if (config.modelId !== undefined) config.modelId = 'mock-503';
          if (config.routing) config.routing.fallbackModelIds = [];
        }
      },
    });

    expect(run.status).toBe('HALTED');
    expect(run.finalOutput ?? {}).toEqual({});
  });

  it('lists three runs newest first with their totals and durations', async () => {
    const { workflowId } = await importFixture('linear-mock.json');
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const started = await client.startRun(workflowId, {});
      await settled(started.id);
      ids.push(started.id);
    }

    const history = (await client.listRuns(workflowId)).items;

    expect(history.map((r) => r.id)).toEqual([...ids].reverse());
    for (const row of history) {
      expect(row.status).toBe('COMPLETE');
      expect(row.durationMs).toBeGreaterThanOrEqual(0);
      expect(row.totals.tokensOut).toBeGreaterThan(0);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Watching a run                                                             */
/* -------------------------------------------------------------------------- */

describe('TC-EXE-013 a dropped socket resumes without losing or duplicating a state', () => {
  it('replays the persisted frames after afterSeq and ends on the engine’s own record', async () => {
    const { workflowId } = await importFixture('slow.json');
    const first = await watch(workflowId);

    const started = await client.startRun(workflowId, {});
    await until(() => first.frames.filter((f) => f.type === 'node.state').length >= 2);

    const seqsBefore = first.frames
      .filter((f) => typeof f.seq === 'number')
      .map((f) => f.seq as number);
    const lastSeq = Math.max(...seqsBefore);
    first.close();

    // Reconnect the way `@ace/sdk` does: subscribe, then ask for everything after the last seq.
    const second = new WebSocket(`${wsUrl}?token=${token}`);
    const replayed: Array<{ type: string; seq?: number; payload?: unknown }> = [];
    const buffer = new RunEventBuffer();
    for (const frame of first.frames) buffer.apply(frame as never);
    await new Promise<void>((resolve, reject) => {
      second.once('open', () => resolve());
      second.once('error', reject);
    });
    second.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as { type: string; seq?: number };
      replayed.push(frame);
      buffer.apply(frame as never);
    });
    second.send(
      JSON.stringify({ type: 'subscribe', payload: { scope: 'workflow', id: workflowId } }),
    );
    second.send(JSON.stringify({ type: 'resume', payload: { afterSeq: lastSeq } }));

    await until(() => replayed.some((f) => f.type === 'run.completed'), 30_000);
    second.close();

    const run = await settled(started.id);
    const nodeRuns = await client.listNodeRuns(run.id);
    const view = buffer.view;

    // Nothing before the cut is replayed, and nothing after it is lost.
    expect(
      replayed.filter((f) => typeof f.seq === 'number').every((f) => (f.seq as number) > lastSeq),
    ).toBe(true);
    const allSeqs = [
      ...seqsBefore,
      ...replayed.map((f) => f.seq).filter((s): s is number => typeof s === 'number'),
    ];
    expect(new Set(allSeqs).size).toBe(allSeqs.length);

    // The fold a reconnecting client ends with is the engine's own record of the run.
    expect(view.status).toBe(run.status);
    for (const nodeRun of nodeRuns) {
      expect(view.nodeState(nodeRun.nodeId)).toBe(nodeRun.status);
    }
  });
});

describe('TC-EXE-008 a client that subscribes after the 201 still sees the run', () => {
  it('receives streamed tokens, and node.token carries no seq (D65, §2.4)', async () => {
    const { workflowId } = await importFixture('slow.json');

    // The order the UI uses: start, *then* subscribe. Before D65 the run was over by now.
    const started = await client.startRun(workflowId, {});
    expect(started.status).toBe('RUNNING');
    const watching = await watch(workflowId);

    await until(() => watching.frames.some((f) => f.type === 'run.completed'), 30_000);
    watching.close();

    const tokens = watching.frames.filter((f) => f.type === 'node.token');
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every((f) => f.seq === undefined)).toBe(true);

    const streamed = watching.buffer.view;
    const nodeRuns = await client.listNodeRuns(started.id);
    const agentRun = nodeRuns.find((r) => r.modelUsed !== undefined) as NodeRun;
    // What streamed is what the engine recorded, not a different rendering of it. Trimmed: the
    // concatenated deltas end with the separator space that the stored output does not carry
    // (D-026, Low) — the words and their order are the part that must agree.
    expect(streamed.streamedText(agentRun.id).trim()).toBe(
      (agentRun.output ?? []).map(partText).join('').trim(),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Prompts, usage and concurrency                                             */
/* -------------------------------------------------------------------------- */

describe('TC-PRM-001 the same config produces the same prompt, byte for byte', () => {
  it('two runs of one workflow record an identical prompt and version', async () => {
    const { workflowId } = await importFixture('linear-mock.json');
    const first = await settled((await client.startRun(workflowId, {})).id);
    const second = await settled((await client.startRun(workflowId, {})).id);

    const promptOf = async (run: Run) => {
      const runs = await client.listNodeRuns(run.id);
      return runs.find((r) => r.prompt !== undefined)?.prompt;
    };
    const a = await promptOf(first);
    const b = await promptOf(second);

    expect(a?.text).toBeTruthy();
    expect(b?.text).toBe(a?.text);
    expect(b?.version).toBe(a?.version);
    // FR-PRM-005: the stored prompt is what was sent, and it holds no key.
    expect(a?.text).not.toMatch(/sk-[A-Za-z0-9-]{8,}/);
  });
});

describe('TC-OBS-002/003 the totals are the sum of the node runs, on a recorded price table', () => {
  it('sums exactly, names its price table, and does not move when the catalog refreshes', async () => {
    const { run, nodeRuns } = await runFixture('linear-mock.json');

    const sum = nodeRuns.reduce(
      (total, nodeRun) => ({
        tokensIn: total.tokensIn + nodeRun.usage.tokensIn,
        tokensOut: total.tokensOut + nodeRun.usage.tokensOut,
        costUsd: total.costUsd + nodeRun.usage.costUsd,
      }),
      { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    );
    expect(run.totals.tokensIn).toBe(sum.tokensIn);
    expect(run.totals.tokensOut).toBe(sum.tokensOut);
    expect(run.totals.costUsd).toBeCloseTo(sum.costUsd, 10);
    expect(run.totals.priceTableVersion).toBeTruthy();

    // FR-OBS-003: a refresh re-reads the catalog; a recorded run is not re-priced (BR-04).
    await client.refreshModels(mockProviderId);
    const after = await client.getRun(run.id);
    expect(after.totals).toEqual(run.totals);
    expect(await client.listNodeRuns(run.id)).toEqual(nodeRuns);
  });
});

describe('TC-PRV-009 a provider’s concurrency limit is respected', () => {
  /*
   * D-027, fixed in #17 (one gate per provider), and D66: a node queued behind the limit stays READY
   * and is stamped `startedAt` only when it holds a slot, so node-run spans show the limit too.
   */
  it('D-027: five agents never run more than two at once on a provider limited to two', async () => {
    const limited = await client.createProvider({
      type: 'mock',
      name: 'Limited',
      concurrency: 2,
    } as never);
    await client.refreshModels(limited.id);

    /*
     * Five agents fed by one Input, all ready at once, so only the limit can stagger them — and on
     * `mock-slow`, because `mock-text` returns inside a millisecond and five instant calls overlap
     * indistinguishably whatever the limit is.
     */
    const { workflowId } = await importFixture('slow.json', {
      providerId: limited.id,
      patch: (exported) => {
        const input = exported.nodes.find((n) => n.kind === 'input');
        const agent = exported.nodes.find((n) => n.kind === 'agent');
        const output = exported.nodes.find((n) => n.kind === 'output');
        if (!input || !agent || !output) throw new Error('fixture shape changed');
        const extras = [1, 2, 3, 4].map((i) => ({
          ...structuredClone(agent),
          id: agent.id.slice(0, -1) + String(i),
          name: `Agent ${i}`,
          inputs: structuredClone(agent.inputs).map((port) => ({
            ...port,
            id: `${agent.id.slice(0, -1) + String(i)}:in:${port.name}`,
          })),
          outputs: structuredClone(agent.outputs).map((port) => ({
            ...port,
            id: `${agent.id.slice(0, -1) + String(i)}:out:${port.name}`,
          })),
        }));
        exported.nodes.push(...extras);
        for (const extra of extras) {
          exported.edges.push({
            id: `${extra.id.slice(0, -2)}E${extra.id.slice(-1)}`,
            workflowId: exported.edges[0]?.workflowId ?? '',
            kind: 'data',
            from: { nodeId: input.id, portId: input.outputs[0]?.id as string },
            to: { nodeId: extra.id, portId: extra.inputs[0]?.id as string },
          } as never);
        }
      },
    });

    const run = await settled((await client.startRun(workflowId, {})).id);
    const nodeRuns = await client.listNodeRuns(run.id);
    const agentRuns = nodeRuns.filter((r) => r.modelUsed !== undefined);
    expect(agentRuns.length).toBe(5);

    /* Overlap from the engine's own timestamps: at no instant were more than two running. */
    const spans = agentRuns
      .map((r) => ({ from: Date.parse(r.startedAt ?? ''), to: Date.parse(r.endedAt ?? '') }))
      .filter((span) => Number.isFinite(span.from) && Number.isFinite(span.to));
    expect(spans.length).toBe(5);
    // A sweep over the start and end instants, ends first on a tie: counting the spans that touch
    // one span overstates it, because a slot handed on mid-span meets two spans, one after another.
    const edges = spans
      .flatMap((span) => [
        { at: span.from, delta: 1 },
        { at: span.to, delta: -1 },
      ])
      .sort((a, b) => a.at - b.at || a.delta - b.delta);
    let running = 0;
    let peak = 0;
    for (const edge of edges) {
      running += edge.delta;
      peak = Math.max(peak, running);
    }
    expect(peak, `peak overlap was ${peak}`).toBeLessThanOrEqual(2);
  });
});
