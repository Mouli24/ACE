import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import type { TestEngine } from './engine.js';

/**
 * The harness's own lever on the engine it started — never a route of the engine's API.
 *
 * Arch §15.4's retention check needs two things the public API rightly does not offer (round 4 §2.4
 * has no such endpoint): moving the artifact store's clock, and running one sweep now. The engine
 * takes both from its composition root — `startEngine({ clock })` and `RunningEngine.sweepArtifacts()`
 * (D-070) — but the suite's engine lives in Vitest's global-setup process while the spec files run in
 * workers, which cannot call a function on it. So global-setup keeps the clock and serves this tiny
 * loopback endpoint, and a spec reaches it through `ACE_TEST_CONTROL_URL` with the session token.
 *
 * `POST /advance-clock-and-sweep { days }` moves the clock forward and runs one sweep, answering the
 * ids it deleted. The clock only ever moves forward, and only the artifact store reads it, so every
 * spec after the one that moved it still sees a consistent (if later) artifact timeline.
 *
 * `GET /mock-provider-calls` answers `{ calls }`, the mock provider's call log since the engine
 * started — round 5 §4 item 8: TC-RAG-009 asserts "two identical runs → exactly one summarisation
 * call ... via `mockProvider.calls()`". The log lives in the global-setup process with the engine,
 * so a spec reads it here. While `RunningEngine` exposes no `mockProvider.calls()` it answers 501
 * and says so (`TestEngine.mockProviderCalls`).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TestClock {
  now(): string;
  advanceDays(days: number): void;
}

/** Real time plus whatever the suite has advanced it by. */
export function createTestClock(): TestClock {
  let offsetMs = 0;
  return {
    now: () => new Date(Date.now() + offsetMs).toISOString(),
    advanceDays: (days) => {
      offsetMs += days * DAY_MS;
    },
  };
}

export interface TestControl {
  url: string;
  close(): Promise<void>;
}

function sameToken(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startTestControl(options: {
  engine: TestEngine;
  clock: TestClock;
}): Promise<TestControl> {
  const { engine, clock } = options;

  const server: Server = createServer((request, response) => {
    const answer = (status: number, body: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };

    const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '')?.[1];
    if (!sameToken(bearer, engine.token)) return answer(401, { error: 'unauthorized' });
    if (request.method === 'GET' && request.url === '/mock-provider-calls') {
      const calls = engine.mockProviderCalls();
      if (calls === undefined) {
        return answer(501, {
          error:
            'RunningEngine exposes no mockProvider.calls() — round 5 §4 item 8 names it as the way TC-RAG-009 counts summarisation calls',
        });
      }
      return answer(200, { calls });
    }
    if (request.method !== 'POST' || request.url !== '/advance-clock-and-sweep') {
      return answer(404, { error: 'not found' });
    }

    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      raw += chunk;
    });
    request.on('end', () => {
      const days = (JSON.parse(raw === '' ? '{}' : raw) as { days?: unknown }).days;
      if (typeof days !== 'number' || !Number.isFinite(days) || days < 0) {
        return answer(400, { error: '`days` must be a non-negative number' });
      }
      clock.advanceDays(days);
      engine.sweepArtifacts().then(
        (deleted) => answer(200, { deleted: deleted.map((artifact) => artifact.id) }),
        (error: unknown) => answer(500, { error: String(error) }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
