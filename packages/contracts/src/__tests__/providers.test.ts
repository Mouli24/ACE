import { describe, expect, it } from 'vitest';

import { ProviderInUseDetailsSchema } from '../errors.js';
import {
  CreateProviderRequestSchema,
  DEFAULT_PROVIDER_CONCURRENCY,
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
