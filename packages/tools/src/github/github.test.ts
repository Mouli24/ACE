import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { GitHubPort } from '@ace/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createGitHubPort,
  GH_INSTALL_DETAIL,
  GH_LOGIN_DETAIL,
  GitHubError,
  pullRequestRepository,
  repositorySlug,
  signedInAccount,
} from './github.js';

/*
 * D276: GitHub delivery goes through the signed-in `gh` CLI. Every `gh` call here is answered by a
 * fake `gh` written in JS — run as `node fake-gh.cjs …` through the port's `prefixArgs` — that
 * records its argv, folder, stdin and environment and prints a canned answer per subcommand, so
 * nothing reaches the network or the machine's own `gh`. The push runs real Git against a local
 * bare repository standing in for `origin`.
 */

const FAKE_GH = `
const fs = require('fs');
const config = JSON.parse(fs.readFileSync(process.env.FAKE_GH_CONFIG, 'utf8'));
const argv = process.argv.slice(2);
const key = argv[0] === '--version' ? '--version' : argv.slice(0, 2).join(' ');
const answer = config[key] || { code: 99, stderr: 'fake gh: nothing canned for ' + key };
const names = ['GH_PROMPT_DISABLED', 'GH_NO_UPDATE_NOTIFIER', 'NO_COLOR', 'GIT_TERMINAL_PROMPT',
  'GCM_INTERACTIVE', 'GIT_DIR', 'ACE_GH_EXTRA'];
function respond(stdin) {
  const env = {};
  for (const name of names) if (process.env[name] !== undefined) env[name] = process.env[name];
  fs.appendFileSync(process.env.FAKE_GH_LOG,
    JSON.stringify({ argv, cwd: process.cwd(), stdin, env, pid: process.pid }) + '\\n');
  if (answer.hang) { setInterval(() => {}, 1000); return; }
  if (answer.stdout) process.stdout.write(answer.stdout);
  if (answer.stderr) process.stderr.write(answer.stderr);
  process.exitCode = answer.code || 0;
}
if (argv.includes('--body-file')) {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { stdin += chunk; });
  process.stdin.on('end', () => respond(stdin));
} else {
  respond(null);
}
`;

interface Answer {
  stdout?: string;
  stderr?: string;
  code?: number;
  hang?: boolean;
}

interface Call {
  argv: string[];
  cwd: string;
  stdin: string | null;
  env: Record<string, string>;
  pid: number;
}

const PR_URL = 'https://github.com/octo/demo/pull/12';
const MERGE_SHA = 'c'.repeat(40);

function prJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 12,
    url: PR_URL,
    state: 'OPEN',
    baseRefName: 'main',
    headRefName: 'ace/task-1',
    mergeCommit: null,
    ...overrides,
  });
}

let root: string;
let script: string;
let configPath: string;
let logPath: string;
let repo: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ace-gh-'));
  script = join(root, 'fake-gh.cjs');
  writeFileSync(script, FAKE_GH);
  configPath = join(root, 'answers.json');
  logPath = join(root, 'calls.jsonl');
  repo = join(root, 'repo');
  mkdirSync(repo);
  answer({});
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 100, retryDelay: 50 });
});

/** What the fake `gh` prints for each subcommand (`--version`, `auth status`, `pr create`, …). */
function answer(answers: Record<string, Answer>): void {
  writeFileSync(configPath, JSON.stringify(answers));
}

function calls(): Call[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Call);
}

function port(extra: { timeoutMs?: number; command?: string; env?: NodeJS.ProcessEnv } = {}) {
  return createGitHubPort({
    command: extra.command ?? process.execPath,
    prefixArgs: extra.command === undefined ? [script] : [],
    env: { FAKE_GH_CONFIG: configPath, FAKE_GH_LOG: logPath, ...extra.env },
    ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }),
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((done) => setTimeout(done, 50));
  }
  return !isAlive(pid);
}

describe('D276 GitHubError', () => {
  it('carries the arguments, exit code and stderr', () => {
    const error = new GitHubError('no', { args: ['pr', 'view'], exitCode: 1, stderr: 'x' });
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: 'GitHubError',
      message: 'no',
      args: ['pr', 'view'],
      exitCode: 1,
      stderr: 'x',
    });
    expect(new GitHubError('bare')).toMatchObject({ args: [], exitCode: null, stderr: '' });
  });
});

describe('D276 status: installed, then signed in', () => {
  it('reports a CLI that cannot be run as not installed, with the install hint', async () => {
    const status = await port({ command: join(root, 'no-such-gh') }).status();
    expect(status).toEqual({ installed: false, loggedIn: false, detail: GH_INSTALL_DETAIL });
    expect(GH_INSTALL_DETAIL).toBe(
      'Install the GitHub CLI: https://cli.github.com, then run gh auth login',
    );
  });

  it('reports a CLI whose --version fails, or never answers, as not installed', async () => {
    answer({ '--version': { code: 1, stderr: 'broken' } });
    expect(await port().status()).toEqual({
      installed: false,
      loggedIn: false,
      detail: GH_INSTALL_DETAIL,
    });

    answer({ '--version': { hang: true } });
    expect(await port({ timeoutMs: 1_000 }).status()).toMatchObject({ installed: false });
  });

  it('reads the signed-in account from the report newer gh prints on stdout', async () => {
    answer({
      '--version': { stdout: 'gh version 2.98.0 (2026-08-20)\n' },
      'auth status': {
        stdout: [
          'github.com',
          '  ✓ Logged in to github.com account octocat (keyring)',
          '  - Active account: true',
          '  - Git operations protocol: https',
          '  - Token: gho_************************************',
          '',
        ].join('\n'),
      },
    });

    expect(await port().status()).toEqual({ installed: true, loggedIn: true, user: 'octocat' });
    const [version, auth] = calls();
    expect(version?.argv).toEqual(['--version']);
    expect(auth?.argv).toEqual(['auth', 'status', '--hostname', 'github.com']);
  });

  it('reads the account from the report older gh prints on stderr', async () => {
    answer({
      '--version': { stdout: 'gh version 2.20.0\n' },
      'auth status': {
        stderr: 'github.com\n  ✓ Logged in to github.com as hubot (oauth_token)\n',
      },
    });
    expect(await port().status()).toEqual({ installed: true, loggedIn: true, user: 'hubot' });
  });

  it('is signed in without a user when the report names none', async () => {
    answer({ '--version': {}, 'auth status': { stdout: 'all good\n' } });
    expect(await port().status()).toEqual({ installed: true, loggedIn: true });
  });

  it('asks for gh auth login when gh is not signed in, or does not answer', async () => {
    answer({
      '--version': {},
      'auth status': { code: 1, stderr: 'You are not logged into any GitHub hosts.' },
    });
    expect(await port().status()).toEqual({
      installed: true,
      loggedIn: false,
      detail: GH_LOGIN_DETAIL,
    });
    expect(GH_LOGIN_DETAIL).toBe('Run gh auth login in a terminal');

    answer({ '--version': {}, 'auth status': { hang: true } });
    expect(await port({ timeoutMs: 1_000 }).status()).toEqual({
      installed: true,
      loggedIn: false,
      detail: GH_LOGIN_DETAIL,
    });
  });

  it('runs gh with prompts, update notices and colour off, and no Git redirection', async () => {
    answer({ '--version': {}, 'auth status': {} });
    await port({ env: { GIT_DIR: join(root, 'elsewhere'), ACE_GH_EXTRA: 'kept' } }).status();
    for (const call of calls()) {
      expect(call.env).toEqual({
        GH_PROMPT_DISABLED: '1',
        GH_NO_UPDATE_NOTIFIER: '1',
        NO_COLOR: '1',
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
        ACE_GH_EXTRA: 'kept',
      });
    }
  });
});

describe('signedInAccount', () => {
  it('picks the active account when gh lists several', () => {
    const report = [
      'github.com',
      '  ✓ Logged in to github.com account first (keyring)',
      '  - Active account: false',
      '  ✓ Logged in to github.com account second (keyring)',
      '  - Active account: true',
    ].join('\n');
    expect(signedInAccount(report)).toBe('second');
  });

  it('falls back to the first account when none is marked active', () => {
    const report = 'Logged in to github.com account one\nLogged in to github.com account two\n';
    expect(signedInAccount(report)).toBe('one');
    expect(signedInAccount('nothing here')).toBeUndefined();
  });
});

describe('D276 open a pull request', () => {
  it('creates it with the body on stdin, then reads it back', async () => {
    answer({
      'pr create': { stdout: `Creating pull request for ace/task-1 into main\n\n${PR_URL}\n` },
      'pr view': { stdout: prJson() },
    });
    const body = 'Adds GET /health.\n\n"Quotes", $dollars and `backticks` stay as written.';

    const info = await port().createPullRequest({
      cwd: repo,
      base: 'main',
      head: 'ace/task-1',
      title: 'Add a health check',
      body,
      draft: false,
    });

    expect(info).toEqual({
      number: 12,
      url: PR_URL,
      state: 'open',
      base: 'main',
      head: 'ace/task-1',
    });
    const [create, view] = calls();
    expect(create?.argv).toEqual([
      'pr',
      'create',
      '--base',
      'main',
      '--head',
      'ace/task-1',
      '--title',
      'Add a health check',
      '--body-file',
      '-',
    ]);
    expect(create?.stdin).toBe(body);
    expect(resolve(create?.cwd ?? '')).toBe(resolve(repo));
    expect(view?.argv).toEqual([
      'pr',
      'view',
      '12',
      '--json',
      'number,url,state,baseRefName,headRefName,mergeCommit',
    ]);
    expect(resolve(view?.cwd ?? '')).toBe(resolve(repo));
  });

  it('opens a draft when asked, and passes a title that looks like a flag as the title', async () => {
    answer({ 'pr create': { stdout: `${PR_URL}\n` }, 'pr view': { stdout: prJson() } });
    await port().createPullRequest({
      cwd: repo,
      base: 'main',
      head: 'ace/task-1',
      title: '--admin',
      body: '',
      draft: true,
    });
    expect(calls()[0]?.argv).toEqual([
      'pr',
      'create',
      '--base',
      'main',
      '--head',
      'ace/task-1',
      '--title',
      '--admin',
      '--body-file',
      '-',
      '--draft',
    ]);
  });

  it("fails with gh's own message when it refuses", async () => {
    answer({
      'pr create': {
        code: 1,
        stderr: '\n  a pull request for branch "ace/task-1" into branch "main" already exists\n',
      },
    });
    const pending = port().createPullRequest({
      cwd: repo,
      base: 'main',
      head: 'ace/task-1',
      title: 't',
      body: 'b',
      draft: false,
    });
    await expect(pending).rejects.toBeInstanceOf(GitHubError);
    await expect(pending).rejects.toMatchObject({
      message: 'a pull request for branch "ace/task-1" into branch "main" already exists',
      exitCode: 1,
    });
    expect(calls()).toHaveLength(1);
  });

  it('fails when gh prints no pull request URL', async () => {
    answer({ 'pr create': { stdout: 'Done?\n' } });
    const input = { cwd: repo, base: 'main', head: 'h', title: 't', body: 'b', draft: false };
    await expect(port().createPullRequest(input)).rejects.toThrow(
      /did not print a pull request URL: Done\?/,
    );
    answer({ 'pr create': {} });
    await expect(port().createPullRequest(input)).rejects.toThrow(
      /did not print the pull request it opened/,
    );
  });

  it('refuses a base or head that would be read as an option, and runs nothing', async () => {
    const input = { cwd: repo, title: 't', body: 'b', draft: false };
    await expect(
      port().createPullRequest({ ...input, base: '--admin', head: 'h' }),
    ).rejects.toThrow(/Invalid base branch/);
    await expect(port().createPullRequest({ ...input, base: 'main', head: ' ' })).rejects.toThrow(
      /Invalid head branch/,
    );
    expect(calls()).toEqual([]);
  });
});

describe('D276 read a pull request back', () => {
  it('maps GitHub state and the merge commit', async () => {
    answer({
      'pr view': { stdout: prJson({ state: 'MERGED', mergeCommit: { oid: MERGE_SHA } }) },
    });
    expect(await port().viewPullRequest({ cwd: repo, number: 12 })).toEqual({
      number: 12,
      url: PR_URL,
      state: 'merged',
      base: 'main',
      head: 'ace/task-1',
      mergeCommitSha: MERGE_SHA,
    });

    answer({ 'pr view': { stdout: prJson({ state: 'CLOSED', mergeCommit: undefined }) } });
    const closed = await port().viewPullRequest({ cwd: repo, number: 12 });
    expect(closed.state).toBe('closed');
    expect(closed).not.toHaveProperty('mergeCommitSha');
  });

  it('fails on an answer it cannot read', async () => {
    answer({ 'pr view': { stdout: 'not json' } });
    await expect(port().viewPullRequest({ cwd: repo, number: 12 })).rejects.toThrow(
      /could not read: not json/,
    );
    answer({ 'pr view': { stdout: prJson({ state: 'DRAFT' }) } });
    await expect(port().viewPullRequest({ cwd: repo, number: 12 })).rejects.toBeInstanceOf(
      GitHubError,
    );
  });

  it('refuses a number that is not a pull request number', async () => {
    for (const number of [0, -1, 1.5, Number.NaN]) {
      await expect(port().viewPullRequest({ cwd: repo, number })).rejects.toThrow(
        /Invalid pull request number/,
      );
    }
    expect(calls()).toEqual([]);
  });

  it('names the repository a pull request URL is on', () => {
    expect(pullRequestRepository(PR_URL)).toBe('octo/demo');
    expect(pullRequestRepository(`${PR_URL}/files`)).toBe('octo/demo');
    expect(pullRequestRepository('https://github.com/octo/demo')).toBeUndefined();
  });
});

describe('D276 merge a pull request', () => {
  it('runs gh pr merge with the method flag — never --admin, never --delete-branch', async () => {
    answer({ 'pr merge': { stdout: '✓ Merged pull request #12\n' } });
    for (const method of ['merge', 'squash', 'rebase'] as const) {
      await port().mergePullRequest({ cwd: repo, number: 12, method });
    }
    expect(calls().map((call) => call.argv)).toEqual([
      ['pr', 'merge', '12', '--merge'],
      ['pr', 'merge', '12', '--squash'],
      ['pr', 'merge', '12', '--rebase'],
    ]);
  });

  it('fails with what gh said, or with the exit code when it said nothing', async () => {
    answer({ 'pr merge': { code: 1, stderr: 'Pull request is not mergeable\n' } });
    await expect(
      port().mergePullRequest({ cwd: repo, number: 12, method: 'merge' }),
    ).rejects.toMatchObject({ message: 'Pull request is not mergeable', exitCode: 1 });

    answer({ 'pr merge': { code: 1, stdout: 'only on stdout\n' } });
    await expect(
      port().mergePullRequest({ cwd: repo, number: 12, method: 'merge' }),
    ).rejects.toThrow('only on stdout');

    answer({ 'pr merge': { code: 3 } });
    await expect(
      port().mergePullRequest({ cwd: repo, number: 12, method: 'merge' }),
    ).rejects.toThrow('gh pr merge exited with code 3.');
  });
});

describe('D276 clone from GitHub', () => {
  it('clones owner/name or a github.com URL into the folder, as an absolute path', async () => {
    answer({ 'repo clone': {} });
    const g = port();
    await g.clone({ repo: 'octo/demo', folder: join(root, 'a') });
    await g.clone({ repo: 'https://github.com/octo/demo.js.git', folder: join(root, 'b') });
    await g.clone({ repo: 'https://github.com/octo/demo/', folder: join(root, 'c') });
    expect(calls().map((call) => call.argv)).toEqual([
      ['repo', 'clone', 'octo/demo', resolve(root, 'a')],
      ['repo', 'clone', 'octo/demo.js', resolve(root, 'b')],
      ['repo', 'clone', 'octo/demo', resolve(root, 'c')],
    ]);
  });

  it('refuses anything that is not a GitHub repository, and runs nothing', async () => {
    for (const repoArg of [
      '--upload-pack=touch /tmp/x',
      '-o/name',
      'git@github.com:octo/demo.git',
      'https://evil.example/octo/demo',
      'http://github.com/octo/demo',
      'https://github.com/octo/demo/tree/main',
      'file:///etc/passwd',
      'octo/demo/extra',
      'octo/..',
      'octo',
      '',
    ]) {
      await expect(
        port().clone({ repo: repoArg, folder: join(root, 'x') }),
        repoArg,
      ).rejects.toThrow(/is not a GitHub repository/);
    }
    expect(calls()).toEqual([]);
  });

  it('reads owner/name out of each accepted form', () => {
    expect(repositorySlug('octo/demo')).toBe('octo/demo');
    expect(repositorySlug('https://github.com/octo/demo.git')).toBe('octo/demo');
    expect(repositorySlug('https://github.com/octo/..')).toBeUndefined();
  });

  it("fails with gh's message when the clone fails", async () => {
    answer({ 'repo clone': { code: 1, stderr: 'GraphQL: Could not resolve to a Repository' } });
    await expect(port().clone({ repo: 'octo/none', folder: join(root, 'n') })).rejects.toThrow(
      'GraphQL: Could not resolve to a Repository',
    );
  });
});

describe('D276 every call is bounded', () => {
  it('kills a call that outlives its timeout, and says so', async () => {
    answer({ 'pr merge': { hang: true } });
    const started = Date.now();
    const pending = port({ timeoutMs: 1_000 }).mergePullRequest({
      cwd: repo,
      number: 12,
      method: 'squash',
    });
    await expect(pending).rejects.toBeInstanceOf(GitHubError);
    await expect(pending).rejects.toMatchObject({
      message: 'gh pr merge did not finish within 1 s and was stopped.',
      exitCode: null,
    });
    expect(Date.now() - started).toBeLessThan(8_000);
    const pid = calls()[0]?.pid ?? 0;
    expect(pid).toBeGreaterThan(0);
    expect(await waitUntilDead(pid, 5_000)).toBe(true);
  });

  it('names a folder that does not exist rather than blaming the CLI', async () => {
    const missing = join(root, 'not-here');
    await expect(port().viewPullRequest({ cwd: missing, number: 1 })).rejects.toMatchObject({
      message: `The folder ${missing} does not exist.`,
      exitCode: null,
    });
  });

  it('says gh could not be run, with the install hint, when it is missing', async () => {
    await expect(
      port({ command: join(root, 'no-such-gh') }).viewPullRequest({ cwd: repo, number: 1 }),
    ).rejects.toThrow(/The GitHub CLI could not be run .*Install the GitHub CLI/);
  });
});

/* -------------------------------------------------------------------------- */
/* push — real Git, a local bare repository as origin                          */
/* -------------------------------------------------------------------------- */

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(gitAvailable)('D276 push the task branch', () => {
  let hermetic: NodeJS.ProcessEnv;
  let github: GitHubPort;

  beforeEach(() => {
    const globalConfig = join(root, 'empty.gitconfig');
    writeFileSync(globalConfig, '');
    hermetic = {
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CEILING_DIRECTORIES: root,
    };
    github = createGitHubPort({ env: hermetic });
  });

  /** Raw Git for setting a scene up, outside the port under test. */
  function sh(cwd: string, ...args: string[]): string {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.toUpperCase().startsWith('GIT_')) delete env[key];
    }
    return execFileSync(
      'git',
      ['-c', 'user.name=Test User', '-c', 'user.email=test@example.com', ...args],
      {
        cwd,
        env: { ...env, ...hermetic, GIT_TERMINAL_PROMPT: '0' },
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();
  }

  /** A work repository on `ace/task-1` with one commit, and a bare `origin` beside it. */
  function scene(): { work: string; origin: string; head: string } {
    const origin = join(root, 'origin.git');
    mkdirSync(origin);
    sh(origin, 'init', '-q', '--bare');
    sh(repo, 'init', '-q');
    sh(repo, 'checkout', '-q', '-b', 'ace/task-1');
    writeFileSync(join(repo, 'health.txt'), 'ok\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'Add a health check');
    sh(repo, 'remote', 'add', 'origin', origin);
    return { work: repo, origin, head: sh(repo, 'rev-parse', 'HEAD') };
  }

  it('pushes the branch to origin and sets it as the upstream', async () => {
    const { work, origin, head } = scene();

    await github.push({ cwd: work, branch: 'ace/task-1' });

    expect(sh(origin, 'rev-parse', 'refs/heads/ace/task-1')).toBe(head);
    expect(sh(work, 'rev-parse', '--abbrev-ref', 'ace/task-1@{upstream}')).toBe(
      'origin/ace/task-1',
    );
  });

  it('pushes to a named remote', async () => {
    const { work, head } = scene();
    const mirror = join(root, 'mirror.git');
    mkdirSync(mirror);
    sh(mirror, 'init', '-q', '--bare');
    sh(work, 'remote', 'add', 'mirror', mirror);

    await github.push({ cwd: work, branch: 'ace/task-1', remote: 'mirror' });

    expect(sh(mirror, 'rev-parse', 'refs/heads/ace/task-1')).toBe(head);
  });

  it("fails with Git's own message for a remote that is not there", async () => {
    const { work } = scene();
    await expect(
      github.push({ cwd: work, branch: 'ace/task-1', remote: 'nowhere' }),
    ).rejects.toMatchObject({
      name: 'GitHubError',
      message: expect.stringContaining("'nowhere' does not appear to be a git repository"),
    });
  });

  it('refuses a branch or remote that would be read as an option', async () => {
    const { work } = scene();
    await expect(github.push({ cwd: work, branch: '--force' })).rejects.toThrow(/Invalid branch/);
    await expect(
      github.push({ cwd: work, branch: 'ace/task-1', remote: '--mirror' }),
    ).rejects.toThrow(/Invalid remote/);
  });

  it('says Git could not be run when the binary is missing', async () => {
    const { work } = scene();
    const broken = createGitHubPort({ gitBinary: join(root, 'no-such-git'), env: hermetic });
    await expect(broken.push({ cwd: work, branch: 'ace/task-1' })).rejects.toThrow(
      /Git could not be run/,
    );
  });
});

describe('D276 --repo pins the repository; D280 issues and failed runs for a scan', () => {
  it('passes --repo owner/name to view and merge when it is named, and refuses a flag-like one', async () => {
    answer({
      'pr view': { stdout: prJson({ state: 'MERGED', mergeCommit: { oid: MERGE_SHA } }) },
      'pr merge': {},
    });
    const gh = port();
    await gh.mergePullRequest({ cwd: repo, number: 12, method: 'squash', repo: 'octo/demo' });
    const info = await gh.viewPullRequest({ cwd: repo, number: 12, repo: 'octo/demo' });
    expect(info.state).toBe('merged');
    expect(calls().map((call) => call.argv.slice(-2))).toEqual([
      ['--repo', 'octo/demo'],
      ['--repo', 'octo/demo'],
    ]);
    await expect(gh.viewPullRequest({ cwd: repo, number: 12, repo: '--admin' })).rejects.toThrow(
      /not a GitHub repository/,
    );
  });

  it('lists open issues and failed workflow runs as the scan reads them', async () => {
    answer({
      'issue list': {
        stdout: JSON.stringify([
          {
            number: 4,
            title: 'Search is slow',
            url: 'https://github.com/octo/demo/issues/4',
            body: 'It takes 3 s.',
            labels: [{ name: 'bug' }],
          },
        ]),
      },
      'run list': {
        stdout: JSON.stringify([
          {
            databaseId: 99,
            workflowName: 'CI',
            url: 'https://github.com/octo/demo/actions/runs/99',
            headBranch: 'main',
            createdAt: '2026-10-07T10:00:00Z',
          },
        ]),
      },
    });
    const gh = port();
    expect(await gh.listOpenIssues?.({ cwd: repo, limit: 500 })).toEqual([
      {
        number: 4,
        title: 'Search is slow',
        url: 'https://github.com/octo/demo/issues/4',
        body: 'It takes 3 s.',
        labels: ['bug'],
      },
    ]);
    expect(await gh.listFailedRuns?.({ cwd: repo, limit: 5 })).toEqual([
      {
        id: 99,
        name: 'CI',
        url: 'https://github.com/octo/demo/actions/runs/99',
        branch: 'main',
        createdAt: '2026-10-07T10:00:00Z',
      },
    ]);
    const [issues, runs] = calls();
    expect(issues?.argv).toContain('100');
    expect(runs?.argv).toEqual(expect.arrayContaining(['--status', 'failure', '--limit', '5']));
  });

  it('fails on a list it cannot read', async () => {
    answer({ 'issue list': { stdout: 'not json' } });
    await expect(port().listOpenIssues?.({ cwd: repo, limit: 5 })).rejects.toThrow(
      /could not read/,
    );
  });
});
