import type { Provider, ProviderType } from '@ace/contracts';
import type { ProviderAdapter } from '@ace/engine';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createMockAdapter } from '../adapters/mock.js';
import { manifestFor } from '../catalog/index.js';
import type { CliDetector } from '../adapters/cli/detect.js';
import { UnknownProviderTypeError, createProviderAdapterFactory } from '../factory.js';

/**
 * The factory is the wiring between a stored provider row and a live adapter. It is the one
 * place a wrong mapping would be invisible — every adapter satisfies the same interface, so a
 * provider typed `google` handed the OpenAI adapter would fail only at the first real call.
 */

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const NOW = '2026-09-22T10:00:00.000Z';

const provider = (type: ProviderType, baseUrl?: string): Provider => ({
  id: '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD',
  type,
  name: type,
  ...(baseUrl === undefined ? {} : { baseUrl }),
  keySet: true,
  status: 'UNKNOWN',
  concurrency: 20,
  createdAt: NOW,
  updatedAt: NOW,
});

describe('Arch §14.1 every provider type maps to its own adapter', () => {
  const factory = createProviderAdapterFactory();

  it.each([
    ['anthropic', 'anthropic'],
    ['google', 'google'],
    ['openai', 'openai'],
    ['openai_compatible', 'openai_compatible'],
    ['ollama', 'ollama'],
    ['mock', 'mock'],
  ] as const)('builds a %s adapter that reports its own type', (type, expected) => {
    const adapter = factory.create(provider(type, 'http://localhost:1234'), 'a-key');

    expect(adapter.type).toBe(expected);
  });

  it('refuses a type this build has no adapter for, naming it', () => {
    expect(() => factory.create(provider('smoke-signals' as ProviderType), undefined)).toThrow(
      UnknownProviderTypeError,
    );
    expect(() => factory.create(provider('smoke-signals' as ProviderType), undefined)).toThrow(
      /smoke-signals/,
    );
  });

  it('shares one mock call log across every mock adapter, so it spans a whole run', async () => {
    const mock = createMockAdapter({ sleep: async () => {} });
    const shared = createProviderAdapterFactory({ mock });
    const drain = async (adapter: ProviderAdapter, prompt: string): Promise<void> => {
      for await (const _chunk of adapter.generate(
        { modelId: 'mock-text', prompt, outputTypes: ['text'] },
        new AbortController().signal,
      )) {
        // Only the call log matters here.
      }
    };

    await drain(shared.create(provider('mock'), undefined), 'first');
    await drain(shared.create(provider('mock'), 'another-key'), 'second');

    expect(mock.calls().map((call) => call.prompt)).toEqual(['first', 'second']);
  });
});

describe('D-025 a mock provider answers §2.6 from its own row (TC-PRV-003, TC-PRV-004)', () => {
  const factory = createProviderAdapterFactory({
    mock: createMockAdapter({ sleep: async () => {} }),
  });

  it.each([
    ['bad', undefined, 'AUTH_FAILED'],
    ['ratelimited', undefined, 'RATE_LIMITED'],
    [undefined, 'http://unreachable.local', 'UNREACHABLE'],
    ['any-other-key', undefined, 'CONNECTED'],
    [undefined, undefined, 'CONNECTED'],
  ] as const)('apiKey %s, baseUrl %s → %s', async (apiKey, baseUrl, expected) => {
    const adapter = factory.create(provider('mock', baseUrl), apiKey);

    expect((await adapter.check()).status).toBe(expected);
  });

  it('keeps two mock providers apart: one bad key does not fail the other', async () => {
    const bad = factory.create(provider('mock'), 'bad');
    const good = factory.create(provider('mock'), 'fine');

    expect((await bad.check()).status).toBe('AUTH_FAILED');
    expect((await good.check()).status).toBe('CONNECTED');
  });
});

describe('FR-PRV-002 the key reaches the adapter and nowhere else', () => {
  it('sends the key anthropic was given', async () => {
    let seen: string | null = null;
    server.use(
      http.get('https://api.anthropic.com/v1/models', ({ request }) => {
        seen = request.headers.get('x-api-key');
        return HttpResponse.json({ data: [] });
      }),
    );

    const factory = createProviderAdapterFactory();
    await factory.create(provider('anthropic'), 'anthropic-key').check();

    expect(seen).toBe('anthropic-key');
  });

  it('lets an openai_compatible provider work with no key at all', async () => {
    server.use(
      http.get('http://localhost:4321/v1/models', ({ request }) => {
        expect(request.headers.get('authorization')).toBeNull();
        return HttpResponse.json({ data: [{ id: 'local' }] });
      }),
    );

    const factory = createProviderAdapterFactory();
    const models = await factory
      .create(provider('openai_compatible', 'http://localhost:4321'), undefined)
      .listModels();

    expect(models.map((model) => model.modelId)).toEqual(['local']);
  });

  it('FR-PRV-007 gives an ollama provider the local address when it has no base URL', async () => {
    let seen = '';
    server.use(
      http.get('http://127.0.0.1:11434/v1/models', ({ request }) => {
        seen = request.url;
        return HttpResponse.json({ data: [] });
      }),
    );

    const factory = createProviderAdapterFactory();
    await factory.create(provider('ollama'), undefined).check();

    expect(seen).toContain('127.0.0.1:11434');
  });

  it('honours a base URL the user set on an ollama provider', async () => {
    server.use(
      http.get('http://192.168.1.9:11434/v1/models', () => HttpResponse.json({ data: [] })),
    );

    const factory = createProviderAdapterFactory();
    const status = await factory
      .create(provider('ollama', 'http://192.168.1.9:11434'), undefined)
      .check();

    expect(status.status).toBe('CONNECTED');
  });
});

describe('FR-MOD-002 the factory carries the manifest and the merge', () => {
  const factory = createProviderAdapterFactory();

  it('hands back the manifest for a provider that has one', () => {
    expect(factory.manifestFor('anthropic').length).toBe(manifestFor('anthropic').length);
    expect(factory.manifestFor('anthropic')[0]?.pricing?.priceTableVersion).toBeTruthy();
  });

  it('hands back nothing for a provider whose models are discovered', () => {
    expect(factory.manifestFor('ollama')).toEqual([]);
  });

  it('merges a listing with the manifest, marking each row with where it came from', () => {
    const merged = factory.mergeCatalog(
      [
        {
          modelId: 'claude-sonnet-4-5',
          displayName: 'Claude Sonnet 4.5',
          inputTypes: ['text'],
          outputTypes: ['text'],
          contextWindow: 8192,
          supportsTools: false,
          supportsJson: false,
        },
      ],
      factory.manifestFor('anthropic'),
    );

    const discovered = merged.find((model) => model.modelId === 'claude-sonnet-4-5');
    expect(discovered?.source).toBe('discovered');
    // Enriched from the manifest: a listing carries neither types nor a context window.
    expect(discovered?.contextWindow).toBe(200_000);
    expect(merged.filter((model) => model.source === 'manifest').length).toBeGreaterThan(0);
  });
});

describe('FR-PRV-007 detection', () => {
  it('reports a detected local runtime', async () => {
    server.use(http.get('http://127.0.0.1:11434/v1/models', () => HttpResponse.json({ data: [] })));

    expect(await createProviderAdapterFactory().detect()).toEqual({
      ollama: { baseUrl: 'http://127.0.0.1:11434', detected: true },
    });
  });

  it('reports not detected rather than throwing when nothing answers', async () => {
    server.use(http.get('http://127.0.0.1:11434/v1/models', () => HttpResponse.error()));

    expect((await createProviderAdapterFactory().detect()).ollama?.detected).toBe(false);
  });
});

describe('X1 CLI providers in the factory', () => {
  const scan = {
    type: 'claude_code' as const,
    installed: true,
    version: '2.1.282',
    login: 'logged_in' as const,
    installHint: 'npm install -g @anthropic-ai/claude-code',
    loginHint: 'claude auth login',
  };
  const detector: CliDetector = {
    detect: async () => scan,
    detectAll: async () => ({ items: [scan] }),
  };
  const row = (overrides: Partial<Provider> = {}): Provider => ({
    id: '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD',
    type: 'claude_code',
    name: 'Claude Code',
    keySet: false,
    status: 'UNKNOWN',
    concurrency: 1,
    cliPermission: 'read_only',
    createdAt: '2026-10-06T10:00:00.000Z',
    updatedAt: '2026-10-06T10:00:00.000Z',
    ...overrides,
  });

  it('builds a Claude Code adapter whose check reads the scan', async () => {
    const adapter = createProviderAdapterFactory({ cliDetector: detector }).create(
      row(),
      undefined,
    );
    expect(adapter.type).toBe('claude_code');
    expect(await adapter.check()).toEqual({ status: 'CONNECTED', message: 'v2.1.282' });
    expect((await adapter.listModels()).map((model) => model.modelId)).toEqual([
      'default',
      'opus',
      'sonnet',
      'haiku',
    ]);
  });

  it('passes the terminal scan through', async () => {
    expect(await createProviderAdapterFactory({ cliDetector: detector }).detectClis?.()).toEqual({
      items: [scan],
    });
  });

  it('D270 asks the permission ceiling on every call of a CLI adapter it builds', async () => {
    let asked = 0;
    const factory = createProviderAdapterFactory({
      cliDetector: detector,
      permissionCeiling: async () => {
        asked += 1;
        return 'edit_files';
      },
    });
    const adapter = factory.create(row({ cliPermission: 'full_auto' }), undefined);
    // A folder that does not exist: the call stops before any CLI could start, installed or not.
    const call = async () => {
      for await (const chunk of adapter.generate(
        {
          modelId: 'sonnet',
          prompt: 'x',
          outputTypes: ['text'],
          workingDir: '/nonexistent/ace-folder',
        },
        new AbortController().signal,
      )) {
        void chunk;
      }
    };
    await expect(call()).rejects.toMatchObject({ nodeError: { kind: expect.any(String) } });
    await expect(call()).rejects.toBeDefined();
    expect(asked).toBe(2);
  });
});
