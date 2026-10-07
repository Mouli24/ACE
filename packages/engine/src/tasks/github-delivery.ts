import type {
  GitHubRepo,
  MergePullRequestRequest,
  OpenPullRequestRequest,
  Task,
  TaskWorkspace,
} from '@ace/contracts';

import { HttpError } from '../gateway/errors.js';
import type { GitHubPort, GitPort, TaskRecord } from '../ports/index.js';
import type { TaskKernel } from './kernel.js';

/**
 * GitHub delivery (ACE parity P1, D276): push the task branch and open a pull request into the
 * branch the worktree was cut from; merge it only after the client repeats the repository and base
 * it showed, and count the task `merged` only when GitHub itself reports the merge.
 */

/** `owner/repo` out of a GitHub remote URL (https or ssh), or undefined. */
export function parseGitHubRemote(url: string | undefined): GitHubRepo | undefined {
  if (url === undefined) return undefined;
  const match =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
      url.trim(),
    );
  if (match === null || match[1] === undefined || match[2] === undefined) return undefined;
  return { owner: match[1], repo: match[2] };
}

const notConnected = (message: string): HttpError =>
  new HttpError('invalid_config', 'not_connected', message);

async function readyWorkspace(kernel: TaskKernel, task: TaskRecord): Promise<TaskWorkspace> {
  const workspace = await kernel.repos().workspaces.getByTask(kernel.scope, task.id);
  if (workspace?.status !== 'ready') {
    throw new HttpError(
      'workflow',
      'no_workspace',
      `Task #${task.number} has no workspace to deliver.`,
    );
  }
  return workspace;
}

async function assertDeliverable(
  kernel: TaskKernel,
  git: GitPort,
  github: GitHubPort,
  task: TaskRecord,
  workspace: TaskWorkspace,
): Promise<GitHubRepo> {
  const failed = await kernel.headChecksFailed(task.id, workspace.headSha);
  if (failed.length > 0) {
    throw new HttpError(
      'workflow',
      'checks_failed',
      `Checks failed on ${workspace.headSha.slice(0, 7)}: ${failed.join(', ')}. Request changes or close the task.`,
      { checks: failed },
    );
  }
  const repo = await git.inspect(workspace.repoPath);
  const remote = parseGitHubRemote(repo.remoteUrl);
  if (remote === undefined) {
    throw notConnected(
      'The project repository has no GitHub remote named origin. Add one (git remote add origin …), or clone the project from GitHub.',
    );
  }
  const status = await github.status();
  if (!status.installed || !status.loggedIn) {
    throw notConnected(
      status.detail ?? 'The GitHub CLI is not signed in. Run gh auth login in a terminal.',
    );
  }
  const { uncommitted } = await git.changes({
    cwd: workspace.path,
    baseSha: workspace.baseSha,
    includeUncommitted: false,
  });
  if (uncommitted || (await git.headSha(workspace.path)) !== workspace.headSha) {
    throw new HttpError(
      'workflow',
      'invalid_task_state',
      `Task #${task.number}'s workspace changed after it was reviewed; run its checks or a work run so the change is recorded first.`,
    );
  }
  return remote;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export async function openPullRequest(
  kernel: TaskKernel,
  git: GitPort,
  github: GitHubPort,
  id: string,
  body: OpenPullRequestRequest,
): Promise<Task> {
  return kernel.withLock(id, async () => {
    const task = await kernel.load(id);
    await kernel.assertAllowed(task, 'open_pr', 'open a pull request');
    const workspace = await readyWorkspace(kernel, task);
    const remote = await assertDeliverable(kernel, git, github, task, workspace);
    const repo = `${remote.owner}/${remote.repo}`;
    const destination = `${repo}: ${workspace.branch} → ${workspace.baseBranch}`;
    const executions = await kernel.repos().executions.listByTask(kernel.scope, id);
    const summary = executions.filter((run) => run.kind === 'work').at(-1)?.summary;

    try {
      await github.push({ cwd: workspace.path, branch: workspace.branch });
      const pr = await github.createPullRequest({
        cwd: workspace.path,
        base: workspace.baseBranch,
        head: workspace.branch,
        title: body.title ?? task.title,
        body:
          body.body ??
          [task.brief.trim(), summary?.trim() ?? '', `_Opened by ACE from task #${task.number}._`]
            .filter((part) => part !== '')
            .join('\n\n'),
        draft: body.draft ?? false,
      });
      await kernel.repos().workspaces.save(kernel.scope, {
        ...workspace,
        pullRequest: { number: pr.number, url: pr.url, state: pr.state, base: pr.base, repo },
        updatedAt: kernel.now(),
      });
      await kernel.repos().deliveries.create(kernel.scope, {
        id: kernel.nextId(),
        taskId: id,
        kind: 'github_pr',
        status: 'succeeded',
        destination,
        url: pr.url,
        at: kernel.now(),
      });
      return kernel.commit(
        kernel.moveTo(
          task,
          'review',
          'idle',
          `Pull request #${pr.number} is open on GitHub. Merge it from here when it is ready.`,
        ),
        { kind: 'delivered', message: `Opened pull request #${pr.number} (${pr.url}).` },
      );
    } catch (error) {
      await kernel.repos().deliveries.create(kernel.scope, {
        id: kernel.nextId(),
        taskId: id,
        kind: 'github_pr',
        status: 'failed',
        destination,
        detail: message(error),
        at: kernel.now(),
      });
      const reason = `Opening the pull request failed: ${message(error)}`;
      return kernel.commit(kernel.moveTo(task, 'review', 'failed', reason), {
        kind: 'delivery_failed',
        message: reason,
      });
    }
  });
}

export async function mergePullRequest(
  kernel: TaskKernel,
  git: GitPort,
  github: GitHubPort,
  id: string,
  body: MergePullRequestRequest,
  onDelivered: (task: TaskRecord, workspace: TaskWorkspace) => Promise<void>,
): Promise<Task> {
  return kernel.withLock(id, async () => {
    const task = await kernel.load(id);
    await kernel.assertAllowed(task, 'merge_pr', 'merge its pull request');
    const workspace = await readyWorkspace(kernel, task);
    const pr = workspace.pullRequest;
    if (pr === undefined) {
      throw new HttpError(
        'workflow',
        'invalid_task_state',
        `Task #${task.number} has no pull request.`,
      );
    }
    if (body.confirm.repo !== pr.repo || body.confirm.base !== pr.base) {
      throw new HttpError(
        'workflow',
        'destination_changed',
        `Pull request #${pr.number} merges into ${pr.repo} @ ${pr.base}, not the destination you confirmed.`,
        { repo: pr.repo, base: pr.base },
      );
    }
    await assertDeliverable(kernel, git, github, task, workspace);
    const destination = `${pr.repo} @ ${pr.base} (#${pr.number})`;

    try {
      // The branch carries every recorded run, so the merge is of what ACE showed for review.
      await github.push({ cwd: workspace.path, branch: workspace.branch });
      await github.mergePullRequest({
        cwd: workspace.path,
        number: pr.number,
        method: body.method,
        repo: pr.repo,
      });
      const after = await github.viewPullRequest({
        cwd: workspace.path,
        number: pr.number,
        repo: pr.repo,
      });
      const at = kernel.now();
      const updated: TaskWorkspace = {
        ...workspace,
        pullRequest: { ...pr, state: after.state },
        updatedAt: at,
      };

      if (after.state !== 'merged') {
        await kernel.repos().workspaces.save(kernel.scope, updated);
        await kernel.repos().deliveries.create(kernel.scope, {
          id: kernel.nextId(),
          taskId: id,
          kind: 'github_merge',
          status: 'uncertain',
          destination,
          detail: `GitHub reports the pull request as ${after.state} after the merge request.`,
          url: after.url,
          at,
        });
        const reason = `GitHub has not confirmed the merge of #${pr.number} (it is ${after.state}). Check it on GitHub, then try Merge again.`;
        return kernel.commit(kernel.moveTo(task, 'review', 'idle', reason), {
          kind: 'delivery_failed',
          message: reason,
        });
      }

      await kernel.repos().deliveries.create(kernel.scope, {
        id: kernel.nextId(),
        taskId: id,
        kind: 'github_merge',
        status: 'succeeded',
        destination,
        ...(after.mergeCommitSha === undefined ? {} : { sha: after.mergeCommitSha }),
        url: after.url,
        at,
      });
      await git
        .removeWorktree({ repoPath: workspace.repoPath, worktreePath: workspace.path })
        .catch((error: unknown) =>
          kernel.logger.warn(
            { subsystem: 'tasks', err: error, taskId: id },
            'worktree not removed after merge',
          ),
        );
      const merged: TaskWorkspace = { ...updated, status: 'merged' };
      await kernel.repos().workspaces.save(kernel.scope, merged);
      await onDelivered(task, merged);
      return kernel.commit(
        kernel.set(kernel.moveTo(task, 'done', 'done'), { outcome: 'merged', completedAt: at }),
        {
          kind: 'delivered',
          message: `Merged pull request #${pr.number} into ${pr.base} on GitHub.`,
        },
      );
    } catch (error) {
      await kernel.repos().deliveries.create(kernel.scope, {
        id: kernel.nextId(),
        taskId: id,
        kind: 'github_merge',
        status: 'failed',
        destination,
        detail: message(error),
        at: kernel.now(),
      });
      const reason = `Merging #${pr.number} failed: ${message(error)}`;
      return kernel.commit(kernel.moveTo(task, 'review', 'failed', reason), {
        kind: 'delivery_failed',
        message: reason,
      });
    }
  });
}
