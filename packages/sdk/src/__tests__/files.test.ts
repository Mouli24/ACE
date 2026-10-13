import { describe, expect, it } from 'vitest';

import { createAceClient } from '../client.js';
import { AceApiError } from '../errors.js';

const PID = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';
const AT = '2026-10-09T10:00:00.000Z';

interface Seen {
  method: string;
  url: string;
  body: unknown;
}

function clientAnswering(status: number, answer: unknown, contentType = 'application/json') {
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
      const payload =
        answer instanceof Uint8Array
          ? new Blob([new Uint8Array(answer)])
          : answer === undefined
            ? null
            : JSON.stringify(answer);
      return new Response(payload, { status, headers: { 'content-type': contentType } });
    },
  });
  return { client, seen };
}

describe('D299 FR-GIT-003 FR-GIT-004 the SDK’s file methods', () => {
  it('lists the root, then a folder with a space in its path', async () => {
    const { client, seen } = clientAnswering(200, { path: '', items: [] });
    await client.listFolder(PID);
    await client.listFolder(PID, 'My Dir/src');
    expect(seen.map((s) => s.url)).toEqual([
      `http://127.0.0.1:4747/api/v1/projects/${PID}/files/tree?path=`,
      `http://127.0.0.1:4747/api/v1/projects/${PID}/files/tree?path=My+Dir%2Fsrc`,
    ]);
  });

  it('saves with PUT and the validated body', async () => {
    const { client, seen } = clientAnswering(200, {
      path: 'a.ts',
      version: 'v2',
      size: 1,
      mtime: AT,
    });
    const body = { path: 'a.ts', content: 'x', baseVersion: 'v1', eol: 'lf' as const, bom: false };
    expect((await client.saveFile(PID, body)).version).toBe('v2');
    expect(seen[0]).toEqual({
      method: 'PUT',
      url: `http://127.0.0.1:4747/api/v1/projects/${PID}/files/content`,
      body,
    });
  });

  it('turns a 409 file_changed into an AceApiError with the disk’s version', async () => {
    const { client } = clientAnswering(409, {
      error: {
        kind: 'workflow',
        code: 'file_changed',
        message: 'changed',
        details: { currentVersion: 'v9' },
        retryable: false,
      },
    });
    const error = await client
      .saveFile(PID, { path: 'a.ts', content: 'x', baseVersion: 'v1', eol: 'lf', bom: false })
      .catch((e: unknown) => e);
    expect(AceApiError.is(error) && error.code).toBe('file_changed');
    expect(AceApiError.is(error) && error.details).toEqual({ currentVersion: 'v9' });
  });

  it('creates, moves, deletes, lists and reads status', async () => {
    const entry = { path: 'n.ts', name: 'n.ts', kind: 'file', size: 0, mtime: AT, ignored: false };
    const { client, seen } = clientAnswering(200, entry);
    await client.createEntry(PID, { path: 'n.ts', kind: 'file' });
    await client.moveEntry(PID, { from: 'n.ts', to: 'b/n.ts' });
    expect(seen.map((s) => [s.method, new URL(s.url).pathname])).toEqual([
      ['POST', `/api/v1/projects/${PID}/files/entries`],
      ['POST', `/api/v1/projects/${PID}/files/move`],
    ]);

    const removed = clientAnswering(204, undefined);
    await removed.client.deleteEntry(PID, 'b/n.ts');
    expect(removed.seen[0]?.url).toBe(
      `http://127.0.0.1:4747/api/v1/projects/${PID}/files/entries?path=b%2Fn.ts`,
    );
    expect(removed.seen[0]?.method).toBe('DELETE');

    const listed = clientAnswering(200, { files: ['a.ts'], truncated: false });
    expect((await listed.client.listAllFiles(PID)).files).toEqual(['a.ts']);
    const status = clientAnswering(200, { repo: false });
    expect(await status.client.repoStatus(PID)).toEqual({ repo: false });
  });

  it('D299 Phase 4 searches with a POST body, and refuses a runaway regex before sending', async () => {
    const answer = {
      files: [
        {
          path: 'a.ts',
          matches: [{ line: 2, column: 3, preview: 'x needle', previewOffset: 2, length: 6 }],
        },
      ],
      truncated: false,
      searchedFiles: 4,
    };
    const { client, seen } = clientAnswering(200, answer);
    const body = { query: 'need.e', regex: true, include: 'src' };
    expect(await client.searchFiles(PID, body)).toEqual(answer);
    expect(seen).toEqual([
      {
        method: 'POST',
        url: `http://127.0.0.1:4747/api/v1/projects/${PID}/files/search`,
        body,
      },
    ]);

    const refused = clientAnswering(200, answer);
    await expect(
      refused.client.searchFiles(PID, { query: '(a+)+', regex: true }),
    ).rejects.toBeInstanceOf(AceApiError);
    expect(refused.seen).toEqual([]);
  });

  it('reads raw bytes as a Blob with their type', async () => {
    const { client } = clientAnswering(200, new Uint8Array([1, 2, 3]), 'image/png');
    const blob = await client.readFileRaw(PID, 'a.png');
    expect(blob.type).toBe('image/png');
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3]);
  });
});
