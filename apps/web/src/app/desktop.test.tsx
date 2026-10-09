import { DEFAULT_ENGINE_ORIGIN, SESSION_TOKEN_STORAGE_KEY } from '@ace/contracts';
import { render, screen } from '@testing-library/react';

import { desktopBridge, readDesktopBridge } from './desktop';
import { engineOrigin, wsUrl } from './env';
import { readSessionToken } from './token';
import { TokenMissing } from './TokenMissing';

const TOKEN = 'b'.repeat(64);
const DEV_BRIDGE = { engineUrl: 'http://127.0.0.1:4747', token: TOKEN, mode: 'dev' } as const;
const PACKAGED_BRIDGE = {
  engineUrl: 'http://127.0.0.1:51234/',
  token: TOKEN,
  mode: 'packaged',
} as const;

type BridgeWindow = Window & { aceDesktop?: unknown };

afterEach(() => {
  delete (window as BridgeWindow).aceDesktop;
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('FR-DSK-002 the desktop bridge (D294)', () => {
  it('is absent in a browser', () => {
    expect(readDesktopBridge()).toEqual({ status: 'absent' });
    expect(desktopBridge()).toBeUndefined();
  });

  it('reads window.aceDesktop and checks it against the contract', () => {
    (window as BridgeWindow).aceDesktop = DEV_BRIDGE;
    expect(readDesktopBridge()).toEqual({ status: 'valid', bridge: DEV_BRIDGE });
    expect(desktopBridge()).toEqual(DEV_BRIDGE);
  });

  it.each([
    ['a non-loopback engine', { ...DEV_BRIDGE, engineUrl: 'http://10.0.0.2:4747' }],
    ['an empty token', { ...DEV_BRIDGE, token: '' }],
    ['an unknown mode', { ...DEV_BRIDGE, mode: 'browser' }],
    ['a string', 'http://127.0.0.1:4747'],
    ['null', null],
  ])('ignores %s, and says so', (_label, value) => {
    expect(readDesktopBridge({ aceDesktop: value })).toEqual({ status: 'invalid' });
    expect(desktopBridge({ aceDesktop: value })).toBeUndefined();
  });
});

describe('FR-DSK-002 engine address: bridge, then VITE_ACE_URL, then the default (D294)', () => {
  it('without a bridge nothing changes', () => {
    expect(engineOrigin({})).toBe(DEFAULT_ENGINE_ORIGIN);
    expect(engineOrigin({ VITE_ACE_URL: 'http://127.0.0.1:47470/' })).toBe(
      'http://127.0.0.1:47470',
    );
    expect(wsUrl({ VITE_ACE_URL: 'http://127.0.0.1:47470' })).toBe('ws://127.0.0.1:47470/ws');
  });

  it('the bridge’s engine beats VITE_ACE_URL, for REST and the socket alike', () => {
    const env = { VITE_ACE_URL: 'http://127.0.0.1:47470' };
    expect(engineOrigin(env, PACKAGED_BRIDGE)).toBe('http://127.0.0.1:51234');
    expect(wsUrl(env, PACKAGED_BRIDGE)).toBe('ws://127.0.0.1:51234/ws');
  });

  it('by default it reads the bridge from the window', () => {
    (window as BridgeWindow).aceDesktop = PACKAGED_BRIDGE;
    expect(engineOrigin({ VITE_ACE_URL: 'http://127.0.0.1:47470' })).toBe('http://127.0.0.1:51234');
    expect(wsUrl({})).toBe('ws://127.0.0.1:51234/ws');
  });

  it('an invalid bridge is ignored: back to VITE_ACE_URL', () => {
    (window as BridgeWindow).aceDesktop = { ...DEV_BRIDGE, engineUrl: 'https://evil.example' };
    expect(engineOrigin({ VITE_ACE_URL: 'http://127.0.0.1:47470' })).toBe('http://127.0.0.1:47470');
  });
});

describe('FR-DSK-002 session token: bridge, then ?token=, then sessionStorage (D294)', () => {
  it('the bridge’s token beats both, and is not stored', () => {
    sessionStorage.setItem(SESSION_TOKEN_STORAGE_KEY, 'stale-from-before-a-restart');
    window.history.replaceState(null, '', '/?token=from-url');
    expect(readSessionToken(DEV_BRIDGE)).toBe(TOKEN);
    expect(sessionStorage.getItem(SESSION_TOKEN_STORAGE_KEY)).toBe('stale-from-before-a-restart');
  });

  it('by default it reads the bridge from the window', () => {
    (window as BridgeWindow).aceDesktop = DEV_BRIDGE;
    sessionStorage.setItem(SESSION_TOKEN_STORAGE_KEY, 'old');
    expect(readSessionToken()).toBe(TOKEN);
  });

  it('without a bridge, ?token= and sessionStorage work as before', () => {
    window.history.replaceState(null, '', '/?token=abc');
    expect(readSessionToken()).toBe('abc');
    expect(window.location.search).toBe('');
    expect(readSessionToken()).toBe('abc');
  });

  it('an invalid bridge falls back to the browser handshake', () => {
    (window as BridgeWindow).aceDesktop = { token: TOKEN };
    window.history.replaceState(null, '', '/?token=abc');
    expect(readSessionToken()).toBe('abc');
  });
});

describe('FR-DSK-002 TokenMissing', () => {
  it('in a browser, says to open the engine link', () => {
    render(<TokenMissing />);
    expect(
      screen.getByRole('heading', { name: 'Open ACE from the engine link' }),
    ).toBeInTheDocument();
  });

  it('with an unusable desktop bridge, says so and how to recover', () => {
    render(<TokenMissing desktop />);
    expect(screen.getByTestId('token-missing-desktop')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'ACE could not connect to its engine' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/pnpm dev/)).not.toBeInTheDocument();
  });
});
