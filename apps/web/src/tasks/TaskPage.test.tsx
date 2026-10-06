import type { CreateTaskRequest } from '@ace/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { startSocket, stopSocket } from '../app/socket';
import { createFakeWebSocket } from '../mocks/fake-socket';
import {
  completeMockWork,
  createTask,
  failNextChecks,
  setTaskWorkPace,
  workTask,
} from '../mocks/tasks';
import { db, installMockServer, queryClient, renderApp } from '../test/app';

installMockServer();

beforeEach(() => setTaskWorkPace('manual'));
afterEach(() => stopSocket());

function seed(task: Partial<CreateTaskRequest> = {}) {
  const project = db.createProject({ name: 'Shop', folderPath: '/mock/projects/shop' });
  db.updateProject(project.id, { checkCommands: [{ name: 'test', command: 'pnpm test' }] });
  const team = db.createWorkflow(project.id, 'Builders');
  db.createWorkflow(project.id, 'Reviewers');
  const created = createTask(db, project.id, {
    title: 'Fix search',
    brief: 'Accents are ignored.',
    workflowId: team.id,
    ...task,
  });
  return { project, team, task: created };
}

function connect() {
  startSocket({
    token: 'mock',
    queryClient,
    url: 'ws://mock.local/ws',
    WebSocket: createFakeWebSocket(db) as unknown as typeof WebSocket,
  });
}

async function openTask(projectId: string, taskId: string) {
  const view = renderApp(`/projects/${projectId}/tasks/${taskId}`);
  await screen.findByTestId('task-page');
  return view;
}

const actions = () =>
  within(screen.getByTestId('task-actions'))
    .getAllByRole('button')
    .map((button) => button.textContent);

/** The task moves to Review the way the engine would: the run completes, frames follow. */
async function finishWork(taskId: string) {
  act(() => {
    completeMockWork(taskId);
  });
  await screen.findByTestId('review-panel');
}

describe('ACE-P0 the task page header (design §8)', () => {
  it('shows #n and the title, the stage stepper, the state and only the allowed actions', async () => {
    const { project, task } = seed();
    await openTask(project.id, task.id);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('#1 Fix search');
    const stepper = screen.getByRole('list', { name: 'Stages' });
    expect(within(stepper).getByText('Inbox')).toHaveAttribute('aria-current', 'step');
    expect(within(stepper).getByText('Done')).not.toHaveAttribute('aria-current');
    expect(screen.getByTestId('task-state')).toHaveAttribute('data-state', 'idle');
    expect(actions()).toEqual([
      'Start',
      'Start work',
      'Pause',
      'Close without verification',
      'Delete',
    ]);
  });

  it('a running task offers Stop; Stop leaves it idle with the reason', async () => {
    const { project, task } = seed();
    workTask(db, task.id);
    const user = userEvent.setup();
    await openTask(project.id, task.id);

    expect(within(screen.getByTestId('stage-stepper')).getByText('Work')).toHaveAttribute(
      'aria-current',
      'step',
    );
    expect(actions()).toEqual(['Stop', 'Pause']);
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByTestId('task-reason')).toHaveTextContent('Stopped.');
    expect(db.getTask(task.id)?.state).toBe('idle');
  });

  it('edits the title in place', async () => {
    const { project, task } = seed();
    const user = userEvent.setup();
    await openTask(project.id, task.id);
    await user.click(screen.getByRole('button', { name: 'Edit title' }));
    const input = screen.getByRole('textbox', { name: 'Task title' });
    await user.clear(input);
    await user.type(input, 'Fix accented search{Enter}');
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      '#1 Fix accented search',
    );
    expect(db.getTask(task.id)?.title).toBe('Fix accented search');
  });

  it('says so when the task does not exist', async () => {
    const project = db.createProject({ name: 'Shop' });
    renderApp(`/projects/${project.id}/tasks/01ARZ3NDEKTSV4RRFFQ69G5FT0`);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This task does not exist any more.',
    );
  });
});

describe('ACE-P0 work → review → changes and diff (design §1, §8)', () => {
  it('starts work, shows the uncommitted note, then the changed files and a unified diff', async () => {
    const { project, task } = seed();
    connect();
    const user = userEvent.setup();
    await openTask(project.id, task.id);

    await user.click(screen.getByRole('button', { name: 'Start work' }));
    await waitFor(() => expect(actions()).toEqual(['Stop', 'Pause']));

    await user.click(screen.getByRole('tab', { name: 'Changes' }));
    expect(await screen.findByTestId('changes-uncommitted')).toHaveTextContent(
      'the run is still going',
    );

    await finishWork(task.id);
    await waitFor(() => expect(screen.queryByTestId('changes-uncommitted')).toBeNull());
    const detail = db.taskWorkspaceOf(task.id)!;
    expect(screen.getByTestId('changes-range')).toHaveTextContent(
      `main @ ${detail.baseSha.slice(0, 7)} → ${detail.headSha.slice(0, 7)} (ace/task-1-fix-search)`,
    );
    expect(screen.getByTestId('changes-totals')).toHaveTextContent('2 files · +52 −3');
    const files = screen.getByRole('list', { name: 'Changed files' });
    const rows = within(files).getAllByRole('button');
    expect(rows.map((row) => row.textContent)).toEqual([
      'Msrc/search.ts+12 −3',
      'Asrc/search.test.ts+40 −0',
    ]);

    await user.click(rows[0]!);
    const diff = await screen.findByRole('region', { name: 'Diff of src/search.ts' });
    const added = diff.querySelectorAll('tr[data-kind="add"]');
    const removed = diff.querySelectorAll('tr[data-kind="del"]');
    expect(added).toHaveLength(12);
    expect(removed).toHaveLength(3);
    expect(added[0]).toHaveTextContent(
      '/** Lower-case and strip accents, so "Café" finds "cafe". */',
    );
    expect(removed[0]).toHaveTextContent('export function search(query: string) {');
    expect(diff.querySelector('tr[data-kind="hunk"]')).toHaveTextContent('@@ -1,8 +1,17 @@');
  });

  it('Build lists the runs newest first with their summary and commit; a follow-up starts another', async () => {
    const { project, task } = seed();
    workTask(db, task.id);
    completeMockWork(task.id);
    connect();
    const user = userEvent.setup();
    await openTask(project.id, task.id);

    await user.click(screen.getByRole('tab', { name: 'Build' }));
    const first = await screen.findByTestId('execution-1');
    expect(within(first).getByTestId('execution-status')).toHaveTextContent('completed');
    expect(within(first).getByText(/Search now ignores accents and case/)).toBeInTheDocument();
    expect(within(first).getByText('2 files changed')).toBeInTheDocument();
    const runId = db.taskExecutionsOf(task.id)[0]!.runId!;
    expect(within(first).getByRole('link', { name: 'Open run' })).toHaveAttribute(
      'href',
      `/runs/${runId}`,
    );

    await user.type(screen.getByLabelText('Follow-up for the team'), 'Handle umlauts too.');
    await user.click(screen.getByRole('button', { name: 'Send follow-up' }));
    await screen.findByTestId('execution-2');
    const list = screen.getByRole('list', { name: 'Runs of this task' });
    expect(Array.from(list.children).map((item) => item.getAttribute('data-testid'))).toEqual([
      'execution-2',
      'execution-1',
    ]);
    expect(db.taskExecutionsOf(task.id)[1]?.request).toBe('Handle umlauts too.');
  });

  it('Checks shows the latest result per check for the head, with its output on demand', async () => {
    const { project, task } = seed();
    workTask(db, task.id);
    completeMockWork(task.id);
    const user = userEvent.setup();
    await openTask(project.id, task.id);

    await user.click(screen.getByRole('tab', { name: 'Checks' }));
    const check = await screen.findByTestId('check-test');
    expect(within(check).getByTestId('check-status')).toHaveTextContent('passed');
    expect(within(check).getByText('pnpm test')).toBeInTheDocument();
    await user.click(within(check).getByRole('button', { name: 'Show output' }));
    expect(within(check).getByTestId('code-body')).toHaveTextContent('8 tests passed');

    // run them again: the newest is the one shown, the first is folded under Older results
    await user.click(screen.getByRole('button', { name: 'Run checks' }));
    expect(await screen.findByText('Older results (1)')).toBeInTheDocument();
  });

  it('Activity lists what happened, newest first', async () => {
    const { project, task } = seed();
    workTask(db, task.id);
    const user = userEvent.setup();
    await openTask(project.id, task.id);
    await user.click(screen.getByRole('tab', { name: 'Activity' }));
    const feed = await screen.findByRole('list', { name: 'Activity' });
    const items = within(feed).getAllByRole('listitem');
    expect(items.at(-1)).toHaveTextContent('Task #1 created.');
    expect(items.map((item) => item.dataset['kind'])).toContain('run_started');
  });
});

describe('ACE-P0 the Review panel (design §8)', () => {
  it('Approve with the finish line Pass review reaches Done, outcome Reviewed', async () => {
    const { project, task } = seed();
    workTask(db, task.id);
    completeMockWork(task.id);
    const user = userEvent.setup();
    await openTask(project.id, task.id);

    const panel = screen.getByTestId('review-panel');
    // no Apply for this finish line
    expect(within(panel).queryByTestId('apply-section')).toBeNull();
    await user.click(within(panel).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByTestId('task-outcome')).toHaveTextContent('Reviewed');
    expect(screen.queryByTestId('review-panel')).toBeNull();
    expect(db.taskReviewsOf(task.id)[0]).toMatchObject({
      decision: 'approved',
      headSha: db.taskWorkspaceOf(task.id)?.headSha,
    });
    // design §2.1 keeps `checks` while the workspace is ready, Done or not
    expect(actions()).toEqual(['Run checks', 'Delete']);
  });

  it('Request changes needs a note, then the team works again with it', async () => {
    const { project, task } = seed();
    workTask(db, task.id);
    completeMockWork(task.id);
    const user = userEvent.setup();
    await openTask(project.id, task.id);

    const panel = screen.getByTestId('review-panel');
    const request = within(panel).getByRole('button', { name: 'Request changes' });
    expect(request).toBeDisabled();
    await user.type(within(panel).getByLabelText('What should change'), 'Handle umlauts too.');
    await user.click(request);

    await waitFor(() => expect(screen.queryByTestId('review-panel')).toBeNull());
    expect(within(screen.getByTestId('stage-stepper')).getByText('Work')).toHaveAttribute(
      'aria-current',
      'step',
    );
    expect(db.getTask(task.id)).toMatchObject({ stage: 'work', state: 'running' });
    expect(db.taskExecutionsOf(task.id).at(-1)?.request).toBe('Handle umlauts too.');
  });

  it('Apply shows the destination, confirms it, and sends exactly that', async () => {
    const { project, task } = seed({ finishLine: 'apply_local' });
    workTask(db, task.id);
    completeMockWork(task.id);
    const user = userEvent.setup();
    await openTask(project.id, task.id);

    const section = await screen.findByTestId('apply-section');
    expect(await within(section).findByTestId('apply-destination')).toHaveTextContent(
      '/mock/projects/shop @ main',
    );
    await user.click(within(section).getByRole('button', { name: 'Apply' }));
    const dialog = await screen.findByRole('dialog', { name: 'Apply these changes?' });
    expect(dialog).toHaveTextContent('/mock/projects/shop @ main');
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }));

    expect(await screen.findByTestId('task-outcome')).toHaveTextContent('Applied');
    expect(db.taskDeliveriesOf(task.id)[0]).toMatchObject({
      status: 'succeeded',
      destination: '/mock/projects/shop @ main',
    });
  });

  it('a failed check warns and disables Apply', async () => {
    const { project, task } = seed({ finishLine: 'apply_local' });
    failNextChecks();
    workTask(db, task.id);
    completeMockWork(task.id);
    await openTask(project.id, task.id);

    const section = await screen.findByTestId('apply-section');
    expect(within(section).getByTestId('apply-checks-failed')).toHaveTextContent(
      'A check failed on these changes',
    );
    await within(section).findByTestId('apply-destination');
    expect(within(section).getByRole('button', { name: 'Apply' })).toBeDisabled();
  });

  it('Apply to a repository that moved is refused and the new destination is shown', async () => {
    const { project, task } = seed({ finishLine: 'apply_local' });
    workTask(db, task.id);
    completeMockWork(task.id);
    const user = userEvent.setup();
    await openTask(project.id, task.id);
    const section = await screen.findByTestId('apply-section');
    await within(section).findByTestId('apply-destination');

    // someone switched the repository's branch after the page read it
    db.setRepository(project.id, { ...db.repositoryOf(project.id), branch: 'develop' });
    await user.click(within(section).getByRole('button', { name: 'Apply' }));
    const dialog = await screen.findByRole('dialog', { name: 'Apply these changes?' });
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }));

    await waitFor(() =>
      expect(within(section).getByTestId('apply-destination')).toHaveTextContent(
        '/mock/projects/shop @ develop',
      ),
    );
    expect(db.getTask(task.id)?.stage).toBe('review');
  });
});

describe('ACE-P0 close and delete (design §2)', () => {
  it('Close without verification asks first, then the task is Done unverified', async () => {
    const { project, task } = seed();
    const user = userEvent.setup();
    await openTask(project.id, task.id);
    await user.click(screen.getByRole('button', { name: 'Close without verification' }));
    const dialog = await screen.findByRole('dialog', { name: 'Close without verification?' });
    await user.type(within(dialog).getByLabelText('Why (optional)'), 'Done by hand.');
    await user.click(within(dialog).getByRole('button', { name: 'Close task' }));

    expect(await screen.findByTestId('task-outcome')).toHaveTextContent(
      'Closed without verification',
    );
    expect(db.getTask(task.id)).toMatchObject({ stage: 'done', outcome: 'closed_unverified' });
    expect(db.taskActivityOf(task.id).at(-1)?.message).toBe(
      'Closed without verification: Done by hand.',
    );
  });

  it('Delete asks first, then goes back to the board without the card', async () => {
    const { project, task } = seed();
    const user = userEvent.setup();
    const { router } = await openTask(project.id, task.id);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete task #1?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete task' }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/projects/${project.id}/tasks`),
    );
    // the board fetches its list afresh; under a loaded runner that takes more than a second
    expect(
      await screen.findByTestId('tasks-empty', undefined, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(db.getTask(task.id)).toBeUndefined();
  });
});

describe('ACE-P0 the Overview tab (design §8)', () => {
  it('saves the plan with its button, and the team and labels as they change', async () => {
    const { project, task } = seed();
    const user = userEvent.setup();
    await openTask(project.id, task.id);

    const plan = screen.getByLabelText('Plan');
    await user.type(plan, '1. Normalize names');
    await user.click(screen.getByRole('button', { name: 'Save plan' }));
    await waitFor(() => expect(db.getTask(task.id)?.plan).toBe('1. Normalize names'));

    await user.selectOptions(screen.getByLabelText('Team'), 'Reviewers');
    await waitFor(() =>
      expect(db.getTask(task.id)?.workflowId).toBe(db.listWorkflows(project.id)[1]?.id),
    );
    await user.selectOptions(screen.getByLabelText('Team'), '');
    await waitFor(() => expect(db.getTask(task.id)?.workflowId).toBeUndefined());

    const labels = screen.getByLabelText('Labels');
    await user.type(labels, 'search, ui{Enter}');
    await waitFor(() => expect(db.getTask(task.id)?.labels).toEqual(['search', 'ui']));

    await user.click(screen.getByLabelText('Brief'));
    await user.type(screen.getByLabelText('Brief'), ' Also umlauts.');
    await user.tab();
    await waitFor(() =>
      expect(db.getTask(task.id)?.brief).toBe('Accents are ignored. Also umlauts.'),
    );
  });
});
