import { aceError } from '@ace/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';

import { startSocket, stopSocket } from '../../app/socket';
import { createFakeWebSocket } from '../../mocks/fake-socket';
import {
  completeMockScan,
  createResponsibility,
  listResponsibilities,
  listSuggestions,
  scanResponsibility,
  seedSuggestion,
  setScanPace,
} from '../../mocks/suggestions';
import {
  completeMockWork,
  createTask,
  failNextChecks,
  failNextWork,
  setTaskWorkPace,
  workTask,
} from '../../mocks/tasks';
import { db, installMockServer, queryClient, renderApp, server } from '../../test/app';

installMockServer();

beforeEach(() => {
  setTaskWorkPace('manual');
  setScanPace('manual');
});
afterEach(() => stopSocket());

/**
 * The Suggestions page (ACE parity P2, D280): responsibilities with Scan now / Cancel / Watch /
 * pause / edit / delete and their last scan, and the suggestions a scan found, each with its
 * reason, evidence, proposed action and completion criteria, added to the Inbox, kept for later or
 * dismissed — against the mock engine through the real SDK.
 */

function seedProject() {
  const project = db.createProject({ name: 'Shop' });
  const team = db.createWorkflow(project.id, 'Builders');
  return { project, team };
}

/** Task #1 fails its work run; task #2 lands in review with its "test" check failing. */
function seedFailures(projectId: string, teamId: string) {
  const stuck = createTask(db, projectId, { title: 'Add filters', workflowId: teamId });
  failNextWork('The model ran out of budget.');
  workTask(db, stuck.id);
  completeMockWork(stuck.id);
  const red = createTask(db, projectId, { title: 'Fix search', workflowId: teamId });
  workTask(db, red.id);
  failNextChecks();
  completeMockWork(red.id);
  return { stuck, red };
}

const card = (title: string) => screen.findByRole('article', { name: title });

describe('ACE-P2 D280 responsibilities', () => {
  it('starts empty, and the project navigation marks Suggestions', async () => {
    const { project } = seedProject();
    renderApp(`/projects/${project.id}/suggestions`);
    expect(await screen.findByRole('heading', { name: 'Suggestions', level: 1 })).toBeVisible();
    expect(await screen.findByTestId('responsibilities-empty')).toBeInTheDocument();
    expect(await screen.findByTestId('suggestions-empty')).toHaveTextContent('Nothing found yet');
    const nav = screen.getByRole('navigation', { name: 'Project' });
    expect(within(nav).getByRole('link', { name: 'Suggestions' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Notes' })).toHaveAttribute(
      'href',
      `/projects/${project.id}/notes`,
    );
  });

  it('adds a responsibility from the dialog; saving it scans nothing', async () => {
    const user = userEvent.setup();
    const { project } = seedProject();
    renderApp(`/projects/${project.id}/suggestions`);
    await user.click(await screen.findByRole('button', { name: 'New responsibility' }));
    const dialog = await screen.findByRole('dialog', { name: 'New responsibility' });

    // The title is required; the contract says so before anything leaves.
    await user.click(within(dialog).getByRole('button', { name: 'Add responsibility' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Say what ACE should watch');
    expect(listResponsibilities(db, project.id)).toEqual([]);

    await user.type(within(dialog).getByLabelText('What to watch'), 'Keep checks green');
    await user.type(within(dialog).getByLabelText('Why it matters'), 'Red checks block delivery.');
    await user.type(
      within(dialog).getByLabelText('What useful work looks like'),
      'Every check passes.',
    );
    await user.click(within(dialog).getByRole('checkbox', { name: 'Watch automatically' }));
    await user.selectOptions(within(dialog).getByLabelText('Scan every'), '30');
    await user.click(within(dialog).getByRole('button', { name: 'Add responsibility' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(listResponsibilities(db, project.id)).toEqual([
      expect.objectContaining({
        kind: 'software_health',
        title: 'Keep checks green',
        why: 'Red checks block delivery.',
        goodWork: 'Every check passes.',
        watch: true,
        watchIntervalMinutes: 30,
      }),
    ]);
    const added = await card('Keep checks green');
    expect(within(added).getByTestId('last-scan')).toHaveTextContent('Not scanned yet.');
    expect(within(added).getByTestId('responsibility-watching')).toHaveTextContent(
      'every 30 minutes',
    );
    expect(within(added).getByText('Every check passes.')).toBeInTheDocument();
  });

  it('Scan now runs, follows the scan while it runs, and shows what it found', async () => {
    const user = userEvent.setup();
    const { project, team } = seedProject();
    seedFailures(project.id, team.id);
    const owner = createResponsibility(db, project.id, {
      kind: 'software_health',
      title: 'Keep checks green',
      goodWork: 'Every check passes.',
    });
    renderApp(`/projects/${project.id}/suggestions`);
    const row = await card('Keep checks green');
    await user.click(within(row).getByRole('button', { name: 'Scan now' }));

    expect(await within(row).findByRole('button', { name: 'Cancel scan' })).toBeInTheDocument();
    expect(within(row).getByTestId('last-scan')).toHaveAttribute('data-status', 'running');
    expect(within(row).getByTestId('last-scan')).toHaveTextContent('Scanning');

    // No socket here: the page polls while the scan runs, and refreshes the suggestions after.
    completeMockScan(owner.id);
    await waitFor(
      () =>
        expect(within(row).getByTestId('last-scan')).toHaveTextContent(
          'Last scan completed — Found 2 new suggestions.',
        ),
      { timeout: 4_000 },
    );
    const list = await screen.findByRole('list', { name: 'Suggestions' });
    await waitFor(() => expect(within(list).getAllByRole('article')).toHaveLength(2));
    expect(within(row).getByRole('button', { name: 'Scan now' })).toBeInTheDocument();
  });

  it('Cancel stops a running scan', async () => {
    const user = userEvent.setup();
    const { project } = seedProject();
    createResponsibility(db, project.id, { kind: 'software_health', title: 'Keep checks green' });
    renderApp(`/projects/${project.id}/suggestions`);
    const row = await card('Keep checks green');
    await user.click(within(row).getByRole('button', { name: 'Scan now' }));
    await user.click(await within(row).findByRole('button', { name: 'Cancel scan' }));
    await waitFor(() =>
      expect(within(row).getByTestId('last-scan')).toHaveTextContent(
        'Last scan cancelled — The scan was cancelled.',
      ),
    );
  });

  it('shows the engine refusal when an email responsibility is scanned', async () => {
    const user = userEvent.setup();
    const { project } = seedProject();
    createResponsibility(db, project.id, {
      kind: 'email',
      title: 'Customer mail',
      query: 'to:support@example.com',
    });
    renderApp(`/projects/${project.id}/suggestions`);
    const row = await card('Customer mail');
    expect(within(row).getByText('to:support@example.com')).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Scan now' }));
    expect(await within(row).findByRole('alert')).toHaveTextContent(
      'Watching email needs a mail connection',
    );
  });

  it('turns watching on with an interval, and pauses it', async () => {
    const user = userEvent.setup();
    const { project } = seedProject();
    const owner = createResponsibility(db, project.id, {
      kind: 'software_health',
      title: 'Keep checks green',
    });
    renderApp(`/projects/${project.id}/suggestions`);
    const row = await card('Keep checks green');
    await user.click(within(row).getByRole('checkbox', { name: 'Watch automatically' }));
    await waitFor(() => expect(listResponsibilities(db, project.id)[0]?.watch).toBe(true));
    await user.selectOptions(within(row).getByLabelText('every'), '120');
    await waitFor(() =>
      expect(listResponsibilities(db, project.id)[0]?.watchIntervalMinutes).toBe(120),
    );
    expect(await within(row).findByTestId('responsibility-watching')).toHaveTextContent(
      'every 2 hours',
    );

    await user.click(within(row).getByRole('button', { name: 'Pause watching' }));
    await waitFor(() => expect(listResponsibilities(db, project.id)[0]?.paused).toBe(true));
    expect(await within(row).findByTestId('responsibility-paused')).toBeInTheDocument();
    expect(within(row).queryByTestId('responsibility-watching')).toBeNull();
    await user.click(within(row).getByRole('button', { name: 'Resume watching' }));
    await waitFor(() => expect(listResponsibilities(db, project.id)[0]?.paused).toBe(false));
    expect(owner.id).toBe(listResponsibilities(db, project.id)[0]?.id);
  });

  it('edits a responsibility, and deletes it with its suggestions after asking', async () => {
    const user = userEvent.setup();
    const { project } = seedProject();
    const owner = createResponsibility(db, project.id, {
      kind: 'software_health',
      title: 'Keep checks green',
    });
    seedSuggestion(db, owner, { title: 'Unblock task #1: Add filters' });
    renderApp(`/projects/${project.id}/suggestions`);

    await user.click(await screen.findByRole('button', { name: 'Edit Keep checks green' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit responsibility' });
    // The kind is fixed once saved.
    expect(within(dialog).getByRole('radio', { name: 'Email' })).toBeDisabled();
    const title = within(dialog).getByLabelText('What to watch');
    await user.clear(title);
    await user.type(title, 'Keep main green');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(listResponsibilities(db, project.id)[0]?.title).toBe('Keep main green'),
    );

    await user.click(await screen.findByRole('button', { name: 'Delete Keep main green' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete "Keep main green"?' });
    expect(within(confirm).getByText(/suggestions are deleted with it/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Delete responsibility' }));
    await waitFor(() => expect(listResponsibilities(db, project.id)).toEqual([]));
    expect(await screen.findByTestId('responsibilities-empty')).toBeInTheDocument();
    expect(listSuggestions(db, project.id)).toEqual([]);
    await waitFor(() => expect(screen.getByTestId('suggestions-empty')).toBeInTheDocument());
  });

  it('follows project.changed from the engine without a reload', async () => {
    const { project } = seedProject();
    startSocket({
      token: 'mock',
      queryClient,
      url: 'ws://mock.local/ws',
      WebSocket: createFakeWebSocket(db) as unknown as typeof WebSocket,
    });
    renderApp(`/projects/${project.id}/suggestions`);
    await screen.findByTestId('responsibilities-empty');
    // Added elsewhere (another tab, the engine): the engine announces it, the page refetches.
    createResponsibility(db, project.id, { kind: 'software_health', title: 'Keep checks green' });
    expect(await card('Keep checks green')).toBeInTheDocument();
  });

  it('shows the error when the responsibilities cannot be read', async () => {
    const { project } = seedProject();
    server.use(
      http.get('*/api/v1/projects/:id/responsibilities', () =>
        HttpResponse.json(aceError('provider', 'internal', 'The engine hit an unexpected error.'), {
          status: 500,
        }),
      ),
    );
    renderApp(`/projects/${project.id}/suggestions`);
    expect(await screen.findByText(/Could not load responsibilities/)).toHaveTextContent(
      'The engine hit an unexpected error.',
    );
  });
});

describe('ACE-P2 D280 suggestions', () => {
  function scanned() {
    const { project, team } = seedProject();
    const { stuck, red } = seedFailures(project.id, team.id);
    const owner = createResponsibility(db, project.id, {
      kind: 'software_health',
      title: 'Keep checks green',
      goodWork: 'Every check passes.',
    });
    scanResponsibility(db, owner.id);
    completeMockScan(owner.id);
    return { project, team, owner, stuck, red };
  }

  it('shows the reason, evidence, proposed action and completion criteria', async () => {
    const { project, red } = scanned();
    renderApp(`/projects/${project.id}/suggestions`);
    const item = await card('Fix the failing "test" check on task #2');
    expect(within(item).getByTestId('suggestion-status')).toHaveTextContent('New');
    expect(within(item).getByText('from “Keep checks green”')).toBeInTheDocument();
    expect(within(item).getByText(/The "test" check \(npm test\) failed/)).toBeInTheDocument();
    expect(within(item).getByText('Failed check')).toBeInTheDocument();
    expect(within(item).getByText(/Check "test" failed on task #2/)).toBeInTheDocument();
    expect(within(item).getByRole('link', { name: 'open the task' })).toHaveAttribute(
      'href',
      `/projects/${project.id}/tasks/${red.id}`,
    );
    expect(within(item).getByText(/Find the cause and make it pass/)).toBeInTheDocument();
    expect(within(item).getByText('Every check passes.')).toBeInTheDocument();
    expect(within(item).getByText('Details')).toBeInTheDocument();
  });

  it('Add to Inbox makes an Inbox task with the chosen team and links to it', async () => {
    const user = userEvent.setup();
    const { project, team } = scanned();
    renderApp(`/projects/${project.id}/suggestions`);
    const item = await card('Unblock task #1: Add filters');
    await user.selectOptions(within(item).getByLabelText('Team for the task'), team.id);
    await user.click(within(item).getByRole('button', { name: 'Add to Inbox' }));

    const banner = await screen.findByTestId('suggestion-accepted');
    const accepted = listSuggestions(db, project.id, 'accepted')[0];
    expect(accepted?.taskId).toBeDefined();
    const task = db.getTask(accepted!.taskId!);
    expect(task).toMatchObject({
      title: 'Unblock task #1: Add filters',
      stage: 'inbox',
      state: 'idle',
      workflowId: team.id,
      finishLine: 'review',
      source: { kind: 'suggestion', refId: accepted!.id, label: 'Keep checks green' },
    });
    expect(within(banner).getByRole('link', { name: 'Open the task' })).toHaveAttribute(
      'href',
      `/projects/${project.id}/tasks/${task!.id}`,
    );
    // It left the New list.
    await waitFor(() =>
      expect(screen.queryByRole('article', { name: 'Unblock task #1: Add filters' })).toBeNull(),
    );

    // Under "Added to Inbox" it says so and links to the task.
    await user.selectOptions(screen.getByLabelText('Show suggestions'), 'accepted');
    const done = await card('Unblock task #1: Add filters');
    expect(within(done).getByTestId('suggestion-status')).toHaveTextContent('Added to Inbox');
    expect(within(done).getByRole('link', { name: 'Open the task' })).toHaveAttribute(
      'href',
      `/projects/${project.id}/tasks/${task!.id}`,
    );
    expect(within(done).queryByRole('button', { name: 'Add to Inbox' })).toBeNull();

    // The board shows it in the Inbox.
    await user.click(
      within(screen.getByRole('navigation', { name: 'Project' })).getByRole('link', {
        name: 'Tasks',
      }),
    );
    const inbox = await screen.findByTestId('column-inbox');
    expect(await within(inbox).findByText('Unblock task #1: Add filters')).toBeInTheDocument();
  });

  it('Later keeps it out of the way; Dismiss is final', async () => {
    const user = userEvent.setup();
    const { project } = scanned();
    renderApp(`/projects/${project.id}/suggestions`);
    const later = await card('Unblock task #1: Add filters');
    await user.click(within(later).getByRole('button', { name: 'Later' }));
    await waitFor(() =>
      expect(listSuggestions(db, project.id, 'later').map((s) => s.title)).toEqual([
        'Unblock task #1: Add filters',
      ]),
    );
    const dismissed = await card('Fix the failing "test" check on task #2');
    await user.click(within(dismissed).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.getByTestId('suggestions-empty')).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText('Show suggestions'), 'later');
    const kept = await card('Unblock task #1: Add filters');
    // A later one can still be added or dismissed, but not put off again.
    expect(within(kept).getByRole('button', { name: 'Add to Inbox' })).toBeInTheDocument();
    expect(within(kept).queryByRole('button', { name: 'Later' })).toBeNull();

    await user.selectOptions(screen.getByLabelText('Show suggestions'), 'dismissed');
    const gone = await card('Fix the failing "test" check on task #2');
    expect(within(gone).getByText(/will not suggest this again/)).toBeInTheDocument();
    expect(within(gone).queryByRole('button', { name: 'Add to Inbox' })).toBeNull();
  });

  it('shows the engine refusal when a decision is refused', async () => {
    const user = userEvent.setup();
    const { project } = scanned();
    server.use(
      http.post('*/api/v1/suggestions/:id/accept', () =>
        HttpResponse.json(
          aceError('workflow', 'invalid_task_state', 'This suggestion was already dismissed.'),
          { status: 409 },
        ),
      ),
    );
    renderApp(`/projects/${project.id}/suggestions`);
    const item = await card('Unblock task #1: Add filters');
    await user.click(within(item).getByRole('button', { name: 'Add to Inbox' }));
    expect(await within(item).findByRole('alert')).toHaveTextContent(
      'This suggestion was already dismissed.',
    );
    expect(screen.queryByTestId('suggestion-accepted')).toBeNull();
  });
});
