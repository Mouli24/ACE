import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Starts one user-configured command line through the platform shell, exactly as they would type
 * it — shared by the command runner (D271) and the preview runner (D278), so a check, a setup
 * command and a preview command are quoted the same way.
 *
 * Windows: `cmd.exe /d /s /c "<command>"` with verbatim arguments — the same quoting Node's
 * `shell: true` uses, so a quoted program path survives `/s`. Elsewhere: `/bin/sh -c <command>`,
 * `detached` so the shell leads its own process group and `killProcessTree` reaches everything the
 * command started. stdin is closed; stdout and stderr are pipes.
 *
 * It throws what `spawn` throws synchronously (a NUL in the command line, say); a shell that cannot
 * be started is an `error` event on the child, as with any spawn.
 */
export function spawnShell(
  command: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; platform?: NodeJS.Platform },
): ChildProcess {
  const platform = options.platform ?? process.platform;
  return platform === 'win32'
    ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: true,
      })
    : spawn('/bin/sh', ['-c', command], {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // A leader of its own group, so the kill reaches everything the command started.
        detached: true,
      });
}

/** The last `max` characters, without starting on the second half of a surrogate pair. */
export function outputTail(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  const cut = text.slice(text.length - max);
  const first = cut.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? cut.slice(1) : cut;
}

/**
 * Appends `chunk` to a running output buffer, trimming as it goes so a command that prints
 * without end cannot grow the buffer without bound. The caller still takes `outputTail` of it.
 */
export function appendOutput(buffer: string, chunk: string, max: number): string {
  const next = buffer + chunk;
  return next.length > max * 2 + 4_096 ? outputTail(next, max) : next;
}
