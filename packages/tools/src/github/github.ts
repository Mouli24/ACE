import { spawn, type ChildProcess } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';

import type { GitHubPort, GitHubStatus, PullRequestInfo } from '@ace/engine';
import { z } from 'zod';

import { REPOSITORY_VARIABLES } from '../git/git.js';
import { isDirectory } from '../process/is-directory.js';
import { killProcessTree } from '../process/kill-tree.js';
import { mergeEnv, unsetEnv } from '../process/merge-env.js';

/**
 * A `gh` or `git` call that failed in a way the caller should show (D276). `message` is the CLI's
 * own stderr, trimmed — or, when it could not be run at all, why not (`exitCode` is then `null`).
 */
export class GitHubError extends Error {
  /** The arguments the CLI was run with (everything after the binary and any prefix arguments). */
  readonly args: readonly string[];
  /** `null` when the CLI never ran (not installed, the folder is gone) or was killed. */
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(
    message: string,
    details: { args?: readonly string[]; exitCode?: number | null; stderr?: string } = {},
  ) {
    super(message);
    this.name = 'GitHubError';
    this.args = details.args ?? [];
    this.exitCode = details.exitCode ?? null;
    this.stderr = details.stderr ?? '';
  }
}

export interface GitHubPortOptions {
  /** The GitHub CLI; `gh` on the PATH by default. */
  command?: string;
  /**
   * Arguments placed before every `gh` argument — how a test runs a fake `gh` written in JS:
   * `{ command: process.execPath, prefixArgs: [fakeGhScript] }`.
   */
  prefixArgs?: string[];
  /** The Git binary `push` runs; `git` on the PATH by default. */
  gitBinary?: string;
  /** Laid over the engine's environment for every call; a key set to `undefined` removes it. */
  env?: NodeJS.ProcessEnv;
  /** How long one call may take before its process tree is killed and it fails. Default 5 minutes. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 300_000;

export const GH_INSTALL_DETAIL =
  'Install the GitHub CLI: https://cli.github.com, then run gh auth login';
export const GH_LOGIN_DETAIL = 'Run gh auth login in a terminal';

/**
 * Set on every call, over whatever the engine's environment says: nothing may wait on a prompt
 * nobody can see (D276). `GCM_INTERACTIVE=never` keeps Git Credential Manager — Git for Windows'
 * default helper — from opening a sign-in window behind a `git push` while the call waits.
 */
const NON_INTERACTIVE: readonly (readonly [string, string])[] = [
  ['GH_PROMPT_DISABLED', '1'],
  ['GH_NO_UPDATE_NOTIFIER', '1'],
  ['NO_COLOR', '1'],
  ['GIT_TERMINAL_PROMPT', '0'],
  ['GCM_INTERACTIVE', 'never'],
];

/** `owner/name`: GitHub's own character sets for an account and a repository name. */
const REPO_SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const REPO_URL =
  /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;

/** What `gh pr view --json number,url,state,baseRefName,headRefName,mergeCommit` prints. */
const PullRequestJsonSchema = z.object({
  number: z.number().int().min(1),
  url: z.string().min(1),
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  baseRefName: z.string().min(1),
  headRefName: z.string().min(1),
  mergeCommit: z
    .object({ oid: z.string().min(1) })
    .nullable()
    .optional(),
});

const PR_FIELDS = 'number,url,state,baseRefName,headRefName,mergeCommit';

interface CliRun {
  args: readonly string[];
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * The GitHub port (D276) over the `gh` CLI the user signed in with, and `git` for the push. ACE
 * never reads the CLI's token: it asks `gh` to do the work, as the user would in a terminal.
 *
 * Every call is `spawn(binary, [...args])` — an argument array, never a shell — with
 * `GH_PROMPT_DISABLED=1`, `GIT_TERMINAL_PROMPT=0` and the other switches in `NON_INTERACTIVE`, none
 * of the `GIT_DIR`-style variables that would point Git at another repository, and a timeout that
 * kills the whole process tree.
 */
export function createGitHubPort(options: GitHubPortOptions = {}): GitHubPort {
  const gh = options.command ?? 'gh';
  const prefix = options.prefixArgs ?? [];
  const git = options.gitBinary ?? 'git';
  const env = cliEnvironment(options.env);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const runGh = (cwd: string | undefined, args: readonly string[], stdin?: string) =>
    exec({ binary: gh, prefix, args, cwd, env, timeoutMs, label: 'gh', stdin });

  /** As `runGh`, but a non-zero exit is a `GitHubError`. */
  const checkGh = async (cwd: string | undefined, args: readonly string[], stdin?: string) => {
    const result = await runGh(cwd, args, stdin);
    if (result.code !== 0) throw failure('gh', result);
    return result;
  };

  const viewPullRequest = async ({
    cwd,
    number,
  }: {
    cwd: string;
    number: number;
  }): Promise<PullRequestInfo> => {
    assertPullRequestNumber(number);
    const result = await checkGh(cwd, ['pr', 'view', String(number), '--json', PR_FIELDS]);
    return toPullRequestInfo(result);
  };

  return {
    async status(): Promise<GitHubStatus> {
      let version: CliRun;
      try {
        version = await runGh(undefined, ['--version']);
      } catch {
        return { installed: false, loggedIn: false, detail: GH_INSTALL_DETAIL };
      }
      if (version.code !== 0) {
        return { installed: false, loggedIn: false, detail: GH_INSTALL_DETAIL };
      }

      let auth: CliRun;
      try {
        auth = await runGh(undefined, ['auth', 'status', '--hostname', 'github.com']);
      } catch {
        return { installed: true, loggedIn: false, detail: GH_LOGIN_DETAIL };
      }
      if (auth.code !== 0) return { installed: true, loggedIn: false, detail: GH_LOGIN_DETAIL };
      // Older `gh` prints the report on stderr, newer on stdout.
      const user = signedInAccount(`${auth.stdout}\n${auth.stderr}`);
      return { installed: true, loggedIn: true, ...(user === undefined ? {} : { user }) };
    },

    async push({ cwd, branch, remote }) {
      const target = remote ?? 'origin';
      assertArgument('remote', target);
      assertArgument('branch', branch);
      const result = await exec({
        binary: git,
        prefix: [],
        args: ['push', '-u', target, branch],
        cwd,
        env,
        timeoutMs,
        label: 'git',
      });
      if (result.code !== 0) throw failure('git', result);
    },

    async createPullRequest({ cwd, base, head, title, body, draft }) {
      assertArgument('base branch', base);
      assertArgument('head branch', head);
      // The body goes on stdin: a pull request body may be far longer than the 32 767 characters
      // a Windows command line holds.
      const created = await checkGh(
        cwd,
        [
          'pr',
          'create',
          '--base',
          base,
          '--head',
          head,
          '--title',
          title,
          '--body-file',
          '-',
          ...(draft ? ['--draft'] : []),
        ],
        body,
      );
      const number = pullRequestNumberIn(created.stdout);
      if (number === undefined) {
        throw new GitHubError(
          created.stdout.trim() === ''
            ? 'gh pr create did not print the pull request it opened.'
            : `gh pr create did not print a pull request URL: ${created.stdout.trim()}`,
          { args: created.args, exitCode: created.code, stderr: created.stderr },
        );
      }
      return viewPullRequest({ cwd, number });
    },

    viewPullRequest,

    async mergePullRequest({ cwd, number, method }) {
      assertPullRequestNumber(number);
      // Never `--admin` (it would bypass the branch's protection) and never `--delete-branch`
      // (the task branch is the user's to remove).
      await checkGh(cwd, ['pr', 'merge', String(number), mergeFlag(method)]);
    },

    async clone({ repo, folder }) {
      const slug = repositorySlug(repo);
      if (slug === undefined) {
        throw new GitHubError(
          `"${repo}" is not a GitHub repository: give it as owner/name or https://github.com/owner/name.`,
        );
      }
      // Absolute, so the folder can never be read as an option, wherever the engine runs from.
      await checkGh(undefined, ['repo', 'clone', slug, resolvePath(folder)]);
    },
  };
}

/** The engine's environment, minus anything that redirects Git, plus `NON_INTERACTIVE`. */
function cliEnvironment(overrides: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const env = mergeEnv(process.env, overrides);
  for (const name of REPOSITORY_VARIABLES) unsetEnv(env, name);
  for (const [name, value] of NON_INTERACTIVE) {
    unsetEnv(env, name);
    env[name] = value;
  }
  return env;
}

interface ExecInput {
  binary: string;
  prefix: readonly string[];
  args: readonly string[];
  cwd: string | undefined;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** What the error messages call the CLI: `gh` or `git`. */
  label: string;
  /** Written to the child's stdin, which is then closed; stdin is ignored without it. */
  stdin?: string;
}

/** Runs one CLI call to its end. Rejects only when it could not run or was killed. */
function exec(input: ExecInput): Promise<CliRun> {
  const { args, cwd, label } = input;
  return new Promise<CliRun>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      void describeSpawnFailure(label, error, cwd).then((message) =>
        reject(new GitHubError(message, { args, exitCode: null })),
      );
    };

    let child: ChildProcess;
    try {
      child = spawn(input.binary, [...input.prefix, ...args], {
        cwd,
        env: input.env,
        shell: false,
        windowsHide: true,
        stdio: [input.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        // On POSIX a leader of its own group, so the timeout's kill reaches what it started (the
        // `git` a `gh` call runs, a credential helper).
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      fail(error);
      return;
    }

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    if (input.stdin !== undefined && child.stdin !== null) {
      // A child that exits without reading all of it closes the pipe; that is its answer, not ours.
      child.stdin.on('error', () => undefined);
      child.stdin.end(input.stdin, 'utf8');
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (child.pid !== undefined) killProcessTree(child.pid);
      reject(
        new GitHubError(
          `${label} ${describeArgs(args)} did not finish within ${Math.round(input.timeoutMs / 1000)} s and was stopped.`,
          { args, exitCode: null, stderr: Buffer.concat(err).toString('utf8') },
        ),
      );
    }, input.timeoutMs);
    timer.unref();

    child.on('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({
        args,
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

async function describeSpawnFailure(
  label: string,
  error: unknown,
  cwd: string | undefined,
): Promise<string> {
  // Node reports a missing working folder as the binary being missing (`spawn gh ENOENT`).
  if (cwd !== undefined && !(await isDirectory(cwd))) return `The folder ${cwd} does not exist.`;
  const reason = error instanceof Error ? error.message : String(error);
  return label === 'gh'
    ? `The GitHub CLI could not be run (${reason}). ${GH_INSTALL_DETAIL}.`
    : `Git could not be run (${reason}). Is it installed and on the PATH?`;
}

function failure(label: string, result: CliRun): GitHubError {
  return new GitHubError(
    result.stderr.trim() ||
      result.stdout.trim() ||
      `${label} ${describeArgs(result.args)} exited with code ${String(result.code)}.`,
    { args: result.args, exitCode: result.code, stderr: result.stderr },
  );
}

/** The subcommand, for a message: `pr create`, not the title and body that followed it. */
function describeArgs(args: readonly string[]): string {
  return args.slice(0, 2).join(' ');
}

/**
 * The account `gh auth status` reports signed in: the active one when it lists several, which
 * newer `gh` marks with `Active account: true` below its line.
 */
export function signedInAccount(report: string): string | undefined {
  const pattern = /Logged in to \S+ (?:account|as) ([A-Za-z0-9][A-Za-z0-9-]*)/g;
  const accounts = [...report.matchAll(pattern)].map((match) => ({
    user: match[1] ?? '',
    at: match.index,
  }));
  if (accounts.length <= 1) return accounts[0]?.user;
  const active = accounts.find((account, index) => {
    const end = accounts[index + 1]?.at ?? report.length;
    return /Active account: true/.test(report.slice(account.at, end));
  });
  return (active ?? accounts[0])?.user;
}

/** The number of the pull request whose URL `gh pr create` printed — its last one. */
function pullRequestNumberIn(stdout: string): number | undefined {
  const numbers = [...stdout.matchAll(/https?:\/\/\S+\/pull\/(\d+)/g)].map((match) =>
    Number(match[1]),
  );
  const number = numbers.at(-1);
  return number !== undefined && Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

/**
 * `owner/name` of the repository a pull request URL is on — what `TaskWorkspace.pullRequest.repo`
 * keeps, which `PullRequestInfo` does not carry. `undefined` for anything else.
 */
export function pullRequestRepository(url: string): string | undefined {
  const match = /^https?:\/\/[^/\s]+\/([^/\s]+\/[^/\s]+)\/pull\/\d+(?:[/?#].*)?$/.exec(url);
  return match?.[1];
}

function toPullRequestInfo(result: CliRun): PullRequestInfo {
  let parsed: z.infer<typeof PullRequestJsonSchema>;
  try {
    parsed = PullRequestJsonSchema.parse(JSON.parse(result.stdout));
  } catch {
    throw new GitHubError(
      `gh pr view answered something ACE could not read: ${result.stdout.trim().slice(0, 400)}`,
      { args: result.args, exitCode: result.code, stderr: result.stderr },
    );
  }
  const info: PullRequestInfo = {
    number: parsed.number,
    url: parsed.url,
    state: parsed.state === 'OPEN' ? 'open' : parsed.state === 'MERGED' ? 'merged' : 'closed',
    base: parsed.baseRefName,
    head: parsed.headRefName,
  };
  const sha = parsed.mergeCommit?.oid;
  if (sha !== undefined) info.mergeCommitSha = sha;
  return info;
}

function mergeFlag(method: 'merge' | 'squash' | 'rebase'): string {
  switch (method) {
    case 'merge':
      return '--merge';
    case 'squash':
      return '--squash';
    case 'rebase':
      return '--rebase';
  }
}

/** `owner/name` from a slug or a github.com URL, or `undefined` for anything else. */
export function repositorySlug(repo: string): string | undefined {
  if (REPO_SLUG.test(repo)) return validName(repo);
  const match = REPO_URL.exec(repo);
  return match?.[1] === undefined ? undefined : validName(match[1]);
}

/** `.` and `..` are not repository names, whatever the character set allows. */
function validName(slug: string): string | undefined {
  const name = slug.split('/')[1];
  return name === '.' || name === '..' ? undefined : slug;
}

function assertPullRequestNumber(number: number): void {
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new GitHubError(`Invalid pull request number: ${String(number)}.`);
  }
}

/**
 * A branch or remote given to the CLI as an argument. One that starts with `-` would be read as an
 * option, so it is refused rather than passed on.
 */
function assertArgument(kind: string, value: string): void {
  if (value.trim() === '' || value.startsWith('-')) {
    throw new GitHubError(`Invalid ${kind}: "${value}".`);
  }
}
