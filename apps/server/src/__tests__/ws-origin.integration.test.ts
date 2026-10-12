import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WS_CLOSE_FORBIDDEN_ORIGIN } from '@ace/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { startEngine, type RunningEngine } from '../server.js';

let engine: RunningEngine;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ace-ws-origin-'));
  engine = await startEngine({ dataDir, port: 0, env: {} });
});

afterAll(async () => {
  await engine.stop();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

/** Opens a socket, closes it after the first frame, and answers the close code and the frames. */
function connect(origin?: string): Promise<{ code: number; frames: string[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `${engine.wsUrl}?token=${engine.token}`,
      origin === undefined ? {} : { origin },
    );
    const frames: string[] = [];
    socket.on('message', (data) => {
      frames.push(String(data));
      if (frames.length === 1) socket.close(1000);
    });
    socket.on('close', (code) => resolve({ code, frames }));
    socket.on('error', reject);
  });
}

describe('FR-SYS-003 D301 the WebSocket checks Origin like REST (design §7)', () => {
  it('closes a socket from a foreign origin with 4403, before a single frame', async () => {
    const refused = await connect('https://evil.example');
    expect(refused.code).toBe(WS_CLOSE_FORBIDDEN_ORIGIN);
    expect(refused.frames).toEqual([]);
  });

  it('greets a socket with no Origin, as curl and the CLI open one', async () => {
    const opened = await connect();
    expect(opened.code).toBe(1000);
    expect(JSON.parse(opened.frames[0] ?? '{}')).toMatchObject({ type: 'hello' });
  });

  it('greets an origin from the allow-list', async () => {
    const opened = await connect('http://localhost:5173');
    expect(JSON.parse(opened.frames[0] ?? '{}')).toMatchObject({ type: 'hello' });
  });

  it('greets the engine’s own origin on the port it really bound (port 0 here)', async () => {
    const opened = await connect(engine.url);
    expect(JSON.parse(opened.frames[0] ?? '{}')).toMatchObject({ type: 'hello' });
  });

  it('answers REST from the engine’s own origin on that real port too', async () => {
    const response = await fetch(`${engine.url}/api/v1/health`, {
      headers: { Authorization: `Bearer ${engine.token}`, Origin: engine.url },
    });
    expect(response.status).toBe(200);
  });
});
