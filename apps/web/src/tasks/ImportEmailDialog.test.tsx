import { aceError } from '@ace/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';

import { setTaskWorkPace } from '../mocks/tasks';
import { db, installMockServer, renderApp, server } from '../test/app';

installMockServer();

beforeEach(() => setTaskWorkPace('manual'));

/**
 * Import email (ACE parity P2, D282): from the board, paste a raw message or pick an `.eml` file,
 * choose the team, and the message becomes an Inbox task — nothing starts. Refusals are shown as
 * the engine words them.
 */

const RAW = [
  'From: Ann <ann@example.com>',
  'To: support@example.com',
  'Subject: Search is slow',
  'Date: Tue, 6 Oct 2026 09:00:00 +0000',
  '',
  'It takes 3 s to find a café.',
].join('\r\n');

function seedProject() {
  const project = db.createProject({ name: 'Shop' });
  const team = db.createWorkflow(project.id, 'Builders');
  return { project, team };
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Import email' }));
  return screen.findByRole('dialog', { name: 'Import an email' });
}

describe('ACE-P2 D282 import an email into the Inbox', () => {
  it('saves a pasted message as an Inbox task with its team, and starts nothing', async () => {
    const user = userEvent.setup();
    const { project, team } = seedProject();
    renderApp(`/projects/${project.id}/tasks`);
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByLabelText('Message'));
    await user.paste(RAW);
    await user.selectOptions(within(dialog).getByLabelText('Team'), team.id);
    await user.click(within(dialog).getByRole('button', { name: 'Add to Inbox' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const inbox = screen.getByTestId('column-inbox');
    expect(await within(inbox).findByText('Search is slow')).toBeInTheDocument();
    const [task] = db.listTasks(project.id);
    expect(task).toMatchObject({
      title: 'Search is slow',
      stage: 'inbox',
      state: 'idle',
      workflowId: team.id,
      source: { kind: 'email', label: 'Ann <ann@example.com>' },
    });
    expect(task?.brief).toContain('It takes 3 s to find a café.');
    expect(db.taskExecutionsOf(task!.id)).toEqual([]);
  });

  it('reads a picked .eml file into the message', async () => {
    const user = userEvent.setup();
    const { project } = seedProject();
    renderApp(`/projects/${project.id}/tasks`);
    const dialog = await openDialog(user);
    const file = new File([RAW], 'slow-search.eml', { type: 'message/rfc822' });
    await user.upload(within(dialog).getByLabelText('.eml file'), file);
    expect(await within(dialog).findByTestId('email-file-name')).toHaveTextContent(
      'slow-search.eml',
    );
    // A textarea keeps line breaks as LF; the engine reads either.
    expect(within(dialog).getByLabelText('Message')).toHaveValue(RAW.replace(/\r\n/g, '\n'));
    await user.click(within(dialog).getByRole('button', { name: 'Add to Inbox' }));
    await waitFor(() => expect(db.listTasks(project.id)).toHaveLength(1));
    expect(db.listTasks(project.id)[0]).toMatchObject({ title: 'Search is slow' });
    expect(db.listTasks(project.id)[0]?.workflowId).toBeUndefined();
  });

  it('asks for a message before sending anything', async () => {
    const user = userEvent.setup();
    const { project } = seedProject();
    renderApp(`/projects/${project.id}/tasks`);
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Add to Inbox' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Paste a message or pick an .eml file.',
    );
    expect(db.listTasks(project.id)).toEqual([]);
  });

  it('shows the engine refusal and keeps the dialog open', async () => {
    const user = userEvent.setup();
    const { project } = seedProject();
    server.use(
      http.post('*/api/v1/projects/:id/tasks/import-email', () =>
        HttpResponse.json(
          aceError('invalid_config', 'validation_failed', 'The message has no readable text.'),
          { status: 400 },
        ),
      ),
    );
    renderApp(`/projects/${project.id}/tasks`);
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByLabelText('Message'));
    await user.paste(RAW);
    await user.click(within(dialog).getByRole('button', { name: 'Add to Inbox' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The message has no readable text.',
    );
    expect(screen.getByRole('dialog', { name: 'Import an email' })).toBeInTheDocument();
    expect(db.listTasks(project.id)).toEqual([]);
  });
});
