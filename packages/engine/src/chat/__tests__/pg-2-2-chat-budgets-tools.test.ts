/**
 * PG-2.2 Chat obeys budgets and tool guardrails (docs/team-prompts/product-gaps-fix-prompt.md).
 *
 * Phase 0 red tests. Chat turns have no `runId` and no cost cap (`chat/service.ts` ~422, ~515),
 * and they skip `evaluateTool`, which only runs use (`runs/index.ts` ~747). After the fix:
 *
 * - a chat turn's spend counts toward `dailyBudgetUsd` — the day's cost the `daily_budget` check
 *   reads (`guardrailStoreFor(...).usage.costUsdForDay`) includes it;
 * - a per-turn cap (the project's `maxCostPerRunUsd`, unless a `maxCostPerChatTurnUsd` is added)
 *   refuses a turn with the budget reason;
 * - tool-point guardrails run on every chat tool call, with the same `ask_user` approvals as runs.
 */
import {
  defaultGuardrailChecks,
  type GuardrailPolicy,
  type Id,
  type Model,
  type Part,
  type ToolDefinition,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import type { CheckInput, CheckRunner } from '../../guardrails/checks.js';
import { NO_MASKING } from '../../guardrails/checks.js';
import type { PolicyService } from '../../guardrails/policy-service.js';
import { guardrailStoreFor } from '../../guardrails/store.js';
import { newId } from '../../ids.js';
import type { GenerateRequest, ProviderAdapter, StreamChunk } from '../../ports/index.js';
import { FakeRepository } from '../../__tests__/fake-repository.js';
import type { ExecutableTool, ToolProvider } from '../../runs/tool-loop.js';
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
const hi: Part[] = [{ type: 'text', text: 'please fix src/b.ts' }];

const priced = (supportsTools: boolean): Model => ({
  id: newId(),
  providerId: PROVIDER_ID,
  modelId: MODEL_ID,
  displayName: 'Mock chat',
  inputTypes: ['text'],
  outputTypes: ['text'],
  contextWindow: 100_000,
  supportsTools,
  supportsJson: false,
  available: true,
  source: 'discovered',
  lastCheckedAt: '2026-10-14T09:00:00.000Z',
  pricing: { inputPer1k: 10, outputPer1k: 10, priceTableVersion: 'pg-v1' },
});

const definition = (name: string): ToolDefinition => ({
  name,
  description: name,
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  permissions: { network: false, fsPaths: ['<project>'], destructive: false },
  timeoutMs: 10_000,
  source: 'builtin',
});

/** The six project tools chat offers; `ran` lists every tool that actually executed. */
function projectTools(): { provider: ToolProvider; ran: string[] } {
  const ran: string[] = [];
  const tools = new Map<string, ExecutableTool>();
  for (const name of [
    'list_files',
    'read_file',
    'write_file',
    'edit_file',
    'git_status',
    'git_diff',
  ]) {
    tools.set(name, {
      definition: definition(name),
      run: async () => {
        ran.push(name);
        return { ok: true };
      },
    });
  }
  return { provider: { get: (name) => tools.get(name) }, ran };
}

/** First call asks for `write_file`; once a result comes back, it answers. */
function writingAdapter(): {
  adapter: ProviderAdapter;
  calls: GenerateRequest[];
} {
  const calls: GenerateRequest[] = [];
  return {
    calls,
    adapter: {
      type: 'openai_compatible',
      check: async () => ({ status: 'CONNECTED' }),
      listModels: async () => [],
      async *generate(req): AsyncIterable<StreamChunk> {
        calls.push(req);
        if ((req.toolResults?.length ?? 0) === 0 && req.tools !== undefined) {
          yield {
            type: 'tool_call',
            callId: 'call-1',
            name: 'write_file',
            args: { path: 'src/b.ts', content: 'x' },
          };
          yield { type: 'usage', tokensIn: 50, tokensOut: 0 };
          yield { type: 'finish', reason: 'tool_calls' };
          return;
        }
        yield { type: 'text', delta: 'Done.' };
        yield { type: 'usage', tokensIn: 100, tokensOut: 100 };
        yield { type: 'finish', reason: 'stop' };
      },
    },
  };
}

function policyWith(toolAllowedAction: 'block' | 'ask_user'): GuardrailPolicy {
  const at = '2026-10-14T09:00:00.000Z';
  return {
    id: newId(),
    projectId: newId(),
    name: 'Default',
    version: 1,
    isProjectDefault: true,
    checks: defaultGuardrailChecks(newId).map((check) =>
      check.point === 'tool' && check.type === 'tool_allowed'
        ? { ...check, action: toolAllowedAction }
        : check,
    ),
    createdAt: at,
    updatedAt: at,
  };
}

/** A runner that records every input; at the tool point it refuses, everywhere else it is silent. */
function recordingChecks(): { checks: CheckRunner; seen: CheckInput[] } {
  const seen: CheckInput[] = [];
  return {
    seen,
    checks: {
      evaluate: (_check, input) => {
        seen.push(input);
        return input.point === 'tool'
          ? { passed: false, reason: 'write_file is not allowed here' }
          : undefined;
      },
    },
  };
}

interface World {
  repository: FakeRepository;
  agentId: Id;
  workflowId: Id;
}

async function world(project: { maxCostPerRunUsd?: number } = {}): Promise<World> {
  const repository = new FakeRepository();
  const projectId = newId();
  await repository.projects.create(scope, {
    id: projectId,
    name: 'Shop',
    folderPath: FOLDER,
    ...project,
    createdAt: '2026-10-14T09:00:00.000Z',
    updatedAt: '2026-10-14T09:00:00.000Z',
  });
  const workflow = makeWorkflow(projectId);
  await repository.workflows.create(scope, workflow);
  const agent = makeAgentNode(workflow.id, { name: 'Coder' });
  await repository.nodes.insert(scope, agent);
  return { repository, agentId: agent.id, workflowId: workflow.id };
}

describe('PG-2.2 chat spend counts toward dailyBudgetUsd', () => {
  it('a priced chat turn shows in the day’s cost the daily_budget check reads', async () => {
    const w = await world();
    const now = makeClock();
    const { bus } = makeBus(w.repository, now);
    const { adapter } = writingAdapter();
    const service = makeChatService(w.repository, bus, {
      workflowId: w.workflowId,
      now,
      adapterFor: async () => adapter,
      modelsFor: async () => [priced(false)],
    });

    const reply = await (await service.chat(w.agentId, { content: hi })).done;
    expect(reply.usage?.costUsd ?? 0).toBeGreaterThan(0);

    const day = reply.at.slice(0, 10);
    const spent = await guardrailStoreFor(w.repository, scope).usage.costUsdForDay(scope, day);
    expect(spent).toBeGreaterThan(0);
  });
});

describe('PG-2.2 a per-turn cap refuses a chat turn with the budget reason', () => {
  it('a turn over the project’s cost cap ends as a failed turn that names the budget', async () => {
    const w = await world({ maxCostPerRunUsd: 0.000001 });
    const now = makeClock();
    const { bus } = makeBus(w.repository, now);
    const { adapter } = writingAdapter();
    const service = makeChatService(w.repository, bus, {
      workflowId: w.workflowId,
      now,
      adapterFor: async () => adapter,
      modelsFor: async () => [priced(false)],
    });

    const reply = await (await service.chat(w.agentId, { content: hi })).done;

    expect(reply.error).toBeDefined();
    expect(reply.error?.message ?? '').toMatch(/budget|cap/i);
  });
});

describe('PG-2.2 tool-point guardrails run on chat tool calls', () => {
  it('a chat tool call passes the tool point, and a block stops the tool from running', async () => {
    const w = await world();
    const now = makeClock();
    const { bus } = makeBus(w.repository, now);
    const { adapter } = writingAdapter();
    const { provider, ran } = projectTools();
    const { checks, seen } = recordingChecks();
    const service = makeChatService(w.repository, bus, {
      workflowId: w.workflowId,
      now,
      adapterFor: async () => adapter,
      modelsFor: async () => [priced(true)],
      tools: provider,
      checks,
      masker: NO_MASKING,
      policies: {
        resolve: async () => policyWith('block'),
      } as unknown as PolicyService,
    });

    await (
      await service.chat(w.agentId, { content: hi })
    ).done;

    expect(seen.some((input) => input.point === 'tool')).toBe(true);
    expect(ran).not.toContain('write_file');
  });

  it('a tool_allowed check set to ask_user asks before the chat tool runs (as runs do)', async () => {
    const w = await world();
    const now = makeClock();
    const { bus, events } = makeBus(w.repository, now);
    const { adapter } = writingAdapter();
    const { provider, ran } = projectTools();
    const { checks } = recordingChecks();
    const service = makeChatService(w.repository, bus, {
      workflowId: w.workflowId,
      now,
      adapterFor: async () => adapter,
      modelsFor: async () => [priced(true)],
      tools: provider,
      checks,
      masker: NO_MASKING,
      policies: {
        resolve: async () => policyWith('ask_user'),
      } as unknown as PolicyService,
    });

    const begun = await service.chat(w.agentId, { content: hi });
    await Promise.race([
      begun.done.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 300)),
    ]);

    expect(ran).not.toContain('write_file');
    expect(events.some((event) => event.type.includes('approval'))).toBe(true);
  });

  it('control: without a policy the chat tool runs (passes today)', async () => {
    const w = await world();
    const now = makeClock();
    const { bus } = makeBus(w.repository, now);
    const { adapter } = writingAdapter();
    const { provider, ran } = projectTools();
    const service = makeChatService(w.repository, bus, {
      workflowId: w.workflowId,
      now,
      adapterFor: async () => adapter,
      modelsFor: async () => [priced(true)],
      tools: provider,
    });

    await (
      await service.chat(w.agentId, { content: hi })
    ).done;
    expect(ran).toContain('write_file');
  });
});
