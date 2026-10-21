import type { ApprovalRequest, Run } from '@ace/contracts';
import { Toaster } from '@ace/ui';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter, useParams } from 'react-router-dom';

import { createNode } from '../../nodes/factory';
import { useRunStore } from '../../runs/run-store';
import { db, installMockServer, renderWithQuery } from '../../test/app';
import { downloadWorkflowExport } from '../../workflows/export';
import { api } from '../api';
import { usePanelsStore } from '../stores/panels';
import { WorkspaceMenu } from './WorkspaceMenu';

installMockServer();

vi.mock('../../workflows/export', () => ({
  downloadWorkflowExport: vi.fn(() => Promise.resolve()),
}));

afterEach(() => {
  useRunStore.getState().reset();
  vi.restoreAllMocks();
  vi.mocked(downloadWorkflowExport).mockClear();
});

const RUN_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

function MenuHost() {
  const { projectId = '', workflowId = '' } = useParams();
  return <WorkspaceMenu projectId={projectId} workflowId={workflowId} />;
}

/** The menu on a workflow route, as the canvas breadcrumb renders it; anywhere else is a probe. */
function renderMenu(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/projects/:projectId/workflows/:workflowId/*', element: <MenuHost /> },
      { path: '*', element: <p data-testid="elsewhere" /> },
    ],
    { initialEntries: [path] },
  );
  renderWithQuery(
    <>
      <RouterProvider router={router} />
      <Toaster />
    </>,
  );
  return router;
}

function seed() {
  const project = db.createProject({ name: 'Shop' });
  const main = db.createWorkflow(project.id, 'Main');
  const second = db.createWorkflow(project.id, 'Second');
  return { project, main, second, ideate: `/projects/${project.id}/workflows/${main.id}` };
}

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByTestId('workspace-menu'));
  return screen.findByRole('menu');
}

/** Wait for an item that needs a query to land (the workflow list, the project, approvals). */
async function item(user: ReturnType<typeof userEvent.setup>, testId: string) {
  await open(user);
  return screen.findByTestId(testId);
}

function liveRun(workflowId: string, over: Partial<ReturnType<typeof useRunStore.getState>> = {}) {
  act(() =>
    useRunStore.setState({
      workflowId,
      runId: RUN_ID,
      status: 'RUNNING',
      allowedActions: ['pause', 'stop'],
      active: true,
      ...over,
    }),
  );
}

describe('D331 the workspace menu', () => {
  it('is the theme’s "…" pill, named for assistive tech, with a section label per group', async () => {
    const user = userEvent.setup();
    renderMenu(seed().ideate);
    const trigger = await screen.findByTestId('workspace-menu');
    expect(trigger).toHaveAccessibleName('Workspace menu');
    // PG-1.2 (D360): the "…" is an SVG icon now, not the glyph
    expect(trigger.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(trigger.textContent?.trim()).toBe('');
    expect(trigger).toHaveClass(
      'h-6',
      'rounded-full',
      'border-[var(--line)]',
      'bg-[var(--soft)]',
      'px-[9px]',
      'text-[11px]',
    );
    const menu = await open(user);
    for (const label of ['Workflows', 'This workflow', 'Run', 'Panels', 'Project', 'ACE']) {
      expect(within(menu).getByText(label)).toBeInTheDocument();
    }
  });

  describe('Workflows', () => {
    it('lists every workflow with a check on the current one; picking another keeps the mode', async () => {
      const user = userEvent.setup();
      const { project, main, second, ideate } = seed();
      const router = renderMenu(`${ideate}/forge`);
      const current = await item(user, `menu-workflow-${main.id}`);
      expect(current).toHaveAttribute('role', 'menuitemradio');
      expect(current).toHaveAttribute('aria-checked', 'true');
      // PG-1.2 (D360): the ✓ is an SVG check icon now
      expect(current).toHaveTextContent('Main');
      expect(current.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
      const other = screen.getByTestId(`menu-workflow-${second.id}`);
      expect(other).toHaveAttribute('aria-checked', 'false');
      expect(other.querySelector('svg')).toBeNull();
      await user.click(other);
      await waitFor(() =>
        expect(router.state.location.pathname).toBe(
          `/projects/${project.id}/workflows/${second.id}/forge`,
        ),
      );
    });

    it('TC-WF-001: New workflow… creates one and opens it', async () => {
      const user = userEvent.setup();
      const { project, ideate } = seed();
      const router = renderMenu(ideate);
      await user.click(await item(user, 'menu-new-workflow'));
      const dialog = await screen.findByRole('dialog');
      await user.type(within(dialog).getByLabelText(/name/i), 'Flow 3');
      await user.click(within(dialog).getByRole('button', { name: /create/i }));
      const created = await waitFor(() => {
        const found = db.listWorkflows(project.id).find((w) => w.name === 'Flow 3');
        expect(found).toBeDefined();
        return found!;
      });
      await waitFor(() =>
        expect(router.state.location.pathname).toBe(
          `/projects/${project.id}/workflows/${created.id}`,
        ),
      );
    });

    it('FR-WF-008: Import workflow… reads the chosen export, creates the workflow and opens it', async () => {
      const user = userEvent.setup();
      const { project, main, ideate } = seed();
      const node = createNode('input', main.id, { x: 1, y: 2 });
      const exported = {
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        name: 'Imported',
        nodes: [node],
        edges: [],
      };
      const router = renderMenu(ideate);
      const input = await screen.findByLabelText('Import workflow JSON');
      const click = vi.spyOn(input, 'click');
      await user.click(await item(user, 'menu-import-workflow'));
      expect(click).toHaveBeenCalled();
      await user.upload(
        input,
        new File([JSON.stringify(exported)], 'flow.ace.json', { type: 'application/json' }),
      );
      await waitFor(() => expect(db.listWorkflows(project.id)).toHaveLength(3));
      const imported = db.listWorkflows(project.id).find((w) => w.name === 'Imported')!;
      await waitFor(() =>
        expect(router.state.location.pathname).toBe(
          `/projects/${project.id}/workflows/${imported.id}`,
        ),
      );
    });

    it('TC-WF-008: an unsupported export says why in a toast and creates nothing', async () => {
      const user = userEvent.setup();
      const { project, ideate } = seed();
      renderMenu(ideate);
      await user.upload(
        await screen.findByLabelText('Import workflow JSON'),
        new File(
          [JSON.stringify({ formatVersion: 99, exportedAt: 'x', name: 'n', nodes: [], edges: [] })],
          'old.ace.json',
          { type: 'application/json' },
        ),
      );
      expect(await screen.findByText(/format version 99/i)).toBeInTheDocument();
      expect(db.listWorkflows(project.id)).toHaveLength(2);
    });
  });

  describe('This workflow (TC-WF-003)', () => {
    it('Rename… renames it', async () => {
      const user = userEvent.setup();
      const { project, ideate } = seed();
      renderMenu(ideate);
      await user.click(await item(user, 'menu-rename-workflow'));
      const dialog = await screen.findByRole('dialog');
      const input = within(dialog).getByLabelText(/name/i);
      await user.clear(input);
      await user.type(input, 'Gamma');
      await user.click(within(dialog).getByRole('button', { name: /save/i }));
      await waitFor(() =>
        expect(db.listWorkflows(project.id).map((w) => w.name)).toEqual(['Gamma', 'Second']),
      );
    });

    it('Duplicate makes a copy and opens it in the same mode', async () => {
      const user = userEvent.setup();
      const { project, ideate } = seed();
      const router = renderMenu(`${ideate}/forge`);
      await user.click(await item(user, 'menu-duplicate-workflow'));
      const copy = await waitFor(() => {
        const found = db.listWorkflows(project.id).find((w) => w.name === 'Main (copy)');
        expect(found).toBeDefined();
        return found!;
      });
      await waitFor(() =>
        expect(router.state.location.pathname).toBe(
          `/projects/${project.id}/workflows/${copy.id}/forge`,
        ),
      );
    });

    it('Export JSON downloads this workflow’s export (FR-WF-007)', async () => {
      const user = userEvent.setup();
      const { main, ideate } = seed();
      renderMenu(ideate);
      await user.click(await item(user, 'menu-export-workflow'));
      expect(downloadWorkflowExport).toHaveBeenCalledWith(main.id, 'Main');
    });

    it('Delete… asks, deletes it and leaves for the project page', async () => {
      const user = userEvent.setup();
      const { project, ideate } = seed();
      const router = renderMenu(ideate);
      const remove = await item(user, 'menu-delete-workflow');
      expect(remove).toHaveClass('text-[#c94c27]');
      await user.click(remove);
      const confirm = await screen.findByRole('dialog');
      await user.click(within(confirm).getByRole('button', { name: /delete/i }));
      await waitFor(() => expect(router.state.location.pathname).toBe(`/projects/${project.id}`));
      expect(db.listWorkflows(project.id).map((w) => w.name)).toEqual(['Second']);
    });
  });

  describe('Run (FR-EXE-001, FR-CTL-001..004, FR-GRD-013)', () => {
    it('Start run starts this workflow’s run when none is active', async () => {
      const user = userEvent.setup();
      const { main, ideate } = seed();
      const start = vi
        .spyOn(api(), 'startRun')
        .mockResolvedValue({ id: RUN_ID, status: 'RUNNING' } as Run);
      renderMenu(ideate);
      const menu = await open(user);
      expect(within(menu).queryByTestId('menu-run-pause')).toBeNull();
      expect(within(menu).queryByTestId('menu-run-details')).toBeNull();
      await user.click(within(menu).getByTestId('menu-start-run'));
      await waitFor(() => expect(start).toHaveBeenCalledWith(main.id, {}));
    });

    it('Start run asks for the Input node’s text first (FR-NODE-011)', async () => {
      const user = userEvent.setup();
      const { main, ideate } = seed();
      const input = createNode('input', main.id, { x: 0, y: 0 });
      db.commitGraph(main.id, [input], []);
      const start = vi
        .spyOn(api(), 'startRun')
        .mockResolvedValue({ id: RUN_ID, status: 'RUNNING' } as Run);
      renderMenu(ideate);
      // the graph must be in before Start can see the Input node
      await waitFor(async () => {
        await open(user);
        await user.click(screen.getByTestId('menu-start-run'));
        expect(await screen.findByTestId('run-input-dialog')).toBeInTheDocument();
      });
      const dialog = screen.getByTestId('run-input-dialog');
      await user.type(within(dialog).getByRole('textbox'), 'hello');
      await user.click(within(dialog).getByRole('button', { name: 'Start run' }));
      await waitFor(() =>
        expect(start).toHaveBeenCalledWith(main.id, {
          inputs: { [input.id]: [{ type: 'text', text: 'hello' }] },
        }),
      );
    });

    it('offers exactly the run’s allowedActions while it is active, and no Start', async () => {
      const user = userEvent.setup();
      const { main, ideate } = seed();
      renderMenu(ideate);
      liveRun(main.id);
      const menu = await open(user);
      expect(within(menu).queryByTestId('menu-start-run')).toBeNull();
      expect(within(menu).getByTestId('menu-run-pause')).toHaveTextContent('Pause');
      expect(within(menu).getByTestId('menu-run-stop')).toHaveTextContent('Stop…');
      for (const absent of ['resume', 'restart', 'end']) {
        expect(within(menu).queryByTestId(`menu-run-${absent}`)).toBeNull();
      }
    });

    it('Pause, Resume, Restart and End send their control; a restart selects the new run in place (D360)', async () => {
      const user = userEvent.setup();
      const { main, ideate } = seed();
      const answer = (status: Run['status']) =>
        ({ id: RUN_ID, workflowId: main.id, status }) as Run;
      const pause = vi.spyOn(api(), 'pauseRun').mockResolvedValue(answer('PAUSED'));
      const resume = vi.spyOn(api(), 'resumeRun').mockResolvedValue(answer('RUNNING'));
      const end = vi.spyOn(api(), 'endRun').mockResolvedValue(answer('COMPLETE'));
      const NEW_RUN = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
      const restart = vi.spyOn(api(), 'restartRun').mockResolvedValue({
        ...answer('RUNNING'),
        id: NEW_RUN,
        restartedFromRunId: RUN_ID,
      } as Run);
      const router = renderMenu(ideate);

      liveRun(main.id, { allowedActions: ['pause', 'stop', 'end'] });
      await user.click(await item(user, 'menu-run-pause'));
      await waitFor(() => expect(pause).toHaveBeenCalledWith(RUN_ID));

      liveRun(main.id, { status: 'PAUSED', allowedActions: ['resume', 'stop'] });
      await user.click(await item(user, 'menu-run-resume'));
      await waitFor(() => expect(resume).toHaveBeenCalledWith(RUN_ID));

      liveRun(main.id, { allowedActions: ['pause', 'stop', 'end'] });
      await user.click(await item(user, 'menu-run-end'));
      await waitFor(() => expect(end).toHaveBeenCalledWith(RUN_ID));

      liveRun(main.id, { status: 'HALTED', allowedActions: ['restart'], active: false });
      const menu = await open(user);
      // a finished run can start afresh or restart
      expect(within(menu).getByTestId('menu-start-run')).toBeInTheDocument();
      await user.click(within(menu).getByTestId('menu-run-restart'));
      await waitFor(() => expect(restart).toHaveBeenCalledWith(RUN_ID));
      // PG-3.5 (D360): the restart keeps the mode — Ideate, with the new run selected.
      await waitFor(() => expect(router.state.location.search).toBe(`?run=${NEW_RUN}`));
      expect(router.state.location.pathname).toBe(ideate);
    });

    it('Stop… asks first in the run controls’ words; Keep running sends nothing', async () => {
      const user = userEvent.setup();
      const { main, ideate } = seed();
      const stop = vi
        .spyOn(api(), 'stopRun')
        .mockResolvedValue({ id: RUN_ID, workflowId: main.id, status: 'HALTED' } as Run);
      renderMenu(ideate);
      liveRun(main.id);

      await user.click(await item(user, 'menu-run-stop'));
      let confirm = await screen.findByTestId('stop-confirm');
      expect(within(confirm).getByText('Stop this run?')).toBeInTheDocument();
      await user.click(within(confirm).getByRole('button', { name: 'Keep running' }));
      await waitFor(() => expect(screen.queryByTestId('stop-confirm')).toBeNull());
      expect(stop).not.toHaveBeenCalled();

      await user.click(await item(user, 'menu-run-stop'));
      confirm = await screen.findByTestId('stop-confirm');
      await user.click(within(confirm).getByRole('button', { name: 'Stop the run' }));
      await waitFor(() => expect(stop).toHaveBeenCalledWith(RUN_ID));
    });

    it('Approvals (N)… opens the waiting approvals; Run details opens the run', async () => {
      const user = userEvent.setup();
      const { main, ideate } = seed();
      const request: ApprovalRequest = {
        id: 'REQ1',
        runId: RUN_ID,
        nodeRunId: 'NR1',
        nodeId: 'N1',
        nodeName: 'Cleaner',
        point: 'output',
        checkType: 'pii',
        reason: 'An email address.',
        preview: 'mail me at a@b.c',
        requestedAt: '2026-09-29T10:00:00.000Z',
      };
      vi.spyOn(api(), 'listApprovals').mockResolvedValue([request]);
      const router = renderMenu(ideate);
      liveRun(main.id);

      const approvals = await item(user, 'menu-approvals');
      expect(approvals).toHaveTextContent('Approvals (1)…');
      await user.click(approvals);
      const list = await screen.findByTestId('approvals-list');
      expect(within(list).getByText('One node is waiting')).toBeInTheDocument();
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByTestId('approvals-list')).toBeNull());

      await user.click(await item(user, 'menu-run-details'));
      await waitFor(() => expect(router.state.location.pathname).toBe(`/runs/${RUN_ID}`));
    });

    it('has no Approvals item when nothing is waiting', async () => {
      const user = userEvent.setup();
      const { main, ideate } = seed();
      vi.spyOn(api(), 'listApprovals').mockResolvedValue([]);
      renderMenu(ideate);
      liveRun(main.id);
      await open(user);
      await screen.findByTestId('menu-run-details');
      expect(screen.queryByTestId('menu-approvals')).toBeNull();
    });
  });

  describe('Panels', () => {
    it('Workflow panel opens the sheet on the Inspector, from Forge by way of Ideate', async () => {
      const user = userEvent.setup();
      const { project, main, ideate } = seed();
      const router = renderMenu(`${ideate}/forge`);
      await user.click(await item(user, 'menu-sheet'));
      expect(usePanelsStore.getState()).toMatchObject({ sheetOpen: true, sheetTab: 'inspect' });
      expect(router.state.location.pathname).toBe(`/projects/${project.id}/workflows/${main.id}`);
    });

    it('Problems & events opens the bottom panel on Validation, and closes it when open', async () => {
      const user = userEvent.setup();
      renderMenu(seed().ideate);
      expect(usePanelsStore.getState().bottomOpen).toBe(false);
      await user.click(await item(user, 'menu-problems'));
      expect(usePanelsStore.getState()).toMatchObject({
        bottomOpen: true,
        bottomTab: 'validation',
      });
      await user.click(await item(user, 'menu-problems'));
      expect(usePanelsStore.getState().bottomOpen).toBe(false);
    });

    it('Timeline goes to the workflow’s timeline', async () => {
      const user = userEvent.setup();
      const { project, main, ideate } = seed();
      const router = renderMenu(ideate);
      await user.click(await item(user, 'menu-timeline'));
      await waitFor(() =>
        expect(router.state.location.pathname).toBe(
          `/projects/${project.id}/workflows/${main.id}/timeline`,
        ),
      );
    });
  });

  describe('Project', () => {
    it.each([
      ['menu-project-page', ''],
      ['menu-project-runs', '/runs'],
      ['menu-knowledge', '/knowledge'],
    ])('%s goes to the project page%s', async (testId, suffix) => {
      const user = userEvent.setup();
      const { project, ideate } = seed();
      const router = renderMenu(ideate);
      await user.click(await item(user, testId));
      await waitFor(() =>
        expect(router.state.location.pathname).toBe(`/projects/${project.id}${suffix}`),
      );
    });

    it('Rename project… renames the project', async () => {
      const user = userEvent.setup();
      const { project, ideate } = seed();
      renderMenu(ideate);
      await waitFor(async () => {
        await open(user);
        expect(screen.getByTestId('menu-rename-project')).not.toHaveAttribute('data-disabled');
      });
      await user.click(screen.getByTestId('menu-rename-project'));
      const dialog = await screen.findByRole('dialog');
      const input = within(dialog).getByLabelText('Name');
      await user.clear(input);
      await user.type(input, 'Store');
      await user.click(within(dialog).getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(db.getProject(project.id)?.name).toBe('Store'));
    });

    it('Delete project… deletes it and goes Home', async () => {
      const user = userEvent.setup();
      const { project, ideate } = seed();
      const router = renderMenu(ideate);
      await waitFor(async () => {
        await open(user);
        expect(screen.getByTestId('menu-delete-project')).not.toHaveAttribute('data-disabled');
      });
      await user.click(screen.getByTestId('menu-delete-project'));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(router.state.location.pathname).toBe('/projects'));
      expect(db.getProject(project.id)).toBeUndefined();
    });
  });

  it.each([
    ['Providers', '/providers'],
    ['Settings', '/settings'],
    ['Usage', '/usage'],
    ['Guardrail policies', '/guardrails'],
    ['Tools', '/library/tools'],
    ['Bench', '/bench'],
    ['Setup wizard', '/onboarding'],
    ['Help', '/help/getting-started'],
  ])('ACE → %s links to %s', async (name, href) => {
    const user = userEvent.setup();
    const router = renderMenu(seed().ideate);
    await open(user);
    const link = screen.getByRole('menuitem', { name });
    expect(link).toHaveAttribute('href', href);
    await user.click(link);
    await waitFor(() => expect(router.state.location.pathname).toBe(href));
  });
});
