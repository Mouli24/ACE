import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { mockSecretValue, putMockSecret } from '../../mocks/secrets';
import { db, installMockServer, renderApp } from '../../test/app';
import { secretNameProblem } from './SecretDialogs';
import { secretScopeLabel } from './SecretsSection';

/**
 * Settings › Secrets (ACE parity P1, D274): add, replace and delete named environment variables —
 * and never show a value, which goes from a password field to the (mock) keychain and stays there.
 */

installMockServer();

/** Obviously fake: no real key is ever written in this repository. */
const VALUE = 'fake-ui-value-0001';
const NOW = '2026-10-07T10:00:00.000Z';

async function openSecrets() {
  renderApp('/settings');
  return screen.findByTestId('settings-secrets');
}

describe('D274 the secret name rules, as typed', () => {
  it('accepts UPPER_SNAKE_CASE and explains everything else', () => {
    expect(secretNameProblem('', [])).toBeUndefined();
    expect(secretNameProblem('DEPLOY_TOKEN', [])).toBeUndefined();
    expect(secretNameProblem('deploy_token', [])).toBe('Use capitals: DEPLOY_TOKEN.');
    expect(secretNameProblem('9LIVES', [])).toMatch(/UPPER_SNAKE_CASE/);
    expect(secretNameProblem('MY-TOKEN', [])).toMatch(/UPPER_SNAKE_CASE/);
    expect(secretNameProblem('PATH', [])).toMatch(/reserved/);
    expect(secretNameProblem('ACE_DATA_DIR', [])).toMatch(/reserved/);
    expect(secretNameProblem('API_TOKEN', ['API_TOKEN'])).toMatch(/already exists/);
  });

  it('labels a scope by its project names, or all projects', () => {
    const project = db.createProject({ name: 'Shop' });
    const secret = { name: 'A', description: '', projectIds: [], createdAt: NOW, updatedAt: NOW };
    expect(secretScopeLabel(secret, [project])).toBe('All projects');
    expect(secretScopeLabel({ ...secret, projectIds: [project.id, 'gone'] }, [project])).toBe(
      'Shop, a deleted project',
    );
  });
});

describe('D274 Settings › Secrets', () => {
  it('explains where values live, and says when there are none', async () => {
    const section = await openSecrets();
    expect(within(section).getByTestId('secrets-note')).toHaveTextContent(
      /keychain.*only the names.*scrubbed from logs/,
    );
    expect(await within(section).findByTestId('secrets-empty')).toHaveTextContent(
      'No secrets yet.',
    );
  });

  it('adds a secret: live name check, a password value, a description and a project scope', async () => {
    const user = userEvent.setup();
    db.createProject({ name: 'Shop' });
    db.createProject({ name: 'Blog' });
    const section = await openSecrets();
    await within(section).findByTestId('secrets-empty');

    await user.click(within(section).getByRole('button', { name: 'Add secret' }));
    const dialog = await screen.findByTestId('add-secret');
    const name = within(dialog).getByLabelText('Name');
    await user.type(name, 'deploy');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Use capitals: DEPLOY.');
    await user.clear(name);
    await user.type(name, 'PATH');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('reserved');
    await user.clear(name);
    await user.type(name, 'DEPLOY_TOKEN');
    expect(within(dialog).queryByRole('alert')).toBeNull();

    const value = within(dialog).getByLabelText('Value');
    expect(value).toHaveAttribute('type', 'password');
    await user.type(value, VALUE);
    await user.type(within(dialog).getByLabelText('Description'), 'Deploys staging');
    expect(within(dialog).getByTestId('secret-scope')).toHaveTextContent('All projects');
    await user.click(await within(dialog).findByRole('checkbox', { name: 'Shop' }));
    expect(within(dialog).getByTestId('secret-scope')).toHaveTextContent('Only the project ticked');

    await user.click(within(dialog).getByRole('button', { name: 'Add secret' }));
    const row = await within(section).findByTestId('secret-DEPLOY_TOKEN');
    expect(screen.queryByTestId('add-secret')).toBeNull();
    expect(within(row).getByText('DEPLOY_TOKEN')).toHaveClass('font-machine');
    expect(within(row).getByText('Deploys staging')).toBeInTheDocument();
    expect(within(row).getByTestId('secret-scope-label')).toHaveTextContent('Shop');
    expect(within(row).getByText('just now')).toBeInTheDocument();

    expect(mockSecretValue('DEPLOY_TOKEN')).toBe(VALUE);
    expect(document.body.textContent).not.toContain(VALUE);
  });

  it('refuses to send a name already taken, or no value', async () => {
    const user = userEvent.setup();
    putMockSecret(
      { name: 'API_TOKEN', description: '', projectIds: [], createdAt: NOW, updatedAt: NOW },
      VALUE,
    );
    const section = await openSecrets();
    await within(section).findByTestId('secret-API_TOKEN');

    await user.click(within(section).getByRole('button', { name: 'Add secret' }));
    const dialog = await screen.findByTestId('add-secret');
    await user.type(within(dialog).getByLabelText('Name'), 'API_TOKEN');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('already exists');
    await user.clear(within(dialog).getByLabelText('Name'));
    await user.type(within(dialog).getByLabelText('Name'), 'OTHER_TOKEN');
    await user.click(within(dialog).getByRole('button', { name: 'Add secret' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter the value.');
    expect(mockSecretValue('OTHER_TOKEN')).toBeUndefined();
  });

  it('replaces a value without ever showing the old one or the new one', async () => {
    const user = userEvent.setup();
    putMockSecret(
      {
        name: 'API_TOKEN',
        description: 'Shop API',
        projectIds: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
      VALUE,
    );
    const section = await openSecrets();
    const row = await within(section).findByTestId('secret-API_TOKEN');
    expect(within(row).getByTestId('secret-scope-label')).toHaveTextContent('All projects');

    await user.click(within(row).getByRole('button', { name: 'Replace the value of API_TOKEN' }));
    const dialog = await screen.findByTestId('replace-secret');
    const input = within(dialog).getByLabelText('New value');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveValue('');
    await user.type(input, 'fake-ui-value-0002');
    await user.click(within(dialog).getByRole('button', { name: 'Replace value' }));

    await waitFor(() => expect(mockSecretValue('API_TOKEN')).toBe('fake-ui-value-0002'));
    await waitFor(() => expect(screen.queryByTestId('replace-secret')).toBeNull());
    expect(document.body.textContent).not.toContain(VALUE);
    expect(document.body.textContent).not.toContain('fake-ui-value-0002');
  });

  it('deletes a secret only after a confirm', async () => {
    const user = userEvent.setup();
    putMockSecret(
      { name: 'API_TOKEN', description: '', projectIds: [], createdAt: NOW, updatedAt: NOW },
      VALUE,
    );
    const section = await openSecrets();
    const row = await within(section).findByTestId('secret-API_TOKEN');

    await user.click(within(row).getByRole('button', { name: 'Delete API_TOKEN' }));
    const confirm = await screen.findByRole('dialog');
    expect(confirm).toHaveTextContent('Delete API_TOKEN?');
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(mockSecretValue('API_TOKEN')).toBe(VALUE);

    await user.click(within(row).getByRole('button', { name: 'Delete API_TOKEN' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete secret' }),
    );
    expect(await within(section).findByTestId('secrets-empty')).toBeInTheDocument();
    expect(mockSecretValue('API_TOKEN')).toBeUndefined();
  });
});
