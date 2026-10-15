/**
 * PG-1.4 Local and open models get their own section (docs/team-prompts/product-gaps-fix-prompt.md).
 *
 * Phase 0 red test. The grouping is one pure function in `@ace/contracts`, `providerGroup(provider)`,
 * so the engine and the web app agree:
 *
 * - cloud  — anthropic, google, openai
 * - local  — ollama, and openai_compatible whose base URL is loopback or LAN (LM Studio, llama.cpp, vLLM)
 * - cli    — claude_code, codex_cli, gemini_cli
 * - custom — openai_compatible on a remote host
 *
 * It does not exist yet, so it is read off the barrel by name: the file typechecks today and fails
 * on the function being missing.
 */
import { describe, expect, it } from 'vitest';

import * as contracts from '../index.js';
import type { Provider, ProviderType } from '../index.js';

const NOW = '2026-10-15T10:00:00.000Z';

const provider = (type: ProviderType, baseUrl?: string): Provider => ({
  id: '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD',
  type,
  name: type,
  ...(baseUrl === undefined ? {} : { baseUrl }),
  keySet: false,
  status: 'CONNECTED',
  concurrency: 4,
  createdAt: NOW,
  updatedAt: NOW,
});

function groupOf(p: Provider): unknown {
  const fn = (contracts as Record<string, unknown>)['providerGroup'];
  expect(typeof fn, 'providerGroup is exported from @ace/contracts').toBe('function');
  return (fn as (provider: Provider) => unknown)(p);
}

describe('PG-1.4 providerGroup(provider)', () => {
  it.fails.each([
    ['anthropic', undefined, 'cloud'],
    ['google', undefined, 'cloud'],
    ['openai', undefined, 'cloud'],
    ['ollama', 'http://localhost:11434', 'local'],
    ['openai_compatible', 'http://localhost:1234/v1', 'local'],
    ['openai_compatible', 'http://127.0.0.1:8080/v1', 'local'],
    ['openai_compatible', 'http://[::1]:8000/v1', 'local'],
    ['openai_compatible', 'http://192.168.1.20:8000/v1', 'local'],
    ['openai_compatible', 'http://10.0.0.5:8000/v1', 'local'],
    ['openai_compatible', 'http://172.16.4.2:8000/v1', 'local'],
    ['claude_code', undefined, 'cli'],
    ['codex_cli', undefined, 'cli'],
    ['gemini_cli', undefined, 'cli'],
    ['openai_compatible', 'https://api.together.xyz/v1', 'custom'],
    ['openai_compatible', 'https://openrouter.ai/api/v1', 'custom'],
  ] as const)('%s at %s is %s', (type, baseUrl, group) => {
    expect(groupOf(provider(type, baseUrl))).toBe(group);
  });
});
