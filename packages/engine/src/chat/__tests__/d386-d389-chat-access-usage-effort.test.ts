/**
 * PandaCode Wave 1 in node chat (docs/research/pandacode-integration-plan.md W1-1, W1-2, W1-5).
 *
 * - D386: an agentic node on a coding-agent CLI chats at its own access level, as its runs do
 *   (D383) — the call carries `cliAccess`, the rules it is told say the same level, and a Read-only
 *   turn is not a writing turn for the checkpoint gate. An Off node keeps the provider's preset.
 * - D387: a call that reports no usage is estimated (characters ÷ 4) and marked `estimated`, and
 *   the estimate counts toward the turn's cap. A reported usage keeps its shape.
 * - D389: the node's reasoning effort rides the chat call only when it is set.
 */
import type {
  AgentWorkspace,
  Id,
  Model,
  Node,
  Part,
  ReasoningEffort,
  WorkspaceAccess,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { newId } from '../../ids.js';
import type {
  CheckpointRecorder,
  GenerateRequest,
  ProviderAdapter,
  StreamChunk,
} from '../../ports/index.js';
import { FakeRepository } from '../../__tests__/fake-repository.js';
import {
  MODEL_ID,
  PROVIDER_ID,
  makeAgentNode,
  makeBus,
  makeChatService,
  makeClock,
  makeWorkflow,
  scope,
} from './harness.js';

const FOLDER = 'D:/projects/shop';
const hi: Part[] = [{ type: 'text', text: 'please add a README' }];

/** An adapter that plays one script per call and keeps every request it was sent. */
function scriptedAdapter(
  script: (req: GenerateRequest) => StreamChunk[],
  type: ProviderAdapter['type'] = 'claude_code',
): { adapter: ProviderAdapter; requests: GenerateRequest[] } {
  const requests: GenerateRequest[] = [];
  return {
    requests,
    adapter: {
      type,
      check: async () => ({ status: 'CONNECTED' }),
      listModels: async () => [],
      async *generate(req) {
        requests.push(req);
        for (const chunk of script(req)) yield chunk;
      },
    },
  };
}

const REPLY = 'I added README.md with a short description of the shop.';
const reported = (tokensIn = 3, tokensOut = 2): StreamChunk[] => [
  { type: 'text', delta: REPLY },
  { type: 'usage', tokensIn, tokensOut },
  { type: 'finish', reason: 'stop' },
];
/** What Codex and Gemini do: an answer and no usage chunk at all. */
const unreported = (): StreamChunk[] => [
  { type: 'text', delta: REPLY.slice(0, 20) },
  { type: 'text', delta: REPLY.slice(20) },
  { type: 'finish', reason: 'stop' },
];

const priced = (): Model => ({
  id: newId(),
  providerId: PROVIDER_ID,
  modelId: MODEL_ID,
  displayName: 'Mock chat',
  inputTypes: ['text'],
  outputTypes: ['text'],
  contextWindow: 100_000,
  supportsTools: false,
  supportsJson: false,
  available: true,
  source: 'discovered',
  lastCheckedAt: '2026-10-21T09:00:00.000Z',
  pricing: { inputPer1k: 10, outputPer1k: 10, priceTableVersion: 'pc-v1' },
});

/** A checkpoint recorder that cannot begin — git missing, say. */
const failingCheckpoints: CheckpointRecorder = {
  begin: async () => {
    throw new Error('git is not installed');
  },
};

interface World {
  repository: FakeRepository;
  node: Node;
  workflowId: Id;
}

async function world(
  options: {
    access?: WorkspaceAccess;
    allowedCommands?: string[];
    folderPath?: string;
    maxCostPerRunUsd?: number;
    reasoningEffort?: ReasoningEffort | null;
  } = {},
): Promise<World> {
  const repository = new FakeRepository();
  const projectId = newId();
  await repository.projects.create(scope, {
    id: projectId,
    name: 'Shop',
    folderPath: options.folderPath ?? FOLDER,
    ...(options.maxCostPerRunUsd === undefined
      ? {}
      : { maxCostPerRunUsd: options.maxCostPerRunUsd }),
    createdAt: '2026-10-21T09:00:00.000Z',
    updatedAt: '2026-10-21T09:00:00.000Z',
  });
  const workflow = makeWorkflow(projectId);
  await repository.workflows.create(scope, workflow);
  const base = makeAgentNode(workflow.id, { name: 'Coder', instructions: 'You write the code.' });
  if (base.kind !== 'agent') throw new Error('makeAgentNode made no agent');
  const workspace: AgentWorkspace | undefined =
    options.access === undefined
      ? undefined
      : { access: options.access, maxTurns: 50, allowedCommands: options.allowedCommands ?? [] };
  const node: Node = {
    ...base,
    config: {
      ...base.config,
      ...(workspace === undefined ? {} : { workspace }),
      execution: {
        ...base.config.execution,
        ...(options.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: options.reasoningEffort }),
      },
    },
  };
  await repository.nodes.insert(scope, node);
  return { repository, node, workflowId: workflow.id };
}

function serviceFor(
  w: World,
  adapter: ProviderAdapter,
  extra: Parameters<typeof makeChatService>[2] = {},
): ReturnType<typeof makeChatService> {
  const now = makeClock();
  const { bus } = makeBus(w.repository, now);
  return makeChatService(w.repository, bus, {
    workflowId: w.workflowId,
    now,
    adapterFor: async () => adapter,
    ...extra,
  });
}

/* -------------------------------------------------------------------------- */
/* D386                                                                        */
/* -------------------------------------------------------------------------- */

describe('D386 a node chat on a coding-agent CLI honours the node’s access level', () => {
  it('a Read-only agentic node’s call carries cliAccess read_only, and it is told it is read only', async () => {
    const w = await world({ access: 'read_only' });
    const { adapter, requests } = scriptedAdapter(() => reported());

    const reply = await (await serviceFor(w, adapter).chat(w.node.id, { content: hi })).done;

    expect(reply.error).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.workingDir).toBe(FOLDER);
    expect(requests[0]?.cliAccess).toEqual({ access: 'read_only', allowedCommands: [] });
    expect(requests[0]?.prompt).toContain('Your access: read only');
  });

  it('an Off node’s call carries no cliAccess: the provider preset applies, as before', async () => {
    const w = await world();
    const { adapter, requests } = scriptedAdapter(() => reported());

    await (
      await serviceFor(w, adapter).chat(w.node.id, { content: hi })
    ).done;

    expect(requests[0]?.workingDir).toBe(FOLDER);
    expect(requests[0]).not.toHaveProperty('cliAccess');
    // The default preset edits, so an Off node is still told it may edit files.
    expect(requests[0]?.prompt).toContain('Your access: edit files —');
  });

  it('Edit + commands carries the node’s allowlist, and the rules for running commands', async () => {
    const w = await world({
      access: 'edit_commands',
      allowedCommands: ['pnpm test', 'git status'],
    });
    const { adapter, requests } = scriptedAdapter(() => reported());

    await (
      await serviceFor(w, adapter).chat(w.node.id, { content: hi })
    ).done;

    expect(requests[0]?.cliAccess).toEqual({
      access: 'edit_commands',
      allowedCommands: ['pnpm test', 'git status'],
    });
    expect(requests[0]?.prompt).toContain('Your access: edit files and run commands');
  });

  it('sends no cliAccess without a project folder, or to an API model', async () => {
    const noFolder = await world({ access: 'read_only', folderPath: '' });
    const cli = scriptedAdapter(() => reported());
    await (
      await serviceFor(noFolder, cli.adapter).chat(noFolder.node.id, { content: hi })
    ).done;
    expect(cli.requests[0]?.workingDir).toBeUndefined();
    expect(cli.requests[0]).not.toHaveProperty('cliAccess');

    const api = await world({ access: 'read_only' });
    const http = scriptedAdapter(() => reported(), 'openai_compatible');
    await (
      await serviceFor(api, http.adapter).chat(api.node.id, { content: hi })
    ).done;
    expect(http.requests[0]).not.toHaveProperty('cliAccess');
  });

  it('a Read-only turn is not a writing turn: a checkpoint that cannot begin does not stop it', async () => {
    const w = await world({ access: 'read_only' });
    const { adapter, requests } = scriptedAdapter(() => reported());

    const reply = await (
      await serviceFor(w, adapter, { checkpoints: failingCheckpoints }).chat(w.node.id, {
        content: hi,
      })
    ).done;

    expect(reply.error).toBeUndefined();
    expect(requests).toHaveLength(1);
  });

  it('an Edit files turn is a writing turn: the same failed checkpoint stops it before the call', async () => {
    const w = await world({ access: 'edit_files' });
    const { adapter, requests } = scriptedAdapter(() => reported());

    const reply = await (
      await serviceFor(w, adapter, { checkpoints: failingCheckpoints }).chat(w.node.id, {
        content: hi,
      })
    ).done;

    expect(reply.error?.code).toBe('checkpoint_unavailable');
    expect(requests).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* D387                                                                        */
/* -------------------------------------------------------------------------- */

describe('D387 a chat call that reports no usage is estimated', () => {
  it('marks the reply’s usage estimated, characters ÷ 4 on the system and prompt and on the reply', async () => {
    const w = await world();
    const { adapter, requests } = scriptedAdapter(() => unreported(), 'codex_cli');
    const service = serviceFor(w, adapter);

    const reply = await (await service.chat(w.node.id, { content: hi })).done;

    const sent = requests[0];
    expect(sent).toBeDefined();
    const promptChars = (sent?.system ?? '').length + (sent?.prompt ?? '').length;
    expect(reply.error).toBeUndefined();
    expect(reply.usage).toMatchObject({
      tokensIn: Math.ceil(promptChars / 4),
      tokensOut: Math.ceil(REPLY.length / 4),
      source: 'estimated',
    });
    expect(reply.usage?.tokensIn ?? 0).toBeGreaterThan(0);
    // stored as it was announced
    const [, stored] = (await service.getThread(reply.threadId)).messages;
    expect(stored?.usage).toEqual(reply.usage);
  });

  it('a reported usage keeps today’s shape — its own numbers, no source', async () => {
    const w = await world();
    const { adapter } = scriptedAdapter(() => reported(3, 2), 'codex_cli');

    const reply = await (await serviceFor(w, adapter).chat(w.node.id, { content: hi })).done;

    expect(reply.usage).toEqual({ tokensIn: 3, tokensOut: 2, costUsd: 0 });
    expect(reply.usage).not.toHaveProperty('source');
  });

  it('a reported zero stays a reported zero', async () => {
    const w = await world();
    const { adapter } = scriptedAdapter(() => reported(0, 0), 'codex_cli');

    const reply = await (await serviceFor(w, adapter).chat(w.node.id, { content: hi })).done;

    expect(reply.usage).toEqual({ tokensIn: 0, tokensOut: 0, costUsd: 0 });
  });

  it('the estimate counts toward the turn’s cap', async () => {
    const capped = await world({ maxCostPerRunUsd: 0.000001 });
    const silent = scriptedAdapter(() => unreported(), 'codex_cli');
    const over = await (
      await serviceFor(capped, silent.adapter, { modelsFor: async () => [priced()] }).chat(
        capped.node.id,
        { content: hi },
      )
    ).done;
    expect(over.error?.message ?? '').toMatch(/budget|cap/i);
    expect(over.usage?.source).toBe('estimated');

    // control: the same cap with a reported zero is not crossed
    const zero = await world({ maxCostPerRunUsd: 0.000001 });
    const free = scriptedAdapter(() => reported(0, 0), 'codex_cli');
    const under = await (
      await serviceFor(zero, free.adapter, { modelsFor: async () => [priced()] }).chat(
        zero.node.id,
        { content: hi },
      )
    ).done;
    expect(under.error).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* D389                                                                        */
/* -------------------------------------------------------------------------- */

describe('D389 a node chat sends the node’s reasoning effort only when it is set', () => {
  it('a node set to high sends reasoningEffort high', async () => {
    const w = await world({ reasoningEffort: 'high' });
    const { adapter, requests } = scriptedAdapter(() => reported());

    await (
      await serviceFor(w, adapter).chat(w.node.id, { content: hi })
    ).done;

    expect(requests[0]?.reasoningEffort).toBe('high');
  });

  it('an unset or cleared (null) effort sends no key at all', async () => {
    for (const reasoningEffort of [undefined, null] as const) {
      const w = await world(reasoningEffort === undefined ? {} : { reasoningEffort });
      const { adapter, requests } = scriptedAdapter(() => reported());

      await (
        await serviceFor(w, adapter).chat(w.node.id, { content: hi })
      ).done;

      expect(requests[0]).not.toHaveProperty('reasoningEffort');
    }
  });
});
