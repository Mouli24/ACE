// A stand-in for claude / codex / gemini in tests. FAKE_CLI_MODE picks the behaviour.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const mode = process.env.FAKE_CLI_MODE ?? 'echo-stdin';
const readStdin = () =>
  new Promise((resolve) => {
    const parts = [];
    process.stdin.on('data', (chunk) => parts.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
  });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (mode === 'echo-stdin') {
  const input = await readStdin();
  const report = JSON.stringify({
    type: 'stdin',
    length: input.length,
    text: input.length <= 2000 ? input : undefined,
    sha: createHash('sha256').update(input).digest('hex'),
    cwd: process.cwd(),
    argv: process.argv.slice(2),
    env: Object.fromEntries(
      // GEMINI_CLI_NO_RELAUNCH always; FAKE_CLI_ECHO_ENV names more to report (comma-separated).
      ['GEMINI_CLI_NO_RELAUNCH', ...(process.env.FAKE_CLI_ECHO_ENV ?? '').split(',')]
        .filter((name) => name !== '')
        .map((name) => [name, process.env[name] ?? null]),
    ),
  });
  // Adapter tests read this back after a call that (rightly) fails for want of a result event.
  if (process.env.FAKE_CLI_ECHO_FILE) writeFileSync(process.env.FAKE_CLI_ECHO_FILE, report);
  process.stdout.write(report + '\n');
} else if (mode === 'replay') {
  // Plays a recorded JSONL file back in 7-character pieces, so lines arrive split.
  await readStdin();
  const text = readFileSync(process.env.FAKE_CLI_FILE, 'utf8');
  for (let i = 0; i < text.length; i += 7) {
    process.stdout.write(text.slice(i, i + 7));
    if (i % 700 === 0) await sleep(1);
  }
  process.exitCode = Number(process.env.FAKE_CLI_EXIT ?? 0);
} else if (mode === 'stderr-exit') {
  await readStdin();
  process.stderr.write('x'.repeat(20_000) + 'END');
  process.exitCode = 3;
} else if (mode === 'hang-with-child') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(process.env.FAKE_CLI_PIDFILE, String(child.pid));
  process.stdout.write(JSON.stringify({ type: 'ready' }) + '\n');
  setInterval(() => {}, 1000);
} else if (mode === 'print') {
  // Detection probes: print what the test asks for, exit with its code.
  process.stdout.write(process.env.FAKE_CLI_STDOUT ?? '');
  process.stderr.write(process.env.FAKE_CLI_STDERR ?? '');
  process.exitCode = Number(process.env.FAKE_CLI_EXIT ?? 0);
}
