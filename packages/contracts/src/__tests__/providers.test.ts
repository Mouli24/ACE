import { describe, expect, it } from 'vitest';

import { ProviderInUseDetailsSchema } from '../errors.js';
import {
  CLI_INSTALL_HINTS,
  CLI_LOGIN_HINTS,
  CLI_PERMISSIONS,
  CLI_PROVIDER_TYPES,
  CliDetectResponseSchema,
  CliDetectionSchema,
  cliPatchError,
  CreateProviderRequestSchema,
  DEFAULT_CLI_CONCURRENCY,
  DEFAULT_CLI_PERMISSION,
  DEFAULT_PROVIDER_CONCURRENCY,
  isCliProviderType,
  routeOf,
  ProviderCheckResultSchema,
  ProviderDetectResponseSchema,
  ProviderSchema,
  UpdateProviderRequestSchema,
} from '../providers.js';
import { NODE_A, NOW, PROVIDER_ID } from './fixtures.js';

const provider = {
  id: PROVIDER_ID,
  type: 'mock',
  name: 'Mock',
  keySet: false,
  status: 'CONNECTED',
  concurrency: 4,
  createdAt: NOW,
  updatedAt: NOW,
};

describe('FR-PRV-001 Provider', () => {
  it('accepts a provider of every type round 2 §2.1 allows', () => {
    for (const type of ['anthropic', 'google', 'openai', 'openai_compatible', 'ollama', 'mock']) {
      expect(ProviderSchema.safeParse({ ...provider, type }).success, type).toBe(true);
    }
  });

  it('carries status, message and last-checked time from the last check', () => {
    const parsed = ProviderSchema.parse({
      ...provider,
      status: 'AUTH_FAILED',
      statusMessage: 'invalid x-api-key',
      lastCheckedAt: NOW,
    });

    expect(parsed.status).toBe('AUTH_FAILED');
    expect(parsed.statusMessage).toBe('invalid x-api-key');
    expect(parsed.lastCheckedAt).toBe(NOW);
  });

  it('refuses a name outside 1..80 characters', () => {
    expect(ProviderSchema.safeParse({ ...provider, name: '' }).success).toBe(false);
    expect(ProviderSchema.safeParse({ ...provider, name: 'x'.repeat(81) }).success).toBe(false);
    expect(ProviderSchema.safeParse({ ...provider, name: 'x'.repeat(80) }).success).toBe(true);
  });

  it('refuses a status that is not a ProviderState', () => {
    expect(ProviderSchema.safeParse({ ...provider, status: 'connected' }).success).toBe(false);
  });

  it('refuses a baseUrl that is not a URL', () => {
    expect(ProviderSchema.safeParse({ ...provider, baseUrl: 'not a url' }).success).toBe(false);
    expect(
      ProviderSchema.safeParse({ ...provider, baseUrl: 'http://127.0.0.1:11434' }).success,
    ).toBe(true);
  });

  it('audit P-8 refuses a base URL that is not http or https', () => {
    for (const baseUrl of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://llm.example']) {
      expect(UpdateProviderRequestSchema.safeParse({ baseUrl }).success).toBe(false);
    }
    const https = UpdateProviderRequestSchema.safeParse({ baseUrl: 'https://llm.example/v1' });
    expect(https.success).toBe(true);
  });
});

describe('FR-PRV-002 the API key is never part of a Provider', () => {
  it('drops an apiKey that reaches the response shape', () => {
    const parsed = ProviderSchema.parse({ ...provider, apiKey: 'test-key-value' });

    expect(parsed).not.toHaveProperty('apiKey');
    expect(JSON.stringify(parsed)).not.toContain('test-key-value');
  });

  it('reports only whether a key is set', () => {
    expect(ProviderSchema.parse({ ...provider, keySet: true }).keySet).toBe(true);
    expect(ProviderSchema.safeParse({ ...provider, keySet: undefined }).success).toBe(false);
  });

  it('takes the key on the create request, where it goes to the SecretStore and no further', () => {
    const parsed = CreateProviderRequestSchema.parse({
      type: 'anthropic',
      name: 'Anthropic',
      apiKey: 'test-key-value',
    });

    expect(parsed.apiKey).toBe('test-key-value');
  });
});

describe('FR-PRV-005 CreateProviderRequest and UpdateProviderRequest', () => {
  it('needs a type and a name to create', () => {
    expect(CreateProviderRequestSchema.safeParse({ name: 'Mock' }).success).toBe(false);
    expect(CreateProviderRequestSchema.safeParse({ type: 'mock' }).success).toBe(false);
    expect(CreateProviderRequestSchema.safeParse({ type: 'mock', name: 'Mock' }).success).toBe(true);
  });

  it('rotates the key when the patch carries one, and changes nothing else when it is absent', () => {
    expect(UpdateProviderRequestSchema.parse({ apiKey: 'rotated' })).toEqual({ apiKey: 'rotated' });
    expect(UpdateProviderRequestSchema.parse({})).toEqual({});
  });

  it('refuses an empty patch field that would blank the provider', () => {
    expect(UpdateProviderRequestSchema.safeParse({ name: '' }).success).toBe(false);
    expect(UpdateProviderRequestSchema.safeParse({ baseUrl: 'nope' }).success).toBe(false);
  });
});

describe('FR-PRV-003 ProviderCheckResult', () => {
  it('reports the state, the message and how long the check took', () => {
    const result = {
      status: 'RATE_LIMITED',
      message: 'slow down',
      latencyMs: 37,
      checkedAt: NOW,
    };

    expect(ProviderCheckResultSchema.parse(result)).toEqual(result);
  });

  it('needs only a state and a time', () => {
    expect(ProviderCheckResultSchema.safeParse({ status: 'CONNECTED', checkedAt: NOW }).success).toBe(
      true,
    );
    expect(ProviderCheckResultSchema.safeParse({ status: 'CONNECTED' }).success).toBe(false);
  });

  it('refuses a negative latency', () => {
    expect(
      ProviderCheckResultSchema.safeParse({ status: 'CONNECTED', latencyMs: -1, checkedAt: NOW })
        .success,
    ).toBe(false);
  });
});

describe('FR-PRV-009 per-provider concurrency', () => {
  it('defaults to the engine-wide limit when the create request omits it', () => {
    expect(CreateProviderRequestSchema.parse({ type: 'mock', name: 'Mock' }).concurrency).toBe(
      DEFAULT_PROVIDER_CONCURRENCY,
    );
  });

  it('bounds the limit to 1..64', () => {
    expect(ProviderSchema.safeParse({ ...provider, concurrency: 0 }).success).toBe(false);
    expect(ProviderSchema.safeParse({ ...provider, concurrency: 65 }).success).toBe(false);
    expect(ProviderSchema.safeParse({ ...provider, concurrency: 1.5 }).success).toBe(false);
    expect(ProviderSchema.safeParse({ ...provider, concurrency: 64 }).success).toBe(true);
  });
});

describe('FR-PRV-007 GET /providers/detect', () => {
  it('reports a detected Ollama with the base URL it was found on', () => {
    const body = { ollama: { baseUrl: 'http://127.0.0.1:11434', detected: true } };

    expect(ProviderDetectResponseSchema.parse(body)).toEqual(body);
  });

  it('reports nothing when no local runtime answered', () => {
    expect(ProviderDetectResponseSchema.parse({})).toEqual({});
  });
});

describe('FR-PRV-005 deleting a provider a node still uses', () => {
  it('names the affected nodes in the 409 details', () => {
    expect(ProviderInUseDetailsSchema.parse({ nodeIds: [NODE_A] })).toEqual({ nodeIds: [NODE_A] });
    expect(ProviderInUseDetailsSchema.safeParse({ nodeIds: ['node-1'] }).success).toBe(false);
  });
});

describe('FR-PRV-008 CLI providers (X1, D261–D262)', () => {
  it('accepts each CLI type with a permission level and no key', () => {
    for (const type of CLI_PROVIDER_TYPES) {
      expect(
        ProviderSchema.safeParse({ ...provider, type, cliPermission: 'edit_files' }).success,
        type,
      ).toBe(true);
      expect(
        CreateProviderRequestSchema.safeParse({ type, name: 'CLI', cliPermission: 'read_only' })
          .success,
        type,
      ).toBe(true);
    }
  });

  it('refuses an API key or a base URL on a CLI provider', () => {
    expect(
      CreateProviderRequestSchema.safeParse({ type: 'claude_code', name: 'C', apiKey: 'sk-x' })
        .success,
    ).toBe(false);
    expect(
      CreateProviderRequestSchema.safeParse({
        type: 'codex_cli',
        name: 'C',
        baseUrl: 'http://127.0.0.1:1',
      }).success,
    ).toBe(false);
  });

  it('refuses a permission level on a provider that is not a CLI', () => {
    expect(
      CreateProviderRequestSchema.safeParse({
        type: 'anthropic',
        name: 'A',
        apiKey: 'k',
        cliPermission: 'full_auto',
      }).success,
    ).toBe(false);
  });

  it('refuses a permission level outside the three presets', () => {
    expect(
      CreateProviderRequestSchema.safeParse({ type: 'gemini_cli', name: 'G', cliPermission: 'root' })
        .success,
    ).toBe(false);
    expect([...CLI_PERMISSIONS]).toEqual(['read_only', 'edit_files', 'full_auto']);
  });

  it('lets a patch change the permission level', () => {
    expect(UpdateProviderRequestSchema.parse({ cliPermission: 'full_auto' })).toEqual({
      cliPermission: 'full_auto',
    });
  });

  it('names each type’s route', () => {
    expect(routeOf('anthropic')).toBe('api');
    expect(routeOf('google')).toBe('api');
    expect(routeOf('openai')).toBe('api');
    expect(routeOf('openai_compatible')).toBe('local');
    expect(routeOf('ollama')).toBe('local');
    expect(routeOf('mock')).toBe('mock');
    for (const type of CLI_PROVIDER_TYPES) expect(routeOf(type)).toBe('cli');
    expect(isCliProviderType('gemini_cli')).toBe(true);
    expect(isCliProviderType('openai')).toBe(false);
  });

  it('starts a CLI provider at editing project files, one call at a time', () => {
    expect(DEFAULT_CLI_PERMISSION).toBe('edit_files');
    expect(DEFAULT_CLI_CONCURRENCY).toBe(1);
  });
});

describe('FR-PRV-008 GET /providers/detect/clis', () => {
  const found = {
    type: 'claude_code',
    installed: true,
    version: '2.1.282',
    path: 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd',
    login: 'logged_in',
    loginDetail: 'claude.ai · max',
    installHint: CLI_INSTALL_HINTS.claude_code,
    loginHint: CLI_LOGIN_HINTS.claude_code,
  };

  it('reports an installed, signed-in CLI with its version', () => {
    expect(CliDetectionSchema.parse(found)).toEqual(found);
  });

  it('reports a missing CLI with only its hints', () => {
    const missing = {
      type: 'gemini_cli',
      installed: false,
      login: 'unknown',
      installHint: CLI_INSTALL_HINTS.gemini_cli,
      loginHint: CLI_LOGIN_HINTS.gemini_cli,
    };
    expect(CliDetectionSchema.safeParse(missing).success).toBe(true);
  });

  it('refuses a stray field, so nothing credential-shaped can ride along', () => {
    expect(CliDetectionSchema.safeParse({ ...found, token: 'x' }).success).toBe(false);
  });

  it('wraps the three in { items }', () => {
    expect(CliDetectResponseSchema.safeParse({ items: [found] }).success).toBe(true);
  });

  it('names the npm package and the login command for each CLI', () => {
    expect(CLI_INSTALL_HINTS).toEqual({
      claude_code: 'npm install -g @anthropic-ai/claude-code',
      codex_cli: 'npm install -g @openai/codex',
      gemini_cli: 'npm install -g @google/gemini-cli',
    });
    expect(CLI_LOGIN_HINTS).toEqual({
      claude_code: 'claude auth login',
      codex_cli: 'codex login',
      gemini_cli: 'gemini',
    });
  });
});

describe('FR-PRV-008 what a patch may change on each kind of provider', () => {
  it('refuses a key or a base URL for a CLI provider', () => {
    expect(cliPatchError('claude_code', { apiKey: 'sk-x' })).toMatch(/no API key/);
    expect(cliPatchError('codex_cli', { baseUrl: 'http://127.0.0.1:1' })).toMatch(/no base URL/);
  });
  it('refuses a permission level for any other provider', () => {
    expect(cliPatchError('openai', { cliPermission: 'full_auto' })).toMatch(/Only a CLI provider/);
  });
  it('accepts everything else', () => {
    expect(cliPatchError('gemini_cli', { cliPermission: 'read_only', name: 'G' })).toBeUndefined();
    expect(cliPatchError('anthropic', { apiKey: 'sk-new' })).toBeUndefined();
  });
});
