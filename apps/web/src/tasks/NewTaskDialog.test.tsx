import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { closeTask, createTask, setTaskWorkPace } from '../mocks/tasks';
import { db, installMockServer, renderApp } from '../test/app';
import { localTimeZone, toDatetimeLocal } from './timing';

/**
 * ACE parity P1 New task (D275–D277): Document and Email types with their own fields, Merge on
 * GitHub for an App, and the Timing section — each kind sent the way the contract writes it.
 */

installMockServer();
beforeEach(() => setTaskWorkPace('manual'));

const HOUR = 3_600_000;

function seed() {
  const project = db.createProject({ name: 'Shop', folderPath: '/mock/projects/shop' });
  const team = db.createWorkflow(project.id, 'Builders');
  return { project, team };
}

async function openDialog(projectId: string) {
  const user = userEvent.setup();
  renderApp(`/projects/${projectId}/tasks`);
  await user.click(await screen.findByRole('button', { name: 'New task' }));
  const dialog = await screen.findByRole('dialog', { name: 'New task' });
  return { user, dialog };
}

const options = (select: HTMLElement) =>
  within(select)
    .getAllByRole('option')
    .map((option) => option.textContent);

describe('ACE-P1 D275 a Document task', () => {
  it('needs a project-relative Save as path, and finishes with Accept document', async () => {
    const { project, team } = seed();
    const { user, dialog } = await openDialog(project.id);
    await user.type(within(dialog).getByLabelText('Title'), 'Release notes');
    await user.click(within(dialog).getByRole('radio', { name: 'Document' }));
    expect(options(within(dialog).getByLabelText('Finish line'))).toEqual(['Accept the document']);

    // required, then refused outside the project folder, both before anything is sent
    await user.click(within(dialog).getByRole('button', { name: 'Add to Inbox' }));
    expect(await within(dialog).findByText(/Say where the document is saved/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Save as'), '../secrets.md');
    await user.click(within(dialog).getByRole('button', { name: 'Add to Inbox' }));
    expect(
      await within(dialog).findByText(/must be a relative path inside the project folder/),
    ).toBeInTheDocument();
    expect(db.listTasks(project.id)).toHaveLength(0);

    await user.clear(within(dialog).getByLabelText('Save as'));
    await user.type(within(dialog).getByLabelText('Save as'), 'docs/notes.md');
    await user.selectOptions(within(dialog).getByLabelText('Team'), 'Builders');
    await user.click(within(dialog).getByRole('button', { name: 'Add to Inbox' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(db.listTasks(project.id)[0]).toMatchObject({
      title: 'Release notes',
      type: 'document',
      finishLine: 'accept_document',
      workflowId: team.id,
      deliverable: { kind: 'document', path: 'docs/notes.md', content: '' },
    });
  });
});

describe('ACE-P1 D275 an Email task', () => {
  it('takes comma-separated recipients, and shows Send as not available yet', async () => {
    const { project } = seed();
    const { user, dialog } = await openDialog(project.id);
    await user.type(within(dialog).getByLabelText('Title'), 'Reply to Ann');
    await user.click(within(dialog).getByRole('radio', { name: 'Email' }));
    const finish = within(dialog).getByLabelText('Finish line');
    expect(options(finish)).toEqual([
      'Accept the draft',
      'Send the email (needs an email connection — not available yet)',
    ]);
    expect(within(finish).getByRole('option', { name: /Send the email/ })).toBeDisabled();

    await user.type(within(dialog).getByLabelText('To'), 'ann@example.com, not-an-address');
    await user.click(within(dialog).getByRole('button', { name: 'Add to Inbox' }));
    expect(
      await within(dialog).findByText(
        'Not an email address: not-an-address. Separate addresses with commas.',
      ),
    ).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText('To'));
    await user.type(within(dialog).getByLabelText('To'), 'ann@example.com, bo@example.com,');
    await user.click(within(dialog).getByRole('button', { name: 'Add to Inbox' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(db.listTasks(project.id)[0]).toMatchObject({
      type: 'email',
      finishLine: 'accept_draft',
      deliverable: {
        kind: 'email',
        to: ['ann@example.com', 'bo@example.com'],
        subject: 'Reply to Ann',
      },
    });
  });
});

describe('ACE-P1 D276 an App task can finish on GitHub', () => {
  it('offers Merge on GitHub and sends it', async () => {
    const { project } = seed();
    const { user, dialog } = await openDialog(project.id);
    await user.type(within(dialog).getByLabelText('Title'), 'Search');
    await user.selectOptions(within(dialog).getByLabelText('Finish line'), 'github_merge');
    await user.click(within(dialog).getByRole('button', { name: 'Add to Inbox' }));
    await waitFor(() => expect(db.listTasks(project.id)[0]?.finishLine).toBe('github_merge'));
  });
});

describe('ACE-P1 D277 Timing in the New task dialog', () => {
  it('At a time: must be in the future, then the task waits in the Inbox with its trigger', async () => {
    const { project, team } = seed();
    const { user, dialog } = await openDialog(project.id);
    await user.type(within(dialog).getByLabelText('Title'), 'Nightly');
    await user.selectOptions(within(dialog).getByLabelText('Team'), 'Builders');
    await user.click(within(dialog).getByRole('radio', { name: 'At a time' }));
    const at = within(dialog).getByLabelText('Starts at');

    fireEvent.change(at, {
      target: { value: toDatetimeLocal(new Date(Date.now() - HOUR).toISOString()) },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Schedule' }));
    expect(await within(dialog).findByText('The time must be in the future.')).toBeInTheDocument();
    expect(db.listTasks(project.id)).toHaveLength(0);

    const later = toDatetimeLocal(new Date(Date.now() + 2 * HOUR).toISOString());
    fireEvent.change(at, { target: { value: later } });
    await user.click(within(dialog).getByRole('button', { name: 'Schedule' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const task = db.listTasks(project.id)[0];
    expect(task).toMatchObject({ stage: 'inbox', state: 'idle', workflowId: team.id });
    expect(db.taskScheduleOf(task?.id ?? '')).toMatchObject({
      trigger: { kind: 'once', at: new Date(later).toISOString() },
      enabled: true,
    });
  });

  it('Repeat: a preset fills the cron, the zone defaults to the viewer’s, a bad cron is refused', async () => {
    const { project } = seed();
    const { user, dialog } = await openDialog(project.id);
    await user.type(within(dialog).getByLabelText('Title'), 'Daily triage');
    await user.click(within(dialog).getByRole('radio', { name: 'Repeat' }));
    expect(within(dialog).getByLabelText('Time zone')).toHaveValue(localTimeZone());

    const cron = within(dialog).getByLabelText('Cron expression');
    await user.clear(cron);
    await user.type(cron, '0 25 * * *');
    await user.click(within(dialog).getByRole('button', { name: 'Schedule' }));
    expect(
      await within(dialog).findByText('The hour field allows 0-23; "25" is outside it.'),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Every Monday 09:00' }));
    expect(cron).toHaveValue('0 9 * * 1');
    await user.click(within(dialog).getByRole('button', { name: 'Daily 09:00' }));
    expect(cron).toHaveValue('0 9 * * *');
    await user.click(within(dialog).getByRole('button', { name: 'Weekdays 09:00' }));
    expect(cron).toHaveValue('0 9 * * 1-5');
    expect(within(dialog).getByRole('button', { name: 'Weekdays 09:00' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(dialog).getByTestId('new-task-next')).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText('Time zone'), 'Europe/London');
    await user.click(within(dialog).getByRole('button', { name: 'Schedule' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const task = db.listTasks(project.id)[0];
    expect(task?.stage).toBe('inbox');
    expect(db.taskScheduleOf(task?.id ?? '')).toMatchObject({
      trigger: { kind: 'recurring', cron: '0 9 * * 1-5', timezone: 'Europe/London' },
    });
  });

  it('After another task: the project’s tasks that are not Done', async () => {
    const { project } = seed();
    const first = createTask(db, project.id, { title: 'First' });
    closeTask(db, createTask(db, project.id, { title: 'Old' }).id);
    const { user, dialog } = await openDialog(project.id);
    await user.type(within(dialog).getByLabelText('Title'), 'Second');
    await user.click(within(dialog).getByRole('radio', { name: 'After another task' }));
    await user.click(within(dialog).getByRole('button', { name: 'Schedule' }));
    expect(await within(dialog).findByText('Pick the task to wait on.')).toBeInTheDocument();

    const wait = within(dialog).getByLabelText('Wait for');
    await waitFor(() => expect(options(wait)).toEqual(['Choose a task…', '#1 First']));
    await user.selectOptions(wait, first.id);
    await user.click(within(dialog).getByRole('button', { name: 'Schedule' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const second = db.listTasks(project.id).find((task) => task.title === 'Second');
    expect(db.taskScheduleOf(second?.id ?? '')?.trigger).toEqual({
      kind: 'after_task',
      taskId: first.id,
    });
    expect(second?.stateReason).toBe('Starts when the task it waits on reaches its finish line.');
  });

  it('Start now starts the task; Add to Inbox is the default', async () => {
    const { project } = seed();
    const { user, dialog } = await openDialog(project.id);
    expect(within(dialog).getByRole('radio', { name: 'Add to Inbox' })).toBeChecked();
    await user.type(within(dialog).getByLabelText('Title'), 'Now');
    await user.selectOptions(within(dialog).getByLabelText('Team'), 'Builders');
    await user.click(within(dialog).getByRole('radio', { name: 'Start now' }));
    await user.click(within(dialog).getByRole('button', { name: 'Start now' }));
    await waitFor(() => expect(db.listTasks(project.id)[0]?.state).toBe('running'));
    expect(db.taskScheduleOf(db.listTasks(project.id)[0]?.id ?? '')).toBeUndefined();
  });
});
