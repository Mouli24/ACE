import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { failNextClone, setMockGitHub } from '../mocks/tasks';
import { db, installMockServer, renderApp } from '../test/app';

installMockServer();

describe('Projects screen (FR-PRJ-001..004)', () => {
  it('TC-PRJ-001: creating a project lists it', async () => {
    const user = userEvent.setup();
    renderApp('/projects');
    await screen.findByRole('heading', { name: /projects/i });
    await user.click(screen.getByRole('button', { name: /new project/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/name/i), 'Demo');
    await user.click(within(dialog).getByRole('button', { name: /^create$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByRole('link', { name: /demo/i })).toBeInTheDocument();
    expect(db.listProjects().map((p) => p.name)).toEqual(['Demo']);
  });

  it('TC-PRJ-002: an unwritable folder shows the invalid_path error inline, naming the path', async () => {
    const user = userEvent.setup();
    renderApp('/projects');
    await user.click(await screen.findByRole('button', { name: /new project/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/name/i), 'Bad');
    await user.type(within(dialog).getByLabelText(/folder/i), '/readonly/bad');
    await user.click(within(dialog).getByRole('button', { name: /^create$/i }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('/readonly/bad');
    expect(db.listProjects()).toHaveLength(0);
  });

  it('renames a project from its menu (FR-PRJ-002)', async () => {
    const user = userEvent.setup();
    db.createProject({ name: 'Old' });
    renderApp('/projects');
    await user.click(await screen.findByRole('button', { name: /actions for old/i }));
    await user.click(await screen.findByRole('menuitem', { name: /rename/i }));
    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText(/name/i);
    await user.clear(input);
    await user.type(input, 'New');
    await user.click(within(dialog).getByRole('button', { name: /save/i }));
    expect(await screen.findByRole('link', { name: /new/i })).toBeInTheDocument();
    expect(db.listProjects()[0]?.name).toBe('New');
  });

  it('TC-PRJ-003: delete asks for confirmation, then removes the project', async () => {
    const user = userEvent.setup();
    db.createProject({ name: 'Gone' });
    renderApp('/projects');
    await user.click(await screen.findByRole('button', { name: /actions for gone/i }));
    await user.click(await screen.findByRole('menuitem', { name: /delete/i }));
    const dialog = await screen.findByRole('dialog');
    expect(db.listProjects()).toHaveLength(1);
    await user.click(within(dialog).getByRole('button', { name: /delete/i }));
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: /gone/i })).not.toBeInTheDocument(),
    );
    expect(db.listProjects()).toHaveLength(0);
  });

  it('TC-PRJ-004: / reopens the last project when settings.lastProjectId is set', async () => {
    const b = db.createProject({ name: 'Project B' });
    db.patchSettings({ lastProjectId: b.id });
    const { router } = renderApp('/');
    await waitFor(() => expect(router.state.location.pathname).toBe(`/projects/${b.id}`));
  });

  it('/ goes to the project list when nothing was opened before', async () => {
    // A fresh user with no projects lands on /onboarding (FR-ONB-001, HomeRedirect.test.tsx).
    db.patchSettings({ onboardingCompleted: true });
    const { router } = renderApp('/');
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects'));
  });

  it('opening a project records it as the last project (FR-PRJ-004)', async () => {
    const user = userEvent.setup();
    const p = db.createProject({ name: 'Open me' });
    const { router } = renderApp('/projects');
    await user.click(await screen.findByRole('link', { name: /open me/i }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/projects/${p.id}`));
    await waitFor(() => expect(db.settings.lastProjectId).toBe(p.id));
  });
});

describe('ACE-P1 D276 Clone from GitHub', () => {
  it('clones owner/name into a new project and opens it', async () => {
    const user = userEvent.setup();
    const { router } = renderApp('/projects');
    await user.click(await screen.findByRole('button', { name: 'Clone from GitHub' }));
    const dialog = await screen.findByRole('dialog', { name: 'Clone from GitHub' });
    expect(within(dialog).getByRole('button', { name: 'Clone' })).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Repository'), 'acme/storefront');
    await user.type(within(dialog).getByLabelText('Project name (optional)'), 'Storefront');
    await user.click(within(dialog).getByRole('button', { name: 'Clone' }));

    await waitFor(() => expect(db.listProjects().map((p) => p.name)).toEqual(['Storefront']));
    const project = db.listProjects()[0];
    await waitFor(() => expect(router.state.location.pathname).toBe(`/projects/${project?.id}`));
    expect(project?.folderPath).toBe('/mock/projects/storefront');
    expect(db.repositoryOf(project?.id ?? '').remoteUrl).toBe(
      'https://github.com/acme/storefront.git',
    );
  });

  it('says plainly when GitHub is not connected, and when the clone fails', async () => {
    setMockGitHub({ signedIn: false });
    const user = userEvent.setup();
    renderApp('/projects');
    await user.click(await screen.findByRole('button', { name: 'Clone from GitHub' }));
    const dialog = await screen.findByRole('dialog', { name: 'Clone from GitHub' });
    await user.type(within(dialog).getByLabelText('Repository'), 'https://github.com/acme/api');
    await user.type(within(dialog).getByLabelText('Folder (optional)'), '/mock/elsewhere/api');
    await user.click(within(dialog).getByRole('button', { name: 'Clone' }));
    const refusal = await within(dialog).findByTestId('clone-error');
    expect(refusal).toHaveAttribute('data-code', 'not_connected');
    expect(refusal).toHaveTextContent(
      'GitHub is not connected. The GitHub CLI is not signed in. Run gh auth login in a terminal.',
    );
    expect(db.listProjects()).toHaveLength(0);

    setMockGitHub({ signedIn: true });
    failNextClone('repository not found');
    await user.click(within(dialog).getByRole('button', { name: 'Clone' }));
    await waitFor(() =>
      expect(within(dialog).getByTestId('clone-error')).toHaveTextContent(
        'The clone failed. Cloning https://github.com/acme/api failed: repository not found',
      ),
    );
    expect(screen.getByRole('dialog', { name: 'Clone from GitHub' })).toBeInTheDocument();
  });
});
