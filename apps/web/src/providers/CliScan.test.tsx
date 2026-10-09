import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { db, installMockServer, renderApp } from '../test/app';

installMockServer();

async function openAddDialog(user: ReturnType<typeof userEvent.setup>) {
  renderApp('/providers');
  await user.click(await screen.findByRole('button', { name: /add provider/i }));
  return screen.getByRole('dialog');
}

describe('FR-PRV-008 the terminal scan in Add provider (X1)', () => {
  it('lists each CLI with what to do next', async () => {
    const user = userEvent.setup();
    const dialog = await openAddDialog(user);

    const claude = await within(dialog).findByTestId('cli-scan-claude_code');
    expect(claude).toHaveTextContent('v2.1.282');
    expect(claude).toHaveTextContent('signed in (claude.ai · max)');
    expect(within(claude).getByRole('button', { name: 'Add Claude Code' })).toBeEnabled();

    const codex = within(dialog).getByTestId('cli-scan-codex_cli');
    expect(codex).toHaveTextContent('not signed in');
    expect(codex).toHaveTextContent('codex login');
    expect(within(codex).queryByRole('button', { name: 'Add Codex CLI' })).toBeNull();

    const gemini = within(dialog).getByTestId('cli-scan-gemini_cli');
    expect(gemini).toHaveTextContent('not installed');
    expect(gemini).toHaveTextContent('npm install -g @google/gemini-cli');
  });

  it('adds a scanned CLI with no key, editing project files, one call at a time', async () => {
    const user = userEvent.setup();
    const dialog = await openAddDialog(user);
    await user.click(await within(dialog).findByRole('button', { name: 'Add Claude Code' }));

    expect(within(dialog).queryByLabelText('API key')).toBeNull();
    expect(within(dialog).getByLabelText('Concurrency')).toHaveValue(1);
    expect(within(dialog).getByRole('combobox', { name: 'Permission' })).toHaveTextContent('Edit project files');

    await user.click(within(dialog).getByRole('button', { name: 'Add provider' }));
    await waitFor(() => expect(db.listProviders()).toHaveLength(1));
    expect(db.listProviders()[0]).toMatchObject({
      type: 'claude_code',
      name: 'Claude Code',
      keySet: false,
      concurrency: 1,
      cliPermission: 'edit_files',
    });
  });

  it('warns before Full auto', async () => {
    const user = userEvent.setup();
    const dialog = await openAddDialog(user);
    await user.click(await within(dialog).findByRole('button', { name: 'Add Claude Code' }));
    await user.click(within(dialog).getByRole('combobox', { name: 'Permission' }));
    await user.click(await screen.findByRole('option', { name: 'Full auto' }));
    expect(within(dialog).getByTestId('cli-permission-hint')).toHaveTextContent(/any command on your machine/);
  });

  it('tells Codex users it runs commands in its own sandbox, which the other CLIs do not (review I8)', async () => {
    const user = userEvent.setup();
    db.createProvider({ type: 'codex_cli', name: 'Codex CLI', concurrency: 1, cliPermission: 'edit_files' });
    renderApp('/providers');

    await user.click(await screen.findByRole('button', { name: 'Actions for Codex CLI' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    const hint = within(screen.getByRole('dialog')).getByTestId('cli-permission-hint');
    expect(hint).toHaveTextContent(/runs commands inside Codex’s workspace sandbox/);
    expect(hint).not.toHaveTextContent(/no shell commands/);
  });

  it('shows a CLI provider’s permission where others show the key, and edits it', async () => {
    const user = userEvent.setup();
    const created = db.createProvider({ type: 'claude_code', name: 'Claude Code', concurrency: 1, cliPermission: 'read_only' });
    renderApp('/providers');

    expect(await screen.findByTestId(`provider-permission-${created.id}`)).toHaveTextContent('Read-only');
    await user.click(screen.getByRole('button', { name: 'Actions for Claude Code' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByLabelText(/API key/)).toBeNull();

    await user.click(within(dialog).getByRole('combobox', { name: 'Permission' }));
    await user.click(await screen.findByRole('option', { name: 'Full auto' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(db.getProvider(created.id)?.cliPermission).toBe('full_auto'));
  });
});
