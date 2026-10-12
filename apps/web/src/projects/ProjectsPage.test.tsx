import type { Node, Project, Run, RunState } from '@ace/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { getSocket, startSocket, stopSocket } from '../app/socket';
import { newId } from '../lib/ulid';
import { createFakeWebSocket } from '../mocks/fake-socket';
import { createNode } from '../nodes/factory';
import { db, installMockServer, queryClient, renderApp, server } from '../test/app';
import { queryKeys } from '../workflows/query-keys';

installMockServer();

// The pages a Home card or entry card opens are other screens' business; here only the route counts.
vi.mock('../workflows/WorkflowLayout', () => ({
  WorkflowLayout: () => <div data-testid="workflow-layout" />,
}));
vi.mock('../workflows/WorkflowPage', () => ({ WorkflowPage: () => null }));
vi.mock('../forge/ForgePage', () => ({ ForgePage: () => null }));
vi.mock('./ProjectPage', () => ({ ProjectPage: () => <div data-testid="project-page" /> }));

afterEach(() => stopSocket());

/** The Home surface — scoped, so whatever the shell draws around it never matches. */
async function home(): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelector('[data-surface="home"]')).not.toBeNull());
  return document.querySelector<HTMLElement>('[data-surface="home"]')!;
}

const card = async (name: string) => within(await home()).findByRole('link', { name });

/** A workflow in `project` whose graph holds these nodes, named. */
function seedWorkflow(
  project: Project,
  nodes: Array<{ kind: 'agent' | 'model' | 'input' | 'output'; name: string }>,
  name = 'Flow',
) {
  const workflow = db.createWorkflow(project.id, name);
  const graph: Node[] = nodes.map(({ kind, name: nodeName }, i) => ({
    ...createNode(kind, workflow.id, { x: i * 200, y: 0 }),
    name: nodeName,
  }));
  db.commitGraph(workflow.id, graph, [], { silent: true });
  return workflow;
}

function seedRun(project: Project, workflowId: string, status: RunState): Run {
  return db.addRun({
    id: newId(),
    workflowId,
    projectId: project.id,
    status,
    snapshot: { version: 1, nodes: [], edges: [] },
    inputs: {},
    preflightIssues: [],
    totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    startedAt: new Date().toISOString(),
  });
}

/** Moves a project's own timestamps into the past (the mock stamps "now"). */
function age(project: Project, ms: number) {
  const at = new Date(Date.now() - ms).toISOString();
  project.createdAt = at;
  project.updatedAt = at;
}

const DAY = 86_400_000;

describe('Home hero (D337)', () => {
  it('renders the header, the hero and the two entry cards', async () => {
    renderApp('/projects');
    const surface = await home();
    expect(within(surface).getByText('ACE')).toBeInTheDocument();
    expect(within(surface).getByText('HOME')).toBeInTheDocument();
    expect(within(surface).getByRole('button', { name: 'Switch theme' })).toBeInTheDocument();
    expect(
      within(surface).getByRole('heading', { level: 1, name: 'What would you like to make?' }),
    ).toBeInTheDocument();
    expect(
      within(surface).getByText('Describe it once — Ace assembles the team and gets to work.'),
    ).toBeInTheDocument();
    expect(
      within(surface).getByRole('button', { name: 'Canvas Sketch, plan and arrange visually' }),
    ).toBeInTheDocument();
    expect(
      within(surface).getByRole('button', { name: 'Forge Code editor — build and ship' }),
    ).toBeInTheDocument();
  });

  it('drops the old list controls: no New project button, no per-project menu', async () => {
    const p = db.createProject({ name: 'Kept' });
    renderApp('/projects');
    const surface = await home();
    await card('Kept');
    expect(within(surface).queryByRole('button', { name: /new project/i })).toBeNull();
    expect(within(surface).queryByRole('button', { name: /actions for/i })).toBeNull();
    expect(within(surface).queryByText(p.folderPath)).toBeNull();
  });

  it('"Agents ready" waits for an open socket and a CONNECTED provider', async () => {
    const provider = db.createProvider({ type: 'mock', name: 'Mock' });
    db.setProviderStatus(provider.id, 'CONNECTED');
    // Provider connected, but no engine socket: not ready.
    const first = renderApp('/projects');
    await within(await home()).findByRole('heading', { level: 1 });
    expect(screen.queryByText('Agents ready')).toBeNull();
    first.unmount();

    startSocket({
      token: 'mock',
      queryClient,
      url: 'ws://mock.local/ws',
      WebSocket: createFakeWebSocket(db) as unknown as typeof WebSocket,
    });
    renderApp('/projects');
    expect(await within(await home()).findByText('Agents ready')).toBeInTheDocument();
  });

  it('"Agents ready" stays hidden with the socket open but no CONNECTED provider', async () => {
    db.createProvider({ type: 'mock', name: 'Mock' }); // UNKNOWN until checked
    startSocket({
      token: 'mock',
      queryClient,
      url: 'ws://mock.local/ws',
      WebSocket: createFakeWebSocket(db) as unknown as typeof WebSocket,
    });
    renderApp('/projects');
    const surface = await home();
    await within(surface).findByRole('heading', { level: 1 });
    // Let the socket open and the providers load before asserting the absence.
    await waitFor(() => expect(getSocket()?.status).toBe('open'));
    await waitFor(() => expect(queryClient.getQueryData(queryKeys.providers())).toBeDefined());
    expect(within(surface).queryByText('Agents ready')).toBeNull();
  });
});

describe('Home entry cards (FR-PRJ-001, D337)', () => {
  it('TC-PRJ-001: Canvas → New project → project + first workflow, opened in Ideate', async () => {
    const user = userEvent.setup();
    const { router } = renderApp('/projects');
    await user.click(await within(await home()).findByRole('button', { name: /^canvas/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/name/i), 'Demo');
    await user.click(within(dialog).getByRole('button', { name: /^create$/i }));

    await waitFor(() =>
      expect(router.state.location.pathname).toMatch(/^\/projects\/\w+\/workflows\/\w+$/),
    );
    const [project] = db.listProjects();
    expect(db.listProjects().map((p) => p.name)).toEqual(['Demo']);
    const workflows = db.listWorkflows(project!.id);
    expect(workflows.map((w) => w.name)).toEqual(['Demo']);
    expect(router.state.location.pathname).toBe(
      `/projects/${project!.id}/workflows/${workflows[0]!.id}`,
    );
    // Opening it recorded it as the last project (FR-PRJ-004).
    await waitFor(() => expect(db.settings.lastProjectId).toBe(project!.id));
  });

  it('Forge → the same, opened in Forge', async () => {
    const user = userEvent.setup();
    const { router } = renderApp('/projects');
    await user.click(await within(await home()).findByRole('button', { name: /^forge/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/name/i), 'Shop');
    await user.click(within(dialog).getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(router.state.location.pathname).toMatch(/\/forge$/));
    const [project] = db.listProjects();
    const [workflow] = db.listWorkflows(project!.id);
    expect(workflow?.name).toBe('Shop');
    expect(router.state.location.pathname).toBe(
      `/projects/${project!.id}/workflows/${workflow!.id}/forge`,
    );
  });

  it('opens the project page when the first workflow cannot be created', async () => {
    server.use(
      http.post('*/api/v1/projects/:id/workflows', () =>
        HttpResponse.json(
          { error: { kind: 'internal', code: 'internal', message: 'boom' } },
          { status: 500 },
        ),
      ),
    );
    const user = userEvent.setup();
    const { router } = renderApp('/projects');
    await user.click(await within(await home()).findByRole('button', { name: /^canvas/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/name/i), 'Solo');
    await user.click(within(dialog).getByRole('button', { name: /^create$/i }));

    const [project] = await waitFor(() => {
      const list = db.listProjects();
      expect(list).toHaveLength(1);
      return list;
    });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/projects/${project!.id}`));
    expect(db.listWorkflows(project!.id)).toHaveLength(0);
  });

  it('TC-PRJ-002: an unwritable folder shows the invalid_path error inline, naming the path', async () => {
    const user = userEvent.setup();
    renderApp('/projects');
    await user.click(await within(await home()).findByRole('button', { name: /^canvas/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/name/i), 'Bad');
    await user.type(within(dialog).getByLabelText(/folder/i), '/readonly/bad');
    await user.click(within(dialog).getByRole('button', { name: /^create$/i }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('/readonly/bad');
    expect(db.listProjects()).toHaveLength(0);
  });
});

describe('Home Recent (D337)', () => {
  it('shows one muted line when there are no projects', async () => {
    renderApp('/projects');
    const surface = await home();
    expect(await within(surface).findByText('No projects yet')).toBeInTheDocument();
    expect(within(surface).getByRole('button', { name: 'All 0' })).toBeInTheDocument();
    expect(within(surface).getByRole('button', { name: 'Live 0' })).toBeInTheDocument();
    expect(within(surface).queryAllByRole('link')).toHaveLength(0);
  });

  it('opening a project card records it as the last project (FR-PRJ-004)', async () => {
    const user = userEvent.setup();
    const p = db.createProject({ name: 'Open me' });
    const { router } = renderApp('/projects');
    await user.click(await card('Open me'));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/projects/${p.id}`));
    await waitFor(() => expect(db.settings.lastProjectId).toBe(p.id));
  });

  it('TC-PRJ-004: / reopens the last project when settings.lastProjectId is set', async () => {
    const b = db.createProject({ name: 'Project B' });
    db.patchSettings({ lastProjectId: b.id });
    const { router } = renderApp('/');
    await waitFor(() => expect(router.state.location.pathname).toBe(`/projects/${b.id}`));
  });

  it('/ goes to Home when nothing was opened before', async () => {
    // A fresh user with no projects lands on /onboarding (FR-ONB-001, HomeRedirect.test.tsx).
    db.patchSettings({ onboardingCompleted: true });
    const { router } = renderApp('/');
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects'));
  });

  it('counts All and Live, and Live shows only projects with a running, paused or preflight run', async () => {
    const running = db.createProject({ name: 'Running' });
    seedRun(running, seedWorkflow(running, [{ kind: 'agent', name: 'Nova' }]).id, 'RUNNING');
    const paused = db.createProject({ name: 'Paused' });
    seedRun(paused, seedWorkflow(paused, []).id, 'PAUSED');
    const done = db.createProject({ name: 'Done' });
    seedRun(done, seedWorkflow(done, []).id, 'COMPLETE');
    db.createProject({ name: 'Idle' });

    const user = userEvent.setup();
    renderApp('/projects');
    const surface = await home();
    const all = await within(surface).findByRole('button', { name: 'All 4' });
    const live = await within(surface).findByRole('button', { name: 'Live 2' });
    expect(all).toHaveAttribute('aria-pressed', 'true');
    expect(within(surface).getAllByRole('link')).toHaveLength(4);

    await user.click(live);
    expect(live).toHaveAttribute('aria-pressed', 'true');
    const names = within(surface)
      .getAllByRole('link')
      .map((link) => link.getAttribute('aria-label'));
    // which projects, not their order (Recent sorts by activity; see the ordering test below)
    expect([...names].sort()).toEqual(['Paused', 'Running']);

    await user.click(all);
    expect(within(surface).getAllByRole('link')).toHaveLength(4);
  });

  it('footer: the agent count, Repository only for a git folder, and how long ago', async () => {
    const repo = db.createProject({ name: 'Repo' });
    seedWorkflow(repo, [
      { kind: 'input', name: 'Brief' },
      { kind: 'agent', name: 'Nova' },
      { kind: 'model', name: 'Iris' },
      { kind: 'output', name: 'Out' },
    ]);
    seedWorkflow(repo, [{ kind: 'agent', name: 'Theo' }], 'Second');
    db.setRepoStatus(repo.id, { repo: true, branch: 'main', files: [], truncated: false });

    const quiet = db.createProject({ name: 'Quiet' });
    age(quiet, 3 * DAY);

    const touched = db.createProject({ name: 'Touched' });
    age(touched, 3 * DAY);
    seedWorkflow(touched, [{ kind: 'agent', name: 'Solo' }]); // its workflow changed just now

    renderApp('/projects');
    const repoCard = await card('Repo');
    await within(repoCard).findByText('3 agents');
    expect(within(repoCard).getByText('Repository')).toBeInTheDocument();
    expect(within(repoCard).getByText('Just now')).toBeInTheDocument();

    const quietCard = await card('Quiet');
    await within(quietCard).findByText('0 agents');
    expect(within(quietCard).getByText('3d ago')).toBeInTheDocument();
    expect(within(quietCard).queryByText('Repository')).toBeNull();

    const touchedCard = await card('Touched');
    await within(touchedCard).findByText('1 agent');
    expect(within(touchedCard).getByText('Just now')).toBeInTheDocument();
  });

  it('the orbiting tiles are the project’s real agents, at most four', async () => {
    const crowd = db.createProject({ name: 'Crowd' });
    seedWorkflow(crowd, [
      { kind: 'agent', name: 'alpha' },
      { kind: 'input', name: 'Brief' },
      { kind: 'model', name: 'Beta' },
    ]);
    seedWorkflow(
      crowd,
      [
        { kind: 'agent', name: 'Gamma' },
        { kind: 'agent', name: 'Delta' },
        { kind: 'agent', name: 'Epsilon' },
      ],
      'Second',
    );
    const pair = db.createProject({ name: 'Pair' });
    seedWorkflow(pair, [
      { kind: 'agent', name: 'Writer' },
      { kind: 'model', name: 'Reviewer' },
    ]);
    db.createProject({ name: 'Empty' });

    renderApp('/projects');
    const crowdCard = await card('Crowd');
    await within(crowdCard).findByText('5 agents');
    const tiles = (el: HTMLElement) =>
      within(el)
        .queryAllByTestId('project-agent-tile')
        .map((tile) => tile.textContent);
    expect(tiles(crowdCard)).toEqual(['A', 'B', 'G', 'D']);

    const pairCard = await card('Pair');
    await within(pairCard).findByText('2 agents');
    expect(tiles(pairCard)).toEqual(['W', 'R']);

    const emptyCard = await card('Empty');
    await within(emptyCard).findByText('0 agents');
    expect(tiles(emptyCard)).toEqual([]);
  });

  it('shows no placeholder footer while the summaries load', async () => {
    const p = db.createProject({ name: 'Slow' });
    seedWorkflow(p, [{ kind: 'agent', name: 'Nova' }]);
    server.use(
      http.get('*/api/v1/projects/:id/workflows', () => new Promise<Response>(() => undefined)),
    );
    renderApp('/projects');
    const slow = await card('Slow');
    expect(within(slow).getByText('Slow')).toBeInTheDocument();
    expect(within(slow).queryByText(/agent/)).toBeNull();
    expect(within(slow).queryByText(/ago|Just now/)).toBeNull();
    expect(within(slow).queryAllByTestId('project-agent-tile')).toHaveLength(0);
    expect(within(await home()).getByRole('button', { name: 'Live' })).toBeInTheDocument();
  });

  it('lists projects newest first, by last activity', async () => {
    const old = db.createProject({ name: 'Old' });
    age(old, 3 * DAY);
    const middle = db.createProject({ name: 'Middle' });
    age(middle, DAY);
    const fresh = db.createProject({ name: 'Fresh' });
    // an old project with a workflow touched just now counts as the newest
    const revived = db.createProject({ name: 'Revived' });
    age(revived, 5 * DAY);
    seedWorkflow(revived, []);
    age(fresh, 2 * 3_600_000);
    renderApp('/projects');
    await within(await home()).findAllByText('Just now');
    const names = () =>
      within(document.querySelector<HTMLElement>('[data-surface="home"]')!)
        .getAllByRole('link')
        .map((link) => link.getAttribute('aria-label') ?? link.textContent);
    await waitFor(() =>
      expect(
        names().filter((n) => ['Old', 'Middle', 'Fresh', 'Revived'].includes(n ?? '')),
      ).toEqual(['Revived', 'Fresh', 'Middle', 'Old']),
    );
  });
});
