import { SESSION_TOKEN_STORAGE_KEY } from '@ace/contracts';

import { readSessionToken } from './token';

describe('readSessionToken (round 1 §2.10 handshake, FR-SYS-002)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  it('reads ?token=, stores it in sessionStorage and strips it from the URL', () => {
    window.history.replaceState(null, '', '/?token=abc123&x=1');
    expect(readSessionToken()).toBe('abc123');
    expect(sessionStorage.getItem(SESSION_TOKEN_STORAGE_KEY)).toBe('abc123');
    expect(window.location.search).toBe('?x=1');
  });

  it('falls back to the stored token when the URL has none', () => {
    sessionStorage.setItem(SESSION_TOKEN_STORAGE_KEY, 'stored');
    expect(readSessionToken()).toBe('stored');
  });

  it('returns undefined when there is no token anywhere', () => {
    expect(readSessionToken()).toBeUndefined();
  });

  it('a fresh ?token= replaces a stored one (new engine start = new token)', () => {
    sessionStorage.setItem(SESSION_TOKEN_STORAGE_KEY, 'old');
    window.history.replaceState(null, '', '/projects?token=new');
    expect(readSessionToken()).toBe('new');
    expect(window.location.pathname).toBe('/projects');
    expect(window.location.search).toBe('');
  });
});
