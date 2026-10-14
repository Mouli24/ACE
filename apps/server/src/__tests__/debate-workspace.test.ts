import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createDebateCaller,
  runDebate,
  type EngineEvent,
  type EventBus,
  type GenerateRequest,
  type ProviderAdapter,
  type StreamChunk,
} from '@ace/engine';
import { createDebateWorkspace } from '@ace/tools';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * D347 D359 (DB8): a debate never writes to the workspace, proved against the real thing — the
 * tools' workspace adapter, a real git repository, and a "CLI" that writes into its working folder
 * on every call, the way a coding agent would if it could.
 */

const hasGit = spawnSync('git', ['--version']).status === 0;
const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
};

const RUN = '01JH0000000000000000000001';
const DEBATE = '01JH0000000000000000000002';
const NODES = [
  '01JH00000000000000000000DA',
  '01JH00000000000000000000DB',
  '01JH00000000000000000000DC',
];
const HUB = '01JH00000000000000000000H0';
const PROVIDER = '01JH00000000000000000000P0';

function scribblingAdapter(seen: string[]): ProviderAdapter {
  return {
    type: 'mock',
    check: async () => ({ status: 'CONNECTED' }),
    listModels: async () => [],
    async *generate(req: GenerateRequest): AsyncIterable<StreamChunk> {
      const cwd = req.workingDir ?? '';
      seen.push(cwd);
      // What a coding agent would do in a project folder.
      writeFileSync(join(cwd, 'scribble.txt'), 'I was here');
      const callId = (req.turnId ?? '').split('/').pop() ?? '';
      const ids = [...req.prompt.matchAll(/^\[(R\d-[A-E])\](?! \(you\))/gm)].map((m) => m[1]);
      const reply = /^R0-/.test(callId)
        ? { answer: 'yes', confidence: 0.5, reasoning: 'r' }
        : /^R\d-/.test(callId)
          ? {
              answer: 'yes',
              confidence: 0.5,
              reasoning: 'r',
              rebuttals: [{ targetTurnId: ids[0], claim: 'c', response: 'r' }],
              positionChanged: false,
              changedBecause: null,
            }
          : {
              answer: 'yes',
              confidence: 0.5,
              rationale: [{ point: 'p', supportedBy: ['judge'] }],
              dissent: [],
              openQuestions: [],
            };
      yield { type: 'text', delta: `\`\`\`json\n${JSON.stringify(reply)}\n\`\`\`` };
      yield { type: 'finish', reason: 'stop' };
    },
  };
}

function memoryBus(): EventBus & { events: EngineEvent[] } {
  const events: EngineEvent[] = [];
  return {
    events,
    async emit(event) {
      const stored = {
        ...event,
        seq: events.length + 1,
        createdAt: new Date().toISOString(),
      } as EngineEvent;
      events.push(stored);
      return stored;
    },
    async emitTransient() {},
    async subscribe() {
      return () => undefined;
    },
  };
}

let project: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'ace-debate-repo-'));
  writeFileSync(join(project, 'README.md'), '# Cache notes\nTTL is 60 seconds.');
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

describe.runIf(hasGit)('D347 DB8 a debate leaves the workspace untouched', () => {
  it('a debater that writes a file changes nothing in the project: git status is the same before and after', async () => {
    git(project, 'init', '-q');
    git(project, 'add', '-A');
    git(project, 'commit', '-q', '-m', 'init');
    const before = git(project, 'status', '--porcelain', '--untracked-files=all');
    const head = git(project, 'rev-parse', 'HEAD').trim();

    const seen: string[] = [];
    const adapter = scribblingAdapter(seen);
    const bus = memoryBus();
    const route = {
      providerId: PROVIDER,
      modelId: 'scribbler',
      routing: { policy: 'fixed' as const, fallbackModelIds: [] },
    };
    const outcome = await runDebate(
      {
        runId: RUN,
        workflowId: RUN,
        debateId: DEBATE,
        hub: { nodeId: HUB, name: 'Hub', route, timeoutMs: 60_000, maxTokens: 4096 },
        config: { topic: 'Is the TTL right?', maxRounds: 1 },
        material: '',
        debaters: NODES.map((nodeId, i) => ({
          nodeId,
          name: `Debater ${i}`,
          route,
          timeoutMs: 60_000,
          maxTokens: 4096,
          reads: ['README.md'],
        })),
        projectFolder: project,
        signal: new AbortController().signal,
      },
      {
        bus,
        caller: createDebateCaller({
          adapterFor: async () => adapter,
          modelsFor: async () => [],
          runGated: async (_id, fn) => fn(),
          router: {
            resolve: (node) => ({
              ok: true,
              route: {
                providerId: node.providerId ?? PROVIDER,
                modelId: node.modelId ?? 'scribbler',
                viaFallback: false,
              },
            }),
            resolveForBench: () => ({ ok: false, code: 'policy_not_allowed', reason: 'no' }),
          },
        }),
        workspace: createDebateWorkspace(),
        tokenBatchMs: 0,
      },
    );

    expect(outcome.kind).toBe('verdict');
    expect(seen.length).toBeGreaterThanOrEqual(7);
    for (const cwd of seen) {
      expect(cwd.startsWith(project)).toBe(false);
      expect(existsSync(cwd)).toBe(false);
    }
    expect(git(project, 'status', '--porcelain', '--untracked-files=all')).toBe(before);
    expect(readdirSync(project).sort()).toEqual(['.git', 'README.md']);

    const started = bus.events.find((e) => e.type === 'debate.started')?.payload as {
      readsSnapshot: { sha: string; dirty: boolean; files: { path: string; chars: number }[] };
    };
    expect(started.readsSnapshot.sha).toBe(head);
    expect(started.readsSnapshot.dirty).toBe(false);
    expect(started.readsSnapshot.files.map((f) => f.path)).toEqual([
      'README.md',
      'README.md',
      'README.md',
    ]);
  });
});
