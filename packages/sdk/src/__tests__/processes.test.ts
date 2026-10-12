import type { ProcessStartRequest } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { createAceClient } from '../client.js';
import { AceApiError } from '../errors.js';

const PID = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';
const PROC = '01J9YYYYYYYYYYYYYYYYYYYYYY';
const AT = '2026-10-10T10:00:00.000Z';
const BASE = `http://127.0.0.1:4747/api/v1/projects/${PID}/processes`;
const SUMMARY = {
  id: PROC,
  projectId: PID,
  label: 'dev',
  command: 'pnpm run dev',
  cwd: '',
  status: 'running',
  exitCode: null,
  signal: null,
  startedAt: AT,
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
      return new Response(answer === undefined ? null : JSON.stringify(answer), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return { client, seen };
}

describe('D301 the SDK’s terminal methods', () => {
  it('starts a typed command with POST and the validated body, and answers its id', async () => {
    const { client, seen } = clientAnswering(201, { processId: PROC });
    expect(await client.startProcess(PID, { command: 'node -v', cwd: 'src' })).toEqual({
      processId: PROC,
    });
    expect(seen).toEqual([{ method: 'POST', url: BASE, body: { command: 'node -v', cwd: 'src' } }]);
  });

  it('starts a script by name', async () => {
    const { client, seen } = clientAnswering(201, { processId: PROC });
    await client.startProcess(PID, { script: 'dev' });
    expect(seen[0]?.body).toEqual({ script: 'dev' });
  });

  it('refuses a body the contract refuses, before anything leaves', async () => {
    const { client, seen } = clientAnswering(201, { processId: PROC });
    const error = await client.startProcess(PID, { command: '   ' }).catch((e: unknown) => e);
    expect(AceApiError.is(error) && error.code).toBe('validation_failed');
    expect(seen).toEqual([]);
  });

  it('refuses a script with a cwd: a script always runs in the project root (D301)', async () => {
    const { client, seen } = clientAnswering(201, { processId: PROC });
    const body = { script: 'dev', cwd: 'web' } as unknown as ProcessStartRequest;
    const error = await client.startProcess(PID, body).catch((e: unknown) => e);
    expect(AceApiError.is(error) && error.code).toBe('validation_failed');
    expect(seen).toEqual([]);
  });

  it('writes a line to stdin as { data }, and a 204 answers nothing', async () => {
    const { client, seen } = clientAnswering(204, undefined);
    await expect(client.processInput(PID, PROC, 'Ada\n')).resolves.toBeUndefined();
    expect(seen).toEqual([
      { method: 'POST', url: `${BASE}/${PROC}/input`, body: { data: 'Ada\n' } },
    ]);
  });

  it('stops with POST and no body', async () => {
    const { client, seen } = clientAnswering(204, undefined);
    await expect(client.stopProcess(PID, PROC)).resolves.toBeUndefined();
    expect(seen).toEqual([{ method: 'POST', url: `${BASE}/${PROC}/stop`, body: undefined }]);
  });

  it('lists the processes, reads one with its output, and reads the scripts', async () => {
    expect(await clientAnswering(200, [SUMMARY]).client.listProcesses(PID)).toEqual([SUMMARY]);
    const detail = { ...SUMMARY, output: 'listening on 3000\n', truncated: false };
    const reading = clientAnswering(200, detail);
    expect(await reading.client.getProcess(PID, PROC)).toEqual(detail);
    expect(reading.seen[0]?.url).toBe(`${BASE}/${PROC}`);
    const scripts = { packageManager: 'pnpm', scripts: [{ name: 'dev', command: 'vite' }] };
    const listing = clientAnswering(200, scripts);
    expect(await listing.client.projectScripts(PID)).toEqual(scripts);
    expect(listing.seen[0]?.url).toBe(`${BASE}/scripts`);
  });

  it('refuses an answer the contract does not describe', async () => {
    const { client } = clientAnswering(200, [{ ...SUMMARY, status: 'paused' }]);
    const error = await client.listProcesses(PID).catch((e: unknown) => e);
    expect(AceApiError.is(error) && error.code).toBe('invalid_response');
  });

  it('turns a 403 terminal_restricted into an AceApiError carrying the engine’s words', async () => {
    const message =
      "This project runs only its own package.json scripts in the terminal. Pick a script, or allow every command in the project's settings.";
    const { client } = clientAnswering(403, {
      error: { kind: 'invalid_config', code: 'terminal_restricted', message, retryable: false },
    });
    const error = await client.startProcess(PID, { command: 'ls' }).catch((e: unknown) => e);
    expect(AceApiError.is(error) && [error.status, error.code, error.message]).toEqual([
      403,
      'terminal_restricted',
      message,
    ]);
  });
});
