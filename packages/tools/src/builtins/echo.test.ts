import { describe, expect, it } from 'vitest';

import { ToolError } from '../errors.js';
import { makeContext } from '../__tests__/helpers.js';
import { ECHO_DEFINITION, createEchoTool } from './echo.js';

describe('TC-TOOL-001 echo definition', () => {
  it('is a builtin with no permissions', () => {
    expect(ECHO_DEFINITION.name).toBe('echo');
    expect(ECHO_DEFINITION.source).toBe('builtin');
    expect(ECHO_DEFINITION.permissions).toEqual({ network: false, fsPaths: [], destructive: false });
  });
});

describe('echo tool', () => {
  const tool = createEchoTool();
  const context = makeContext();

  it('returns the text it was given', async () => {
    await expect(tool.implementation({ text: 'hi' }, context)).resolves.toEqual({ text: 'hi' });
  });

  it('re-parses its args and refuses a bad shape', async () => {
    await expect(tool.implementation({ notText: 1 }, context)).rejects.toBeInstanceOf(ToolError);
    await expect(tool.implementation({ text: 5 }, context)).rejects.toMatchObject({ kind: 'invalid_args' });
  });
});
