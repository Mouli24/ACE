import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { db, installMockServer, renderApp } from '../test/app';

installMockServer();

const section = (testId: string) => screen.getByTestId(testId);

describe('ACE-P0 project settings (design §8)', () => {
  it('reads the repository and initializes Git in a plain folder after confirming', async () => {
    const project = db.createProject({ name: 'Notes', folderPath: '/mock/no-git/notes' });
    const user = userEvent.setup();
    renderApp(`/projects/${project.id}/settings`);

    const repo = await screen.findByTestId('project-repository');
    await within(repo).findByText('/mock/no-git/notes');
    expect(within(repo).getByText('Git repository').nextSibling).toHaveTextContent('no');
    await user.click(within(repo).getByRole('button', { name: 'Initialize Git' }));
    const dialog = await screen.findByRole('dialog', { name: 'Initialize Git here?' });
    expect(dialog).toHaveTextContent('first commit');
    await user.click(within(dialog).getByRole('button', { name: 'Initialize Git' }));

    await waitFor(() =>
      expect(within(repo).getByText('Git repository').nextSibling).toHaveTextContent('yes'),
    );
    expect(within(repo).getByText('Branch').nextSibling).toHaveTextContent('main');
    expect(within(repo).getByText('Working tree').nextSibling).toHaveTextContent('clean');
    expect(within(repo).queryByRole('button', { name: 'Initialize Git' })).toBeNull();
    expect(db.repositoryOf(project.id).isRepo).toBe(true);
  });

  it('edits, reorders, removes and saves the check commands', async () => {
    const project = db.createProject({ name: 'Shop' });
    const user = userEvent.setup();
    renderApp(`/projects/${project.id}/settings`);
    const checks = await screen.findByTestId('project-checks');
    expect(within(checks).getByText('No checks yet.')).toBeInTheDocument();

    await user.click(within(checks).getByRole('button', { name: 'Add check' }));
    // a row without a command is not saved
    await user.click(within(checks).getByRole('button', { name: 'Save checks' }));
    expect(await within(checks).findByRole('alert')).toHaveTextContent(
      'Check 1 needs a name and a command.',
    );

    await user.type(within(checks).getByLabelText('Check 1 name'), 'test');
    await user.type(within(checks).getByLabelText('Check 1 command'), 'pnpm test');
    await user.click(within(checks).getByRole('button', { name: 'Add check' }));
    await user.type(within(checks).getByLabelText('Check 2 name'), 'lint');
    await user.type(within(checks).getByLabelText('Check 2 command'), 'pnpm lint');
    await user.click(within(checks).getByRole('button', { name: 'Add check' }));
    await user.type(within(checks).getByLabelText('Check 3 name'), 'tmp');
    await user.type(within(checks).getByLabelText('Check 3 command'), 'echo');
    await user.click(within(checks).getByRole('button', { name: 'Move check 2 up' }));
    await user.click(within(checks).getByRole('button', { name: 'Remove check 3' }));
    await user.click(within(checks).getByRole('button', { name: 'Save checks' }));

    await waitFor(() =>
      expect(db.getProject(project.id)?.checkCommands).toEqual([
        { name: 'lint', command: 'pnpm lint' },
        { name: 'test', command: 'pnpm test' },
      ]),
    );
    expect(await screen.findByText('Checks saved')).toBeInTheDocument();
  });

  it('saves and clears the setup command, and saves the Build capacity', async () => {
    const project = db.createProject({ name: 'Shop' });
    const user = userEvent.setup();
    renderApp(`/projects/${project.id}/settings`);

    const setup = await screen.findByTestId('project-setup');
    await user.type(within(setup).getByLabelText('Setup command'), 'pnpm install');
    await user.click(within(setup).getByRole('button', { name: 'Save setup command' }));
    await waitFor(() => expect(db.getProject(project.id)?.setupCommand).toBe('pnpm install'));
    await user.click(within(section('project-setup')).getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(db.getProject(project.id)?.setupCommand).toBeUndefined());

    const capacity = within(section('project-capacity')).getByLabelText(/How many tasks/);
    expect(capacity).toHaveValue(2);
    await user.clear(capacity);
    await user.type(capacity, '9');
    expect(within(section('project-capacity')).getByRole('alert')).toHaveTextContent('from 1 to 8');
    await user.clear(capacity);
    await user.type(capacity, '4');
    await user.click(
      within(section('project-capacity')).getByRole('button', { name: 'Save capacity' }),
    );
    await waitFor(() => expect(db.getProject(project.id)?.buildCapacity).toBe(4));
  });

  it('pauses and resumes the project', async () => {
    const project = db.createProject({ name: 'Shop' });
    const user = userEvent.setup();
    renderApp(`/projects/${project.id}/settings`);
    await user.click(await screen.findByRole('button', { name: 'Pause project' }));
    expect(await screen.findByRole('button', { name: 'Resume project' })).toBeInTheDocument();
    expect(db.getProject(project.id)?.paused).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Resume project' }));
    await waitFor(() => expect(db.getProject(project.id)?.paused).toBe(false));
  });

  it('the project navigation marks Settings, and every project page carries it', async () => {
    const project = db.createProject({ name: 'Shop' });
    const user = userEvent.setup();
    const { router } = renderApp(`/projects/${project.id}/settings`);
    const nav = await screen.findByRole('navigation', { name: 'Project' });
    expect(within(nav).getByRole('link', { name: 'Project settings' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    for (const [name, path] of [
      ['Tasks', '/tasks'],
      ['Runs', '/runs'],
      ['Knowledge', '/knowledge'],
      ['Overview', ''],
    ] as const) {
      await user.click(
        within(screen.getByRole('navigation', { name: 'Project' })).getByRole('link', { name }),
      );
      await waitFor(() =>
        expect(router.state.location.pathname).toBe(`/projects/${project.id}${path}`),
      );
      expect(
        within(await screen.findByRole('navigation', { name: 'Project' })).getByRole('link', {
          name,
        }),
      ).toHaveAttribute('aria-current', 'page');
    }
  });
});
