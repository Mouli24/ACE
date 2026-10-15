/**
 * PG-2.4 No silent loss of undo (docs/team-prompts/product-gaps-fix-prompt.md).
 *
 * Phase 0 red tests. A failed checkpoint start is only logged today and the run or turn goes on
 * (`runs/index.ts` ~2918 `beginRunCheckpoint`, and `chat/service.ts` ~397). After the fix a
 * writing run or chat turn whose checkpoint cannot begin stops before its first write, and offers
 * "Run without undo" as a one-time choice.
 *
 * Note: `run-checkpoints.test.ts` › "still runs when the checkpoint cannot begin" asserts today's
 * behaviour (a toolless run COMPLETEs); the fix decides whether that case is "writing" and so
 * whether that test changes. It is left as it is here (never weaken an existing test).
 */
import type { Checkpoint, Id, Model, Node, Part, ToolDefinition } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import {
  PROJECT_ID,
  createRunDriverHarness,
  scope,
  type RunDriverHarness,
} from '../../__tests__/run-driver-harness.js';
import { FakeRepository } from '../../__tests__/fake-repository.js';
import {
  MODEL_ID,
  PROVIDER_ID,
  makeAgentNode,
  makeBus,
  makeChatService,
  makeClock,
  makeWorkflow,
} from '../../chat/__tests__/harness.js';
import { newId } from '../../ids.js';
import type {
  CheckpointRecorder,
  GenerateRequest,
  ProviderAdapter,
  StreamChunk,
} from '../../ports/index.js';
import type { ExecutableTool, ToolProvider } from '../../runs/tool-loop.js';

const AT = '2026-10-15T10:00:00.000Z';
const FOLDER = 'D:/projects/shop';

function recorder(failBegin: boolean): CheckpointRecorder {
  let begun = 0;
  return {
    async begin() {
      if (failBegin) throw new Error('checkpoint store unavailable');
      begun += 1;
      return {
        id: `cp${begun}`,
        finish: async () => undefined as Checkpoint | undefined,
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Runs                                                                        */
/* -------------------------------------------------------------------------- */

/** Input → Writer (write_file enabled: a writing node) → Output, in a project with a folder. */
async function writingRun(failBegin: boolean): Promise<{ h: RunDriverHarness; writer: Node }> {
  const h = await createRunDriverHarness({ checkpoints: recorder(failBegin) });
  await h.repository.projects.create(scope, {
    id: PROJECT_ID,
    name: 'Shop',
    folderPath: FOLDER,
    createdAt: AT,
    updatedAt: AT,
  });
  const brief = h.inputNode();
  const base = h.agentNode('Writer');
  const writer: Node =
    base.kind === 'agent'
      ? {
          ...base,
          config: {
            ...base.config,
            tools: {
              ...base.config.tools,
              enabled: ['write_file', 'edit_file'],
            },
          },
        }
      : base;
  const result = h.outputNode();
  await h.seed([brief, writer, result], [h.edge(brief, writer), h.edge(writer, result)]);
  h.scripts.set('Writer', [{ text: 'wrote it' }]);
  return { h, writer };
}

describe('PG-2.4 a writing run whose checkpoint cannot begin stops before its first write', () => {
  it.fails('no provider call is made and the run does not COMPLETE', async () => {
    const { h } = await writingRun(true);

    const ended = await (await h.start()).done;

    expect(h.calls('Writer')).toBe(0);
    expect(ended.status).not.toBe('COMPLETE');
  });

  it('control: with a working checkpoint the same writing run completes (passes today)', async () => {
    const { h } = await writingRun(false);

    const ended = await (await h.start()).done;

    expect(ended.status).toBe('COMPLETE');
    expect(h.calls('Writer')).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Chat                                                                        */
/* -------------------------------------------------------------------------- */

const hi: Part[] = [{ type: 'text', text: 'please fix src/b.ts' }];

const definition = (name: string): ToolDefinition => ({
  name,
  description: name,
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  permissions: { network: false, fsPaths: ['<project>'], destructive: false },
  timeoutMs: 10_000,
  source: 'builtin',
});

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

function writingAdapter(): ProviderAdapter {
  return {
    type: 'openai_compatible',
    check: async () => ({ status: 'CONNECTED' }),
    listModels: async () => [],
    async *generate(req: GenerateRequest): AsyncIterable<StreamChunk> {
      if ((req.toolResults?.length ?? 0) === 0 && req.tools !== undefined) {
        yield {
          type: 'tool_call',
          callId: 'call-1',
          name: 'write_file',
          args: { path: 'src/b.ts', content: 'x' },
        };
        yield { type: 'finish', reason: 'tool_calls' };
        return;
      }
      yield { type: 'text', delta: 'Done.' };
      yield { type: 'finish', reason: 'stop' };
    },
  };
}

const toolModel: Model = {
  id: newId(),
  providerId: PROVIDER_ID,
  modelId: MODEL_ID,
  displayName: 'Mock chat',
  inputTypes: ['text'],
  outputTypes: ['text'],
  contextWindow: 100_000,
  supportsTools: true,
  supportsJson: false,
  available: true,
  source: 'discovered',
  lastCheckedAt: AT,
};

async function writingTurn(failBegin: boolean) {
  const repository = new FakeRepository();
  const projectId: Id = newId();
  await repository.projects.create(scope, {
    id: projectId,
    name: 'Shop',
    folderPath: FOLDER,
    createdAt: AT,
    updatedAt: AT,
  });
  const workflow = makeWorkflow(projectId);
  await repository.workflows.create(scope, workflow);
  const agent = makeAgentNode(workflow.id, { name: 'Coder' });
  await repository.nodes.insert(scope, agent);
  const now = makeClock();
  const { bus } = makeBus(repository, now);
  const { provider, ran } = projectTools();
  const service = makeChatService(repository, bus, {
    workflowId: workflow.id,
    now,
    adapterFor: async () => writingAdapter(),
    modelsFor: async () => [toolModel],
    tools: provider,
    checkpoints: recorder(failBegin),
  });
  const reply = await (await service.chat(agent.id, { content: hi })).done;
  return { reply, ran };
}

describe('PG-2.4 a writing chat turn whose checkpoint cannot begin stops before its first write', () => {
  it.fails('the write tool never runs and the turn ends saying why', async () => {
    const { reply, ran } = await writingTurn(true);

    expect(ran).not.toContain('write_file');
    expect(reply.error).toBeDefined();
  });

  it('control: with a working checkpoint the turn writes (passes today)', async () => {
    const { reply, ran } = await writingTurn(false);

    expect(ran).toContain('write_file');
    expect(reply.error).toBeUndefined();
  });
});
