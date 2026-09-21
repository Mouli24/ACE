import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONFIG_PRECEDENCE,
  ConfigError,
  DEFAULT_ENGINE_CONFIG,
  loadEngineConfig,
  resolveConfig,
} from '../config/index.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-config-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('FR-SYS-010 configuration precedence', () => {
  it('resolves node -> project -> user -> engine -> defaults, in that order', () => {
    expect([...CONFIG_PRECEDENCE]).toEqual(['node', 'project', 'user', 'engine', 'defaults']);
  });

  it('lets a lower layer fill in what the layers above leave unset', () => {
    const resolved = resolveConfig<{ timeoutMs: number; retries: number; theme: string }>({
      node: { timeoutMs: 30_000 },
      user: { retries: 4 },
      defaults: { timeoutMs: 120_000, retries: 2, theme: 'dark' },
    });

    expect(resolved).toEqual({ timeoutMs: 30_000, retries: 4, theme: 'dark' });
  });

  it('treats an explicitly undefined value as "not set at this layer"', () => {
    const resolved = resolveConfig<{ timeoutMs: number }>({
      node: { timeoutMs: undefined },
      defaults: { timeoutMs: 120_000 },
    });

    expect(resolved.timeoutMs).toBe(120_000);
  });

  it('keeps a falsy value that a layer really did set', () => {
    const resolved = resolveConfig<{ retries: number; verbose: boolean }>({
      node: { retries: 0, verbose: false },
      defaults: { retries: 2, verbose: true },
    });

    expect(resolved).toEqual({ retries: 0, verbose: false });
  });
});

describe('TC-SYS-012 Precedence', () => {
  it('uses the node value when a timeout is set at both project and node', () => {
    const resolved = resolveConfig<{ timeoutMs: number }>({
      node: { timeoutMs: 30_000 },
      project: { timeoutMs: 90_000 },
      user: { timeoutMs: 150_000 },
      engine: { timeoutMs: 300_000 },
      defaults: { timeoutMs: 120_000 },
    });

    expect(resolved.timeoutMs).toBe(30_000);
  });

  it('falls through to the project value when the node does not set one', () => {
    const resolved = resolveConfig<{ timeoutMs: number }>({
      project: { timeoutMs: 90_000 },
      user: { timeoutMs: 150_000 },
      defaults: { timeoutMs: 120_000 },
    });

    expect(resolved.timeoutMs).toBe(90_000);
  });

  it('falls all the way to defaults when nothing else sets it', () => {
    expect(resolveConfig<{ timeoutMs: number }>({ defaults: { timeoutMs: 120_000 } })).toEqual({
      timeoutMs: 120_000,
    });
  });
});

describe('FR-SYS-010 engine config loading', () => {
  it('uses the documented defaults when there is no file and no env', () => {
    const config = loadEngineConfig({ dataDir: dir, env: {} });

    expect(config.port).toBe(DEFAULT_ENGINE_CONFIG.port);
    expect(config.logLevel).toBe(DEFAULT_ENGINE_CONFIG.logLevel);
    expect(config.dataDir).toBe(dir);
  });

  it('reads ace.config.json from the data directory', () => {
    writeFileSync(join(dir, 'ace.config.json'), JSON.stringify({ port: 5000, logLevel: 'debug' }));

    const config = loadEngineConfig({ dataDir: dir, env: {} });

    expect(config.port).toBe(5000);
    expect(config.logLevel).toBe('debug');
  });

  it('lets ACE_PORT override the config file', () => {
    writeFileSync(join(dir, 'ace.config.json'), JSON.stringify({ port: 5000 }));

    expect(loadEngineConfig({ dataDir: dir, env: { ACE_PORT: '6000' } }).port).toBe(6000);
  });

  it('binds 127.0.0.1 and offers no way to change it (FR-SYS-001)', () => {
    writeFileSync(join(dir, 'ace.config.json'), JSON.stringify({ host: '0.0.0.0' }));

    expect(loadEngineConfig({ dataDir: dir, env: {} }).host).toBe('127.0.0.1');
  });
});

describe('TC-SYS-011 Bad config file', () => {
  it('refuses to start on malformed JSON, naming the file', () => {
    const path = join(dir, 'ace.config.json');
    writeFileSync(path, '{ this is not json');

    expect(() => loadEngineConfig({ dataDir: dir, env: {} })).toThrow(ConfigError);
    expect(() => loadEngineConfig({ dataDir: dir, env: {} })).toThrow(/ace\.config\.json/);
  });

  it('refuses to start on an out-of-range port, naming the field and the range', () => {
    writeFileSync(join(dir, 'ace.config.json'), JSON.stringify({ port: 99_999 }));

    expect(() => loadEngineConfig({ dataDir: dir, env: {} })).toThrow(/port/);
  });

  it('refuses to start on a log level it does not know', () => {
    writeFileSync(join(dir, 'ace.config.json'), JSON.stringify({ logLevel: 'chatty' }));

    expect(() => loadEngineConfig({ dataDir: dir, env: {} })).toThrow(/logLevel/);
  });

  it('refuses to start on a non-numeric ACE_PORT rather than silently ignoring it', () => {
    expect(() => loadEngineConfig({ dataDir: dir, env: { ACE_PORT: 'eight thousand' } })).toThrow(
      /ACE_PORT/,
    );
  });

  it('says what to do next, not just what is wrong (NFR-USE-03)', () => {
    writeFileSync(join(dir, 'ace.config.json'), JSON.stringify({ port: -1 }));

    expect(() => loadEngineConfig({ dataDir: dir, env: {} })).toThrow(/refusing to start/i);
  });
});
