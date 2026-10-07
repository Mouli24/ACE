import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import { setupServer } from 'msw/node';
import type { ReactElement } from 'react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';

import { configureApi } from '../app/api';
import { routes } from '../app/routes';
import { usePanelsStore } from '../app/stores/panels';
import { useSelectionStore } from '../app/stores/selection';
import { MockDb } from '../mocks/db';
import { createHandlers } from '../mocks/handlers';
import { createRound2Handlers, stopScenario } from '../mocks/handlers-round2';
import { createRound3Handlers } from '../mocks/handlers-round3';
import { createRound4Handlers } from '../mocks/handlers-round4';
import { createRound5Handlers } from '../mocks/handlers-round5';
import { createSkillHandlers } from '../mocks/handlers-skills';
import { createTaskHandlers } from '../mocks/handlers-tasks';
import { resetMockTasks } from '../mocks/tasks';
import { resetGraphSyncRegistry } from '../workflows/sync-registry';

/** One mock engine per test file; `installMockServer()` wires the lifecycle hooks. */
export const db = new MockDb({ persist: false });
/** Newest round first: a round 3 route wins over a round 2 stand-in for the same path. */
export const server = setupServer(
  ...createSkillHandlers(db),
  ...createTaskHandlers(db),
  ...createRound5Handlers(db),
  ...createRound4Handlers(db),
  ...createRound3Handlers(db),
  ...createRound2Handlers(db),
  ...createHandlers(db),
);

export let queryClient = new QueryClient();

/** The panels store as the app starts: sheet closed, bottom panel open, no dialog, no chat target. */
const initialPanels = usePanelsStore.getState();

export function installMockServer(): void {
  beforeAll(() => {
    server.listen({ onUnhandledRequest: 'error' });
    configureApi({ token: 'mock', baseUrl: 'http://mock.local' });
  });
  beforeEach(() => {
    stopScenario();
    resetMockTasks();
    db.reset();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    resetGraphSyncRegistry();
    useSelectionStore.getState().clear();
    usePanelsStore.setState(initialPanels, true);
  });
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
}

/** Render the real route tree at `path` against the mock engine. */
export function renderApp(
  path: string,
): RenderResult & { router: ReturnType<typeof createMemoryRouter> } {
  const router = createMemoryRouter(routes, {
    initialEntries: [path],
    future: { v7_relativeSplatPath: true },
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} future={{ v7_startTransition: true }} />
    </QueryClientProvider>,
  );
  return { ...result, router };
}

/** Render a component that needs the query client but no router. */
export function renderWithQuery(ui: ReactElement): RenderResult {
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}
