import '@fontsource/plus-jakarta-sans/400.css';
import '@fontsource/plus-jakarta-sans/500.css';
import '@fontsource/plus-jakarta-sans/600.css';
import '@fontsource/plus-jakarta-sans/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './index.css';

import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';

import { TokenMissing } from './app/TokenMissing';
import { configureApi } from './app/api';
import { readDesktopBridge } from './app/desktop';
import { isMockMode } from './app/env';
import { createQueryClient } from './app/query-client';
import { preloadRoutes, routes } from './app/routes';
import { startSocket } from './app/socket';
import { readSessionToken } from './app/token';
import { initThemeMode } from './theme/mode';

const MOCK_TOKEN = 'mock-session';

async function boot(): Promise<void> {
  initThemeMode();
  const root = createRoot(document.getElementById('root') as HTMLElement);
  const queryClient = createQueryClient();

  let token = readSessionToken();
  let WebSocketImpl: typeof WebSocket | undefined;

  if (isMockMode()) {
    const { startMocks, seedFixtureFromUrl } = await import('./mocks/browser');
    const mocks = await startMocks();
    WebSocketImpl = mocks.WebSocket;
    token ??= MOCK_TOKEN;
    const fixture = seedFixtureFromUrl();
    if (fixture) {
      window.history.replaceState(
        null,
        '',
        `/projects/${fixture.projectId}/workflows/${fixture.workflowId}`,
      );
    }
  }

  if (!token) {
    root.render(
      <StrictMode>
        <TokenMissing desktop={readDesktopBridge().status === 'invalid'} />
      </StrictMode>,
    );
    return;
  }

  configureApi({ token });
  startSocket({ token, queryClient, ...(WebSocketImpl ? { WebSocket: WebSocketImpl } : {}) });

  const router = createBrowserRouter(routes, { future: { v7_relativeSplatPath: true } });
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </QueryClientProvider>
    </StrictMode>,
  );
  // Audit U-8: the screens split off the main chunk load once the first screen is up, so opening
  // one later does not wait. A failed fetch is retried by that screen's own first visit.
  const preload = () => void preloadRoutes().catch(() => undefined);
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(preload);
  else setTimeout(preload, 1500);
}

void boot();
