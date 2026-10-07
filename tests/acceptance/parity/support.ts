import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What the ACE parity e2e tests share: the suite's engine handle, REST calls to it, `git` in a test
 * repository, and a record of what a test added to the shared engine so it can be removed after —
 * later rows (round 2's demo counts the mock models) must see none of it.
 */

export interface EngineHandle {
  url: string;
  token: string;
}

export function engine(): EngineHandle {
  const handleFile = fileURLToPath(new URL('../.playwright-engine.json', import.meta.url));
  return JSON.parse(readFileSync(handleFile, 'utf8')) as EngineHandle;
}

export async function api<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const { url, token } = engine();
  const response = await fetch(`${url}/api/v1${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${response.status} ${text}`);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

/** A repository with one commit on `main`: a README. Answers its path and that commit. */
export function makeRepository(root: string, name: string): { repo: string; baseSha: string } {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# Demo shop\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  return { repo, baseSha: git(repo, 'rev-parse', 'HEAD') };
}

/** What a test added to the shared engine. */
export interface Created {
  projectIds: string[];
  providerId?: string;
}

/** The mock provider, added (and recorded for removal) only when the engine has none. */
export async function mockProvider(created: Created): Promise<string> {
  const providers = await api<{ items: { id: string; type: string }[] }>('/providers');
  const existing = providers.items.find((provider) => provider.type === 'mock');
  if (existing !== undefined) return existing.id;
  const added = await api<{ id: string }>('/providers', {
    method: 'POST',
    body: { type: 'mock', name: 'Mock' },
  });
  created.providerId = added.id;
  return added.id;
}

/** A project on `folderPath` with the mock models listed and the _Single builder_ team. */
export async function projectWithTeam(
  created: Created,
  folderPath: string,
): Promise<{ projectId: string; teamId: string }> {
  const project = await api<{ id: string }>('/projects', {
    method: 'POST',
    body: { name: `Shop ${Date.now()}`, folderPath },
  });
  created.projectIds.push(project.id);
  await api(`/providers/${await mockProvider(created)}/refresh-models`, { method: 'POST' });
  const team = await api<{ workflow: { id: string } }>('/templates/single-builder/instantiate', {
    method: 'POST',
    body: { projectId: project.id },
  });
  return { projectId: project.id, teamId: team.workflow.id };
}

/**
 * Removes what the test added. A project's workflows go first and explicitly: deleting a project
 * leaves its workflows (and their nodes, which name the provider) in place. Task worktrees go with
 * the project.
 */
export async function removeCreated(created: Created): Promise<void> {
  for (const projectId of created.projectIds) {
    const workflows = await api<{ items: { id: string }[] }>(`/projects/${projectId}/workflows`);
    for (const workflow of workflows.items) {
      await api(`/workflows/${workflow.id}`, { method: 'DELETE' });
    }
    await api(`/projects/${projectId}`, { method: 'DELETE' });
  }
  if (created.providerId !== undefined) {
    await api(`/providers/${created.providerId}`, { method: 'DELETE' });
  }
}
