import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { db, installMockServer, renderApp } from '../test/app';

installMockServer();

vi.mock('../canvas/Canvas', () => ({
  Canvas: ({ workflowId }: { workflowId: string }) => (
    <div data-testid="canvas">canvas:{workflowId}</div>
  ),
}));

describe('Workflow tabs (FR-WF-001..003)', () => {
  it('TC-WF-001: creating a workflow opens it as a tab on the Canvas route', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'P' });
    const { router } = renderApp(`/projects/${project.id}`);
    await user.click(await screen.findByRole('button', { name: /new workflow/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/name/i), 'Flow 1');
    await user.click(within(dialog).getByRole('button', { name: /create/i }));
    const created = await waitFor(() => {
      const wf = db.listWorkflows(project.id)[0];
      expect(wf).toBeDefined();
      return wf!;
    });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        `/projects/${project.id}/workflows/${created.id}`,
      ),
    );
    expect(await screen.findByRole('tab', { name: /flow 1/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('TC-WF-002: switching tabs shows the other workflow', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'P' });
    const a = db.createWorkflow(project.id, 'Alpha');
    const b = db.createWorkflow(project.id, 'Beta');
    const { router } = renderApp(`/projects/${project.id}/workflows/${a.id}`);
    expect(await screen.findByTestId('canvas')).toHaveTextContent(a.id);
    await user.click(await screen.findByRole('tab', { name: /beta/i }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/projects/${project.id}/workflows/${b.id}`),
    );
    expect(await screen.findByTestId('canvas')).toHaveTextContent(b.id);
    expect(screen.getByRole('tab', { name: /beta/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /alpha/i })).toHaveAttribute('aria-selected', 'false');
  });

  it('TC-WF-003: rename, duplicate and delete from the tab menu', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'P' });
    const a = db.createWorkflow(project.id, 'Alpha');
    const { router } = renderApp(`/projects/${project.id}/workflows/${a.id}`);
    await screen.findByRole('tab', { name: /alpha/i });

    await user.click(screen.getByRole('button', { name: /workflow actions for alpha/i }));
    await user.click(await screen.findByRole('menuitem', { name: /rename/i }));
    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText(/name/i);
    await user.clear(input);
    await user.type(input, 'Gamma');
    await user.click(within(dialog).getByRole('button', { name: /save/i }));
    expect(await screen.findByRole('tab', { name: /gamma/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /workflow actions for gamma/i }));
    await user.click(await screen.findByRole('menuitem', { name: /duplicate/i }));
    expect(await screen.findByRole('tab', { name: /gamma \(copy\)/i })).toBeInTheDocument();
    const copy = db.listWorkflows(project.id).find((w) => w.name === 'Gamma (copy)');
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/projects/${project.id}/workflows/${copy?.id}`),
    );

    await user.click(screen.getByRole('button', { name: /workflow actions for gamma \(copy\)/i }));
    await user.click(await screen.findByRole('menuitem', { name: /delete/i }));
    const confirm = await screen.findByRole('dialog');
    await user.click(within(confirm).getByRole('button', { name: /delete/i }));
    await waitFor(() =>
      expect(screen.queryByRole('tab', { name: /gamma \(copy\)/i })).not.toBeInTheDocument(),
    );
    expect(db.listWorkflows(project.id).map((w) => w.name)).toEqual(['Gamma']);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/projects/${project.id}`));
  });
});
