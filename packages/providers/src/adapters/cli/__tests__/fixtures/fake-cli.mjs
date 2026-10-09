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
    env: { GEMINI_CLI_NO_RELAUNCH: process.env.GEMINI_CLI_NO_RELAUNCH ?? null },
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
} else if (mode === 'claude-init') {
  // Claude Code's stream-json control handshake: answer `initialize` with FAKE_CLI_INIT (a JSON
  // response body), record the argv and cwd it was started with, then exit when stdin closes.
  if (process.env.FAKE_CLI_ECHO_FILE) {
    writeFileSync(
      process.env.FAKE_CLI_ECHO_FILE,
      JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }),
    );
  }
  let buffered = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const request = JSON.parse(line);
      if (request.type === 'control_request' && request.request?.subtype === 'initialize') {
        const reply =
          process.env.FAKE_CLI_INIT_ERROR !== undefined
            ? {
                subtype: 'error',
                request_id: request.request_id,
                error: process.env.FAKE_CLI_INIT_ERROR,
              }
            : {
                subtype: 'success',
                request_id: request.request_id,
                response: JSON.parse(process.env.FAKE_CLI_INIT ?? '{"models":[]}'),
              };
        process.stdout.write(JSON.stringify({ type: 'control_response', response: reply }) + '\n');
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
} else if (mode === 'ignore-stdin-exit') {
  // An older CLI that does not speak the control protocol: it complains and exits.
  process.stderr.write(
    'Error: Input must be provided either through stdin or as a prompt argument',
  );
  process.exitCode = 1;
} else if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else if (mode === 'print') {
  // Detection probes: print what the test asks for, exit with its code.
  process.stdout.write(process.env.FAKE_CLI_STDOUT ?? '');
  process.stderr.write(process.env.FAKE_CLI_STDERR ?? '');
  process.exitCode = Number(process.env.FAKE_CLI_EXIT ?? 0);
}
