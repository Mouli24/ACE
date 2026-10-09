import { describe, expect, it } from 'vitest';

import {
  DESKTOP_BRIDGE_CHANNEL,
  DESKTOP_BRIDGE_KEY,
  DESKTOP_MODES,
  DesktopBridgeSchema,
  EngineIpcReadySchema,
  EngineIpcShutdownSchema,
  EngineToShellMessageSchema,
  ShellToEngineMessageSchema,
} from '../desktop.js';
import * as contracts from '../index.js';

const TOKEN = 'f'.repeat(64);

describe('FR-DSK-002 the desktop bridge (D294)', () => {
  it('names the window key and the IPC channel', () => {
    expect(DESKTOP_BRIDGE_KEY).toBe('aceDesktop');
    expect(DESKTOP_BRIDGE_CHANNEL).toBe('ace-desktop:bridge');
    expect(DESKTOP_MODES).toEqual(['dev', 'packaged']);
  });

  it.each([
    ['dev, on the default port', { engineUrl: 'http://127.0.0.1:4747', token: TOKEN, mode: 'dev' }],
    [
      'packaged, on a picked port',
      { engineUrl: 'http://127.0.0.1:51234', token: TOKEN, mode: 'packaged' },
    ],
    ['the localhost spelling', { engineUrl: 'http://localhost:4747', token: 'abc', mode: 'dev' }],
  ])('accepts %s', (_label, bridge) => {
    expect(DesktopBridgeSchema.parse(bridge)).toEqual(bridge);
  });

  it.each([
    ['a non-loopback engine', { engineUrl: 'http://192.168.1.5:4747', token: TOKEN, mode: 'dev' }],
    ['a remote engine', { engineUrl: 'https://ace.example.com', token: TOKEN, mode: 'dev' }],
    ['a non-http scheme', { engineUrl: 'file:///C:/engine', token: TOKEN, mode: 'dev' }],
    ['an engine that is not a URL', { engineUrl: '127.0.0.1:4747', token: TOKEN, mode: 'dev' }],
    ['an empty token', { engineUrl: 'http://127.0.0.1:4747', token: '', mode: 'dev' }],
    ['a token with spaces', { engineUrl: 'http://127.0.0.1:4747', token: 'a b', mode: 'dev' }],
    ['an unknown mode', { engineUrl: 'http://127.0.0.1:4747', token: TOKEN, mode: 'web' }],
    ['a missing field', { engineUrl: 'http://127.0.0.1:4747', mode: 'dev' }],
    ['not an object', 'aceDesktop'],
  ])('rejects %s', (_label, bridge) => {
    expect(DesktopBridgeSchema.safeParse(bridge).success).toBe(false);
  });

  it('is exported from the barrel', () => {
    expect(contracts.DesktopBridgeSchema).toBe(DesktopBridgeSchema);
    expect(contracts.DESKTOP_BRIDGE_KEY).toBe(DESKTOP_BRIDGE_KEY);
  });
});

describe('FR-DSK-002 engine IPC messages (D296)', () => {
  const ready = { type: 'ready', url: 'http://127.0.0.1:51234', port: 51234, token: TOKEN };

  it('ready carries the engine origin, port and token', () => {
    expect(EngineToShellMessageSchema.parse(ready)).toEqual(ready);
    expect(EngineIpcReadySchema.parse({ ...ready, url: 'http://localhost:51234' })).toBeTruthy();
  });

  it.each([
    ['https', { ...ready, url: 'https://127.0.0.1:51234' }],
    ['a remote host', { ...ready, url: 'http://10.0.0.1:51234' }],
    ['port 0', { ...ready, port: 0 }],
    ['an empty token', { ...ready, token: '' }],
    ['an unknown type', { ...ready, type: 'started' }],
  ])('ready rejects %s', (_label, message) => {
    expect(EngineToShellMessageSchema.safeParse(message).success).toBe(false);
  });

  it('shutdown is the one shell → engine message', () => {
    expect(ShellToEngineMessageSchema.parse({ type: 'shutdown' })).toEqual({ type: 'shutdown' });
    expect(EngineIpcShutdownSchema.safeParse({ type: 'stop' }).success).toBe(false);
    expect(ShellToEngineMessageSchema.safeParse(ready).success).toBe(false);
  });
});
