import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { db, installMockServer, renderApp } from '../../test/app';
import { usePanelsStore } from '../stores/panels';

installMockServer();

vi.mock('../../canvas/Canvas', () => ({
  Canvas: ({ workflowId }: { workflowId: string }) => <div data-testid="canvas">{workflowId}</div>,
}));

afterEach(() => {
  usePanelsStore.setState({ sheetOpen: false, newNodeOpen: false });
});

describe('TopBar (V2)', () => {
  it('New node opens the dialog through the panels store on a Canvas', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'P' });
    const workflow = db.createWorkflow(project.id, 'F');
    renderApp(`/projects/${project.id}/workflows/${workflow.id}`);
    await user.click(await screen.findByTestId('new-node-button'));
    expect(usePanelsStore.getState().newNodeOpen).toBe(true);
  });

  it('has no New node or panel toggle off a Canvas', async () => {
    const project = db.createProject({ name: 'P' });
    renderApp(`/projects/${project.id}`);
    await screen.findByTestId('project-name');
    expect(screen.queryByTestId('new-node-button')).toBeNull();
    expect(screen.queryByTestId('sheet-toggle')).toBeNull();
  });

  it('the panel toggle opens and closes the sheet', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'P' });
    const workflow = db.createWorkflow(project.id, 'F');
    renderApp(`/projects/${project.id}/workflows/${workflow.id}`);
    const toggle = await screen.findByTestId('sheet-toggle');
    expect(toggle).toHaveAccessibleName('Workflow panel');
    await user.click(toggle);
    await waitFor(() => expect(usePanelsStore.getState().sheetOpen).toBe(true));
    await user.click(toggle);
    await waitFor(() => expect(usePanelsStore.getState().sheetOpen).toBe(false));
  });

  it('below xl the four links fold into one More menu that still names each of them', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'P' });
    const workflow = db.createWorkflow(project.id, 'F');
    renderApp(`/projects/${project.id}/workflows/${workflow.id}`);

    // the inline row is for xl and up; the More button stands in for it below xl
    const usage = await screen.findByRole('link', { name: 'Usage' });
    expect(usage.parentElement).toHaveClass('hidden', 'xl:flex');
    const more = screen.getByRole('button', { name: 'More' });
    expect(more).toHaveClass('xl:hidden');

    await user.click(more);
    const routes: Record<string, string> = {
      Usage: '/usage',
      'Guardrail policies': '/guardrails',
      Settings: '/settings',
      Help: '/help/getting-started',
    };
    for (const [name, href] of Object.entries(routes)) {
      expect(await screen.findByRole('menuitem', { name })).toHaveAttribute('href', href);
    }
  });

  it('keeps Run, the run chip and New node in the bar at every width: what folds away keeps its name', async () => {
    const project = db.createProject({ name: 'P' });
    const workflow = db.createWorkflow(project.id, 'F');
    renderApp(`/projects/${project.id}/workflows/${workflow.id}`);

    // New node folds to its + below lg, and keeps "New node" as its name
    const add = await screen.findByTestId('new-node-button');
    expect(add).toHaveAccessibleName('New node');
    expect(screen.getByText('New node')).toHaveClass('max-lg:sr-only');
    // the workflow tabs give way first: a low floor below xl, and they scroll
    expect(screen.getByRole('tablist', { name: 'Workflows' }).parentElement).toHaveClass(
      'min-w-16',
      'xl:min-w-40',
    );
    // on a Canvas below lg "/ project" folds away (ACE and the tabs remain)
    expect((await screen.findByTestId('project-name')).parentElement).toHaveClass(
      'hidden',
      'lg:flex',
    );
  });

  it('keeps the project name at every width off a Canvas, where the bar has room', async () => {
    const project = db.createProject({ name: 'P' });
    renderApp(`/projects/${project.id}`);
    const name = await screen.findByTestId('project-name');
    expect(name.parentElement).not.toHaveClass('hidden');
  });

  it('keeps Usage, Guardrail policies, Settings and Help reachable by name', async () => {
    const project = db.createProject({ name: 'P' });
    renderApp(`/projects/${project.id}`);
    for (const name of ['Usage', 'Guardrail policies', 'Settings', 'Help']) {
      expect(await screen.findByRole('link', { name })).toBeInTheDocument();
    }
  });
});
