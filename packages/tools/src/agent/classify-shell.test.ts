import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { classifyCommand } from './classify.js';
import { agentEnv } from './env.js';
import { resolveAgentShell, shellInvocation } from './shell.js';

/**
 * D376 review 2, pinned against the real agent shell: the classifier once read `^` as cmd.exe's
 * escape, so `echo hi ^> out.txt` looked like one harmless `echo` — but bash, the shell
 * `run_command` really uses, reads the caret as an ordinary character and redirects. The command
 * runs here through the same invocation `run_command` uses (on Windows the `ACE_AGENT_COMMAND` +
 * `eval` path), in a temp folder, and the classifier must not have auto-allowed what bash did.
 * Skipped where the agent shell is not bash (Windows without Git Bash falls back to PowerShell).
 */

const shell = resolveAgentShell({ platform: process.platform, env: process.env });

describe('D376 the classifier and the real agent shell', () => {
  it.skipIf(shell.kind !== 'bash')(
    'echo hi ^> out.txt: bash writes the file, so the classifier must not auto-allow it',
    () => {
      const command = 'echo hi ^> out.txt';
      const classified = classifyCommand(command, ['echo']);
      expect(classified.autoAllowed).toBe(false);
      expect(classified.alwaysAllowPrefix).toBeUndefined();

      const dir = mkdtempSync(join(tmpdir(), 'ace classify-'));
      try {
        const spec = shellInvocation(shell, command, agentEnv(process.env, process.platform));
        const result = spawnSync(spec.file, spec.args, {
          cwd: dir,
          env: spec.env,
          encoding: 'utf8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 20_000,
        });
        expect(result.status, result.stderr).toBe(0);
        // Bash really redirected: the caret is a word of its own and the file holds it.
        expect(existsSync(join(dir, 'out.txt'))).toBe(true);
        expect(readFileSync(join(dir, 'out.txt'), 'utf8').trim()).toBe('hi ^');
        expect(result.stdout).toBe('');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
