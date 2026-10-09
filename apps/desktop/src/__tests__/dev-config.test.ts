import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveDevConfig } from '../dev-config.js';

const HOME = join('C:', 'Users', 'someone');

function files(map: Record<string, string>): (path: string) => string | undefined {
  return (path) => map[path];
}

describe('FR-DSK-002 the dev window resolves the engine the way the engine does (D295)', () => {
  it('defaults: ~/.ace, port 4747, Vite on localhost:5173', () => {
    const config = resolveDevConfig({ env: {}, home: HOME, readFile: files({}) });
    expect(config).toEqual({
      dataDir: join(HOME, '.ace'),
      tokenFile: join(HOME, '.ace', 'session-token'),
      port: 4747,
      engineUrl: 'http://127.0.0.1:4747',
      webUrl: 'http://localhost:5173',
    });
  });

  it('ACE_DATA_DIR replaces ~/.ace, and an empty one counts as unset', () => {
    const dir = join('D:', 'ace-data');
    expect(
      resolveDevConfig({ env: { ACE_DATA_DIR: dir }, home: HOME, readFile: files({}) }).tokenFile,
    ).toBe(join(dir, 'session-token'));
    expect(
      resolveDevConfig({ env: { ACE_DATA_DIR: '' }, home: HOME, readFile: files({}) }).dataDir,
    ).toBe(join(HOME, '.ace'));
  });

  it('port precedence: ACE_PORT, then ace.config.json, then 4747', () => {
    const configFile = join(HOME, '.ace', 'ace.config.json');
    const withFile = files({ [configFile]: JSON.stringify({ port: 5000 }) });
    expect(resolveDevConfig({ env: {}, home: HOME, readFile: withFile }).port).toBe(5000);
    expect(
      resolveDevConfig({ env: { ACE_PORT: '6000' }, home: HOME, readFile: withFile }),
    ).toMatchObject({
      port: 6000,
      engineUrl: 'http://127.0.0.1:6000',
    });
  });

  it('an invalid ACE_PORT or file port falls through rather than picking a nonsense address', () => {
    const configFile = join(HOME, '.ace', 'ace.config.json');
    const badFile = files({ [configFile]: JSON.stringify({ port: 70_000 }) });
    expect(resolveDevConfig({ env: { ACE_PORT: '0' }, home: HOME, readFile: badFile }).port).toBe(
      4747,
    );
    expect(
      resolveDevConfig({ env: { ACE_PORT: 'abc' }, home: HOME, readFile: files({}) }).port,
    ).toBe(4747);
  });

  it('ace.config.json may move the data dir, but ACE_DATA_DIR still wins', () => {
    const configFile = join(HOME, '.ace', 'ace.config.json');
    const moved = join('E:', 'elsewhere');
    const readFile = files({ [configFile]: JSON.stringify({ dataDir: moved }) });
    expect(resolveDevConfig({ env: {}, home: HOME, readFile }).dataDir).toBe(moved);

    const explicit = join('F:', 'explicit');
    expect(
      resolveDevConfig({ env: { ACE_DATA_DIR: explicit }, home: HOME, readFile: files({}) })
        .dataDir,
    ).toBe(explicit);
  });

  it('a config file that is not JSON (or not an object) is ignored', () => {
    const configFile = join(HOME, '.ace', 'ace.config.json');
    expect(
      resolveDevConfig({ env: {}, home: HOME, readFile: files({ [configFile]: '{oops' }) }).port,
    ).toBe(4747);
    expect(
      resolveDevConfig({ env: {}, home: HOME, readFile: files({ [configFile]: '7' }) }).port,
    ).toBe(4747);
  });

  it('reads the real file system by default', () => {
    const config = resolveDevConfig({ env: { ACE_DATA_DIR: join(HOME, 'definitely-missing') } });
    expect(config.port).toBe(4747);
  });
});
