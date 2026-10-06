import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { startSocket, stopSocket } from '../app/socket';
import { createFakeWebSocket } from '../mocks/fake-socket';
import {
  closeTask,
  completeMockWork,
  createTask,
  failNextWork,
  setTaskWorkPace,
  updateTask,
  workTask,
} from '../mocks/tasks';
import { db, installMockServer, queryClient, renderApp } from '../test/app';

installMockServer();

beforeEach(() => setTaskWorkPace('manual'));
afterEach(() => stopSocket());

function seedProject() {
  const project = db.createProject({ name: 'Shop' });
  const team = db.createWorkflow(project.id, 'Builders');
  return { project, team };
}

const column = (stage: string) => screen.getByTestId(`column-${stage}`);
const card = (n: number) => screen.getByTestId(`task-card-${n}`);

describe('ACE-P0 the Tasks board (design §8)', () => {
  it('shows five columns with counts, and cards with their state, team, labels and outcome', async () => {
    const { project, team } = seedProject();
    createTask(db, project.id, {
      title: 'Write docs',
      labels: ['docs'],
      priority: 'urgent',
    });
    const running = createTask(db, project.id, { title: 'Fix search', workflowId: team.id });
    workTask(db, running.id);
    const failing = createTask(db, project.id, { title: 'Add filters', workflowId: team.id });
    failNextWork('The model ran out of budget.');
    workTask(db, failing.id);
    completeMockWork(failing.id);
    closeTask(db, createTask(db, project.id, { title: 'Old idea' }).id);

    renderApp(`/projects/${project.id}/tasks`);

    expect(await screen.findByRole('heading', { name: 'Tasks', level: 1 })).toBeInTheDocument();
    await waitFor(() =>
      expect(within(column('inbox')).getByText('Write docs')).toBeInTheDocument(),
    );
    for (const [stage, count] of [
      ['inbox', '1'],
      ['plan', '0'],
      ['work', '2'],
      ['review', '0'],
      ['done', '1'],
    ] as const) {
      expect(screen.getByTestId(`column-count-${stage}`)).toHaveTextContent(count);
    }
    expect(within(column('work')).getAllByRole('link')).toHaveLength(2);

    // an idle card shows no state chip; its priority and labels are on it
    const docs = card(1);
    expect(within(docs).queryByTestId('task-state')).toBeNull();
    expect(within(docs).getByTestId('task-priority')).toHaveTextContent('Urgent');
    expect(within(docs).getByText('docs')).toBeInTheDocument();
    expect(within(docs).getByText('#1')).toBeInTheDocument();
    expect(within(docs).getByText('App')).toBeInTheDocument();

    // running and failed show their chip; the reason is part of the failed chip's name
    expect(within(card(2)).getByTestId('task-state')).toHaveAttribute('data-state', 'running');
    expect(within(card(2)).getByTestId('task-team')).toHaveTextContent('Builders');
    expect(
      within(card(3)).getByRole('img', { name: 'failed: The model ran out of budget.' }),
    ).toBeInTheDocument();
    // Done shows the outcome
    expect(within(card(4)).getByTestId('task-outcome')).toHaveTextContent(
      'Closed without verification',
    );
    expect(card(2)).toHaveAttribute('href', `/projects/${project.id}/tasks/${running.id}`);
  });

  it('filters by search, label and Needs attention, and clears them', async () => {
    const { project, team } = seedProject();
    createTask(db, project.id, { title: 'Write docs', labels: ['docs'] });
    const fix = createTask(db, project.id, {
      title: 'Fix search',
      labels: ['search'],
      workflowId: team.id,
    });
    workTask(db, fix.id);
    completeMockWork(fix.id); // → review, idle: waiting on a person
    const user = userEvent.setup();
    renderApp(`/projects/${project.id}/tasks`);
    await screen.findByTestId('task-card-1');

    await user.type(screen.getByRole('searchbox', { name: 'Search tasks' }), 'fix');
    await waitFor(() => expect(screen.queryByTestId('task-card-1')).toBeNull());
    expect(card(2)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await screen.findByTestId('task-card-1');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Label' }), 'docs');
    await waitFor(() => expect(screen.queryByTestId('task-card-2')).toBeNull());
    expect(card(1)).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Label' }), '');
    await screen.findByTestId('task-card-2');

    const attention = screen.getByRole('button', { name: 'Needs attention' });
    await user.click(attention);
    expect(attention).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(screen.queryByTestId('task-card-1')).toBeNull());
    expect(within(column('review')).getByTestId('task-card-2')).toBeInTheDocument();

    await user.type(screen.getByRole('searchbox', { name: 'Search tasks' }), 'nothing like it');
    expect(await screen.findByTestId('tasks-no-match')).toBeInTheDocument();
  });

  it('an empty project explains tasks and opens New task', async () => {
    const { project } = seedProject();
    const user = userEvent.setup();
    renderApp(`/projects/${project.id}/tasks`);
    const empty = await screen.findByTestId('tasks-empty');
    await user.click(within(empty).getByRole('button', { name: 'Create your first task' }));
    expect(await screen.findByRole('dialog', { name: 'New task' })).toBeInTheDocument();
  });

  it('a paused project says so, and Resume unpauses it', async () => {
    const { project } = seedProject();
    db.updateProject(project.id, { paused: true });
    const user = userEvent.setup();
    renderApp(`/projects/${project.id}/tasks`);
    const banner = await screen.findByTestId('project-paused');
    await user.click(within(banner).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(screen.queryByTestId('project-paused')).toBeNull());
    expect(db.getProject(project.id)?.paused).toBe(false);
  });

  it('shows the engine’s error when the board cannot load', async () => {
    renderApp('/projects/01ARZ3NDEKTSV4RRFFQ69G5FAV/tasks');
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load tasks');
  });

  it('task.updated frames patch the board live, and task.deleted drops the card', async () => {
    const { project, team } = seedProject();
    const task = createTask(db, project.id, { title: 'Fix search', workflowId: team.id });
    startSocket({
      token: 'mock',
      queryClient,
      url: 'ws://mock.local/ws',
      WebSocket: createFakeWebSocket(db) as unknown as typeof WebSocket,
    });
    renderApp(`/projects/${project.id}/tasks`);
    await waitFor(() =>
      expect(within(column('inbox')).getByText('Fix search')).toBeInTheDocument(),
    );

    // the engine moves it on its own: no refetch, the frame carries the card
    const lists = vi.spyOn(queryClient, 'invalidateQueries');
    act(() => {
      workTask(db, task.id);
    });
    await waitFor(() =>
      expect(within(column('work')).getByTestId('task-card-1')).toBeInTheDocument(),
    );
    expect(within(card(1)).getByTestId('task-state')).toHaveAttribute('data-state', 'running');

    act(() => {
      completeMockWork(task.id);
    });
    await waitFor(() =>
      expect(within(column('review')).getByTestId('task-card-1')).toBeInTheDocument(),
    );
    act(() => {
      updateTask(db, task.id, { title: 'Fix accented search' });
    });
    expect(await within(card(1)).findByText('Fix accented search')).toBeInTheDocument();
    // the board list was patched by the frames, never invalidated and refetched
    expect(lists.mock.calls.some(([filters]) => filters?.queryKey?.[0] === 'tasks')).toBe(false);
    lists.mockRestore();

    act(() => {
      db.deleteTask(task.id);
      db.emit({
        type: 'task.deleted',
        scope: 'engine',
        payload: { taskId: task.id, projectId: project.id },
      });
    });
    await waitFor(() => expect(screen.queryByTestId('task-card-1')).toBeNull());
  });
});

describe('ACE-P0 New task (design §8)', () => {
  it('Add to Inbox creates the task with what the form says', async () => {
    const { project, team } = seedProject();
    const user = userEvent.setup();
    renderApp(`/projects/${project.id}/tasks`);
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    const dialog = await screen.findByRole('dialog', { name: 'New task' });

    // a title is required
    await user.click(within(dialog).getByRole('button', { name: 'Add to Inbox' }));
    expect(await within(dialog).findByText('Give the task a title.')).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText('Title'), 'Fix search');
    await user.type(within(dialog).getByLabelText('Brief'), 'Accents are ignored.');
    await user.type(within(dialog).getByLabelText('How you will check it'), 'café finds cafe');
    // only App tasks for now; the others are visible but disabled
    expect(within(dialog).getByRole('radio', { name: 'Email' })).toBeDisabled();
    expect(within(dialog).getByRole('radio', { name: 'Document' })).toBeDisabled();
    expect(within(dialog).getByText(/coming in a later step/)).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText('Team'), 'Builders');
    // the finish lines of an App task; GitHub is not offered yet
    const finish = within(dialog).getByLabelText('Finish line');
    expect(
      within(finish)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Pass review', 'Apply changes locally', 'Merge on GitHub (coming later)']);
    expect(within(finish).getByRole('option', { name: /Merge on GitHub/ })).toBeDisabled();
    await user.selectOptions(finish, 'apply_local');
    await user.click(within(dialog).getByRole('radio', { name: /^Manual/ }));
    expect(within(dialog).getByText(/needs Full access|only with Full access/)).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText('Priority'), 'high');
    await user.type(within(dialog).getByLabelText('Labels'), 'search, ui, search');
    await user.click(within(dialog).getByRole('button', { name: 'Add to Inbox' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await within(column('inbox')).findByText('Fix search')).toBeInTheDocument();
    expect(db.listTasks(project.id)[0]).toMatchObject({
      title: 'Fix search',
      brief: 'Accents are ignored.',
      acceptance: 'café finds cafe',
      workflowId: team.id,
      finishLine: 'apply_local',
      automation: 'manual',
      priority: 'high',
      labels: ['search', 'ui'],
      stage: 'inbox',
    });
  });

  it('Start now starts it: with a team and Assisted, straight into work', async () => {
    const { project } = seedProject();
    const user = userEvent.setup();
    renderApp(`/projects/${project.id}/tasks`);
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    const dialog = await screen.findByRole('dialog', { name: 'New task' });
    await user.type(within(dialog).getByLabelText('Title'), 'Fix search');
    await user.selectOptions(within(dialog).getByLabelText('Team'), 'Builders');
    await user.click(within(dialog).getByRole('button', { name: 'Start now' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() =>
      expect(within(column('work')).getByTestId('task-card-1')).toBeInTheDocument(),
    );
    expect(db.listTasks(project.id)[0]).toMatchObject({ stage: 'work', state: 'running' });
  });
});
