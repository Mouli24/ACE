import type { DataType, Node } from '@ace/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import { setupServer } from 'msw/node';
import type { ReactElement } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';

import { configureApi } from '../app/api';
import { startSocket, stopSocket } from '../app/socket';
import { useSelectionStore } from '../app/stores/selection';
import { MockCheckpoints } from '../mocks/checkpoints';
import { MockDb } from '../mocks/db';
import { createFakeWebSocket } from '../mocks/fake-socket';
import { createHandlers } from '../mocks/handlers';
import { createCheckpointHandlers } from '../mocks/handlers-checkpoints';
import { createRound2Handlers, stopScenario } from '../mocks/handlers-round2';
import { createRound3Handlers } from '../mocks/handlers-round3';
import { createRound4Handlers, setChatScenario } from '../mocks/handlers-round4';
import { useLayoutStore } from '../app/stores/layout';
import { usePanelsStore } from '../app/stores/panels';
import { useWorkspaceStatus } from '../app/stores/workspace-status';
import { createNode } from '../nodes/factory';
import { resetGraphSyncRegistry } from '../workflows/sync-registry';
import { useChatSessions } from './session-store';
import { useChatSocket } from './useChat';

/**
 * A self-contained mock engine for the chat panel's component tests. The shared `test/app.tsx`
 * harness does not register round 4's handlers (and is not this feature's to edit), so the chat
 * tests wire their own — round 4 newest, then 3/2/1 for the graph and catalogue endpoints the panel
 * leans on — plus the fake socket the streaming reply arrives on.
 */
export const db = new MockDb({ persist: false });
/** D300: the mock engine's checkpoints, for the Changes card under a chat turn. */
export const checkpoints = new MockCheckpoints(db);
export const server = setupServer(
  ...createCheckpointHandlers(db, checkpoints),
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
    checkpoints.reset();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    resetGraphSyncRegistry();
    useSelectionStore.getState().clear();
    // Sessions outlive components on purpose (D285); between tests they must not.
    useChatSessions.getState().reset();
    usePanelsStore.getState().chatWith(undefined);
    useLayoutStore.setState({ chatOpen: true });
    useWorkspaceStatus.getState().setMessageCount(null);
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

/**
 * Seed a project + workflow with one agent node on the mock provider's `mock-chat` model and focus
 * it. `withModel: false` leaves the model unchosen, which the engine refuses up front (D285).
 */
export function seedAgentNode(
  options: {
    instructions?: string;
    name?: string;
    withModel?: boolean;
    workflowId?: string;
    /** `['text', 'image']` by default, for the attachment tests; a run needs what the model reads. */
    inputTypes?: DataType[];
  } = {},
): {
  workflowId: string;
  node: Node;
} {
  const workflowId =
    options.workflowId ?? db.createWorkflow(db.createProject({ name: 'P' }).id, 'F').id;
  const provider = db.listProviders()[0] ?? db.createProvider({ type: 'mock', name: 'Mock' });
  const base = createNode('agent', workflowId, { x: 0, y: 0 });
  // instructions drive the French variant of mock-chat (§2.6).
  const node = {
    ...base,
    name: options.name ?? 'Writer',
    config: {
      ...base.config,
      ...(options.withModel === false ? {} : { providerId: provider.id, modelId: 'mock-chat' }),
      instructions: options.instructions ?? '',
      inputTypes: options.inputTypes ?? ['text', 'image'],
    },
  } as Node;
  db.commitGraph(workflowId, [...db.nodesOf(workflowId), node], db.edgesOf(workflowId));
  useSelectionStore.getState().setSelection([node.id], []);
  return { workflowId, node };
}

/** The router's current path, so a test can see where a link or button navigated. */
function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

/**
 * The chat socket, as the workflow layout mounts it (D354): the aside and the phone panel no
 * longer mount it themselves, so a component test standing either up alone mounts it here — on the
 * column's node, else the focused one.
 */
function ChatSocket() {
  const chatNodeId = usePanelsStore((s) => s.chatNodeId);
  const focusedNodeId = useSelectionStore((s) => s.focusedNodeId);
  useChatSocket(chatNodeId ?? focusedNodeId);
  return null;
}

/** Render inside a router (the aside's links navigate) with the location probe. */
export function renderChat(ui: ReactElement): RenderResult {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        {ui}
        <ChatSocket />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
