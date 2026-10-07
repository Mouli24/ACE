import { describe, expect, it } from 'vitest';

import { createTaskHarness, file } from './harness.js';

/*
 * ACE parity P1 (D274): a project's setup and check commands run with the secrets in that project's
 * scope as environment variables, and a value a command printed is scrubbed from the stored output.
 */

const VALUE = 'fake-check-value-0001';

describe('D274 setup and check commands get the secrets of their project', () => {
  it('asks for the task project’s environment for each command, and stores the output scrubbed', async () => {
    const asked: string[] = [];
    const h = await createTaskHarness({
      projectPatch: {
        setupCommand: 'pnpm install',
        checkCommands: [{ name: 'test', command: 'pnpm test' }],
      },
      commandEnv: async (projectId) => {
        asked.push(projectId);
        return { DEPLOY_TOKEN: VALUE };
      },
      mask: (text) => text.split(VALUE).join('[SECRET:DEPLOY_TOKEN]'),
    });
    h.commands.results.set('pnpm test', { exitCode: 0, output: `using token ${VALUE}` });

    const task = await h.service.create(h.project.id, {
      title: 'Ship it',
      workflowId: h.team.id,
      start: 'now',
    });
    await h.settle();
    await h.finishRun(h.lastRunId(), 'COMPLETE', {
      text: 'Done.',
      changes: [file('src/app.ts')],
    });
    await h.settle();

    expect(h.commands.ran.map(({ command, env }) => ({ command, env }))).toEqual([
      { command: 'pnpm install', env: { DEPLOY_TOKEN: VALUE } },
      { command: 'pnpm test', env: { DEPLOY_TOKEN: VALUE } },
    ]);
    expect(asked).toEqual([h.project.id, h.project.id]);

    const checks = (await h.service.get(task.id)).checks;
    const test = checks.find((check) => check.name === 'test');
    expect(test?.output).toBe('using token [SECRET:DEPLOY_TOKEN]');
    expect(JSON.stringify(checks)).not.toContain(VALUE);
  });

  it('gives a preview the same secrets, with its PORT on top', async () => {
    const h = await createTaskHarness({
      projectPatch: { previewCommand: 'pnpm dev', previewUrl: 'http://localhost:{port}' },
      commandEnv: async () => ({ DEPLOY_TOKEN: VALUE, PORT: 'not-this-one' }),
    });
    const task = await h.service.create(h.project.id, {
      title: 'Look at it',
      workflowId: h.team.id,
      start: 'now',
    });
    await h.settle();
    await h.finishRun(h.lastRunId(), 'COMPLETE', {
      text: 'Done.',
      changes: [file('src/app.ts')],
    });
    await h.settle();

    await h.service.startPreview(task.id);
    expect(h.preview.started[0]?.env).toMatchObject({ DEPLOY_TOKEN: VALUE, PORT: '5199' });
  });

  it('runs commands with no extra environment when none is wired', async () => {
    const h = await createTaskHarness({ projectPatch: { setupCommand: 'pnpm install' } });
    await h.service.create(h.project.id, { title: 'x', workflowId: h.team.id, start: 'now' });
    await h.settle();
    expect(h.commands.ran[0]).toEqual({ command: 'pnpm install', cwd: expect.any(String) });
  });
});
