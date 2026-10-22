import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { db, installMockServer, processes, renderApp, server } from '../test/app';

installMockServer();

describe('ProjectPage in the Ace UI theme (D328)', () => {
  it('lists the workflows as cards that open the Canvas', async () => {
    const project = db.createProject({ name: 'Atlas' });
    const first = db.createWorkflow(project.id, 'Daily digest');
    const second = db.createWorkflow(project.id, 'Weekly report');
    const { router } = renderApp(`/projects/${project.id}`);

    expect(await screen.findByRole('heading', { level: 1, name: 'Atlas' })).toBeInTheDocument();
    const card = await screen.findByTestId(`workflow-card-${first.id}`);
    expect(card).toHaveTextContent('Daily digest');
    expect(card).toHaveTextContent(`v${first.version}`);
    expect(screen.getByTestId(`workflow-card-${second.id}`)).toHaveTextContent('Weekly report');

    await userEvent.click(card);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/projects/${project.id}/workflows/${first.id}`),
    );
  });

  it('says so in one muted line when there is no workflow yet', async () => {
    const project = db.createProject({ name: 'Empty' });
    renderApp(`/projects/${project.id}`);
    expect(
      await screen.findByText('No workflows yet. Create one to open an empty Canvas.'),
    ).toBeInTheDocument();
  });

  it('keeps Runs, Knowledge, Import JSON and New workflow', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'Atlas' });
    renderApp(`/projects/${project.id}`);
    await screen.findByRole('heading', { level: 1, name: 'Atlas' });

    expect(screen.getByRole('link', { name: 'Runs' })).toHaveAttribute(
      'href',
      `/projects/${project.id}/runs`,
    );
    expect(screen.getByRole('link', { name: 'Knowledge' })).toHaveAttribute(
      'href',
      `/projects/${project.id}/knowledge`,
    );
    expect(screen.getByRole('button', { name: 'Import JSON' })).toBeInTheDocument();
    // The hidden file input keeps its accessible name for the import flow (FR-WF-008).
    expect(screen.getByLabelText('Import JSON')).toHaveAttribute('type', 'file');

    await user.click(screen.getByRole('button', { name: 'New workflow' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('reports an import that is not JSON under the button', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'Atlas' });
    renderApp(`/projects/${project.id}`);
    await screen.findByRole('heading', { level: 1, name: 'Atlas' });

    await user.upload(
      screen.getByLabelText('Import JSON'),
      new File(['not json'], 'broken.json', { type: 'application/json' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('“broken.json” is not valid JSON.');
  });

  it('saves the per-run budget on the project (FR-GRD-008)', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'Atlas' });
    renderApp(`/projects/${project.id}`);

    const fields = await screen.findByTestId('budget-fields');
    const cap = within(fields).getByTestId('max-cost-per-run');
    await waitFor(() => expect(cap).not.toBeDisabled());
    await user.type(cap, '0.5{Enter}');
    await waitFor(() => expect(db.getProject(project.id)?.maxCostPerRunUsd).toBe(0.5));
    expect(within(fields).queryByTestId('daily-budget')).not.toBeInTheDocument();
  });
});

describe('D301 a project says how far it trusts its terminal', () => {
  async function terminalSelect() {
    const select = await screen.findByTestId('project-terminal');
    await waitFor(() => expect(select).toBeEnabled());
    return select;
  }

  it('reads On by default, as the theme’s dropdown in its own card, and saves Scripts only', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'Shop' });
    renderApp(`/projects/${project.id}`);
    const select = await terminalSelect();
    expect(select).toHaveTextContent('On — any command');
    expect(select).toHaveClass('h-[38px]', 'rounded-[9px]', 'bg-[var(--canvas)]');
    expect(screen.getByTestId('project-terminal-card')).toHaveClass(
      'rounded-[12px]',
      'border-[var(--line)]',
      'bg-[var(--surface)]',
    );

    await user.click(select);
    await user.click(await screen.findByRole('option', { name: 'Scripts only' }));
    await waitFor(() => expect(db.getProject(project.id)?.terminal).toBe('scripts'));
    expect(select).toHaveTextContent('Scripts only');
  });

  it('Off stops what runs in the project', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'Shop' });
    const { processId } = processes.start(project.id, { command: 'serve' });
    renderApp(`/projects/${project.id}`);
    const select = await terminalSelect();

    await user.click(select);
    await user.click(await screen.findByRole('option', { name: 'Off' }));
    await waitFor(() => expect(db.getProject(project.id)?.terminal).toBe('off'));
    expect(processes.get(project.id, processId)).toMatchObject({
      status: 'exited',
      signal: 'SIGKILL',
    });
  });
});

describe('D299 Phase 4 a project names its check command and format-on-save', () => {
  async function checkInput() {
    const input = await screen.findByTestId('project-check-command');
    await waitFor(() => expect(input).toBeEnabled());
    return input;
  }

  it('shows a Checks card after the Terminal card, with the placeholder and Off by default', async () => {
    const project = db.createProject({ name: 'Shop' });
    renderApp(`/projects/${project.id}`);
    const input = await checkInput();
    expect(input).toHaveAttribute('placeholder', 'pnpm tsc --noEmit');
    expect(input).toHaveValue('');
    expect(screen.getByTestId('project-format-on-save')).toHaveTextContent('Off');
    const terminal = screen.getByTestId('project-terminal-card');
    const checks = screen.getByTestId('project-checks-card');
    expect(checks).toHaveClass('rounded-[12px]', 'border-[var(--line)]', 'bg-[var(--surface)]');
    expect(
      terminal.compareDocumentPosition(checks) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('saves the check command on Enter, and clearing it removes it', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'Shop' });
    renderApp(`/projects/${project.id}`);
    const input = await checkInput();

    await user.type(input, '  pnpm lint  {Enter}');
    await waitFor(() => expect(db.getProject(project.id)?.checkCommand).toBe('pnpm lint'));

    await user.clear(input);
    await user.keyboard('{Enter}');
    input.blur();
    await waitFor(() => expect(db.getProject(project.id)).not.toHaveProperty('checkCommand'));
  });

  it('refuses a command over 1000 characters inline and sends nothing', async () => {
    const project = db.createProject({ name: 'Shop' });
    renderApp(`/projects/${project.id}`);
    const input = await checkInput();
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(input, { target: { value: 'x'.repeat(1001) } });
    fireEvent.blur(input);
    expect(await screen.findByRole('alert')).toHaveTextContent('1000');
    expect(db.getProject(project.id)?.checkCommand).toBeUndefined();
  });

  it('turns format-on-save on', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'Shop' });
    renderApp(`/projects/${project.id}`);
    const select = await screen.findByTestId('project-format-on-save');
    await waitFor(() => expect(select).toBeEnabled());

    await user.click(select);
    await user.click(await screen.findByRole('option', { name: 'On' }));
    await waitFor(() => expect(db.getProject(project.id)?.formatOnSave).toBe(true));
    expect(select).toHaveTextContent('On');
  });
});

describe('audit U-2 (D-009) "not found" means the engine said 404', () => {
  it('a 404 still reads "Project not found", with the way back', async () => {
    renderApp('/projects/01J9ZZZZZZZZZZZZZZZZZZZZZZ');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Project not found.');
    expect(within(alert).getByRole('link', { name: 'Back to projects' })).toBeInTheDocument();
  });

  it('any other failure shows the engine’s words and Retry, which loads the project', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'Atlas' });
    let fail = true;
    server.use(
      http.get('*/api/v1/projects/:id', () =>
        fail
          ? HttpResponse.json(
              {
                error: {
                  kind: 'workflow',
                  code: 'internal',
                  message: 'Database is locked.',
                  retryable: true,
                },
              },
              { status: 500 },
            )
          : undefined,
      ),
    );
    renderApp(`/projects/${project.id}`);
    const error = await screen.findByTestId('query-error');
    expect(error).toHaveTextContent('Could not load this project: Database is locked.');
    expect(error).not.toHaveTextContent('not found');

    fail = false;
    await user.click(within(error).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Atlas' })).toBeInTheDocument();
  });
});
