import type { Node, Project, RunState } from '@ace/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';

import { fileKeys } from '../forge/files/keys';
import { newId } from '../lib/ulid';
import { createNode } from '../nodes/factory';
import { db, installMockServer, queryClient, server } from '../test/app';
import { queryKeys } from '../workflows/query-keys';
import { latestRunKey, useProjectSummaries } from './useProjectSummaries';

installMockServer();

// `test/app` loads the route tree; this file renders no route, so Forge's page stays out of it.
vi.mock('../forge/ForgePage', () => ({ ForgePage: () => null }));

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

function seedWorkflow(project: Project, kinds: Array<'agent' | 'model' | 'input'>, name = 'Flow') {
  const workflow = db.createWorkflow(project.id, name);
  const nodes: Node[] = kinds.map((kind, i) => ({
    ...createNode(kind, workflow.id, { x: i * 200, y: 0 }),
    name: `${kind} ${i}`,
  }));
  db.commitGraph(workflow.id, nodes, [], { silent: true });
  return { workflow, nodes };
}

function seedRun(project: Project, workflowId: string, status: RunState, startedAt: string) {
  db.addRun({
    id: newId(),
    workflowId,
    projectId: project.id,
    status,
    snapshot: { version: 1, nodes: [], edges: [] },
    inputs: {},
    preflightIssues: [],
    totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    startedAt,
  });
}

function summariesOf(projects: Project[]) {
  return renderHook(() => useProjectSummaries(projects), { wrapper });
}

describe('useProjectSummaries (D337)', () => {
  it('gathers agents, repo status, live state and last activity from the shared caches', async () => {
    const project = db.createProject({ name: 'P' });
    const one = seedWorkflow(project, ['input', 'agent', 'model']);
    const two = seedWorkflow(project, ['agent'], 'Second');
    db.setRepoStatus(project.id, { repo: true, branch: 'main', files: [], truncated: false });
    seedRun(project, one.workflow.id, 'RUNNING', '2026-10-01T10:00:00.000Z');

    const { result } = summariesOf([project]);
    await waitFor(() => expect(result.current.get(project.id)?.live).toBeDefined());
    await waitFor(() => expect(result.current.get(project.id)?.agents).toBeDefined());
    const summary = result.current.get(project.id)!;

    // Agent and Model nodes only, workflow by workflow, in graph order.
    expect(summary.agents?.map((a) => a.nodeId)).toEqual([
      one.nodes[1]!.id,
      one.nodes[2]!.id,
      two.nodes[0]!.id,
    ]);
    expect(summary.agents?.map((a) => a.letter)).toEqual(['A', 'M', 'A']);
    expect(summary.repo).toBe(true);
    expect(summary.live).toBe(true);
    const newest = Math.max(
      ...[project.updatedAt, one.workflow.updatedAt, two.workflow.updatedAt].map(Date.parse),
    );
    expect(summary.lastActivity).toBe(newest);

    // The workspace's own keys: Home and the workspace read one cache.
    expect(queryClient.getQueryData(queryKeys.workflows(project.id))).toHaveLength(2);
    expect(queryClient.getQueryData(queryKeys.workflow(one.workflow.id))).toMatchObject({
      workflow: { id: one.workflow.id },
    });
    expect(queryClient.getQueryData(fileKeys.status(project.id))).toMatchObject({ repo: true });
    expect(queryClient.getQueryData(latestRunKey(one.workflow.id))).toMatchObject({
      status: 'RUNNING',
    });
  });

  it('asks for the newest run only (limit 1)', async () => {
    const project = db.createProject({ name: 'P' });
    const { workflow } = seedWorkflow(project, ['agent']);
    const urls: string[] = [];
    const onRequest = ({ request }: { request: Request }) => {
      if (request.url.includes(`/workflows/${workflow.id}/runs`)) urls.push(request.url);
    };
    server.events.on('request:start', onRequest);
    try {
      const { result } = summariesOf([project]);
      await waitFor(() => expect(result.current.get(project.id)?.live).toBe(false));
    } finally {
      server.events.removeListener('request:start', onRequest);
    }
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]!).searchParams.get('limit')).toBe('1');
  });

  it.each<[RunState, boolean]>([
    ['RUNNING', true],
    ['PAUSED', true],
    ['PREFLIGHT', true],
    ['COMPLETE', false],
    ['HALTED', false],
    ['BLOCKED', false],
  ])('a latest run %s is live: %s', async (status, live) => {
    const project = db.createProject({ name: 'P' });
    const { workflow } = seedWorkflow(project, []);
    seedRun(project, workflow.id, status, '2026-10-01T10:00:00.000Z');
    const { result } = summariesOf([project]);
    await waitFor(() => expect(result.current.get(project.id)?.live).toBe(live));
  });

  it('only the newest run counts: an old RUNNING behind a newer COMPLETE is not live', async () => {
    const project = db.createProject({ name: 'P' });
    const { workflow } = seedWorkflow(project, []);
    seedRun(project, workflow.id, 'RUNNING', '2026-10-01T10:00:00.000Z');
    seedRun(project, workflow.id, 'COMPLETE', '2026-10-02T10:00:00.000Z');
    const { result } = summariesOf([project]);
    await waitFor(() => expect(result.current.get(project.id)?.live).toBe(false));
  });

  it('a project with no workflows: no agents, not live, last activity from the project', async () => {
    const project = db.createProject({ name: 'Empty' });
    const { result } = summariesOf([project]);
    await waitFor(() => expect(result.current.get(project.id)?.repo).toBe(false));
    await waitFor(() => expect(result.current.get(project.id)?.agents).toEqual([]));
    const summary = result.current.get(project.id)!;
    expect(summary.live).toBe(false);
    expect(summary.lastActivity).toBe(Date.parse(project.updatedAt));
  });

  it('lastOpenedAt counts when it is the newest', async () => {
    const project = db.createProject({ name: 'Opened' });
    project.updatedAt = '2026-09-01T00:00:00.000Z';
    project.lastOpenedAt = '2026-09-20T00:00:00.000Z';
    const { result } = summariesOf([project]);
    await waitFor(() =>
      expect(result.current.get(project.id)?.lastActivity).toBe(
        Date.parse('2026-09-20T00:00:00.000Z'),
      ),
    );
  });

  it('leaves every field undefined while loading', () => {
    const project = db.createProject({ name: 'P' });
    const { result } = summariesOf([project]);
    expect(result.current.get(project.id)).toEqual({
      agents: undefined,
      repo: undefined,
      live: undefined,
      lastActivity: undefined,
    });
  });

  it('a graph that fails to load keeps the agent count unknown; a failed run list is not live', async () => {
    const project = db.createProject({ name: 'P' });
    seedWorkflow(project, ['agent']);
    const fail = () =>
      HttpResponse.json(
        { error: { kind: 'internal', code: 'internal', message: 'boom' } },
        { status: 500 },
      );
    server.use(
      http.get('*/api/v1/workflows/:id', fail),
      http.get('*/api/v1/workflows/:id/runs', fail),
    );
    const { result } = summariesOf([project]);
    await waitFor(() => expect(result.current.get(project.id)?.live).toBe(false));
    await waitFor(() =>
      expect(
        queryClient.getQueryState(queryKeys.workflow(db.listWorkflows(project.id)[0]!.id))?.status,
      ).toBe('error'),
    );
    expect(result.current.get(project.id)?.agents).toBeUndefined();
    expect(result.current.get(project.id)?.lastActivity).toBeDefined();
  });

  it('no projects, no summaries', () => {
    const { result } = renderHook(() => useProjectSummaries(undefined), { wrapper });
    expect(result.current.size).toBe(0);
  });
});
