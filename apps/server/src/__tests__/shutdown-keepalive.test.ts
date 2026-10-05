import { mkdtempSync, rmSync } from 'node:fs';
import { Agent, request } from 'node:http';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { startEngine } from '../server.js';

/**
 * FR-SYS-008: shutdown returns promptly even while a client still holds a connection open. A
 * browser keeps its HTTP connections alive between requests, and `server.close()` alone waits for
 * them to end — the §7.1 cross-test measured 6.9 s, 83 s and 180 s with a Playwright context open.
 * Node closes a connection that is idle between requests by itself; what it waits on is a socket
 * that has not finished a request — one a browser preconnected and sent nothing on yet, or one
 * whose request is only half sent.
 */

/** A raw socket to the engine, connected, with `payload` written (nothing: a browser preconnect). */
async function rawSocket(port: number, payload: string): Promise<Socket> {
  const socket = connect(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  if (payload !== '') socket.write(payload);
  return socket;
}

/** One request on a keep-alive agent; the socket stays open, idle in the agent's pool. */
function keepAliveRequest(url: string, token: string, agent: Agent): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      `${url}/api/v1/health`,
      { agent, headers: { Authorization: `Bearer ${token}`, Connection: 'keep-alive' } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('FR-SYS-008 shutdown with connections still open', () => {
  it('stop() resolves within 2 s with a preconnected socket, a half-sent request, a keep-alive connection and a WebSocket open', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ace-keepalive-'));
    const engine = await startEngine({ dataDir: dir, port: 0, env: {} });
    const agent = new Agent({ keepAlive: true, keepAliveMsecs: 60_000 });
    const ws = new WebSocket(`${engine.wsUrl}?token=${engine.token}`);
    // Listened for at once: the socket may open while the HTTP request below is in flight.
    const opened = new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const sockets: Socket[] = [];
    try {
      expect(await keepAliveRequest(engine.url, engine.token, agent)).toBe(200);
      await opened;
      sockets.push(await rawSocket(engine.port, ''));
      sockets.push(
        await rawSocket(engine.port, 'GET /api/v1/health HTTP/1.1\r\nHost: 127.0.0.1\r\n'),
      );
      // Give the server a moment to accept both, as a browser's sockets would long have been.
      await new Promise((resolve) => setTimeout(resolve, 100));
      // The pooled socket is idle and open: exactly what a browser tab leaves behind.
      expect(Object.values(agent.freeSockets).flat()).toHaveLength(1);

      const started = Date.now();
      await engine.stop();

      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      agent.destroy();
      ws.terminate();
      for (const socket of sockets) socket.destroy();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows can still hold the SQLite WAL handle for a moment; the OS reclaims temp itself.
      }
    }
  }, 30_000);
});
