import { describe, expect, it } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { LOCAL_SCOPE } from '../../ports/index.js';
import { isOriginAllowed } from '../index.js';

describe('FR-SYS-003 D301 one Origin rule for REST and the WebSocket', () => {
  const deps = {
    repository: new FakeRepository(),
    scope: LOCAL_SCOPE,
    selfOrigins: ['http://127.0.0.1:47490', 'http://localhost:47490'],
  };

  it.each([
    [undefined, true],
    ['', true],
    ['http://localhost:5173', true],
    ['http://127.0.0.1:5173', true],
    ['http://127.0.0.1:47490', true],
    ['http://localhost:47490', true],
    ['https://evil.example', false],
    ['http://localhost:5174', false],
    ['null', false],
  ] as const)('Origin %j is allowed: %s', async (origin, allowed) => {
    expect(await isOriginAllowed(deps, origin)).toBe(allowed);
  });

  it('follows the stored allow-list, not a hard-coded one', async () => {
    const repository = new FakeRepository();
    await repository.settings.update(LOCAL_SCOPE, { allowedOrigins: ['https://ace.example'] });
    const own = { repository, scope: LOCAL_SCOPE };
    expect(await isOriginAllowed(own, 'https://ace.example')).toBe(true);
    expect(await isOriginAllowed(own, 'http://localhost:5173')).toBe(false);
  });
});
