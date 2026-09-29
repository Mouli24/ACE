import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ToolError } from '../errors.js';
import { SANDBOX_DENIED_MESSAGE } from '../logging.js';
import { makeContext } from '../__tests__/helpers.js';
import { SANDBOX_DELETE_DEFINITION, createSandboxDeleteTool } from './sandbox-delete.js';

const tool = createSandboxDeleteTool();
let contexts: Array<{ cleanup: () => void }> = [];
afterEach(() => {
  for (const context of contexts) context.cleanup();
  contexts = [];
});

describe('sandbox_delete definition', () => {
  it('is the destructive builtin confined to the sandbox', () => {
    expect(SANDBOX_DELETE_DEFINITION.permissions).toEqual({
      network: false,
      fsPaths: ['<sandbox>'],
      destructive: true,
    });
  });
});

describe('TC-GRD-006 sandbox_delete confinement', () => {
  it('deletes a file inside the sandbox', async () => {
    const context = makeContext();
    contexts.push(context);
    const file = join(context.sandboxDir, 'notes.txt');
    writeFileSync(file, 'x');

    await expect(tool.implementation({ path: 'notes.txt' }, context)).resolves.toEqual({ deleted: true });
    expect(existsSync(file)).toBe(false);
  });

  it('returns deleted:false for a path that is not there', async () => {
    const context = makeContext();
    contexts.push(context);
    await expect(tool.implementation({ path: 'gone.txt' }, context)).resolves.toEqual({ deleted: false });
  });

  it('refuses `../../x`, deleting nothing and logging the attempt (NFR-SEC-04)', async () => {
    const context = makeContext();
    contexts.push(context);
    const outside = join(context.sandboxDir, '..', 'victim.txt');
    writeFileSync(outside, 'important');

    await expect(tool.implementation({ path: '../victim.txt' }, context)).rejects.toMatchObject({ kind: 'denied' });
    expect(existsSync(outside)).toBe(true);
    expect(context.logger.matching(SANDBOX_DENIED_MESSAGE)).toHaveLength(1);
  });

  it('refuses a bad args shape', async () => {
    const context = makeContext();
    contexts.push(context);
    await expect(tool.implementation({}, context)).rejects.toBeInstanceOf(ToolError);
  });
});
