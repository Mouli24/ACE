import { rmSync, statSync } from 'node:fs';

import { z } from 'zod';

import { type ToolDefinition } from '@ace/contracts';

import { ToolError } from '../errors.js';
import { type RegisteredTool } from '../registry.js';
import { assertInsideSandbox } from '../sandbox/paths.js';

/**
 * `sandbox_delete { path } → { deleted }` (§2.2). The one destructive built-in (`destructive: true`),
 * so a call to it waits for an approval card at the tool guardrail point (FR-GRD-006, BR-14) — that
 * gate is the executor's; this tool assumes it has already passed.
 *
 * Its own guarantee is confinement: the path is resolved through {@link assertInsideSandbox}, so
 * `../../x` (TC-GRD-006) or an absolute path is refused *and logged* before anything is removed. A
 * refusal throws a `denied` {@link ToolError}, which the executor logs as a `blocked` ToolCall and
 * fails the node `GUARDRAIL_VIOLATION`.
 */

const DeleteArgs = z.strictObject({ path: z.string() });

export const SANDBOX_DELETE_DEFINITION: ToolDefinition = {
  name: 'sandbox_delete',
  description: 'Deletes a file or folder inside the run sandbox. Destructive: asks for approval.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path relative to the run sandbox folder.' } },
    required: ['path'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { deleted: { type: 'boolean' } },
    required: ['deleted'],
  },
  permissions: { network: false, fsPaths: ['<sandbox>'], destructive: true },
  timeoutMs: 5_000,
  source: 'builtin',
};

export function createSandboxDeleteTool(): RegisteredTool {
  return {
    definition: SANDBOX_DELETE_DEFINITION,
    // async so a thrown ToolError (bad args, or a confinement refusal) surfaces as a rejection.
    implementation: async (args, context) => {
      const parsed = DeleteArgs.safeParse(args);
      if (!parsed.success) {
        throw new ToolError('invalid_args', 'sandbox_delete', 'sandbox_delete needs { path: string }.', {
          issues: parsed.error.issues.map((issue) => issue.message),
        });
      }

      const target = assertInsideSandbox({
        sandboxDir: context.sandboxDir,
        candidate: parsed.data.path,
        toolName: 'sandbox_delete',
        operation: 'delete',
        logger: context.logger,
        runId: context.runId,
      });

      let exists = true;
      try {
        statSync(target);
      } catch {
        exists = false;
      }
      if (!exists) return { deleted: false };

      rmSync(target, { recursive: true, force: true });
      return { deleted: true };
    },
  };
}
