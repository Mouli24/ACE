/*
 * ACE parity P1 ports (D276, D278): GitHub delivery through the signed-in `gh` CLI, and the
 * long-running preview process of a task's workspace. Interfaces only — `packages/tools` implements
 * both, as it implements the Git port and the command runner.
 */

/* -------------------------------------------------------------------------- */
/* GitHub (D276)                                                              */
/* -------------------------------------------------------------------------- */

export interface GitHubStatus {
  /** Whether the `gh` CLI could be run. */
  installed: boolean;
  /** Whether `gh auth status` reports a signed-in account for github.com. */
  loggedIn: boolean;
  /** The account, when signed in. */
  user?: string;
  /** What to tell the user when it is not usable: the install or login command. */
  detail?: string;
}

export type PullRequestState = 'open' | 'merged' | 'closed';

export interface PullRequestInfo {
  number: number;
  url: string;
  state: PullRequestState;
  base: string;
  head: string;
  /** The merge commit once merged. */
  mergeCommitSha?: string;
}

/**
 * GitHub through the `gh` CLI the user signed in with. ACE never reads its token (as D264 for the
 * coding CLIs). Every call runs `gh`/`git` with an argument array, never a shell, with
 * `GH_PROMPT_DISABLED=1` and `GIT_TERMINAL_PROMPT=0`, and a timeout. A refusal is a `GitHubError`
 * (`packages/tools`) whose message is the CLI's own, trimmed.
 */
export interface GitHubPort {
  status(): Promise<GitHubStatus>;
  /** `git push -u <remote> <branch>` from `cwd` (the task worktree); the remote defaults to `origin`. */
  push(input: { cwd: string; branch: string; remote?: string }): Promise<void>;
  /** `gh pr create` for `head` into `base` of the repository `cwd` belongs to. */
  createPullRequest(input: {
    cwd: string;
    base: string;
    head: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<PullRequestInfo>;
  /** `gh pr view <number> --json …` — the pull request as GitHub reports it now. */
  viewPullRequest(input: { cwd: string; number: number }): Promise<PullRequestInfo>;
  /**
   * `gh pr merge <number> --merge|--squash|--rebase`. Answers when the CLI returns; the caller then
   * reads the pull request back, because only GitHub's own `merged` state counts (ACE: "a GitHub
   * delivery is complete when ACE records the confirmed merge").
   */
  mergePullRequest(input: {
    cwd: string;
    number: number;
    method: 'merge' | 'squash' | 'rebase';
  }): Promise<void>;
  /** `gh repo clone <repo> <folder>`; `repo` is `owner/name` or a github.com URL. */
  clone(input: { repo: string; folder: string }): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Preview (D278)                                                             */
/* -------------------------------------------------------------------------- */

/** One running preview process. */
export interface PreviewProcess {
  /** stdout and stderr as they arrived, the last `maxOutput` characters. */
  output(): string;
  running(): boolean;
  /** The exit code once it has exited (`null` when it was killed). */
  exitCode(): number | null | undefined;
  /** Kills the whole process tree; resolves once it has exited. */
  stop(): Promise<void>;
  /** Called once, when the process exits for any reason. */
  onExit(listener: (exitCode: number | null) => void): void;
}

/**
 * Starts long-running user-configured commands (a dev server) through the platform shell, as the
 * command runner does, but without waiting for them to end (D271's trust: written by the user, shown
 * on the project settings page, never proposed by an agent).
 */
export interface PreviewRunner {
  start(input: {
    command: string;
    cwd: string;
    env?: Record<string, string>;
    maxOutput: number;
  }): PreviewProcess;
  /** A TCP port free on 127.0.0.1 right now. */
  freePort(): Promise<number>;
}
