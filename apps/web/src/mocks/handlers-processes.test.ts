import { PROCESS_RUNNING_MAX, type ServerFrame } from '@ace/contracts';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The engine's refusals as text, so the mock's copy can never drift from them (D301).
import engineErrors from '../../../../packages/engine/src/processes/errors.ts?raw';
import { MockDb } from './db';
import { createFakeWebSocket, type FakeWebSocketInstance } from './fake-socket';
import { createHandlers } from './handlers';
import { createProcessHandlers } from './handlers-processes';
import { MOCK_MESSAGES, MockProcesses } from './processes';

const db = new MockDb({ persist: false });
const processes = new MockProcesses(db, { tickMs: 20 });
const server = setupServer(...createProcessHandlers(db, processes), ...createHandlers(db));
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

const PACKAGE = JSON.stringify({
  packageManager: 'pnpm@9.15.9',
  scripts: { hello: 'echo hi from a script', dev: 'serve' },
});

let projectId: string;
let frames: ServerFrame[];
let socket: FakeWebSocketInstance;

beforeEach(async () => {
  db.reset();
  projectId = db.createProject({ name: 'P' }).id;
  db.seedFiles(projectId, { 'src/app.ts': 'export {};\n', 'package.json': PACKAGE });
  frames = [];
  const Socket = createFakeWebSocket(db);
  socket = new Socket('ws://mock/ws?token=t');
  socket.onmessage = (event) => frames.push(JSON.parse(String(event.data)) as ServerFrame);
  await vi.waitFor(() => expect(socket.readyState).toBe(1));
  socket.send(JSON.stringify({ type: 'subscribe', payload: { scope: 'project', id: projectId } }));
});
afterEach(() => {
  socket.close();
  processes.reset();
  server.resetHandlers();
});

const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`http://mock.local/api/v1/projects/${projectId}${path}`, {
    method,
    headers: {
      authorization: 'Bearer t',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: (text === '' ? undefined : JSON.parse(text)) as Record<string, unknown> | undefined,
  };
};

const start = async (body: unknown): Promise<string> => {
  const answer = await call('POST', '/processes', body);
  expect(answer.status).toBe(201);
  return String(answer.json?.processId);
};

const outputOf = (processId: string, stream?: 'stdout' | 'stderr'): string =>
  frames
    .flatMap((frame) =>
      frame.type === 'process.output' &&
      frame.payload.processId === processId &&
      (stream === undefined || frame.payload.stream === stream)
        ? [frame.payload.data]
        : [],
    )
    .join('');

const exitOf = (processId: string) =>
  frames.flatMap((frame) =>
    frame.type === 'process.exited' && frame.payload.processId === processId ? [frame.payload] : [],
  )[0];

const ended = (processId: string) => vi.waitFor(() => expect(exitOf(processId)).toBeDefined());

describe('D301 the mock engine’s scripted processes', () => {
  it('echo prints its text and exits 0, on the project scope, transient', async () => {
    const id = await start({ command: 'echo hello' });
    await ended(id);
    expect(outputOf(id)).toBe('hello\n');
    expect(exitOf(id)).toEqual({
      projectId,
      processId: id,
      exitCode: 0,
      signal: null,
      status: 'exited',
    });
    expect(
      frames.filter((frame) => frame.type.startsWith('process.')).every((f) => !('seq' in f)),
    ).toBe(true);
  });

  it('node -v answers v24.0.0; fail writes stderr and exits 1; an unknown command exits 127', async () => {
    const node = await start({ command: 'node -v' });
    const fail = await start({ command: 'fail' });
    const unknown = await start({ command: 'nosuch --flag' });
    await ended(node);
    await ended(fail);
    await ended(unknown);
    expect(outputOf(node)).toBe('v24.0.0\n');
    expect(outputOf(fail, 'stderr')).toBe('something went wrong\n');
    expect(exitOf(fail)?.exitCode).toBe(1);
    expect(outputOf(unknown, 'stderr')).toBe('mock: nosuch: not found\n');
    expect(exitOf(unknown)?.exitCode).toBe(127);
  });

  it('broken never starts: its reason on stderr and status failed (design §10)', async () => {
    const id = await start({ command: 'broken' });
    await ended(id);
    expect(outputOf(id, 'stderr')).toBe('Could not start: spawn /bin/sh ENOENT\r\n');
    expect(exitOf(id)).toMatchObject({ status: 'failed', exitCode: null });
  });

  it('ask prompts, reads one line of input and greets it; input to a finished process is 409', async () => {
    const id = await start({ command: 'ask' });
    await vi.waitFor(() => expect(outputOf(id)).toBe('name? '));
    expect((await call('POST', `/processes/${id}/input`, { data: 'Ada\n' })).status).toBe(204);
    await ended(id);
    expect(outputOf(id)).toBe('name? hello Ada\n');
    const late = await call('POST', `/processes/${id}/input`, { data: 'x\n' });
    expect(late.status).toBe(409);
    expect(late.json).toMatchObject({
      error: { code: 'process_not_running', message: MOCK_MESSAGES.process_not_running },
    });
  });

  it('serve prints a line every tick until Stop, which ends it SIGKILL; stopping again is 204', async () => {
    const id = await start({ command: 'serve' });
    await vi.waitFor(() => expect(outputOf(id)).toContain('GET / 200 (2)'));
    expect(outputOf(id).startsWith('listening on 3000\n')).toBe(true);
    expect((await call('POST', `/processes/${id}/stop`)).status).toBe(204);
    await ended(id);
    expect(exitOf(id)).toMatchObject({ exitCode: null, signal: 'SIGKILL', status: 'exited' });
    expect((await call('POST', `/processes/${id}/stop`)).status).toBe(204);
  });

  it('reads the scripts from the seeded package.json and runs one as <pm> run <name>', async () => {
    expect((await call('GET', '/processes/scripts')).json).toEqual({
      packageManager: 'pnpm',
      scripts: [
        { name: 'hello', command: 'echo hi from a script' },
        { name: 'dev', command: 'serve' },
      ],
    });
    const script = await start({ script: 'hello' });
    const typed = await start({ command: 'pnpm run hello' });
    await ended(script);
    await ended(typed);
    const expected = '\n> hello\n> echo hi from a script\n\nhi from a script\n';
    expect(outputOf(script)).toBe(expected);
    expect(outputOf(typed)).toBe(expected);
    expect((await call('GET', `/processes/${script}`)).json).toMatchObject({
      label: 'hello',
      command: 'pnpm run hello',
      output: expected,
    });
  });

  it('answers npm and no scripts without a package.json, and reads a lockfile', async () => {
    delete db.filesOf(projectId)['package.json'];
    expect((await call('GET', '/processes/scripts')).json).toEqual({
      packageManager: 'npm',
      scripts: [],
    });
    db.seedFiles(projectId, { 'yarn.lock': '' });
    expect((await call('GET', '/processes/scripts')).json).toMatchObject({
      packageManager: 'yarn',
    });
  });

  it('never offers a script whose name a shell would read as code, nor __proto__, as the engine’s reader', async () => {
    db.seedFiles(projectId, {
      'package.json':
        '{"scripts":{"ok":"echo ok","x & del *":"echo bad","__proto__":"echo proto"}}',
    });
    expect((await call('GET', '/processes/scripts')).json).toEqual({
      packageManager: 'npm',
      scripts: [{ name: 'ok', command: 'echo ok' }],
    });
    expect((await call('POST', '/processes', { script: 'x & del *' })).status).toBe(404);
  });

  it('scripts trust refuses a typed command with the engine’s words, and still runs a script', async () => {
    db.updateProject(projectId, { terminal: 'scripts' });
    const refused = await call('POST', '/processes', { command: 'echo hi' });
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({
      error: { code: 'terminal_restricted', message: MOCK_MESSAGES.terminal_restricted },
    });
    await start({ script: 'hello' });
  });

  it('off refuses every start; a PATCH to off stops what runs, as the engine does', async () => {
    const id = await start({ command: 'serve' });
    const patched = await call('PATCH', '', { terminal: 'off' });
    expect(patched.status).toBe(200);
    expect(patched.json).toMatchObject({ terminal: 'off' });
    await ended(id);
    const refused = await call('POST', '/processes', { script: 'hello' });
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({ error: { code: 'terminal_disabled' } });
  });

  it('a PATCH the contract refuses changes nothing and stops nothing', async () => {
    const id = await start({ command: 'serve' });
    expect((await call('PATCH', '', { terminal: 'sometimes' })).status).toBe(400);
    expect(processes.get(projectId, id).status).toBe('running');
    expect(db.getProject(projectId)?.terminal).toBeUndefined();
  });

  it('deleting a project stops its processes first, as the engine does', async () => {
    const id = await start({ command: 'serve' });
    expect((await call('DELETE', '')).status).toBe(204);
    await ended(id);
    expect(exitOf(id)).toMatchObject({ exitCode: null, signal: 'SIGKILL' });
    expect(db.getProject(projectId)).toBeUndefined();
  });

  it('forgets a deleted project’s processes, finished ones included', async () => {
    const done = await start({ command: 'echo a' });
    await ended(done);
    await start({ command: 'serve' });
    expect((await call('DELETE', '')).status).toBe(204);
    expect(processes.list(projectId)).toEqual([]);
    expect(() => processes.get(projectId, done)).toThrow();
  });

  it('keeps the last 20 that finished, by finish order, not start order', async () => {
    const first = await start({ command: 'serve' });
    const others: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const id = await start({ command: `echo ${i}` });
      await ended(id);
      others.push(id);
    }
    expect((await call('POST', `/processes/${first}/stop`)).status).toBe(204);
    await ended(first);
    expect(processes.get(projectId, first).status).toBe('exited');
    expect(() => processes.get(projectId, others[0] ?? '')).toThrow();
    expect(processes.list(projectId)).toHaveLength(20);
  });

  it('once the engine is stopping, what ran is stopped and a start is 503 engine_stopping in its words', async () => {
    const id = await start({ command: 'serve' });
    processes.stopAll();
    await ended(id);
    expect(exitOf(id)).toMatchObject({ exitCode: null, signal: 'SIGKILL' });
    const refused = await call('POST', '/processes', { command: 'echo late' });
    expect(refused.status).toBe(503);
    expect(refused.json).toMatchObject({
      error: { kind: 'workflow', code: 'engine_stopping', message: MOCK_MESSAGES.engine_stopping },
    });
    // A reset is an engine restart: it starts again.
    processes.reset();
    await start({ command: 'echo again' });
  });

  it('refuses in the engine’s own words, engine_stopping included (processes/errors.ts)', () => {
    expect(Object.keys(MOCK_MESSAGES).sort()).toEqual([
      'engine_stopping',
      'process_limit',
      'process_not_running',
      'terminal_disabled',
      'terminal_restricted',
    ]);
    for (const [code, message] of Object.entries(MOCK_MESSAGES)) {
      // The engine's source writes the limit as a template; the mock's copy has it filled in.
      const source =
        code === 'process_limit' ? message.replace(String(PROCESS_RUNNING_MAX), '${max}') : message;
      expect(engineErrors, code).toContain(source);
    }
  });

  it('labels and places a command as the engine does; a script never takes a cwd', async () => {
    const long = `echo ${'x'.repeat(200)}`;
    const id = await start({ command: `  ${long}  `, cwd: 'src/' });
    expect((await call('GET', `/processes/${id}`)).json).toMatchObject({
      label: `${long.slice(0, 79)}…`,
      cwd: 'src',
    });
    expect((await call('POST', '/processes', { script: 'hello', cwd: 'src' })).status).toBe(400);
  });

  it('refuses a ninth running process with 409 process_limit', async () => {
    for (let i = 0; i < 8; i += 1) await start({ command: 'serve' });
    const ninth = await call('POST', '/processes', { command: 'serve' });
    expect(ninth.status).toBe(409);
    expect(ninth.json).toMatchObject({ error: { code: 'process_limit' } });
  });

  it('confines the working folder as the engine does, and records it folded', async () => {
    expect((await call('POST', '/processes', { command: 'echo', cwd: '..' })).json).toMatchObject({
      error: { code: 'outside_project' },
    });
    expect(
      (await call('POST', '/processes', { command: 'echo', cwd: 'src/../..' })).json,
    ).toMatchObject({
      error: { code: 'outside_project' },
    });
    expect((await call('POST', '/processes', { command: 'echo', cwd: 'missing' })).status).toBe(
      400,
    );
    expect((await call('POST', '/processes', { command: 'echo', cwd: 'src' })).status).toBe(201);
    const folded = await start({ command: 'echo', cwd: 'src/./deep/..' });
    expect((await call('GET', `/processes/${folded}`)).json).toMatchObject({ cwd: 'src' });
  });

  it('lists running first, then finished, newest first; an unknown process is 404', async () => {
    const done = await start({ command: 'echo a' });
    await ended(done);
    const running = await start({ command: 'serve' });
    const listed = (await call('GET', '/processes')).json as unknown as Array<{ id: string }>;
    expect(listed.map((summary) => summary.id)).toEqual([running, done]);
    expect((await call('GET', `/processes/${db.nextId()}`)).status).toBe(404);
  });
});
