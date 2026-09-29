import { z } from 'zod';

import { type ToolDefinition } from '@ace/contracts';

import { ToolError } from '../errors.js';
import { type RegisteredTool } from '../registry.js';

/**
 * `echo { text } → { text }` (§2.2). The test tool: no permissions, no side effects, so a scenario
 * can prove the whole tool loop — guardrails, logging, feeding the result back untrusted — without
 * touching the disk or the network. `mock-tool` calls it once (§2.6).
 */

const EchoArgs = z.strictObject({ text: z.string() });

export const ECHO_DEFINITION: ToolDefinition = {
  name: 'echo',
  description: 'Returns the text it was given. A test tool with no side effects.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  permissions: { network: false, fsPaths: [], destructive: false },
  timeoutMs: 5_000,
  source: 'builtin',
};

export function createEchoTool(): RegisteredTool {
  return {
    definition: ECHO_DEFINITION,
    implementation: (args) => {
      const parsed = EchoArgs.safeParse(args);
      if (!parsed.success) {
        return Promise.reject(
          new ToolError('invalid_args', 'echo', 'echo needs { text: string }.', {
            issues: parsed.error.issues.map((issue) => issue.message),
          }),
        );
      }
      return Promise.resolve({ text: parsed.data.text });
    },
  };
}
