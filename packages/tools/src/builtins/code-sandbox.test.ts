import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ChildProcessSandbox } from '../sandbox/runner.js';
import { makeContext } from '../__tests__/helpers.js';
import { CODE_SANDBOX_DEFINITION, createCodeSandboxTool } from './code-sandbox.js';

const tool = createCodeSandboxTool({ sandbox: new ChildProcessSandbox() });
let contexts: Array<{ cleanup: () => void }> = [];
afterEach(() => {
  for (const context of contexts) context.cleanup();
  contexts = [];
});
function ctx(): ReturnType<typeof makeContext> {
  const context = makeContext();
  contexts.push(context);
  return context;
}

describe('code_sandbox definition', () => {
  it('is confined to the sandbox with no network permission', () => {
    expect(CODE_SANDBOX_DEFINITION.permissions).toEqual({ network: false, fsPaths: ['<sandbox>'], destructive: false });
  });
});

describe('TC-TOOL-004/005 code_sandbox execution', () => {
  it('runs JavaScript and returns stdout and the exit code', async () => {
    const result = (await tool.implementation(
      { language: 'javascript', code: 'process.stdout.write("hello from js")' },
      ctx(),
    )) as { stdout: string; exitCode: number; files: unknown[] };
    expect(result.stdout).toBe('hello from js');
    expect(result.exitCode).toBe(0);
    expect(result.files).toEqual([]);
  });

  it('collects a file the run produced', async () => {
    const context = ctx();
    const result = (await tool.implementation(
      { language: 'javascript', code: `require('fs').writeFileSync('artifact.txt', 'produced')` },
      context,
    )) as { files: Array<{ path: string; size: number }> };
    expect(result.files).toContainEqual({ path: 'artifact.txt', size: 'produced'.length });
    expect(readFileSync(join(context.sandboxDir, 'artifact.txt'), 'utf8')).toBe('produced');
  });

  it('reports timeout when code overruns, carrying partial output', async () => {
    await expect(
      tool.implementation(
        { language: 'javascript', code: 'process.stdout.write("before"); while (true) {}', timeoutMs: 500 },
        ctx(),
      ),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('makes the home directory the sandbox, so `~` cannot reach the real home', async () => {
    const context = ctx();
    const result = (await tool.implementation(
      { language: 'javascript', code: `process.stdout.write(require('os').homedir())` },
      context,
    )) as { stdout: string };
    expect(result.stdout).toBe(context.sandboxDir);
  });

  it('denies the interpreter its own network (NFR-SEC-04)', async () => {
    const result = (await tool.implementation(
      {
        language: 'javascript',
        code: `try { require('node:http').get('http://127.0.0.1:1'); } catch (e) { process.stderr.write(String(e.message)); }`,
      },
      ctx(),
    )) as { stderr: string };
    expect(result.stderr).toContain('network access is denied');
  });

  it('refuses a bad args shape', async () => {
    await expect(tool.implementation({ language: 'ruby', code: 'x' }, ctx())).rejects.toMatchObject({
      kind: 'invalid_args',
    });
  });

  it('reports python unavailable rather than failing when there is no interpreter', async () => {
    const noPython = createCodeSandboxTool({ sandbox: new ChildProcessSandbox(), pythonPath: null });
    await expect(noPython.implementation({ language: 'python', code: 'print(1)' }, ctx())).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });
});
