import type { Envelope } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import {
  ENVIRONMENT_PROMPT_VERSION,
  SYSTEM_BASE_VERSION,
  assemblePrompt,
  environmentBlock,
  promptVersion,
} from '../prompts/index.js';

/*
 * ACE parity P1 (D274): a CLI agent's prompt names the environment variables its process has, under
 * `## Context` → `### Environment`. Names only, and nothing changes for a prompt without them.
 */

const NOW = '2026-10-07T10:00:00.000Z';

const envelope: Envelope = {
  id: '01JBXQ8Z9KQ4R7N2VWXYZ0ENVP',
  runId: '01JBXQ8Z9KQ4R7N2VWXYZ0RN55',
  fromNodeId: '01JBXQ8Z9KQ4R7N2VWXYZ0ABCD',
  toNodeId: '01JBXQ8Z9KQ4R7N2VWXYZ0EFGH',
  iteration: 1,
  reads: [{ type: 'text', text: 'the brief text' }],
  context: {
    budgetTokens: 4000,
    trust: 'untrusted',
    memory: [{ key: 'style', value: 'terse' }],
  },
  contract: { outputTypes: ['text'] },
  createdAt: NOW,
};

const base = {
  instructions: 'Deploy the branch.',
  envelopes: [envelope],
  contract: { outputTypes: ['text' as const] },
  iteration: 1,
};

describe('D274 the ### Environment block', () => {
  it('is absent — the prompt and its version exactly as before — with no names', () => {
    const plain = assemblePrompt(base);
    for (const names of [undefined, []]) {
      const same = assemblePrompt({
        ...base,
        ...(names === undefined ? {} : { environmentNames: names }),
      });
      expect(same).toEqual(plain);
    }
    expect(plain.text).not.toContain('### Environment');
    expect(plain.version).toBe(
      promptVersion(SYSTEM_BASE_VERSION, base.instructions, base.contract),
    );
  });

  it('lists the names, sorted and once each, last in the Context section', () => {
    const prompt = assemblePrompt({
      ...base,
      environmentNames: ['DEPLOY_TOKEN', 'API_URL', 'DEPLOY_TOKEN'],
    });
    expect(environmentBlock(['API_URL', 'DEPLOY_TOKEN'])).toBe(
      '### Environment\nThese environment variables are set for the commands you run: API_URL, DEPLOY_TOKEN. Never print their values.',
    );
    expect(prompt.text).toContain(environmentBlock(['API_URL', 'DEPLOY_TOKEN']));
    const at = prompt.text.indexOf('### Environment');
    expect(at).toBeGreaterThan(prompt.text.indexOf('### Memory'));
    expect(at).toBeLessThan(prompt.text.indexOf('## Input'));
    expect(prompt.redactedText).toBe(prompt.text);
  });

  it('folds the block and its names into the version', () => {
    const plain = assemblePrompt(base);
    const one = assemblePrompt({ ...base, environmentNames: ['API_URL'] });
    const two = assemblePrompt({ ...base, environmentNames: ['API_URL', 'DEPLOY_TOKEN'] });
    expect(ENVIRONMENT_PROMPT_VERSION).toBe('ace-env-1');
    expect(new Set([plain.version, one.version, two.version]).size).toBe(3);
    expect(two.version).toBe(
      promptVersion(SYSTEM_BASE_VERSION, base.instructions, base.contract, undefined, undefined, [
        'API_URL',
        'DEPLOY_TOKEN',
      ]),
    );
  });
});
