import { DEFAULT_ENGINE_ORIGIN } from '@ace/contracts';

import { engineOrigin, isMockMode, wsUrl } from './env';

describe('env — engine address and mock switch (D27, round 1 §5)', () => {
  it('defaults to the contract engine origin', () => {
    expect(engineOrigin({})).toBe(DEFAULT_ENGINE_ORIGIN);
  });

  it('VITE_ACE_URL overrides the origin and a trailing slash is dropped', () => {
    expect(engineOrigin({ VITE_ACE_URL: 'http://127.0.0.1:47470/' })).toBe(
      'http://127.0.0.1:47470',
    );
  });

  it('derives the ws url from the origin', () => {
    expect(wsUrl({ VITE_ACE_URL: 'http://127.0.0.1:4747' })).toBe('ws://127.0.0.1:4747/ws');
    expect(wsUrl({ VITE_ACE_URL: 'https://ace.example' })).toBe('wss://ace.example/ws');
  });

  it('mock mode is on only when VITE_ACE_MOCK is set to a truthy value', () => {
    expect(isMockMode({})).toBe(false);
    expect(isMockMode({ VITE_ACE_MOCK: '' })).toBe(false);
    expect(isMockMode({ VITE_ACE_MOCK: '0' })).toBe(false);
    expect(isMockMode({ VITE_ACE_MOCK: '1' })).toBe(true);
    expect(isMockMode({ VITE_ACE_MOCK: 'true' })).toBe(true);
  });
});
