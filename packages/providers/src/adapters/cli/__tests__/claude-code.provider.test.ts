import { describe, expect, it } from 'vitest';

import type { StreamChunk } from '../../../adapter.js';
import { createClaudeCodeAdapter } from '../claude-code.js';
import { createCliDetector } from '../detect.js';

describe('@provider Claude Code, the real CLI (X1)', () => {
  it('is installed and signed in, and answers a read-only prompt with usage and cost', async () => {
    const detection = await createCliDetector().detect('claude_code', { force: true });
    expect(detection.installed).toBe(true);
    const adapter = createClaudeCodeAdapter({ permission: 'read_only', detect: async () => detection });
    expect((await adapter.check()).status).toBe('CONNECTED');

    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.generate(
      { modelId: 'haiku', prompt: 'Reply with the single word OK.', outputTypes: ['text'] },
      AbortSignal.timeout(120_000),
    )) {
      chunks.push(chunk);
    }
    const text = chunks.flatMap((chunk) => (chunk.type === 'text' ? [chunk.delta] : [])).join('');
    expect(text).toMatch(/OK/);
    expect(chunks.find((chunk) => chunk.type === 'usage')).toMatchObject({ costUsd: expect.any(Number) });
  }, 180_000);
});
