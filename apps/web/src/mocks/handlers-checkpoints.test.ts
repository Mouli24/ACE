import type { Checkpoint, ServerFrame } from '@ace/contracts';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The engine's refusals as text, so the mock's copy can never drift from them (D300).
import enginePort from '../../../../packages/engine/src/ports/checkpoints.ts?raw';
import engineErrors from '../../../../packages/engine/src/checkpoints/errors.ts?raw';
import engineService from '../../../../packages/engine/src/checkpoints/service.ts?raw';
import { MOCK_CHECKPOINT_MESSAGES, MockCheckpoints } from './checkpoints';
import { MockDb } from './db';
import { createFakeWebSocket, type FakeWebSocketInstance } from './fake-socket';
import { createCheckpointHandlers } from './handlers-checkpoints';
import { createHandlers } from './handlers';

const db = new MockDb({ persist: false });
const checkpoints = new MockCheckpoints(db);
const server = setupServer(...createCheckpointHandlers(db, checkpoints), ...createHandlers(db));
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

let projectId: string;
let frames: ServerFrame[];
let socket: FakeWebSocketInstance;

beforeEach(async () => {
  db.reset();
  checkpoints.reset();
  projectId = db.createProject({ name: 'P' }).id;
  frames = [];
  const Socket = createFakeWebSocket(db);
  socket = new Socket('ws://mock/ws?token=t');
  socket.onmessage = (event) => frames.push(JSON.parse(String(event.data)) as ServerFrame);
  await vi.waitFor(() => expect(socket.readyState).toBe(1));
  socket.send(JSON.stringify({ type: 'subscribe', payload: { scope: 'project', id: projectId } }));
});
afterEach(() => {
  socket.close();
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
  return { status: response.status, json: (text === '' ? undefined : JSON.parse(text)) as unknown };
};

const fileOf = (path: string): string | undefined => {
  const entry = db.filesOf(projectId)[path];
  return entry?.kind === 'file' ? entry.content : undefined;
};

function seedTwo(): Checkpoint {
  return checkpoints.seed(projectId, [
    { path: 'src/a.ts', before: 'one\ntwo\n', after: 'one\nTWO\nthree\n' },
    { path: 'src/new.ts', after: 'fresh\n' },
  ]);
}

describe('D300 the mock engine’s checkpoints', () => {
  it('repeats the engine’s refusals word for word', () => {
    expect(enginePort).toContain("changed after the agent's edit; review it before reverting");
    expect(engineErrors).toContain(
      "files changed after the agent's edit; review them before reverting.",
    );
    expect(engineService).toContain(MOCK_CHECKPOINT_MESSAGES.recording);
    expect(engineService).toContain(MOCK_CHECKPOINT_MESSAGES.failed);
    expect(engineService).toContain('during the session, so it is not reverted here.');
    expect(enginePort).toContain("ACE could not capture ${path} (${UNCAPTURED_REASON_WORDS");
    expect(enginePort).toContain("too_large: 'over 5 MB'");
    expect(enginePort).toContain("vanished: 'it vanished while being captured'");
    expect(MOCK_CHECKPOINT_MESSAGES.uncaptured('a.bin', 'too_large')).toBe(
      "ACE could not capture a.bin (over 5 MB), so it can't be reverted",
    );
  });

  it('seeds a pending checkpoint, puts its after text in the folder and announces it', async () => {
    const seeded = seedTwo();
    expect(seeded.files).toEqual([
      {
        path: 'src/a.ts',
        change: 'modified',
        additions: 2,
        deletions: 1,
        binary: false,
        state: 'pending',
      },
      {
        path: 'src/new.ts',
        change: 'added',
        additions: 1,
        deletions: 0,
        binary: false,
        state: 'pending',
      },
    ]);
    expect(fileOf('src/a.ts')).toBe('one\nTWO\nthree\n');
    await vi.waitFor(() =>
      expect(frames.some((frame) => frame.type === 'checkpoint.updated')).toBe(true),
    );
    const listed = await call('GET', '/checkpoints');
    expect((listed.json as Checkpoint[]).map((each) => each.id)).toEqual([seeded.id]);
  });

  it('answers a file diff and 404 for a path it does not have', async () => {
    const seeded = seedTwo();
    expect((await call('GET', `/checkpoints/${seeded.id}/diff?path=src/a.ts`)).json).toEqual({
      before: 'one\ntwo\n',
      after: 'one\nTWO\nthree\n',
      binary: false,
    });
    expect((await call('GET', `/checkpoints/${seeded.id}/diff?path=src/new.ts`)).json).toEqual({
      after: 'fresh\n',
      binary: false,
    });
    expect((await call('GET', `/checkpoints/${seeded.id}/diff?path=x`)).status).toBe(404);
  });

  it('reverts: the before text comes back and a created file goes', async () => {
    const seeded = seedTwo();
    const answer = await call('POST', `/checkpoints/${seeded.id}/actions`, { action: 'revert' });
    expect(answer.status).toBe(200);
    expect((answer.json as Checkpoint).status).toBe('reverted');
    expect(fileOf('src/a.ts')).toBe('one\ntwo\n');
    expect(fileOf('src/new.ts')).toBeUndefined();
  });

  it('refuses to revert a file changed since, with the engine’s 409, and reverts the rest', async () => {
    const seeded = seedTwo();
    db.writeFileExternally(projectId, 'src/a.ts', 'mine\n');
    const answer = await call('POST', `/checkpoints/${seeded.id}/actions`, { action: 'revert' });
    expect(answer.status).toBe(409);
    expect(answer.json).toMatchObject({
      error: {
        code: 'checkpoint_conflict',
        message: MOCK_CHECKPOINT_MESSAGES.conflict('src/a.ts'),
        details: { conflicts: [{ path: 'src/a.ts' }] },
      },
    });
    expect(fileOf('src/a.ts')).toBe('mine\n');
    expect(fileOf('src/new.ts')).toBeUndefined();
    const after = (await call('GET', `/checkpoints/${seeded.id}`)).json as Checkpoint;
    expect(after.files.map((file) => file.state)).toEqual(['pending', 'reverted']);
  });

  it('keeps per file, then closes as partial; validates the body', async () => {
    const seeded = seedTwo();
    await call('POST', `/checkpoints/${seeded.id}/actions`, {
      action: 'revert',
      paths: ['src/new.ts'],
    });
    const kept = await call('POST', `/checkpoints/${seeded.id}/actions`, { action: 'keep' });
    expect((kept.json as Checkpoint).status).toBe('partial');
    const bad = await call('POST', `/checkpoints/${seeded.id}/actions`, { action: 'nuke' });
    expect(bad.status).toBe(400);
  });
});
