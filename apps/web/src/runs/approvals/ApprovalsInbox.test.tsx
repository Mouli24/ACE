import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { startSocket, stopSocket } from '../../app/socket';
import { createFakeWebSocket } from '../../mocks/fake-socket';
import { seedPendingApproval } from '../../mocks/inbox-seed';
import { createTask, updateTask } from '../../mocks/tasks';
import { db, installMockServer, queryClient, renderApp } from '../../test/app';
import { APPROVALS_INBOX_REFETCH_MS, approvalsInboxKey } from './inbox';

/**
 * ACE parity P1 (D270): the approvals inbox in the top bar — every approval waiting across runs,
 * with links to its run and task, decided from the same card as on the Canvas.
 */

installMockServer();
afterEach(() => stopSocket());

vi.mock('../../canvas/Canvas', () => ({
  Canvas: ({ workflowId }: { workflowId: string }) => <div data-testid="canvas">{workflowId}</div>,
}));

async function settledInbox(): Promise<void> {
  await waitFor(() => expect(queryClient.getQueryData(approvalsInboxKey())).toBeDefined());
}

describe('D270 the approvals inbox', () => {
  it('is hidden while nothing waits', async () => {
    db.createProject({ name: 'Quiet' });
    renderApp('/projects');
    await settledInbox();
    expect(queryClient.getQueryData(approvalsInboxKey())).toEqual([]);
    expect(screen.queryByTestId('approvals-inbox')).toBeNull();
  });

  it('lists every pending approval across runs, links each to its run and task, and decides it', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'Shop' });
    const team = db.createWorkflow(project.id, 'Team');
    const task = createTask(db, project.id, { title: 'Ship it', workflowId: team.id });
    const fromTask = seedPendingApproval(db, {
      projectId: project.id,
      workflowId: team.id,
      taskId: task.id,
      nodeName: 'Builder',
      reason: 'run_command is a destructive tool.',
      requestedAt: '2026-10-07T10:05:00.000Z',
    });
    const plain = seedPendingApproval(db, {
      nodeName: 'Cleaner',
      reason: 'The output contains an email address.',
      preview: 'contact [email redacted]',
      requestedAt: '2026-10-07T10:01:00.000Z',
    });

    renderApp('/projects');
    const button = await screen.findByTestId('approvals-inbox');
    expect(button).toHaveAttribute('data-count', '2');
    expect(button).toHaveAccessibleName('Approvals inbox: 2 waiting');

    await user.click(button);
    const list = await screen.findByTestId('approvals-inbox-list');
    const entries = within(list).getAllByRole('listitem');
    // Oldest first: the one that has waited longest is read first.
    expect(entries.map((entry) => entry.getAttribute('data-testid'))).toEqual([
      `inbox-entry-${plain.request.id}`,
      `inbox-entry-${fromTask.request.id}`,
    ]);

    const first = within(entries[0]!);
    expect(first.getByText('Cleaner')).toBeInTheDocument();
    expect(first.getByTestId('approval-reason')).toHaveTextContent(
      'The output contains an email address.',
    );
    expect(first.getByTestId('approval-preview')).toHaveTextContent('contact [email redacted]');
    expect(first.getByRole('link', { name: 'Open run' })).toHaveAttribute(
      'href',
      `/runs/${plain.run.id}`,
    );
    expect(first.queryByRole('link', { name: 'Open task' })).toBeNull();

    const second = within(entries[1]!);
    expect(second.getByRole('link', { name: 'Open task' })).toHaveAttribute(
      'href',
      `/projects/${project.id}/tasks/${task.id}`,
    );
    expect(second.getByTestId('approval-tool-name')).toHaveTextContent('run_command');

    await user.click(first.getByRole('button', { name: /approve/i }));
    await waitFor(() =>
      expect(within(list).queryByTestId(`inbox-entry-${plain.request.id}`)).toBeNull(),
    );
    expect(screen.getByTestId('approvals-inbox')).toHaveAttribute('data-count', '1');
    expect(db.pendingApprovals(plain.run.id)).toEqual([]);

    await user.click(
      within(screen.getByTestId(`inbox-entry-${fromTask.request.id}`)).getByRole('button', {
        name: /reject/i,
      }),
    );
    expect(await screen.findByTestId('approvals-inbox-empty')).toHaveTextContent('All clear');
    expect(screen.queryByTestId('approvals-inbox')).toBeNull();
  });

  it('closes when a link is followed', async () => {
    const user = userEvent.setup();
    const { run } = seedPendingApproval(db);
    const view = renderApp('/projects');
    await user.click(await screen.findByTestId('approvals-inbox'));
    await user.click(await screen.findByRole('link', { name: 'Open run' }));
    await waitFor(() => expect(view.router.state.location.pathname).toBe(`/runs/${run.id}`));
    expect(screen.queryByTestId('approvals-inbox-list')).toBeNull();
  });

  it('refetches every 10 s and on a task.updated frame', async () => {
    const project = db.createProject({ name: 'Shop' });
    const team = db.createWorkflow(project.id, 'Team');
    const task = createTask(db, project.id, { title: 'Ship it', workflowId: team.id });
    startSocket({
      token: 'mock',
      queryClient,
      url: 'ws://mock.local/ws',
      WebSocket: createFakeWebSocket(db) as unknown as typeof WebSocket,
    });
    renderApp('/projects');
    await settledInbox();
    expect(APPROVALS_INBOX_REFETCH_MS).toBe(10_000);
    const query = queryClient.getQueryCache().find({ queryKey: approvalsInboxKey() });
    expect(query?.observers[0]?.options.refetchInterval).toBe(10_000);
    expect(screen.queryByTestId('approvals-inbox')).toBeNull();

    // A card raised without a frame of its own; the task's next frame brings the inbox up to date.
    seedPendingApproval(db, { projectId: project.id, workflowId: team.id, taskId: task.id });
    act(() => {
      updateTask(db, task.id, { title: 'Ship it now' });
    });
    expect(await screen.findByTestId('approvals-inbox')).toHaveAttribute('data-count', '1');
  });
});
