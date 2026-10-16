import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProviderCallError, type StreamChunk } from '../../../adapter.js';
import { claudeCodeDialect, claudeResultError, createClaudeCodeParser } from '../claude-code.js';
import { claudeModelsFrom, listClaudeCodeModels } from '../claude-models.js';
import type { ResolvedCommand } from '../resolve.js';

/**
 * D286: Claude Code's models come from the installed CLI itself — the `initialize` answer of its
 * stream-json control protocol, the list its own `/model` picker shows — never from a list kept
 * in ACE. Asking costs no tokens: no prompt is sent, and the CLI exits when its stdin closes.
 */

const FAKE = fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url));
const fake: ResolvedCommand = {
  command: process.execPath,
  prefixArgs: [FAKE],
  path: FAKE,
};

/** What Claude Code 2.1.282 answered on the dev machine on 2026-10-09, trimmed to its shape. */
const RECORDED = {
  models: [
    {
      value: 'default',
      resolvedModel: 'claude-opus-5-5',
      displayName: 'Default (recommended)',
      description: 'Opus 5.5 · Best for everyday, complex tasks',
    },
    {
      value: 'opus',
      resolvedModel: 'claude-opus-5-5',
      displayName: 'Opus 5.5',
      description: 'For complex work and everyday tasks',
    },
    {
      value: 'claude-fable-5-1',
      resolvedModel: 'claude-fable-5-1',
      displayName: 'Fable 5.1',
      description: 'For your toughest challenges',
    },
    {
      value: 'haiku',
      resolvedModel: 'claude-haiku-4-5-20251001',
      displayName: 'Haiku 4.5',
      description: 'Fastest for quick answers',
    },
  ],
  unavailable_models: [
    {
      value: 'claude-sonnet-5-5',
      resolvedModel: 'claude-sonnet-5-5',
      displayName: 'Sonnet 5.5',
      description: 'Update Claude Code to use this model',
      disabled: true,
    },
  ],
  account: {
    email: 'someone@example.com',
    organization: 'Org',
    subscriptionType: 'max',
  },
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-claude-models-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('D286 reading Claude Code’s own model list', () => {
  it('takes every model the CLI lists — alias, exact version, name and description — and nothing else', () => {
    const models = claudeModelsFrom(RECORDED);

    expect(models.map((model) => model.modelId)).toEqual([
      'default',
      'opus',
      'claude-fable-5-1',
      'haiku',
      'claude-sonnet-5-5',
    ]);
    expect(models.find((model) => model.modelId === 'opus')).toMatchObject({
      displayName: 'Opus 5.5',
      description: 'For complex work and everyday tasks',
      resolvedModelId: 'claude-opus-5-5',
      available: true,
      inputTypes: ['text'],
      outputTypes: ['text'],
      supportsJson: false,
    });
    // a full name that resolves to itself says nothing more
    expect(
      models.find((model) => model.modelId === 'claude-fable-5-1')?.resolvedModelId,
    ).toBeUndefined();
  });

  it('lists a model this CLI version cannot use as unavailable, with the CLI’s reason', () => {
    const tooNew = claudeModelsFrom(RECORDED).find(
      (model) => model.modelId === 'claude-sonnet-5-5',
    );
    expect(tooNew).toMatchObject({
      available: false,
      unavailableReason: 'Update Claude Code to use this model',
    });
  });

  it('skips malformed entries and duplicates, and invents nothing when the list is empty', () => {
    expect(
      claudeModelsFrom({
        models: [{ value: 'opus' }, { displayName: 'no value' }, 7, null, { value: 'opus' }],
      }).map((model) => model.modelId),
    ).toEqual(['opus']);
    expect(claudeModelsFrom({ models: [] })).toEqual([]);
    expect(claudeModelsFrom({})).toEqual([]);
  });

  it('asks the installed CLI over its control protocol, in a throwaway folder, with no prompt and no --model', async () => {
    const echo = join(dir, 'echo.json');
    const models = await listClaudeCodeModels(fake, {
      env: {
        ...process.env,
        FAKE_CLI_MODE: 'claude-init',
        FAKE_CLI_INIT: JSON.stringify(RECORDED),
        FAKE_CLI_ECHO_FILE: echo,
      },
    });

    expect(models.map((model) => model.modelId)).toContain('claude-fable-5-1');
    const started = JSON.parse(readFileSync(echo, 'utf8')) as {
      argv: string[];
      cwd: string;
    };
    expect(started.argv).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--setting-sources',
      '',
      '--strict-mcp-config',
    ]);
    expect(started.cwd).not.toBe(process.cwd());
  });

  it('says to update a CLI that does not answer the handshake, rather than guessing a list', async () => {
    const failure = await listClaudeCodeModels(fake, {
      env: { ...process.env, FAKE_CLI_MODE: 'ignore-stdin-exit' },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderCallError);
    expect((failure as ProviderCallError).nodeError).toMatchObject({
      kind: 'provider',
      code: 'cli_model_list_unsupported',
    });
    expect((failure as ProviderCallError).message).toMatch(/update/i);
  });

  it('reports the CLI’s own refusal of the handshake', async () => {
    const failure = await listClaudeCodeModels(fake, {
      env: {
        ...process.env,
        FAKE_CLI_MODE: 'claude-init',
        FAKE_CLI_INIT_ERROR: 'not logged in',
      },
    }).catch((error: unknown) => error);

    expect((failure as ProviderCallError).nodeError).toMatchObject({
      kind: 'auth',
      code: 'cli_not_signed_in',
    });
  });

  it('gives up on a CLI that never answers', async () => {
    const failure = await listClaudeCodeModels(fake, {
      env: { ...process.env, FAKE_CLI_MODE: 'hang' },
      timeoutMs: 300,
    }).catch((error: unknown) => error);

    expect((failure as ProviderCallError).nodeError).toMatchObject({
      code: 'cli_model_list_timeout',
    });
  });

  // D370: skipped until updated to the product-gaps behaviour — see docs/team-prompts/product-gaps/tests-todo.md
  it.skip('offers an older CLI that cannot list only its own default, and says why', async () => {
    const previous = process.env['FAKE_CLI_MODE'];
    process.env['FAKE_CLI_MODE'] = 'ignore-stdin-exit';
    try {
      const models = await claudeCodeDialect.listModels(() => fake);
      expect(models.map((model) => model.modelId)).toEqual(['default']);
      expect(models[0]?.available).not.toBe(false);
      expect(models[0]?.description).toMatch(/update/i);
    } finally {
      if (previous === undefined) delete process.env['FAKE_CLI_MODE'];
      else process.env['FAKE_CLI_MODE'] = previous;
    }
  });

  it('says how to install a CLI that is not there', async () => {
    const failure = await claudeCodeDialect
      .listModels(() => undefined)
      .catch((error: unknown) => error);
    expect((failure as ProviderCallError).nodeError).toMatchObject({
      code: 'cli_not_found',
    });
  });
});

describe('D286 running the model that was chosen, and saying so', () => {
  it('reports the model the CLI says it is using', () => {
    const parser = createClaudeCodeParser(() => 0);
    const chunks = parser.onEvent({
      type: 'system',
      subtype: 'init',
      model: 'claude-opus-5-5',
      session_id: 's',
    });
    expect(chunks).toEqual([{ type: 'model', modelId: 'claude-opus-5-5' }]);
  });

  it('never passes the CLI’s "issue with the selected model" notice off as the answer', () => {
    const parser = createClaudeCodeParser(() => 0);
    const chunks: StreamChunk[] = [
      ...parser.onEvent({
        type: 'system',
        subtype: 'init',
        model: 'bogus-model-x',
      }),
      ...parser.onEvent({
        type: 'assistant',
        error: 'model_not_found',
        message: {
          model: '<synthetic>',
          content: [
            {
              type: 'text',
              text: "There's an issue with the selected model (bogus-model-x). It may not exist or you may not have access to it.",
            },
          ],
        },
      }),
      ...parser.onEvent({
        type: 'result',
        subtype: 'success',
        is_error: true,
        api_error_status: 404,
        result:
          "There's an issue with the selected model (bogus-model-x). It may not exist or you may not have access to it.",
      }),
    ];

    expect(chunks.filter((chunk) => chunk.type === 'text')).toEqual([]);
    let thrown: unknown;
    try {
      parser.finish({ code: 1, signal: null, stderrTail: '', killed: false });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as ProviderCallError).nodeError).toMatchObject({
      kind: 'invalid_config',
      code: 'model_unavailable',
      retryable: false,
    });
    expect((thrown as ProviderCallError).message).toContain('bogus-model-x');
  });

  it('reads a 404 result as a model this account cannot use — a setting to fix, not a retry', () => {
    expect(
      claudeResultError({
        type: 'result',
        subtype: 'success',
        is_error: true,
        api_error_status: 404,
        result: 'There is an issue with the selected model (x).',
      }),
    ).toMatchObject({
      kind: 'invalid_config',
      code: 'model_unavailable',
      retryable: false,
    });
  });
});
