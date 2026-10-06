import { spawn } from 'node:child_process';

/**
 * Kills a process and everything it started — the shared kill behind the code sandbox's timeout
 * (TC-TOOL-004) and the check command runner's timeout and abort (D271).
 *
 * Windows has no process groups a parent can signal, so `taskkill /T /F` ends the child and its
 * descendants. On POSIX the child must have been spawned `detached`, so it leads its own group and
 * `-pid` reaches everything it started.
 */
export function killProcessTree(pid: number, platform: NodeJS.Platform = process.platform): void {
  try {
    if (platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      }).on('error', () => undefined);
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // Already gone, or never started. Either way there is nothing left to kill.
  }
}
