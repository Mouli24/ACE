import type { CreateTaskRequest } from '@ace/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { startSocket, stopSocket } from '../app/socket';
import { createFakeWebSocket } from '../mocks/fake-socket';
import {
  applyDestination,
  applyTask,
  completeMockWork,
  createTask,
  failNextMerge,
  putSchedule,
  setMockGitHub,
  setTaskWorkPace,
  workTask,
} from '../mocks/tasks';
import { db, installMockServer, queryClient, renderApp, server } from '../test/app';
import { formatWhen } from './meta';

/**
 * ACE parity P1 on the task page (D275–D278): the Draft, Accept and Send, GitHub delivery, the
 * Preview tab, the Schedule card, the source line and the delivered outcome — against the mock
 * engine, which answers with the engine's refusals and messages.
 */

installMockServer();
beforeEach(() => setTaskWorkPace('manual'));
afterEach(() => {
  stopSocket();
  server.events.removeAllListeners();
});

const HOUR = 3_600_000;

function seed(projectPatch: Parameters<typeof db.updateProject>[1] = {}) {
  const project = db.createProject({ name: 'Shop', folderPath: '/mock/projects/shop' });
  db.updateProject(project.id, {
    checkCommands: [{ name: 'test', command: 'pnpm test' }],
    ...projectPatch,
  });
  const team = db.createWorkflow(project.id, 'Builders');
  return { project, team };
}

/** A task that has run once and waits in Review, set up before the page opens. */
function inReview(projectId: string, body: CreateTaskRequest) {
  const task = createTask(db, projectId, body);
  workTask(db, task.id);
  completeMockWork(task.id);
  return task;
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
  const user = userEvent.setup();
  renderApp(`/projects/${projectId}/tasks/${taskId}`);
  await screen.findByTestId('task-page');
  return user;
}

describe('ACE-P1 D275 a Document task: run → edit the draft → accept', () => {
  it('writes the draft from the run, keeps an edit, and accepts it into the project folder', async () => {
    const { project, team } = seed();
    const task = createTask(db, project.id, {
      title: 'Release notes',
      type: 'document',
      documentPath: 'docs/notes.md',
      workflowId: team.id,
    });
    connect();
    const user = await openTask(project.id, task.id);
    const draft = screen.getByTestId('task-draft');
    expect(within(draft).getByLabelText('Document')).toHaveValue('');

    await user.click(screen.getByRole('button', { name: 'Start work' }));
    await waitFor(() => expect(db.getTask(task.id)?.state).toBe('running'));
    // the editor is read-only while the team writes
    await waitFor(() =>
      expect(within(screen.getByTestId('task-draft')).getByLabelText('Document')).toBeDisabled(),
    );
    act(() => {
      completeMockWork(task.id);
    });
    const panel = await screen.findByTestId('review-panel');

    const content = await within(screen.getByTestId('task-draft')).findByDisplayValue(
      /# Release notes/,
    );
    expect(content).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(
      within(screen.getByTestId('draft-preview')).getByRole('heading', { name: 'Release notes' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Markdown' }));
    const editor = within(screen.getByTestId('task-draft')).getByLabelText('Document');
    await user.clear(editor);
    await user.type(editor, '# Final notes');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() =>
      expect(db.getTask(task.id)?.deliverable).toEqual({
        kind: 'document',
        path: 'docs/notes.md',
        content: '# Final notes',
      }),
    );

    expect(within(panel).getByTestId('accept-destination')).toHaveTextContent(
      'Saves docs/notes.md in /mock/projects/shop; never overwrites an existing file.',
    );
    expect(within(panel).queryByTestId('apply-section')).toBeNull();
    await user.click(within(panel).getByRole('button', { name: 'Accept document' }));
    const dialog = await screen.findByRole('dialog', { name: 'Accept this document?' });
    expect(within(dialog).getByTestId('accept-confirm-path')).toHaveTextContent(
      '/mock/projects/shop/docs/notes.md',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Accept and save' }));

    expect(await screen.findByTestId('task-outcome')).toHaveTextContent('Accepted');
    expect(screen.getByTestId('task-delivered')).toHaveTextContent(
      'Accepted as docs/notes.md (/mock/projects/shop/docs/notes.md).',
    );
    expect(db.projectFileOf(project.id, 'docs/notes.md')).toBe('# Final notes');
    // a Done task's draft is read-only
    expect(within(screen.getByTestId('task-draft')).getByLabelText('Save as')).toBeDisabled();
  });

  it('refuses to overwrite an existing file, in place; a new path in the draft accepts', async () => {
    const { project, team } = seed();
    db.writeProjectFile(project.id, 'notes.md', '# Already here');
    const task = inReview(project.id, {
      title: 'Notes',
      type: 'document',
      documentPath: 'notes.md',
      workflowId: team.id,
    });
    const user = await openTask(project.id, task.id);
    const panel = screen.getByTestId('review-panel');
    await within(panel).findByText('/mock/projects/shop');

    await user.click(within(panel).getByRole('button', { name: 'Accept document' }));
    const dialog = await screen.findByRole('dialog', { name: 'Accept this document?' });
    await user.click(within(dialog).getByRole('button', { name: 'Accept and save' }));
    const refusal = await within(panel).findByTestId('delivery-error');
    expect(refusal).toHaveAttribute('data-code', 'file_exists');
    expect(refusal).toHaveTextContent(
      'The file already exists: notes.md already exists in the project folder; ACE never overwrites a file on accept. Choose another path.',
    );
    expect(within(panel).getByText(/Change “Save as” in the Draft/)).toBeInTheDocument();
    expect(db.getTask(task.id)?.stage).toBe('review');
    expect(db.projectFileOf(project.id, 'notes.md')).toBe('# Already here');

    const path = within(screen.getByTestId('task-draft')).getByLabelText('Save as');
    await user.clear(path);
    await user.type(path, 'docs/notes-2.md');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() =>
      expect(within(panel).getByTestId('accept-destination')).toHaveTextContent(
        'Saves docs/notes-2.md in /mock/projects/shop',
      ),
    );
    await user.click(within(panel).getByRole('button', { name: 'Accept document' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Accept this document?' })).getByRole(
        'button',
        { name: 'Accept and save' },
      ),
    );
    expect(await screen.findByTestId('task-outcome')).toHaveTextContent('Accepted');
    expect(db.projectFileOf(project.id, 'docs/notes-2.md')).toContain('# Release notes');
  });

  it('a path the draft editor refuses is never sent', async () => {
    const { project, team } = seed();
    const task = inReview(project.id, {
      title: 'Notes',
      type: 'document',
      documentPath: 'notes.md',
      workflowId: team.id,
    });
    const user = await openTask(project.id, task.id);
    const path = within(screen.getByTestId('task-draft')).getByLabelText('Save as');
    await user.clear(path);
    await user.type(path, '/etc/passwd');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(
      await within(screen.getByTestId('task-draft')).findByText(
        'must be a relative path inside the project folder, like docs/notes.md',
      ),
    ).toBeInTheDocument();
    expect(db.getTask(task.id)?.deliverable).toMatchObject({ path: 'notes.md' });
  });
});

describe('ACE-P1 D275 an Email task', () => {
  it('edits the draft, then accepts it for its recipients — nothing is sent', async () => {
    const { project, team } = seed();
    const task = inReview(project.id, {
      title: 'Reply to Ann',
      type: 'email',
      emailTo: ['ann@example.com'],
      workflowId: team.id,
    });
    const user = await openTask(project.id, task.id);
    const draft = screen.getByTestId('task-draft');
    expect(within(draft).getByLabelText('Subject')).toHaveValue('An update on your order');
    expect((within(draft).getByLabelText('Body') as HTMLTextAreaElement).value).toMatch(/^Hi,/);

    await user.type(within(draft).getByLabelText('Cc'), 'not an address');
    await user.click(within(draft).getByRole('button', { name: 'Save draft' }));
    expect(await within(draft).findByText('Not an email address: not an address.')).toBeVisible();
    await user.clear(within(draft).getByLabelText('Cc'));
    await user.type(within(draft).getByLabelText('Cc'), 'bo@example.com');
    await user.click(within(draft).getByRole('button', { name: 'Save draft' }));
    await waitFor(() =>
      expect(db.getTask(task.id)?.deliverable).toMatchObject({ cc: ['bo@example.com'] }),
    );

    const panel = screen.getByTestId('review-panel');
    expect(within(panel).getByTestId('accept-destination')).toHaveTextContent(
      'Accepts the draft to ann@example.com; it is not sent.',
    );
    expect(within(panel).queryByTestId('send-section')).toBeNull();
    await user.click(within(panel).getByRole('button', { name: 'Accept draft' }));
    expect(await screen.findByTestId('task-outcome')).toHaveTextContent('Accepted');
    expect(screen.getByTestId('task-delivered')).toHaveTextContent(
      'Draft accepted for ann@example.com. It was not sent.',
    );
  });

  it('Send is offered only for the Send finish line, and says plainly it is not connected', async () => {
    const { project, team } = seed();
    const task = inReview(project.id, {
      title: 'Send it',
      type: 'email',
      emailTo: ['bo@example.com'],
      finishLine: 'send_email',
      workflowId: team.id,
    });
    const user = await openTask(project.id, task.id);
    const panel = screen.getByTestId('review-panel');
    expect(within(panel).queryByTestId('accept-section')).toBeNull();
    await user.click(within(panel).getByRole('button', { name: 'Send email' }));
    const refusal = await within(panel).findByTestId('delivery-error');
    expect(refusal).toHaveAttribute('data-code', 'not_connected');
    expect(refusal).toHaveTextContent(
      'Not connected: Sending needs an email connection, which this version of ACE does not have.',
    );
    expect(within(panel).getByText(/change the finish line to “Accept the draft”/)).toBeVisible();
    expect(db.getTask(task.id)?.stage).toBe('review');
    // the finish line it has is shown as it is, with why it cannot be reached yet
    expect(screen.getByLabelText('Finish line')).toHaveDisplayValue(
      'Send the email (needs an email connection — not available yet)',
    );
  });
});

describe('ACE-P1 D276 Merge on GitHub', () => {
  function githubTask() {
    const { project, team } = seed();
    const task = inReview(project.id, {
      title: 'Search',
      finishLine: 'github_merge',
      workflowId: team.id,
    });
    return { project, task };
  }

  it('opens a pull request, then merges it after confirming the repository and base it sends', async () => {
    const { project, task } = githubTask();
    const bodies: unknown[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.url.endsWith('/merge-pr') || request.url.endsWith('/open-pr')) {
        void request
          .clone()
          .json()
          .then((json: unknown) => bodies.push(json));
      }
    });
    const user = await openTask(project.id, task.id);
    const section = screen.getByTestId('github-section');
    expect(section).toHaveTextContent(
      'Pushes the task branch ace/task-1-search and opens a pull request into main.',
    );
    expect(screen.queryByTestId('apply-section')).toBeNull();

    await user.click(within(section).getByRole('button', { name: 'Open pull request' }));
    const dialog = await screen.findByRole('dialog', { name: 'Open a pull request' });
    expect(within(dialog).getByLabelText('Title (optional)')).toHaveAttribute(
      'placeholder',
      'Search',
    );
    await user.type(within(dialog).getByLabelText('Title (optional)'), 'Accent-insensitive search');
    await user.click(within(dialog).getByLabelText('Open it as a draft'));
    await user.click(within(dialog).getByRole('button', { name: 'Open pull request' }));

    const link = await within(section).findByRole('link', { name: /Pull request #1/ });
    expect(link).toHaveAttribute('href', 'https://github.com/mock/shop/pull/1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
    expect(within(section).getByTestId('pull-request-state')).toHaveTextContent('open');
    expect(within(section).getByTestId('pull-request')).toHaveTextContent('into mock/shop @ main');

    await user.selectOptions(within(section).getByLabelText('Merge method'), 'rebase');
    await user.click(within(section).getByRole('button', { name: 'Merge on GitHub' }));
    const confirm = await screen.findByRole('dialog', { name: 'Merge pull request #1?' });
    expect(within(confirm).getByTestId('merge-destination')).toHaveTextContent('mock/shop @ main');
    expect(confirm).toHaveTextContent('Rebase and merge');
    await user.click(within(confirm).getByRole('button', { name: 'Merge on GitHub' }));

    expect(await screen.findByTestId('task-outcome')).toHaveTextContent('Merged');
    const delivered = screen.getByTestId('task-delivered');
    expect(delivered).toHaveTextContent('Merged on GitHub into mock/shop @ main');
    expect(within(delivered).getByRole('link', { name: /Pull request #1/ })).toHaveAttribute(
      'href',
      'https://github.com/mock/shop/pull/1',
    );
    expect(bodies).toEqual([
      { title: 'Accent-insensitive search', draft: true },
      { method: 'rebase', confirm: { repo: 'mock/shop', base: 'main' } },
    ]);
  });

  it('a merge GitHub did not confirm keeps the task in review, and says so', async () => {
    const { project, task } = githubTask();
    const user = await openTask(project.id, task.id);
    const section = screen.getByTestId('github-section');
    await user.click(within(section).getByRole('button', { name: 'Open pull request' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Open a pull request' })).getByRole(
        'button',
        { name: 'Open pull request' },
      ),
    );
    await within(section).findByRole('link', { name: /Pull request #1/ });

    failNextMerge('uncertain');
    await user.click(within(section).getByRole('button', { name: 'Merge on GitHub' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Merge pull request #1?' })).getByRole(
        'button',
        { name: 'Merge on GitHub' },
      ),
    );
    expect(await within(section).findByTestId('merge-uncertain')).toHaveTextContent(
      'GitHub has not confirmed the merge',
    );
    expect(screen.getByTestId('task-reason')).toHaveTextContent(
      'GitHub has not confirmed the merge of #1 (it is open). Check it on GitHub, then try Merge again.',
    );
    expect(db.getTask(task.id)).toMatchObject({ stage: 'review', state: 'idle' });
    expect(within(section).getByRole('button', { name: 'Merge on GitHub' })).toBeEnabled();
  });

  it('says plainly when GitHub is not connected', async () => {
    const { project, task } = githubTask();
    setMockGitHub({ signedIn: false });
    const user = await openTask(project.id, task.id);
    const section = screen.getByTestId('github-section');
    await user.click(within(section).getByRole('button', { name: 'Open pull request' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Open a pull request' })).getByRole(
        'button',
        { name: 'Open pull request' },
      ),
    );
    const refusal = await within(section).findByTestId('delivery-error');
    expect(refusal).toHaveAttribute('data-code', 'not_connected');
    expect(refusal).toHaveTextContent(
      'Not connected: The GitHub CLI is not signed in. Run gh auth login in a terminal.',
    );
    expect(within(section).queryByRole('link')).toBeNull();
  });
});

describe('ACE-P1 D278 the Preview tab', () => {
  it('starts the preview, links and embeds it with its output, then stops it', async () => {
    const { project, team } = seed({
      previewCommand: 'pnpm dev --port $PORT',
      previewUrl: 'http://localhost:{port}/',
    });
    const task = inReview(project.id, { title: 'Search', workflowId: team.id });
    const user = await openTask(project.id, task.id);
    await user.click(screen.getByRole('tab', { name: 'Preview' }));
    const tab = await screen.findByTestId('task-preview');
    expect(within(tab).getByTestId('preview-empty')).toBeInTheDocument();

    await user.click(within(tab).getByRole('button', { name: 'Start preview' }));
    expect(await within(tab).findByTestId('preview-status')).toHaveTextContent('running');
    const open = within(tab).getByRole('link', { name: /Open preview/ });
    expect(open).toHaveAttribute('href', 'http://localhost:5199/');
    expect(open).toHaveAttribute('target', '_blank');
    expect(open).toHaveAttribute('rel', 'noreferrer');
    expect(within(tab).getByTitle('Preview of task #1')).toHaveAttribute(
      'src',
      'http://localhost:5199/',
    );
    expect(within(tab).getByText(/headers may forbid being shown/)).toBeInTheDocument();
    expect(within(tab).getByTestId('code-body')).toHaveTextContent('$ pnpm dev --port $PORT');

    await user.click(within(tab).getByRole('button', { name: 'Stop preview' }));
    await waitFor(() =>
      expect(within(tab).getByTestId('preview-status')).toHaveTextContent('stopped'),
    );
    expect(within(tab).queryByTitle('Preview of task #1')).toBeNull();
    expect(within(tab).getByRole('button', { name: 'Start again' })).toBeEnabled();
  });

  it('is not shown when the project has no preview command', async () => {
    const { project, team } = seed();
    const task = inReview(project.id, { title: 'Search', workflowId: team.id });
    await openTask(project.id, task.id);
    expect(screen.queryByRole('tab', { name: 'Preview' })).toBeNull();
  });
});

describe('ACE-P1 D277 the Schedule card', () => {
  it('shows the trigger, next run and skipped count; edits and removes the schedule', async () => {
    const { project, team } = seed();
    const task = createTask(db, project.id, { title: 'Nightly', workflowId: team.id });
    const at = new Date(Date.now() + HOUR).toISOString();
    putSchedule(db, task.id, { trigger: { kind: 'once', at } });
    const user = await openTask(project.id, task.id);

    const card = screen.getByTestId('schedule-card');
    expect(within(card).getByTestId('schedule-trigger')).toHaveTextContent(
      `Once, on ${formatWhen(at)}`,
    );
    expect(within(card).getByTestId('schedule-next')).toHaveTextContent(formatWhen(at));
    expect(within(card).getByTestId('schedule-skipped')).toHaveTextContent('0');
    expect(screen.getByTestId('task-reason')).toHaveTextContent(`Scheduled for ${at}.`);

    await user.click(within(card).getByRole('button', { name: 'Edit schedule' }));
    expect(within(card).getByRole('radio', { name: 'At a time' })).toBeChecked();
    expect(within(card).queryByRole('radio', { name: 'Start now' })).toBeNull();
    await user.click(within(card).getByRole('radio', { name: 'Repeat' }));
    const cron = within(card).getByLabelText('Cron expression');
    await user.clear(cron);
    await user.type(cron, '0 9 31 2 *');
    await user.click(within(card).getByRole('button', { name: 'Save schedule' }));
    expect(await within(card).findByText('That cron expression never matches.')).toBeVisible();
    await user.click(within(card).getByRole('button', { name: 'Weekdays 09:00' }));
    await user.selectOptions(within(card).getByLabelText('Time zone'), 'UTC');
    await user.click(within(card).getByRole('button', { name: 'Save schedule' }));

    await waitFor(() =>
      expect(within(card).getByTestId('schedule-trigger')).toHaveTextContent(
        'Repeats on weekdays at 09:00 (UTC)',
      ),
    );
    expect(db.taskScheduleOf(task.id)).toMatchObject({
      trigger: { kind: 'recurring', cron: '0 9 * * 1-5', timezone: 'UTC' },
    });

    await user.click(within(card).getByRole('button', { name: 'Remove schedule' }));
    expect(await within(card).findByText(/Not scheduled/)).toBeInTheDocument();
    expect(db.taskScheduleOf(task.id)).toBeUndefined();
    expect(screen.queryByTestId('task-reason')).toBeNull();
  });

  it('schedules an unscheduled Inbox task to start after another task', async () => {
    const { project, team } = seed();
    const first = createTask(db, project.id, { title: 'First', workflowId: team.id });
    const task = createTask(db, project.id, { title: 'Second', workflowId: team.id });
    const user = await openTask(project.id, task.id);
    const card = screen.getByTestId('schedule-card');
    await user.click(within(card).getByRole('button', { name: 'Schedule…' }));
    await user.click(within(card).getByRole('radio', { name: 'After another task' }));
    const wait = within(card).getByLabelText('Wait for');
    await waitFor(() => expect(within(wait).getAllByRole('option')).toHaveLength(2));
    await user.selectOptions(wait, first.id);
    await user.click(within(card).getByRole('button', { name: 'Save schedule' }));
    await waitFor(() =>
      expect(within(card).getByTestId('schedule-trigger')).toHaveTextContent(
        'After #1 First reaches its finish line',
      ),
    );
    expect(within(card).getByTestId('schedule-next')).toHaveTextContent(
      'When that task reaches its finish line',
    );
  });
});

describe('ACE-P1 the source line and the delivered outcome', () => {
  it('a task from a chat links back to its workflow; an occurrence to its template', async () => {
    const { project, team } = seed();
    const fromChat = createTask(db, project.id, {
      title: 'From chat',
      source: { kind: 'chat', workflowId: team.id, label: 'Builder' },
    });
    const template = createTask(db, project.id, { title: 'Daily triage' });
    const occurrence = createTask(db, project.id, {
      title: 'Daily triage · 2026-10-07',
      source: { kind: 'schedule', refId: template.id, label: 'Daily triage' },
    });

    const view = renderApp(`/projects/${project.id}/tasks/${fromChat.id}`);
    const line = await screen.findByTestId('task-source');
    expect(line).toHaveTextContent('From a chat with Builder');
    expect(within(line).getByRole('link', { name: 'Open the workflow' })).toHaveAttribute(
      'href',
      `/projects/${project.id}/workflows/${team.id}`,
    );
    view.unmount();

    renderApp(`/projects/${project.id}/tasks/${occurrence.id}`);
    const scheduled = await screen.findByTestId('task-source');
    expect(scheduled).toHaveTextContent('Made by a schedule');
    expect(within(scheduled).getByRole('link', { name: 'Template: Daily triage' })).toHaveAttribute(
      'href',
      `/projects/${project.id}/tasks/${template.id}`,
    );
  });

  it('an applied task says where it was applied', async () => {
    const { project, team } = seed();
    const task = inReview(project.id, {
      title: 'Search',
      finishLine: 'apply_local',
      workflowId: team.id,
    });
    applyTask(db, task.id, { destination: applyDestination(db, project.id) });
    await openTask(project.id, task.id);
    const sha = db.taskDeliveriesOf(task.id).at(-1)?.sha ?? '';
    expect(screen.getByTestId('task-delivered')).toHaveTextContent(
      `Applied to /mock/projects/shop @ main as ${sha.slice(0, 7)}.`,
    );
  });
});
