import dns from 'node:dns';
import net from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PLACEHOLDER,
  addCorpusFile,
  createKb,
  createProject,
  fixtureWorkflow,
  importWorkflow,
  mockProvider,
  runToEnd,
  settledDocuments,
  startRound5Engine,
  type Round5Engine,
} from './round5-harness.js';

/**
 * NFR-PRIV-01 / TC-NFR-012: no telemetry and no outbound calls. Every socket connect and every DNS
 * lookup in this process is recorded from before the engine starts until after a full knowledge-base
 * ingestion, a search and a run on the mock provider: the only connections are the test's own HTTP
 * client to the engine on 127.0.0.1, and nothing is ever looked up.
 */

const connections: string[] = [];
const lookups: string[] = [];
const originalConnect = net.Socket.prototype.connect;
const originalLookup = dns.lookup;
const originalPromisesLookup = dns.promises.lookup;

/** `host:port` (or `pipe:<path>`) of a `Socket#connect` call, whichever overload it used. */
function target(args: unknown[]): string {
  // `net.connect` hands the socket its already-normalised `[options, callback]` array.
  const first: unknown = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  if (typeof first === 'string') return `pipe:${first}`;
  if (typeof first === 'number') return `${String(args[1] ?? 'localhost')}:${first}`;
  const options = (first ?? {}) as { host?: string; port?: number; path?: string };
  if (options.path !== undefined) return `pipe:${options.path}`;
  return `${options.host ?? 'localhost'}:${String(options.port)}`;
}

let e: Round5Engine;

beforeAll(async () => {
  net.Socket.prototype.connect = function connect(this: net.Socket, ...args: unknown[]) {
    connections.push(target(args));
    return (originalConnect as (...rest: unknown[]) => net.Socket).apply(this, args);
  } as typeof originalConnect;
  dns.lookup = function lookup(...args: unknown[]) {
    lookups.push(String(args[0]));
    return (originalLookup as (...rest: unknown[]) => unknown).apply(dns, args);
  } as typeof dns.lookup;
  dns.promises.lookup = function lookup(...args: unknown[]) {
    lookups.push(String(args[0]));
    return (originalPromisesLookup as (...rest: unknown[]) => unknown).apply(dns.promises, args);
  } as typeof dns.promises.lookup;

  e = await startRound5Engine();
}, 60_000);

afterAll(async () => {
  await e?.stop();
  net.Socket.prototype.connect = originalConnect;
  dns.lookup = originalLookup;
  dns.promises.lookup = originalPromisesLookup;
});

describe('NFR-PRIV-01 TC-NFR-012 the engine makes no outbound connection', () => {
  it('a full knowledge base and run on the mock provider connect only to the engine on 127.0.0.1', async () => {
    const providerId = await mockProvider(e);
    const projectId = await createProject(e, 'Offline');
    const kb = await createKb(e, projectId, providerId);
    await addCorpusFile(e, kb.id, 'handbook.md');
    await addCorpusFile(e, kb.id, 'notes.txt');
    expect((await settledDocuments(e, kb.id, 2)).map((doc) => doc.status)).toEqual([
      'ready',
      'ready',
    ]);
    await e.post(`/knowledge-bases/${kb.id}/query`, { query: 'zephyrine-protocol-7' });
    const graph = await importWorkflow(
      e,
      projectId,
      fixtureWorkflow('rag-qa.json', {
        [PLACEHOLDER.provider]: providerId,
        [PLACEHOLDER.knowledgeBase]: kb.id,
      }),
    );
    expect((await runToEnd(e, graph.workflow.id)).status).toBe('COMPLETE');

    expect(connections.length).toBeGreaterThan(0);
    expect([...new Set(connections)]).toEqual([`127.0.0.1:${e.engine.port}`]);
    // No name is ever resolved. The one `dns.lookup` there is, is Node's `server.listen` passing the
    // engine's own bind address through it — an IP literal, answered without any resolver query.
    expect(lookups.filter((name) => net.isIP(name) === 0)).toEqual([]);
    expect([...new Set(lookups)]).toEqual(['127.0.0.1']);
  }, 60_000);
});
