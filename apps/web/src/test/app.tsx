import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import { setupServer } from 'msw/node';
import type { ReactElement } from 'react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';

import { configureApi } from '../app/api';
import { routes } from '../app/routes';
import { LAYOUT_STORAGE_KEY, useLayoutStore } from '../app/stores/layout';
import { usePanelsStore } from '../app/stores/panels';
import { useSelectionStore } from '../app/stores/selection';
import { useEditorStatus } from '../forge/editor/editor-status';
import { useEditorStore } from '../forge/editor/editor-store';
import { resetModels, setMonaco } from '../forge/editor/models';
import { useExplorerStore } from '../forge/explorer/explorer-store';
import { useOutputStore } from '../forge/panel/output-store';
import { useProblemsStore } from '../forge/panel/problems-store';
import { useQuickOpen } from '../forge/quick-open/quick-open-store';
import { MockDb } from '../mocks/db';
import { createHandlers } from '../mocks/handlers';
import { createDomainHandlers, domainMock } from '../mocks/handlers-domain';
import { createForgeHandlers } from '../mocks/handlers-forge';
import { createProcessHandlers } from '../mocks/handlers-processes';
import { createRound2Handlers, stopScenario } from '../mocks/handlers-round2';
import { createRound3Handlers } from '../mocks/handlers-round3';
import { createRound4Handlers } from '../mocks/handlers-round4';
import { createRound5Handlers } from '../mocks/handlers-round5';
import { MockProcesses } from '../mocks/processes';
import { resetGraphSyncRegistry } from '../workflows/sync-registry';
import { asMonaco, createFakeMonaco } from './fake-monaco';

/** One mock engine per test file; `installMockServer()` wires the lifecycle hooks. */
export const db = new MockDb({ persist: false });
/** The mock engine's terminal processes (D301); reset before every test. */
export const processes = new MockProcesses(db);
/** Newest round first: a round 3 route wins over a round 2 stand-in for the same path. */
export const server = setupServer(
  // First: it answers a project PATCH and sees a project DELETE before the others (D301).
  ...createProcessHandlers(db, processes),
  ...createDomainHandlers(db),
  ...createForgeHandlers(db),
  ...createRound5Handlers(db),
  ...createRound4Handlers(db),
  ...createRound3Handlers(db),
  ...createRound2Handlers(db),
  ...createHandlers(db),
);

export let queryClient = new QueryClient();

/** The panels store as the app starts: sheet closed, bottom panel open, no dialog, no chat target. */
const initialPanels = usePanelsStore.getState();
/** The Forge layout as the app starts: chat and side bar open, bottom panel closed. */
const initialLayout = useLayoutStore.getState();

export function installMockServer(): void {
  beforeAll(() => {
    server.listen({ onUnhandledRequest: 'error' });
    configureApi({ token: 'mock', baseUrl: 'http://mock.local' });
  });
  beforeEach(() => {
    stopScenario();
    db.reset();
    domainMock.reset();
    processes.reset();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    resetGraphSyncRegistry();
    useSelectionStore.getState().clear();
    usePanelsStore.setState(initialPanels, true);
    useExplorerStore.setState({ projects: {} });
    useQuickOpen.setState({ open: false });
    useEditorStore.setState({ projects: {} });
    resetModels();
    setMonaco(asMonaco(createFakeMonaco()));
    localStorage.removeItem(LAYOUT_STORAGE_KEY);
    useLayoutStore.setState(initialLayout, true);
    useOutputStore.setState({ lines: {} });
    useProblemsStore.setState({ byProject: {} });
    // no text file shown (D330's `path`), and the position, file facts and language as at start
    useEditorStatus.getState().clear();
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
