import type { Node } from '@ace/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import { setupServer } from 'msw/node';
import type { ReactElement } from 'react';

import { configureApi } from '../app/api';
import { startSocket, stopSocket } from '../app/socket';
import { useSelectionStore } from '../app/stores/selection';
import { MockDb } from '../mocks/db';
import { createFakeWebSocket } from '../mocks/fake-socket';
import { createHandlers } from '../mocks/handlers';
import { createRound2Handlers, stopScenario } from '../mocks/handlers-round2';
import { createRound3Handlers } from '../mocks/handlers-round3';
import { createRound4Handlers, setChatScenario } from '../mocks/handlers-round4';
import { createNode } from '../nodes/factory';
import { resetGraphSyncRegistry } from '../workflows/sync-registry';

/**
 * A self-contained mock engine for the chat panel's component tests. The shared `test/app.tsx`
 * harness does not register round 4's handlers (and is not this feature's to edit), so the chat
 * tests wire their own — round 4 newest, then 3/2/1 for the graph and catalogue endpoints the panel
 * leans on — plus the fake socket the streaming reply arrives on.
 */
export const db = new MockDb({ persist: false });
export const server = setupServer(
  ...createRound4Handlers(db),
  ...createRound3Handlers(db),
  ...createRound2Handlers(db),
  ...createHandlers(db),
);

export let queryClient = new QueryClient();

export function installChatMockServer(): void {
  beforeAll(() => {
    server.listen({ onUnhandledRequest: 'error' });
    configureApi({ token: 'mock', baseUrl: 'http://mock.local' });
  });
  beforeEach(() => {
    stopScenario();
    setChatScenario('chat-stream');
    db.reset();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    resetGraphSyncRegistry();
    useSelectionStore.getState().clear();
    startSocket({
      token: 'mock',
      queryClient,
      url: 'ws://mock.local/ws',
      WebSocket: createFakeWebSocket(db) as unknown as typeof WebSocket,
    });
  });
  afterEach(() => {
    stopSocket();
    server.resetHandlers();
  });
  afterAll(() => server.close());
}

/** Seed a project + workflow with one agent node (mock-chat behaviour) and focus it. */
export function seedAgentNode(options: { instructions?: string; name?: string } = {}): {
  workflowId: string;
  node: Node;
} {
  const project = db.createProject({ name: 'P' });
  const workflow = db.createWorkflow(project.id, 'F');
  db.createProvider({ type: 'mock', name: 'Mock' });
  const base = createNode('agent', workflow.id, { x: 0, y: 0 });
  // mock-chat replies regardless of the model row; instructions drive the French variant (§2.6).
  const node = {
    ...base,
    name: options.name ?? 'Writer',
    config: {
      ...base.config,
      instructions: options.instructions ?? '',
      inputTypes: ['text', 'image'],
    },
  } as Node;
  db.commitGraph(workflow.id, [node], []);
  useSelectionStore.getState().setSelection([node.id], []);
  return { workflowId: workflow.id, node };
}

export function renderChat(ui: ReactElement): RenderResult {
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}
