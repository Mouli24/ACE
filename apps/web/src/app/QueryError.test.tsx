import { AceApiError } from '@ace/sdk';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { QueryError, describeError } from './QueryError';

const apiError = (status: number, code: string, kind = 'workflow', message = 'boom') =>
  new AceApiError(status, {
    kind: kind as never,
    code,
    message,
    retryable: false,
  });

function renderError(error: unknown, what = 'workflow') {
  return render(
    <MemoryRouter>
      <QueryError error={error} what={what} />
    </MemoryRouter>,
  );
}

/**
 * D-009 / NFR-USE-03: every failure used to read "Workflow not found." — a stale token, a blocked
 * origin and a dead engine all said the same thing and the offered link failed the same way.
 */
describe('describeError (D-009, NFR-USE-03)', () => {
  it('401 says the session token is stale and how to get a fresh one', () => {
    const described = describeError(apiError(401, 'unauthorized', 'auth'), 'workflow');
    expect(described.title).toMatch(/session/i);
    expect(described.detail).toMatch(/token/i);
    expect(described.detail).toMatch(/\?token=/);
    expect(described.kind).toBe('auth');
  });

  it('403 explains the origin allow-list', () => {
    const described = describeError(apiError(403, 'forbidden_origin', 'auth'), 'workflow');
    expect(described.title).toMatch(/refused this address|origin/i);
    expect(described.detail).toMatch(/allow-list|allowedOrigins/i);
  });

  it('404 is the only case that says "not found", and names the thing', () => {
    const described = describeError(apiError(404, 'not_found'), 'workflow');
    expect(described.title).toMatch(/workflow/i);
    expect(described.title).toMatch(/not found/i);
    expect(described.kind).toBe('missing');
  });

  it('a dead engine reads as unreachable, not as missing', () => {
    const described = describeError(AceApiError.network(new Error('Failed to fetch')), 'workflow');
    expect(described.title).toMatch(/cannot reach the engine/i);
    expect(described.detail).toMatch(/pnpm dev|running/i);
    expect(described.kind).toBe('offline');
    expect(described.title).not.toMatch(/not found/i);
  });

  it('a 500 keeps the engine message rather than inventing one', () => {
    const described = describeError(
      apiError(500, 'internal', 'provider', 'disk on fire'),
      'workflow',
    );
    expect(described.detail).toContain('disk on fire');
    expect(described.title).not.toMatch(/not found/i);
  });

  it('a non-API error still produces something a person can act on', () => {
    const described = describeError(new Error('kaboom'), 'project');
    expect(described.title).toMatch(/project/i);
    expect(described.detail).toContain('kaboom');
  });
});

describe('QueryError', () => {
  it('renders the title and the detail as an alert', () => {
    renderError(apiError(404, 'not_found'));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/workflow.*not found/i);
  });

  it('offers a way back only when navigating away can help', () => {
    const { unmount } = renderError(apiError(404, 'not_found'));
    expect(screen.getByRole('link', { name: /projects/i })).toBeInTheDocument();
    unmount();

    // a stale token is not fixed by navigating: the page must not offer a link that fails the same way
    renderError(apiError(401, 'unauthorized', 'auth'));
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/\?token=/);
  });
});
