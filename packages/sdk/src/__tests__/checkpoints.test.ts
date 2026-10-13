import { describe, expect, it } from 'vitest';

import { createAceClient } from '../client.js';
import { AceApiError } from '../errors.js';

const PID = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';
const CP = '01J9YYYYYYYYYYYYYYYYYYYYYY';
const AT = '2026-10-14T10:00:00.000Z';
const BASE = `http://127.0.0.1:4747/api/v1/projects/${PID}/checkpoints`;
const CHECKPOINT = {
  id: CP,
  projectId: PID,
  kind: 'chat',
  status: 'pending',
  files: [
    {
      path: 'a.ts',
      change: 'modified',
      additions: 1,
      deletions: 1,
      binary: false,
      state: 'pending',
    },
  ],
  skipped: [],
  createdAt: AT,
  updatedAt: AT,
};

interface Seen {
  method: string;
  url: string;
  body: unknown;
}

function clientAnswering(status: number, answer: unknown) {
  const seen: Seen[] = [];
  const client = createAceClient({
    baseUrl: 'http://127.0.0.1:4747',
    token: 't',
    fetch: async (input, init) => {
      seen.push({
        method: init?.method ?? 'GET',
        url: String(input),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return new Response(JSON.stringify(answer), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return { client, seen };
}

describe('D300 the SDK’s checkpoint methods', () => {
  it('lists and gets checkpoints', async () => {
    const list = clientAnswering(200, [CHECKPOINT]);
    expect(await list.client.listCheckpoints(PID)).toEqual([CHECKPOINT]);
    expect(list.seen[0]).toMatchObject({ method: 'GET', url: BASE });

    const one = clientAnswering(200, CHECKPOINT);
    expect(await one.client.getCheckpoint(PID, CP)).toEqual(CHECKPOINT);
    expect(one.seen[0]?.url).toBe(`${BASE}/${CP}`);
  });

  it('asks for one file’s diff by path, encoded', async () => {
    const { client, seen } = clientAnswering(200, { before: 'a', after: 'b', binary: false });
    expect(await client.checkpointFileDiff(PID, CP, 'src/a b.ts')).toEqual({
      before: 'a',
      after: 'b',
      binary: false,
    });
    expect(seen[0]?.url).toBe(`${BASE}/${CP}/diff?path=src%2Fa+b.ts`);
  });

  it('posts a keep or revert, validated before anything leaves', async () => {
    const { client, seen } = clientAnswering(200, CHECKPOINT);
    await client.checkpointAction(PID, CP, { action: 'revert', paths: ['a.ts'] });
    expect(seen).toEqual([
      { method: 'POST', url: `${BASE}/${CP}/actions`, body: { action: 'revert', paths: ['a.ts'] } },
    ]);
    const error = await client
      .checkpointAction(PID, CP, { action: 'keep', paths: [] })
      .catch((e: unknown) => e);
    expect(AceApiError.is(error) && error.code).toBe('validation_failed');
    expect(seen).toHaveLength(1);
  });

  it('surfaces a 409 checkpoint_conflict with its details', async () => {
    const details = { conflicts: [{ path: 'a.ts', message: 'a.ts changed.' }] };
    const { client } = clientAnswering(409, {
      error: {
        kind: 'workflow',
        code: 'checkpoint_conflict',
        message: 'a.ts changed.',
        details,
        retryable: false,
      },
    });
    const error = await client.checkpointAction(PID, CP, { action: 'revert' }).catch((e) => e);
    expect(AceApiError.is(error) && error.code).toBe('checkpoint_conflict');
    expect((error as AceApiError).details).toEqual(details);
  });
});
