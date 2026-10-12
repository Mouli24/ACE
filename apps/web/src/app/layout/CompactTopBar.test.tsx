import type { ApprovalRequest } from '@ace/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { installMatchMedia, uninstallMatchMedia } from '../../responsive/test-support';
import { useRunStore } from '../../runs/run-store';
import { db, installMockServer, renderApp } from '../../test/app';
import { api } from '../api';

installMockServer();

vi.mock('../../canvas/Canvas', () => ({
  Canvas: ({ workflowId }: { workflowId: string }) => <div data-testid="canvas">{workflowId}</div>,
}));

beforeEach(() => {
  installMatchMedia(true);
});
afterEach(() => {
  uninstallMatchMedia();
  useRunStore.getState().reset();
  vi.restoreAllMocks();
});

function seed() {
  const project = db.createProject({ name: 'Phone project' });
  const workflow = db.createWorkflow(project.id, 'Phone flow');
  return { project, workflow, path: `/projects/${project.id}/workflows/${workflow.id}` };
}

describe('FR-MOB-001 the phone header', () => {
  it('wears the theme tokens: the mark, ACE to Home and the project', async () => {
    const { project } = seed();
    renderApp(`/projects/${project.id}`);
    const bar = await screen.findByTestId('topbar-compact');
    expect(bar).toHaveClass('bg-[var(--hdr)]', 'border-[var(--line)]');
    expect(within(bar).getByRole('link', { name: 'ACE' })).toHaveAttribute('href', '/projects');
    const name = await within(bar).findByTestId('project-name');
    expect(name).toHaveTextContent('Phone project');
    expect(name).toHaveAttribute('href', `/projects/${project.id}`);
  });

  it('folds the links into one "…" menu, with provider status and the day’s totals on top', async () => {
    const user = userEvent.setup();
    const { project } = seed();
    db.createProvider({ type: 'mock', name: 'Mock' });
    renderApp(`/projects/${project.id}`);
    const menu = await screen.findByTestId('topbar-menu');
    expect(menu).toHaveAccessibleName('Menu');
    expect(menu).toHaveClass('min-h-11', 'min-w-11');
    expect(screen.queryByRole('link', { name: 'Usage' })).toBeNull();

    await user.click(menu);
    const routes: Record<string, string> = {
      Runs: `/projects/${project.id}/runs`,
      Usage: '/usage',
      'Guardrail policies': '/guardrails',
      // the settings gear's links (D338): the phone bar has no gear in its corner
      Providers: '/providers',
      Onboarding: '/onboarding',
      Settings: '/settings',
      Help: '/help/getting-started',
    };
    for (const [name, href] of Object.entries(routes)) {
      expect(await screen.findByRole('menuitem', { name })).toHaveAttribute('href', href);
    }
    const status = screen.getByTestId('topbar-menu-status');
    expect(await within(status).findByTestId('provider-status-bar')).toBeInTheDocument();
    // the chip shows at phone width (it used to hide below lg)
    const chip = await within(status).findByTestId('day-totals-chip');
    expect(chip).toHaveClass('inline-flex');
    expect(chip).not.toHaveClass('hidden');
  });

  it('inside a workflow, gives the mode switch and the run bar a row of their own', async () => {
    const { path } = seed();
    renderApp(path);
    const bar = await screen.findByTestId('topbar-compact');
    expect(within(bar).getByTestId('mode-switch')).toBeInTheDocument();
    const run = within(bar).getByTestId('run-bar');
    expect(within(run).getByRole('button', { name: 'Start run' })).toBeInTheDocument();
  });

  it('FR-MOB-002: the approvals waiting stay in sight and open the same cards', async () => {
    const user = userEvent.setup();
    const { workflow, path } = seed();
    const request: ApprovalRequest = {
      id: 'REQ1',
      runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      nodeRunId: 'NR1',
      nodeId: 'N1',
      nodeName: 'Cleaner',
      point: 'output',
      checkType: 'pii',
      reason: 'An email address.',
      preview: 'mail me at a@b.c',
      requestedAt: '2026-09-29T10:00:00.000Z',
    };
    const list = vi.spyOn(api(), 'listApprovals').mockResolvedValue([request]);
    renderApp(path);
    await screen.findByTestId('topbar-compact');
    act(() =>
      useRunStore.setState({ workflowId: workflow.id, runId: request.runId, status: 'RUNNING' }),
    );
    const badge = await screen.findByTestId('approvals-badge');
    expect(badge).toHaveAccessibleName('1 approval waiting');
    expect(badge).toHaveAttribute('data-count', '1');
    expect(badge).toHaveClass('min-h-11', 'min-w-11');
    await user.click(badge);
    expect(await screen.findByTestId('approvals-list')).toHaveTextContent('One node is waiting');

    // decided elsewhere: the badge and its dialog go
    list.mockResolvedValue([]);
    act(() => useRunStore.setState({ revision: useRunStore.getState().revision + 1 }));
    await waitFor(() => expect(screen.queryByTestId('approvals-badge')).toBeNull());
    expect(screen.queryByTestId('approvals-list')).toBeNull();
  });
});
