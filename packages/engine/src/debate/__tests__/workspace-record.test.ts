import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { createDebateFold, foldDebate } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { createFakeDebateProvider } from './fake-debate-provider.js';
import { PROJECT, debateHarness, fakeWorkspace, scratchGone } from './harness.js';

describe('D347 D359 DB8 a debate never writes to the workspace', () => {
  it('runs every turn in its own scratch folder under the temp dir, read-only, deleted after the turn', async () => {
    const provider = createFakeDebateProvider();
    provider.script('R0-A', [{ writeFile: { name: 'notes.md', content: 'scratch' } }]);
    const workspace = fakeWorkspace();
    await debateHarness({ provider, workspace, config: { maxRounds: 1 } }).run();

    const dirs = provider.calls.map((c) => c.workingDir ?? '');
    expect(new Set(dirs).size).toBe(provider.calls.length);
    for (const dir of dirs) {
      expect(resolve(dir).startsWith(resolve(tmpdir()))).toBe(true);
      expect(resolve(dir).startsWith(resolve(PROJECT))).toBe(false);
      expect(scratchGone(dir)).toBe(true);
    }
    expect(provider.calls.every((c) => c.readOnly === true)).toBe(true);
    expect(workspace.scratches.every((s) => s.disposed)).toBe(true);
  });

  it('snapshots the reads once: a file changed mid-debate does not change later prompts', async () => {
    const provider = createFakeDebateProvider();
    const workspace = fakeWorkspace({ 'src/cache.ts': 'export const TTL = 60;' });
    void provider
      .whenCalled('R0-A')
      .then(() => workspace.files.set('src/cache.ts', 'export const TTL = 999;'));
    const { record } = await debateHarness({
      provider,
      workspace,
      reads: { A: ['src/cache.ts'] },
      config: { maxRounds: 2, earlyStop: false },
    }).run();

    for (const prompt of [...provider.promptsOf('R1-A'), ...provider.promptsOf('R2-A')]) {
      expect(prompt).toContain('--- src/cache.ts ---\nexport const TTL = 60;');
      expect(prompt).not.toContain('999');
    }
    // Only the debater that declared the read sees it.
    expect(provider.promptsOf('R0-B')[0]).not.toContain('src/cache.ts');
    expect(record?.readsSnapshot).toEqual({
      sha: 'abc1234',
      dirty: false,
      files: [{ label: 'A', path: 'src/cache.ts', chars: 22 }],
    });
  });

  it('refuses to start over 100,000 characters of reads, listing files and sizes, with zero calls', async () => {
    const provider = createFakeDebateProvider();
    const workspace = fakeWorkspace({
      'big.txt': 'x'.repeat(60_000),
      'other.txt': 'y'.repeat(40_001),
    });
    const { outcome, record, events } = await debateHarness({
      provider,
      workspace,
      reads: { A: ['big.txt'], B: ['other.txt'] },
    }).run();

    expect(provider.calls).toHaveLength(0);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.error.code).toBe('debate_reads_too_large');
    expect(outcome.error.message).toContain('big.txt (A): 60000 characters');
    expect(outcome.error.message).toContain('other.txt (B): 40001 characters');
    expect(outcome.error.message).toContain('100001');
    expect(record).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('refuses a read that cannot be read, before any call', async () => {
    const provider = createFakeDebateProvider();
    const { outcome } = await debateHarness({ provider, reads: { A: ['missing.ts'] } }).run();
    expect(provider.calls).toHaveLength(0);
    expect(outcome.kind === 'failed' && outcome.error.code).toBe('debate_read_failed');
  });

  it('refuses reads when the project has no folder', async () => {
    const provider = createFakeDebateProvider();
    const { outcome } = await debateHarness({
      provider,
      projectFolder: '',
      reads: { A: ['a.ts'] },
    }).run();
    expect(provider.calls).toHaveLength(0);
    expect(outcome.kind === 'failed' && outcome.error.code).toBe('debate_reads_without_folder');
  });
});

describe('D343 DB4 reasoning shown to others is capped at 6000 characters', () => {
  it('cuts it with a marker in the other debaters’ prompts and keeps the full text', async () => {
    const long = `${'a'.repeat(6000)}TAIL-THAT-IS-CUT`;
    const provider = createFakeDebateProvider();
    provider.script('R0-B', [{ reply: { answer: 'yes', confidence: 0.5, reasoning: long } }]);
    const { record } = await debateHarness({ provider, config: { maxRounds: 1 } }).run();

    const [forA] = provider.promptsOf('R1-A');
    expect(forA).toContain(`${'a'.repeat(6000)} [truncated]`);
    expect(forA).not.toContain('TAIL-THAT-IS-CUT');
    expect(record?.turns['R0-B']?.reasoning).toBe(long);
  });
});

describe('D352 DB13 the event log is the source of truth', () => {
  it('folding the persisted log reproduces the record the debate ended with, exactly', async () => {
    const provider = createFakeDebateProvider();
    provider.script('R0-C', [{ fail: 'cli_exit_1' }]);
    provider.script('R1-A', [{ reply: 'not json' }]);
    const { outcome, events } = await debateHarness({ provider, config: { maxRounds: 2 } }).run();

    expect(outcome.kind).toBe('verdict');
    if (outcome.kind !== 'verdict') return;
    const replayed = foldDebate(JSON.parse(JSON.stringify(events)));
    expect(replayed).toEqual(outcome.record);
    expect(replayed?.verdict).toEqual(outcome.verdict);
  });

  it('a replay over the live fold changes nothing', async () => {
    const { events } = await debateHarness({ config: { maxRounds: 1 } }).run();
    const fold = createDebateFold();
    for (const event of events) fold.apply(event);
    const once = structuredClone(fold.records());
    for (const event of events) fold.apply(event);
    expect(fold.records()).toEqual(once);
  });

  it('streams each call’s text as transient deltas that never reach the log', async () => {
    const h = debateHarness({ config: { maxRounds: 1 } });
    const { published, events } = await h.run();
    const deltas = published.filter((e) => e.type === 'debate.turn_delta');
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.every((e) => e.seq === 0)).toBe(true);
    expect(events.some((e) => e.type === 'debate.turn_delta')).toBe(false);
  });
});

describe('D355 guardrails on debate turns', () => {
  it('masks the material and the reads before any model sees them', async () => {
    const provider = createFakeDebateProvider();
    const workspace = fakeWorkspace({ '.env': 'KEY=SECRET-123' });
    await debateHarness({
      provider,
      workspace,
      material: 'Use SECRET-123 to log in.',
      reads: { A: ['.env'] },
      config: { maxRounds: 1 },
      guardrails: {
        checkInput: async (text) => ({
          kind: 'continue',
          text: text.replaceAll('SECRET-123', '[MASKED]'),
        }),
        checkOutput: async (_nodeId, text) => ({ kind: 'continue', text }),
      },
    }).run();
    for (const call of provider.calls) expect(call.prompt).not.toContain('SECRET-123');
    expect(provider.promptsOf('R0-A')[0]).toContain('KEY=[MASKED]');
  });

  it('masks a reply before its event is written', async () => {
    const provider = createFakeDebateProvider();
    provider.script('R0-A', [
      { reply: { answer: 'yes', confidence: 0.5, reasoning: 'token SECRET-123' } },
    ]);
    const { events } = await debateHarness({
      provider,
      config: { maxRounds: 1 },
      guardrails: {
        checkInput: async (text) => ({ kind: 'continue', text }),
        checkOutput: async (_nodeId, text) => ({
          kind: 'continue',
          text: text.replaceAll('SECRET-123', '[MASKED]'),
        }),
      },
    }).run();
    expect(JSON.stringify(events)).not.toContain('SECRET-123');
    expect(provider.promptsOf('R1-B')[0]).toContain('token [MASKED]');
  });

  it('a blocked debater reply is GUARDRAIL_VIOLATION and that debater sits out the round', async () => {
    const provider = createFakeDebateProvider();
    provider.script('R1-B', [
      {
        reply: {
          answer: 'yes',
          confidence: 0.5,
          reasoning: 'BLOCK-ME',
          rebuttals: [],
          positionChanged: false,
          changedBecause: null,
        },
      },
    ]);
    const { record, outcome } = await debateHarness({
      provider,
      config: { maxRounds: 2, earlyStop: false },
      guardrails: {
        checkInput: async (text) => ({ kind: 'continue', text }),
        checkOutput: async (_nodeId, text) =>
          text.includes('BLOCK-ME')
            ? { kind: 'blocked', message: 'Blocked by the output policy.' }
            : { kind: 'continue', text },
      },
    }).run();
    expect(outcome.kind).toBe('verdict');
    expect(record?.rounds[1]?.failures).toEqual([
      expect.objectContaining({
        callId: 'R1-B',
        failureReason: 'GUARDRAIL_VIOLATION',
        willRetry: false,
        out: false,
      }),
    ]);
    expect(record?.turns['R2-B']).toBeDefined();
  });

  it('a blocked verdict ends the hub GUARDRAIL_VIOLATION', async () => {
    const provider = createFakeDebateProvider({
      answer: (id) => (id === 'judge' ? 'BLOCK-ME' : 'yes'),
    });
    const { outcome, record } = await debateHarness({
      provider,
      config: { maxRounds: 1 },
      guardrails: {
        checkInput: async (text) => ({ kind: 'continue', text }),
        checkOutput: async (_nodeId, text) =>
          text.includes('BLOCK-ME')
            ? { kind: 'blocked', message: 'Blocked.' }
            : { kind: 'continue', text },
      },
    }).run();
    expect(outcome.kind === 'failed' && outcome.failureReason).toBe('GUARDRAIL_VIOLATION');
    expect(record?.status).toBe('failed');
  });

  it('blocked material refuses the debate before any call', async () => {
    const provider = createFakeDebateProvider();
    const { outcome } = await debateHarness({
      provider,
      guardrails: {
        checkInput: async () => ({ kind: 'blocked', message: 'Blocked input.' }),
        checkOutput: async (_nodeId, text) => ({ kind: 'continue', text }),
      },
    }).run();
    expect(provider.calls).toHaveLength(0);
    expect(outcome.kind === 'failed' && outcome.failureReason).toBe('GUARDRAIL_VIOLATION');
  });
});
