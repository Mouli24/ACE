import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import { setupServer } from 'msw/node';
import type { ReactElement } from 'react';

import { configureApi } from '../../app/api';
import { startSocket, stopSocket } from '../../app/socket';
import { MockDb } from '../../mocks/db';
import { createFakeWebSocket } from '../../mocks/fake-socket';
import { createHandlers } from '../../mocks/handlers';
import { createRound2Handlers, stopScenario } from '../../mocks/handlers-round2';
import { createRound3Handlers } from '../../mocks/handlers-round3';
import { createRound4Handlers } from '../../mocks/handlers-round4';

/**
 * A self-contained mock engine for the Tools library tests. `apps/web/src/test/app` boots only the
 * round 1–3 handlers and routes, and this screen's `/library/tools` route and the round 4 handlers
 * are not wired there yet — so these tests stand up their own MSW server (newest round first) and
 * render the component directly, the same lifecycle `installMockServer` uses.
 */
export const db = new MockDb({ persist: false });

export const server = setupServer(
  ...createRound4Handlers(db),
  ...createRound3Handlers(db),
  ...createRound2Handlers(db),
  ...createHandlers(db),
);

export let queryClient = new QueryClient();

export function installToolsMockServer(): void {
  beforeAll(() => {
    server.listen({ onUnhandledRequest: 'error' });
    configureApi({ token: 'mock', baseUrl: 'http://mock.local' });
  });
  beforeEach(() => {
    stopScenario();
    db.reset();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  });
  afterEach(() => {
    stopSocket();
    server.resetHandlers();
  });
  afterAll(() => server.close());
}

/** Render a component against the mock engine's query client, no router needed. */
export function renderTools(ui: ReactElement): RenderResult {
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

/** Start the single socket over the fake WebSocket, so `db.emit` reaches the screen (mcp.status). */
export function startToolsSocket(): void {
  startSocket({
    token: 'mock',
    queryClient,
    url: 'ws://mock.local/ws',
    WebSocket: createFakeWebSocket(db) as unknown as typeof WebSocket,
  });
}
