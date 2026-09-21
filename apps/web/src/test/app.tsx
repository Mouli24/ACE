import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import { setupServer } from 'msw/node';
import type { ReactElement } from 'react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';

import { configureApi } from '../app/api';
import { routes } from '../app/routes';
import { useSelectionStore } from '../app/stores/selection';
import { MockDb } from '../mocks/db';
import { createHandlers } from '../mocks/handlers';
import { resetGraphSyncRegistry } from '../workflows/sync-registry';

/** One mock engine per test file; `installMockServer()` wires the lifecycle hooks. */
export const db = new MockDb({ persist: false });
export const server = setupServer(...createHandlers(db));

export let queryClient = new QueryClient();

export function installMockServer(): void {
  beforeAll(() => {
    server.listen({ onUnhandledRequest: 'error' });
    configureApi({ token: 'mock', baseUrl: 'http://mock.local' });
  });
  beforeEach(() => {
    db.reset();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    resetGraphSyncRegistry();
    useSelectionStore.getState().clear();
  });
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
}

/** Render the real route tree at `path` against the mock engine. */
export function renderApp(
  path: string,
): RenderResult & { router: ReturnType<typeof createMemoryRouter> } {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...result, router };
}

/** Render a component that needs the query client but no router. */
export function renderWithQuery(ui: ReactElement): RenderResult {
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}
