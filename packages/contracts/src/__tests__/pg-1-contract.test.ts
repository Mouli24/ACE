/**
 * PG-1.4 and PG-1.6 contract additions (D352, D359): the optional fields and request shapes the
 * product-gaps Phase 1 builds on. Every field is optional, so a row written before parses.
 */
import { describe, expect, it } from 'vitest';

import {
  ChatEditRequestSchema,
  ChatMessageSchema,
  ChatStopResponseSchema,
  ModelSchema,
  PROVIDER_GROUP_LABELS,
  UsageSchema,
  isLocalBaseUrl,
  providerGroup,
} from '../index.js';

const NOW = '2026-10-15T10:00:00.000Z';
const ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';

describe('PG-1.4 contract', () => {
  it('a model may carry its size on disk', () => {
    const base = {
      id: ID,
      providerId: ID,
      modelId: 'llama3.2:3b',
      displayName: 'llama3.2:3b',
      inputTypes: ['text'],
      outputTypes: ['text'],
      contextWindow: 8192,
      supportsTools: true,
      supportsJson: true,
      available: true,
      source: 'discovered',
      lastCheckedAt: NOW,
    };
    expect(ModelSchema.safeParse(base).success).toBe(true);
    expect(ModelSchema.parse({ ...base, sizeBytes: 2_019_393_189 }).sizeBytes).toBe(2_019_393_189);
    expect(ModelSchema.safeParse({ ...base, sizeBytes: -1 }).success).toBe(false);
  });

  it('usage says when its cost is unknown, and old usage still parses', () => {
    expect(UsageSchema.safeParse({ tokensIn: 1, tokensOut: 1, costUsd: 0 }).success).toBe(true);
    expect(
      UsageSchema.parse({ tokensIn: 1, tokensOut: 1, costUsd: 0, costKnown: false }).costKnown,
    ).toBe(false);
  });

  it('groups a provider with no base URL by type, and labels every group', () => {
    expect(providerGroup({ type: 'mock' })).toBe('mock');
    expect(providerGroup({ type: 'openai_compatible' })).toBe('local');
    expect(PROVIDER_GROUP_LABELS.local).toBe('Local & open models');
    expect(isLocalBaseUrl('not a url')).toBe(false);
    expect(isLocalBaseUrl('http://fcbarcelona.example/v1')).toBe(false);
    expect(isLocalBaseUrl('http://printer.local:8080')).toBe(true);
  });
});

describe('PG-1.6 contract', () => {
  const message = {
    id: ID,
    threadId: ID,
    role: 'agent',
    content: [{ type: 'text', text: 'hi' }],
    verdicts: [],
    at: NOW,
  };

  it('a chat message may be superseded or deleted', () => {
    expect(ChatMessageSchema.safeParse(message).success).toBe(true);
    expect(ChatMessageSchema.safeParse({ ...message, supersededAt: NOW }).success).toBe(true);
    expect(ChatMessageSchema.safeParse({ ...message, deletedAt: NOW }).success).toBe(true);
  });

  it('an edit carries new content; stop says whether a turn was stopped', () => {
    expect(ChatEditRequestSchema.safeParse({ content: [] }).success).toBe(false);
    expect(
      ChatEditRequestSchema.safeParse({ content: [{ type: 'text', text: 'x' }] }).success,
    ).toBe(true);
    expect(ChatStopResponseSchema.parse({ stopped: false }).stopped).toBe(false);
  });
});
