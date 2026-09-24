import { PROVIDER_TYPES } from '@ace/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { createNode } from '../nodes/factory';
import { db, installMockServer, queryClient, renderApp } from '../test/app';
import { PROVIDER_TYPE_LABEL } from './provider-meta';
import { patchProviderStatus } from './status-patch';

installMockServer();

/** Pick a type in the Add dialog's Select (Radix needs a click, not a `selectOptions`). */
async function pickType(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole('combobox', { name: 'Type' }));
  await user.click(await screen.findByRole('option', { name: label }));
}

/** The same provider has a chip in its row and one in the top bar; tests mean the row's. */
async function rowChip(providerId: string) {
  const row = await screen.findByTestId(`provider-row-${providerId}`);
  return within(row).getByTestId(`provider-status-${providerId}`);
}

async function openAddDialog(user: ReturnType<typeof userEvent.setup>) {
  renderApp('/providers');
  await user.click(await screen.findByRole('button', { name: /add provider/i }));
  return screen.getByRole('dialog');
}

describe('TC-PRV-001 every provider type can be added from the form', () => {
  it.each(PROVIDER_TYPES)('adds a %s provider', async (type) => {
    const user = userEvent.setup();
    const dialog = await openAddDialog(user);
    await pickType(user, PROVIDER_TYPE_LABEL[type]);

    await user.clear(within(dialog).getByLabelText('Name'));
    await user.type(within(dialog).getByLabelText('Name'), `My ${type}`);

    const key = within(dialog).queryByLabelText('API key');
    if (key) await user.type(key, 'sk-test-value');

    const baseUrl = within(dialog).queryByLabelText('Base URL');
    if (baseUrl && !(baseUrl as HTMLInputElement).value) {
      await user.type(baseUrl, 'http://127.0.0.1:1234');
    }

    await user.click(within(dialog).getByRole('button', { name: 'Add provider' }));

    await waitFor(() => expect(db.listProviders()).toHaveLength(1));
    const created = db.listProviders()[0]!;
    expect(created.type).toBe(type);
    expect(created.name).toBe(`My ${type}`);
    expect(await screen.findByTestId(`provider-name-${created.id}`)).toHaveTextContent(
      `My ${type}`,
    );
  });

  it('prefills the detected Ollama address and offers it as a banner (FR-PRV-007)', async () => {
    const user = userEvent.setup();
    renderApp('/providers');
    const banner = await screen.findByTestId('ollama-detected');
    expect(banner).toHaveTextContent('http://127.0.0.1:11434');

    await user.click(within(banner).getByRole('button', { name: 'Add it' }));
    await pickType(user, 'Ollama');
    expect(screen.getByLabelText('Base URL')).toHaveValue('http://127.0.0.1:11434');
  });
});

describe('TC-PRV-002 the UI never shows a key, only whether one is set', () => {
  it('shows "key set: yes" after adding a key and never echoes it back', async () => {
    const user = userEvent.setup();
    const dialog = await openAddDialog(user);
    await pickType(user, 'Anthropic');
    await user.type(within(dialog).getByLabelText('API key'), 'sk-ant-secret-123');
    await user.click(within(dialog).getByRole('button', { name: 'Add provider' }));

    const provider = await waitFor(() => {
      const [first] = db.listProviders();
      if (!first) throw new Error('not created yet');
      return first;
    });

    expect(await screen.findByTestId(`provider-key-set-${provider.id}`)).toHaveTextContent(
      'key set: yes',
    );
    expect(document.body.textContent).not.toContain('sk-ant-secret-123');

    // Reopening the provider for editing must not prefill the stored key either.
    await user.click(screen.getByRole('button', { name: `Actions for ${provider.name}` }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    expect(screen.getByLabelText('Rotate API key')).toHaveValue('');
    expect(document.body.textContent).not.toContain('sk-ant-secret-123');
  });

  it('shows "key set: no" for a provider added without one', async () => {
    const provider = db.createProvider({ type: 'mock', name: 'Mock' });
    renderApp('/providers');
    expect(await screen.findByTestId(`provider-key-set-${provider.id}`)).toHaveTextContent(
      'key set: no',
    );
  });
});

describe('TC-PRV-003 Test renders the check result', () => {
  it('reports CONNECTED for a good key', async () => {
    const user = userEvent.setup();
    const provider = db.createProvider({ type: 'anthropic', name: 'Anthropic', apiKey: 'good' });
    renderApp('/providers');

    await user.click(await screen.findByRole('button', { name: 'Test' }));

    const chip = await rowChip(provider.id);
    await waitFor(() => expect(chip).toHaveAttribute('data-status', 'CONNECTED'));
    expect(chip).toHaveTextContent('connected');
  });

  it('reports AUTH_FAILED with the engine message for a rejected key', async () => {
    const user = userEvent.setup();
    const provider = db.createProvider({ type: 'openai', name: 'OpenAI', apiKey: 'bad' });
    renderApp('/providers');

    await user.click(await screen.findByRole('button', { name: 'Test' }));

    const chip = await rowChip(provider.id);
    await waitFor(() => expect(chip).toHaveAttribute('data-status', 'AUTH_FAILED'));
    expect(chip).toHaveTextContent('auth failed');
    await waitFor(() => expect(db.getProvider(provider.id)?.statusMessage).toBeDefined());
  });
});

describe('TC-PRV-004 each provider state is rendered with its own label', () => {
  it.each([
    ['ratelimited', undefined, 'RATE_LIMITED', 'rate limited'],
    [undefined, 'http://unreachable.local:1234', 'UNREACHABLE', 'unreachable'],
  ] as const)('renders %s as %s', async (apiKey, baseUrl, expectedStatus, expectedLabel) => {
    const user = userEvent.setup();
    const provider = db.createProvider({
      type: 'openai_compatible',
      name: 'Local',
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(baseUrl === undefined ? {} : { baseUrl }),
    });
    renderApp('/providers');

    await user.click(await screen.findByRole('button', { name: 'Test' }));

    const chip = await rowChip(provider.id);
    await waitFor(() => expect(chip).toHaveAttribute('data-status', expectedStatus));
    expect(chip).toHaveTextContent(expectedLabel);
  });

  it('starts at UNKNOWN before any check', async () => {
    const provider = db.createProvider({ type: 'mock', name: 'Mock' });
    renderApp('/providers');
    const chip = await rowChip(provider.id);
    expect(chip).toHaveAttribute('data-status', 'UNKNOWN');
    expect(screen.getByText('never checked')).toBeInTheDocument();
  });
});

describe('TC-PRV-005 status changes live, without a reload', () => {
  it('a provider.status frame updates the row and the top bar', async () => {
    const provider = db.createProvider({ type: 'mock', name: 'Mock' });
    renderApp('/providers');

    expect(await rowChip(provider.id)).toHaveAttribute('data-status', 'UNKNOWN');

    // What `startSocket` does on an engine-scope frame — no refetch, no reload.
    patchProviderStatus(queryClient, {
      providerId: provider.id,
      status: 'CONNECTED',
      message: 'ok',
    });

    await waitFor(async () =>
      expect(await rowChip(provider.id)).toHaveAttribute('data-status', 'CONNECTED'),
    );
    const bar = screen.getByTestId('provider-status-bar');
    expect(within(bar).getByTestId(`provider-status-${provider.id}`)).toHaveAttribute(
      'data-status',
      'CONNECTED',
    );
  });
});

describe('TC-PRV-006 removing an in-use provider warns and then marks the nodes', () => {
  it('shows the 409 with the affected node, then removes it on confirmation', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'P' });
    const workflow = db.createWorkflow(project.id, 'W');
    const provider = db.createProvider({ type: 'mock', name: 'Mock' });
    const node = createNode('agent', workflow.id, { x: 0, y: 0 });
    node.config = {
      ...node.config,
      providerId: provider.id,
      modelId: 'mock-text',
    } as typeof node.config;
    db.commitGraph(workflow.id, [node], []);

    renderApp('/providers');
    await user.click(await screen.findByRole('button', { name: `Actions for ${provider.name}` }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    await user.click(screen.getByRole('button', { name: 'Remove' }));

    const warning = await screen.findByTestId('provider-in-use');
    expect(warning).toHaveTextContent('1 node still uses this provider.');
    expect(warning).toHaveTextContent(node.id);
    expect(db.getProvider(provider.id)).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Remove anyway' }));
    await waitFor(() => expect(db.getProvider(provider.id)).toBeUndefined());
  });

  it('removes an unused provider on the first confirmation', async () => {
    const user = userEvent.setup();
    const provider = db.createProvider({ type: 'mock', name: 'Mock' });
    renderApp('/providers');

    await user.click(await screen.findByRole('button', { name: `Actions for ${provider.name}` }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    await user.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(db.getProvider(provider.id)).toBeUndefined());
  });
});

describe('TC-PRV-007 editing a provider rotates the key and keeps the rest', () => {
  it('sends only what changed and leaves the key alone when the field stays empty', async () => {
    const user = userEvent.setup();
    const provider = db.createProvider({
      type: 'openai_compatible',
      name: 'Local',
      baseUrl: 'http://127.0.0.1:1234',
      apiKey: 'first-key',
      concurrency: 4,
    });
    renderApp('/providers');

    await user.click(await screen.findByRole('button', { name: `Actions for ${provider.name}` }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));

    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Renamed');
    await user.clear(screen.getByLabelText('Concurrency'));
    await user.type(screen.getByLabelText('Concurrency'), '8');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(db.getProvider(provider.id)?.name).toBe('Renamed'));
    expect(db.getProvider(provider.id)?.concurrency).toBe(8);
    expect(db.getProvider(provider.id)?.keySet).toBe(true);
    await waitFor(() =>
      expect(screen.getByTestId(`provider-name-${provider.id}`)).toHaveTextContent('Renamed'),
    );
  });
});
