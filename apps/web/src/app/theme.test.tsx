import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { db, installMockServer, queryClient } from '../test/app';

import { useApplyTheme, useResolvedTheme } from './theme';

installMockServer();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('FR-SYS-005 the web app applies Settings.theme', () => {
  afterEach(() => {
    delete document.documentElement.dataset['theme'];
    document.documentElement.style.colorScheme = '';
  });

  it('starts on the default (dark) and switches to the persisted light theme', async () => {
    db.settings.theme = 'light';
    renderHook(() => useApplyTheme(), { wrapper });
    await waitFor(() => expect(document.documentElement.dataset['theme']).toBe('light'));
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('useResolvedTheme follows data-theme on <html>', async () => {
    const { result } = renderHook(() => useResolvedTheme());
    expect(result.current).toBe('dark');
    act(() => {
      document.documentElement.dataset['theme'] = 'light';
    });
    await waitFor(() => expect(result.current).toBe('light'));
  });
});
