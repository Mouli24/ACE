import { spawn } from 'node:child_process';

import { type Sandbox, type SandboxResult, type SandboxSpec, type Scope } from '@ace/engine';

import { sandboxEnv } from './env.js';

/**
 * The child-process code sandbox (FR-TOOL-004, D13, Arch §16).
 *
 * D13 is "a child process, using Docker when it is available"; this is the child-process runner,
 * and it is the one every test uses (round 4 §2: no Docker may be required). It is the concrete
 * `Sandbox` port from `packages/engine` — the engine wires it in, and a hosted deployment swaps in
 * a container runner without the tool layer changing (NFR-PORT-01).
 *
 * What "sandbox" means here, given a plain OS process and no gVisor/Firecracker:
 *
 * - **Folder.** `cwd` is the run's own folder and the env's `HOME`/`TMPDIR` point there too, so a
 *   program that reaches for `~` or a temp file lands inside the sandbox, not the real home (the
 *   remap is in `env.ts`, exercised by TC-TOOL-005). Hard filesystem isolation from the rest of the
 *   disk is Docker's job (D13); this runner does not chroot.
 * - **Time.** `timeoutMs` is enforced by killing the whole process *group*, so a `while(true)` and
 *   anything it spawned die together (TC-TOOL-004), and `timedOut` is set.
 * - **Environment and network.** The child's environment is built by {@link sandboxEnv} — nothing
 *   inherited but what an interpreter needs, every proxy pointed at a dead port — unless the caller
 *   passed its own `env`. The PATH deny-shims and per-language preludes are layered on by the
 *   `code_sandbox` tool that builds the spec.
 *
 * Output is capped at {@link OUTPUT_CAP_BYTES} per stream so a program that prints without end
 * cannot exhaust the engine's memory before its timeout fires.
 */

/** Per-stream cap. A program that floods stdout is truncated, not allowed to OOM the engine. */
export const OUTPUT_CAP_BYTES = 1024 * 1024;

/** Grace between SIGTERM and SIGKILL, and how long we wait for `close` after a kill. */
const KILL_GRACE_MS = 500;

function killTree(pid: number, platform: NodeJS.Platform): void {
  try {
    if (platform === 'win32') {
      // Windows has no process groups we can signal; taskkill /T ends the child and its descendants.
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => undefined);
    } else {
      // The child is spawned `detached`, so it leads its own group and `-pid` reaches everything it
      // started — the point of killing a runaway that itself spawned children.
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // Already gone, or never started. Either way there is nothing left to kill.
  }
}

/** Appends `chunk` to `parts` while under the cap; returns the running total. */
function capture(parts: string[], total: number, chunk: string): number {
  if (total >= OUTPUT_CAP_BYTES) return total;
  const room = OUTPUT_CAP_BYTES - total;
  parts.push(chunk.length <= room ? chunk : chunk.slice(0, room));
  return total + chunk.length;
}

export class ChildProcessSandbox implements Sandbox {
  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  run(_scope: Scope, spec: SandboxSpec): Promise<SandboxResult> {
    const env = spec.env ?? sandboxEnv({ sandboxDir: spec.workingDirectory });

    return new Promise<SandboxResult>((resolve) => {
      const child = spawn(spec.command, spec.args, {
        cwd: spec.workingDirectory,
        env,
        // A leader of its own group on POSIX, so a runaway's children die with it. Windows has no
        // equivalent; taskkill /T is the fallback in killTree.
        detached: this.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      const stdout: string[] = [];
      const stderr: string[] = [];
      let outLen = 0;
      let errLen = 0;
      let timedOut = false;
      let settled = false;

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        outLen = capture(stdout, outLen, chunk);
      });
      child.stderr?.on('data', (chunk: string) => {
        errLen = capture(stderr, errLen, chunk);
      });

      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid !== undefined) killTree(child.pid, this.platform);
        // If the group kill did not take (a stuck Windows taskkill, say), settle anyway so the tool
        // loop is never wedged behind a sandbox that refused to die.
        setTimeout(() => finish(-1), KILL_GRACE_MS);
      }, spec.timeoutMs);

      const finish = (code: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode: code,
          stdout: stdout.join(''),
          stderr: stderr.join(''),
          timedOut,
        });
      };

      child.on('error', (error) => {
        // Command not found (no interpreter on PATH), or spawn refused. Report it as a failed run
        // rather than throwing, so the tool can turn it into a ToolError the model can read.
        errLen = capture(stderr, errLen, `${(error as Error).message}\n`);
        finish(-1);
      });

      child.on('close', (code) => finish(code ?? -1));
    });
  }
}
