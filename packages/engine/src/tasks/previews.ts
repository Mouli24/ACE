import type { Id, Task, TaskPreview } from '@ace/contracts';
import { CHECK_OUTPUT_MAX } from '@ace/contracts';

import { HttpError } from '../gateway/errors.js';
import type { PreviewProcess, PreviewRunner } from '../ports/index.js';
import type { TaskKernel } from './kernel.js';

/**
 * Task previews (ACE parity P1, D278): the project's preview command, run in the task's worktree
 * with `PORT` set to a free local port and the project's secrets, so the user can open the app as
 * the task left it. One per task; stopped on Stop, when the worktree goes (apply, merge, delete) and
 * at shutdown. Kept in memory: a preview does not outlive the engine that started it.
 */
export interface PreviewManager {
  start(taskId: Id): Promise<Task>;
  stop(taskId: Id): Promise<Task>;
  /** The preview as the task detail shows it, output masked; `undefined` when none was started. */
  info(taskId: Id): TaskPreview | undefined;
  /** Stops a task's preview without touching the task (its worktree is about to go). */
  stopFor(taskId: Id): Promise<void>;
  stopAll(): Promise<void>;
}

const DEFAULT_PREVIEW_URL = 'http://localhost:{port}';

interface Running {
  process: PreviewProcess;
  info: TaskPreview;
  stopping: boolean;
}

export function createPreviewManager(kernel: TaskKernel, runner: PreviewRunner): PreviewManager {
  const previews = new Map<Id, Running>();

  /** Refreshes the board and page: the preview is part of the task detail. */
  const announce = (taskId: Id): void => {
    kernel.track(async () => {
      await kernel.withLock(taskId, async () => {
        const task = await kernel.repos().tasks.get(kernel.scope, taskId);
        if (task !== null) await kernel.commit(task);
      });
    });
  };

  const stopFor = async (taskId: Id): Promise<void> => {
    const running = previews.get(taskId);
    if (running === undefined || !running.process.running()) return;
    running.stopping = true;
    await running.process.stop();
  };

  return {
    async start(taskId) {
      return kernel.withLock(taskId, async () => {
        const task = await kernel.load(taskId);
        await kernel.assertAllowed(task, 'preview', 'start a preview');
        const project = await kernel.loadProject(task.projectId);
        const command = project.previewCommand ?? undefined;
        if (command === undefined) {
          throw new HttpError(
            'invalid_config',
            'no_preview_command',
            'Set a preview command in the project settings first (for example: pnpm dev --port $PORT).',
          );
        }
        const workspace = await kernel.repos().workspaces.getByTask(kernel.scope, taskId);
        if (workspace?.status !== 'ready') {
          throw new HttpError(
            'workflow',
            'no_workspace',
            `Task #${task.number} has no workspace to preview.`,
          );
        }
        const existing = previews.get(taskId);
        if (existing !== undefined && existing.process.running()) return kernel.present(task);

        const port = await runner.freePort();
        const env = { ...((await kernel.commandEnv(task.projectId)) ?? {}), PORT: String(port) };
        const process = runner.start({
          command,
          cwd: workspace.path,
          env,
          maxOutput: CHECK_OUTPUT_MAX,
        });
        const running: Running = {
          process,
          stopping: false,
          info: {
            taskId,
            status: 'running',
            command,
            port,
            url: (project.previewUrl ?? DEFAULT_PREVIEW_URL).replaceAll('{port}', String(port)),
            output: '',
            startedAt: kernel.now(),
          },
        };
        previews.set(taskId, running);
        process.onExit((exitCode) => {
          running.info = {
            ...running.info,
            status: running.stopping || exitCode === 0 ? 'stopped' : 'failed',
            ...(exitCode === null ? {} : { exitCode }),
            endedAt: kernel.now(),
          };
          announce(taskId);
        });
        return kernel.commit(task, { kind: 'edited', message: `Preview started on port ${port}.` });
      });
    },

    async stop(taskId) {
      await stopFor(taskId);
      return kernel.withLock(taskId, async () => kernel.present(await kernel.load(taskId)));
    },

    info(taskId) {
      const running = previews.get(taskId);
      if (running === undefined) return undefined;
      return {
        ...running.info,
        output: kernel.mask(running.process.output()).slice(-CHECK_OUTPUT_MAX),
      };
    },

    stopFor,

    async stopAll() {
      await Promise.all([...previews.keys()].map((taskId) => stopFor(taskId)));
    },
  };
}
