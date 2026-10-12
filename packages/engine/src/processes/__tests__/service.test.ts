import type { Project, TerminalTrust } from '@ace/contracts';
import { describe, expect, it, vi } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { InProcessPubSubStub } from '../../__tests__/pubsub-stub.js';
import { createEventBus } from '../../events/index.js';
import { HttpError } from '../../gateway/errors.js';
import { newId } from '../../ids.js';
import { createLogger } from '../../logging/index.js';
import {
  LOCAL_SCOPE,
  WorkspaceFsError,
  isWorkspaceFsError,
  type EngineEvent,
} from '../../ports/index.js';
import {
  createProcessService,
  framesOf,
  normaliseCwd,
  tailOf,
  type ProcessServiceDeps,
} from '../service.js';
import { fakeRunner, type FakeRunner } from './fake-runner.js';

const FOLDER = 'D:/projects/demo';
const AT = '2026-10-10T10:00:00.000Z';
const logger = createLogger({ level: 'silent', destination: { write: () => undefined } });

async function harness(
  options: {
    trust?: TerminalTrust;
    runner?: FakeRunner;
    deps?: Partial<ProcessServiceDeps>;
  } = {},
) {
  const repository = new FakeRepository();
  const project: Project = {
    id: newId(),
    name: 'Demo',
    folderPath: FOLDER,
    createdAt: AT,
    updatedAt: AT,
    ...(options.trust === undefined ? {} : { terminal: options.trust }),
  };
  await repository.projects.create(LOCAL_SCOPE, project);
  const events: EngineEvent[] = [];
  const bus = createEventBus({
    repository,
    scope: LOCAL_SCOPE,
    pubsub: new InProcessPubSubStub<EngineEvent>(),
  });
  await bus.subscribe((event) => events.push(event));
  const runner = options.runner ?? fakeRunner();
  const service = createProcessService({
    repository,
    scope: LOCAL_SCOPE,
    runner,
    bus,
    logger,
    batchMs: 5,
    ...options.deps,
  });
  const payloads = (type: string) =>
    events.filter((event) => event.type === type).map((event) => event.payload);
  return { repository, project, events, runner, service, payloads };
}

/** The code and status a call was refused with; fails when it resolves. */
async function refusal(promise: Promise<unknown>): Promise<{ code: string; status?: number }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError) return { code: error.code, status: error.status };
    if (isWorkspaceFsError(error)) return { code: error.code };
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('D301 a typed command runs as a supervised process', () => {
  it('runs in the project folder and the asked-for working folder, and lists it as running', async () => {
    const { project, runner, service } = await harness();
    const { processId } = await service.start(project.id, { command: 'node -v', cwd: 'src' });

    expect(runner.last().spec).toEqual({ root: FOLDER, cwd: 'src', command: 'node -v' });
    expect(await service.list(project.id)).toEqual([
      {
        id: processId,
        projectId: project.id,
        label: 'node -v',
        command: 'node -v',
        cwd: 'src',
        status: 'running',
        exitCode: null,
        signal: null,
        startedAt: expect.any(String),
      },
    ]);
  });

  it('labels a long command by its first 80 characters, and keeps a label it was given', async () => {
    const { project, service } = await harness();
    const long = `node ${'x'.repeat(200)}`;
    const a = await service.start(project.id, { command: long });
    const b = await service.start(project.id, { command: 'pnpm dev', label: 'web' });
    expect((await service.get(project.id, a.processId)).label).toBe(`${long.slice(0, 79)}…`);
    expect((await service.get(project.id, b.processId)).label).toBe('web');
  });

  it('streams output as transient process.output frames, one per stream run in a batch, then process.exited', async () => {
    const { project, runner, service, events, payloads } = await harness();
    const { processId } = await service.start(project.id, { command: 'build' });
    runner.last().print('compiling ');
    runner.last().print('done\n');
    runner.last().print('1 warning\n', 'stderr');

    await vi.waitFor(() =>
      expect(payloads('process.output')).toEqual([
        { projectId: project.id, processId, stream: 'stdout', data: 'compiling done\n' },
        { projectId: project.id, processId, stream: 'stderr', data: '1 warning\n' },
      ]),
    );
    runner.last().exit(0);
    await vi.waitFor(() =>
      expect(payloads('process.exited')).toEqual([
        { projectId: project.id, processId, exitCode: 0, signal: null, status: 'exited' },
      ]),
    );
    expect(events.every((event) => event.transient === true)).toBe(true);
    expect(events.at(-1)?.type).toBe('process.exited');
    expect(await service.get(project.id, processId)).toMatchObject({
      status: 'exited',
      exitCode: 0,
      endedAt: expect.any(String),
      output: 'compiling done\n1 warning\n',
      truncated: false,
    });
  });

  it('flushes output that is still batched before it says the process ended', async () => {
    const { project, runner, service, events } = await harness({ deps: { batchMs: 10_000 } });
    await service.start(project.id, { command: 'echo hi' });
    runner.last().print('hi\n');
    runner.last().exit(0);
    await vi.waitFor(() =>
      expect(events.map((event) => event.type)).toEqual(['process.output', 'process.exited']),
    );
  });

  it('writes nothing to the event log, whatever it prints (design §7)', async () => {
    const { project, runner, service, repository, payloads } = await harness();
    const before = await repository.events.currentSeq(LOCAL_SCOPE);
    await service.start(project.id, { command: 'echo token=abc' });
    runner.last().print('token=abc\n');
    runner.last().exit(0);
    await vi.waitFor(() => expect(payloads('process.exited')).toHaveLength(1));
    expect(await repository.events.currentSeq(LOCAL_SCOPE)).toBe(before);
  });

  it('a flood in one batch goes out as frames of at most 65,536 characters, in order', async () => {
    const { project, runner, service, payloads } = await harness({ deps: { batchMs: 10_000 } });
    await service.start(project.id, { command: 'flood' });
    // 😀 straddles the first frame's edge, so the cut must step back one code unit.
    const flood = `${'a'.repeat(65_535)}😀${'b'.repeat(300_000)}`;
    runner.last().print(flood);
    runner.last().exit(0);

    await vi.waitFor(() => expect(payloads('process.exited')).toHaveLength(1));
    const frames = payloads('process.output') as Array<{ data: string }>;
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) {
      expect(frame.data.length).toBeLessThanOrEqual(65_536);
      expect(frame.data.charCodeAt(0) >= 0xdc00 && frame.data.charCodeAt(0) <= 0xdfff).toBe(false);
    }
    expect(frames.map((frame) => frame.data).join('')).toBe(flood);
    expect(framesOf('abcde', 2)).toEqual(['ab', 'cd', 'e']);
  });

  it('runs a command in the folder it was given, and lists that folder normalised', async () => {
    const { project, runner, service } = await harness();
    const { processId } = await service.start(project.id, { command: 'ls', cwd: 'src\\deep/' });
    expect(runner.last().spec.cwd).toBe('src\\deep/');
    expect((await service.get(project.id, processId)).cwd).toBe('src/deep');
    expect(normaliseCwd('./src//a/./')).toBe('src/a');
    expect(normaliseCwd('src/deep/..')).toBe('src');
    expect(normaliseCwd('.')).toBe('');
  });

  it('keeps only the last 1,048,576 characters, never half a character', async () => {
    const { project, runner, service } = await harness();
    const { processId } = await service.start(project.id, { command: 'flood' });
    runner.last().print('x'.repeat(1_048_576));
    runner.last().print('END');
    const detail = await service.get(project.id, processId);
    expect(detail.output).toHaveLength(1_048_576);
    expect(detail.output.endsWith('xEND')).toBe(true);
    expect(detail.truncated).toBe(true);

    const small = await harness({ deps: { outputCapChars: 3 } });
    const cut = await small.service.start(small.project.id, { command: 'emoji' });
    // 'ab😀cd' is six code units; the last three start with the second half of 😀.
    small.runner.last().print('ab\ud83d\ude00cd');
    expect((await small.service.get(small.project.id, cut.processId)).output).toBe('cd');
    expect(tailOf('ab\ud83d\ude00cd', 4)).toBe('\ud83d\ude00cd');
  });

  it('a process that never started is failed, with its reason in the output (design §10)', async () => {
    const { project, runner, service, payloads } = await harness();
    const { processId } = await service.start(project.id, { command: 'x' });
    runner.last().fail('spawn /bin/sh ENOENT');

    await vi.waitFor(() =>
      expect(payloads('process.exited')).toEqual([
        { projectId: project.id, processId, exitCode: null, signal: null, status: 'failed' },
      ]),
    );
    expect(payloads('process.output')).toEqual([
      {
        projectId: project.id,
        processId,
        stream: 'stderr',
        data: 'Could not start: spawn /bin/sh ENOENT\r\n',
      },
    ]);
    expect(await service.get(project.id, processId)).toMatchObject({
      status: 'failed',
      output: 'Could not start: spawn /bin/sh ENOENT\r\n',
    });
  });

  it('writes input to stdin while it runs; a finished process answers 409 process_not_running', async () => {
    const { project, runner, service } = await harness();
    const { processId } = await service.start(project.id, { command: 'ask' });
    await service.input(project.id, processId, 'Ada\n');
    expect(runner.last().written).toEqual(['Ada\n']);

    runner.last().exit(0);
    expect(await refusal(service.input(project.id, processId, 'late\n'))).toEqual({
      code: 'process_not_running',
      status: 409,
    });
  });

  it('stops a running process, and a second stop of a finished one does nothing', async () => {
    const { project, runner, service } = await harness();
    const { processId } = await service.start(project.id, { command: 'serve' });
    await service.stop(project.id, processId);
    await vi.waitFor(async () =>
      expect(await service.get(project.id, processId)).toMatchObject({
        status: 'exited',
        exitCode: null,
        signal: 'SIGKILL',
      }),
    );
    await service.stop(project.id, processId);
    expect(runner.last().stops).toBe(1);
  });

  it('refuses a ninth running process with 409 process_limit; a finished one frees a place', async () => {
    const { project, runner, service } = await harness();
    for (let i = 0; i < 8; i += 1) await service.start(project.id, { command: `serve ${i}` });
    expect(await refusal(service.start(project.id, { command: 'one more' }))).toEqual({
      code: 'process_limit',
      status: 409,
    });
    runner.started[0]?.exit(0);
    await expect(service.start(project.id, { command: 'one more' })).resolves.toEqual({
      processId: expect.any(String),
    });
  });

  it('remembers the last 20 finished processes; running ones list first, each group newest first', async () => {
    const { project, runner, service } = await harness();
    const finished: string[] = [];
    for (let i = 0; i < 22; i += 1) {
      finished.push((await service.start(project.id, { command: `job ${i}` })).processId);
      runner.last().exit(0);
    }
    const running = (await service.start(project.id, { command: 'serve' })).processId;

    const listed = (await service.list(project.id)).map((summary) => summary.id);
    expect(listed).toEqual([running, ...finished.slice(2).reverse()]);
    expect(await refusal(service.get(project.id, finished[0] ?? ''))).toEqual({
      code: 'not_found',
      status: 404,
    });
  });

  it('answers 404 for a project or a process it does not know', async () => {
    const { project, service } = await harness();
    const unknown = newId();
    expect((await refusal(service.list(unknown))).code).toBe('not_found');
    expect((await refusal(service.start(unknown, { command: 'x' }))).code).toBe('not_found');
    expect((await refusal(service.get(project.id, unknown))).code).toBe('not_found');
    expect((await refusal(service.input(project.id, unknown, 'x'))).code).toBe('not_found');
    expect((await refusal(service.stop(project.id, unknown))).code).toBe('not_found');
  });

  it('keeps the runner’s refusal of a working folder, and remembers nothing', async () => {
    const runner = fakeRunner({
      refuse: (spec) =>
        spec.cwd === '..'
          ? new WorkspaceFsError('outside_project', 'That path is outside the project folder.')
          : undefined,
    });
    const { project, service } = await harness({ runner });
    expect(await refusal(service.start(project.id, { command: 'ls', cwd: '..' }))).toEqual({
      code: 'outside_project',
    });
    expect(await service.list(project.id)).toEqual([]);
  });

  it('refuses a project with no folder as invalid_path', async () => {
    const { repository, service } = await harness();
    const bare: Project = {
      id: newId(),
      name: 'Bare',
      folderPath: '',
      createdAt: AT,
      updatedAt: AT,
    };
    await repository.projects.create(LOCAL_SCOPE, bare);
    expect((await refusal(service.start(bare.id, { command: 'x' }))).code).toBe('invalid_path');
  });
});

describe('D301 the project’s trust level governs a start, never a stop', () => {
  const scripts = {
    packageManager: 'pnpm' as const,
    scripts: [
      { name: 'dev', command: 'vite' },
      { name: 'x & y', command: 'echo odd' },
    ],
  };

  it('scripts: refuses a typed command with 403 terminal_restricted, and runs a script as <pm> run <name>', async () => {
    const { project, runner, service } = await harness({
      trust: 'scripts',
      runner: fakeRunner({ scripts }),
    });
    expect(await refusal(service.start(project.id, { command: 'rm -rf /' }))).toEqual({
      code: 'terminal_restricted',
      status: 403,
    });
    const { processId } = await service.start(project.id, { script: 'dev' });
    expect(runner.last().spec.command).toBe('pnpm run dev');
    expect(await service.get(project.id, processId)).toMatchObject({
      label: 'dev',
      command: 'pnpm run dev',
    });
  });

  it('runs a script in the project root, always (decision 5)', async () => {
    const { project, runner, service } = await harness({ runner: fakeRunner({ scripts }) });
    const { processId } = await service.start(project.id, { script: 'dev' });
    expect(runner.last().spec).toEqual({ root: FOLDER, cwd: '', command: 'pnpm run dev' });
    expect((await service.get(project.id, processId)).cwd).toBe('');
  });

  it('reads the trust level again after package.json: an off that lands meanwhile refuses the script', async () => {
    let release: () => void = () => undefined;
    const scriptsGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { project, repository, runner, service } = await harness({
      runner: fakeRunner({ scripts, scriptsGate }),
    });
    const starting = refusal(service.start(project.id, { script: 'dev' }));
    // The start has read the trust level (on) and now waits on package.json.
    await vi.waitFor(() => expect(runner.scriptsAsked).toBe(1));
    await repository.projects.update(LOCAL_SCOPE, project.id, { terminal: 'off', updatedAt: AT });
    await service.stopProject(project.id);
    release();
    expect(await starting).toEqual({ code: 'terminal_disabled', status: 403 });
    expect(runner.started).toEqual([]);
  });

  it('a script package.json does not have is 404; a name a shell would split is refused before a shell sees it', async () => {
    const { project, runner, service } = await harness({ runner: fakeRunner({ scripts }) });
    expect(await refusal(service.start(project.id, { script: 'nope' }))).toEqual({
      code: 'not_found',
      status: 404,
    });
    expect(await refusal(service.start(project.id, { script: 'x & y' }))).toEqual({
      code: 'validation_failed',
      status: 400,
    });
    expect(runner.started).toEqual([]);
  });

  it('re-checks the script name against the safe pattern even when the runner offers it', async () => {
    const odd = {
      packageManager: 'npm' as const,
      scripts: [{ name: 'x & del *', command: 'echo' }],
    };
    const { project, runner, service } = await harness({ runner: fakeRunner({ scripts: odd }) });
    expect(await refusal(service.start(project.id, { script: 'x & del *' }))).toEqual({
      code: 'validation_failed',
      status: 400,
    });
    expect(runner.started).toEqual([]);
  });

  it('off: refuses every start with 403 terminal_disabled, while list, get, input and stop still work', async () => {
    const { project, repository, runner, service } = await harness({
      runner: fakeRunner({ scripts }),
    });
    const { processId } = await service.start(project.id, { command: 'serve' });
    await repository.projects.update(LOCAL_SCOPE, project.id, { terminal: 'off', updatedAt: AT });

    expect(await refusal(service.start(project.id, { command: 'ls' }))).toEqual({
      code: 'terminal_disabled',
      status: 403,
    });
    expect((await refusal(service.start(project.id, { script: 'dev' }))).code).toBe(
      'terminal_disabled',
    );
    expect(await service.list(project.id)).toHaveLength(1);
    await service.input(project.id, processId, 'q\n');
    expect(runner.last().written).toEqual(['q\n']);
    await service.stop(project.id, processId);
    await vi.waitFor(async () =>
      expect((await service.get(project.id, processId)).status).toBe('exited'),
    );
  });

  it('answers the runner’s scripts for the project’s folder', async () => {
    const { project, service } = await harness({ runner: fakeRunner({ scripts }) });
    expect(await service.scripts(project.id)).toEqual(scripts);
    expect((await refusal(service.scripts(newId()))).code).toBe('not_found');
  });
});

describe('D301 stopping everything', () => {
  it('stopProject stops every running process of that project only, and resolves when they have ended', async () => {
    const one = await harness();
    const other = await one.repository.projects.create(LOCAL_SCOPE, {
      id: newId(),
      name: 'Other',
      folderPath: 'D:/projects/other',
      createdAt: AT,
      updatedAt: AT,
    });
    const a = await one.service.start(one.project.id, { command: 'serve a' });
    const b = await one.service.start(one.project.id, { command: 'serve b' });
    const c = await one.service.start(other.id, { command: 'serve c' });

    await one.service.stopProject(one.project.id);
    expect((await one.service.get(one.project.id, a.processId)).status).toBe('exited');
    expect((await one.service.get(one.project.id, b.processId)).status).toBe('exited');
    expect((await one.service.get(other.id, c.processId)).status).toBe('running');
  });

  it('stopAll stops every process and resolves once each has ended (FR-SYS-008)', async () => {
    const { project, service } = await harness();
    await service.start(project.id, { command: 'serve a' });
    await service.start(project.id, { command: 'serve b' });
    await service.stopAll();
    expect((await service.list(project.id)).map((summary) => summary.status)).toEqual([
      'exited',
      'exited',
    ]);
  });

  it('stopAll resolves at once with nothing running', async () => {
    const { service } = await harness();
    await expect(service.stopAll()).resolves.toBeUndefined();
  });
});

describe('D301 fences: nothing starts once the engine or its project is stopping', () => {
  const scripts = { packageManager: 'npm' as const, scripts: [{ name: 'dev', command: 'vite' }] };
  const gated = () => {
    let release: () => void = () => undefined;
    const scriptsGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { release: () => release(), runner: fakeRunner({ scripts, scriptsGate }) };
  };

  it('a script start waiting on package.json is refused engine_stopping once stopAll ran', async () => {
    const { release, runner } = gated();
    const { project, service } = await harness({ runner });
    const starting = refusal(service.start(project.id, { script: 'dev' }));
    await vi.waitFor(() => expect(runner.scriptsAsked).toBe(1));
    await service.stopAll();
    release();
    expect(await starting).toEqual({ code: 'engine_stopping', status: 503 });
    expect(runner.started).toEqual([]);
  });

  it('a command start after stopAll is refused engine_stopping', async () => {
    const { project, runner, service } = await harness();
    await service.stopAll();
    expect(await refusal(service.start(project.id, { command: 'x' }))).toEqual({
      code: 'engine_stopping',
      status: 503,
    });
    expect(runner.started).toEqual([]);
  });

  it('a script start waiting on package.json is refused terminal_disabled once stopProject ran', async () => {
    const { release, runner } = gated();
    const { project, service } = await harness({ runner });
    const starting = refusal(service.start(project.id, { script: 'dev' }));
    await vi.waitFor(() => expect(runner.scriptsAsked).toBe(1));
    await service.stopProject(project.id);
    release();
    expect(await starting).toEqual({ code: 'terminal_disabled', status: 403 });
    expect(runner.started).toEqual([]);
  });
});

describe('D301 the recent list keeps what finished last', () => {
  it('a long-running process that ends after 20 short jobs is kept; the first short job is evicted', async () => {
    const { project, runner, service } = await harness();
    const a = await service.start(project.id, { command: 'long' });
    const longRun = runner.last();
    const jobs: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      jobs.push((await service.start(project.id, { command: `job ${i}` })).processId);
      runner.last().exit(0);
    }
    longRun.exit(1);
    expect(await service.get(project.id, a.processId)).toMatchObject({
      status: 'exited',
      exitCode: 1,
    });
    expect(await refusal(service.get(project.id, jobs[0] ?? ''))).toEqual({
      code: 'not_found',
      status: 404,
    });
    expect((await service.get(project.id, jobs[1] ?? '')).status).toBe('exited');
  });
});

describe('D301 a deleted project is forgotten', () => {
  it('forgetProject releases the records once the project is stopped', async () => {
    const { project, service } = await harness();
    const { processId } = await service.start(project.id, { command: 'serve' });
    await service.stopProject(project.id);
    service.forgetProject(project.id);
    expect(await service.list(project.id)).toEqual([]);
    expect(await refusal(service.get(project.id, processId))).toEqual({
      code: 'not_found',
      status: 404,
    });
  });
});
