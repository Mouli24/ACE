import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { http, HttpResponse } from 'msw';

import { db, installMockServer, renderApp, renderWithQuery, server } from '../test/app';
import { ProviderPickerDialog } from './ProviderModelPicker';

installMockServer();

/**
 * PG-1.4 (D359) the grouped picker and PG-1.3 (D351) the provider-first dialog: sections from the
 * contract's `providerGroup`, local models with their size and no price, the `ollama pull` hint,
 * and a confirm that waits for both a provider and a model.
 */

function seedProviders() {
  const cloud = db.createProvider({ type: 'anthropic', name: 'Claude API', apiKey: 'k' });
  const ollama = db.createProvider({
    type: 'ollama',
    name: 'Ollama here',
    baseUrl: 'http://127.0.0.1:11434',
  });
  const lmStudio = db.createProvider({
    type: 'openai_compatible',
    name: 'LM Studio LAN',
    baseUrl: 'http://192.168.1.20:1234/v1',
  });
  const remote = db.createProvider({
    type: 'openai_compatible',
    name: 'Together remote',
    baseUrl: 'https://api.together.xyz/v1',
  });
  const cli = db.createProvider({ type: 'claude_code', name: 'Claude Code here' });
  const mock = db.createProvider({ type: 'mock', name: 'Mock' });
  for (const provider of [cloud, ollama, lmStudio, remote, cli, mock]) {
    db.refreshModels(provider.id);
  }
  db.setProviderStatus(mock.id, 'CONNECTED');
  return { cloud, ollama, lmStudio, remote, cli, mock };
}

function pickerDialog(onConfirm = vi.fn(), onCancel = vi.fn()) {
  renderWithQuery(<ProviderPickerDialog onConfirm={onConfirm} onCancel={onCancel} />);
  return { onConfirm, onCancel };
}

const groupNamed = (name: string) => screen.getByRole('group', { name });

describe('PG-1.4 the grouped provider picker', () => {
  it('puts each provider in its section: Cloud APIs, Local & open models, CLI agents, Custom endpoints, Test providers', async () => {
    seedProviders();
    pickerDialog();
    await screen.findByRole('option', { name: /Claude API/ });

    expect(
      within(groupNamed('Cloud APIs')).getByRole('option', { name: /Claude API/ }),
    ).toBeVisible();
    const local = groupNamed('Local & open models');
    expect(within(local).getByRole('option', { name: /Ollama here/ })).toBeVisible();
    // an OpenAI-compatible server on the LAN is local (LM Studio, llama.cpp, vLLM)…
    expect(within(local).getByRole('option', { name: /LM Studio LAN/ })).toBeVisible();
    // …and on any other host it is a custom endpoint
    expect(
      within(groupNamed('Custom endpoints')).getByRole('option', { name: /Together remote/ }),
    ).toBeVisible();
    expect(
      within(groupNamed('CLI agents')).getByRole('option', { name: /Claude Code here/ }),
    ).toBeVisible();
    expect(
      within(groupNamed('Test providers')).getByRole('option', { name: /Mock/ }),
    ).toBeVisible();
    expect(within(local).queryByRole('option', { name: /Mock|Claude API|Together/ })).toBeNull();
  });

  it('a local provider’s models show their size, tools/JSON and "Free · runs on your machine"', async () => {
    const user = userEvent.setup();
    seedProviders();
    pickerDialog();
    await user.click(await screen.findByRole('option', { name: /Ollama here/ }));

    const model = await screen.findByRole('option', { name: /Llama mock/ });
    expect(model).toHaveTextContent('1.2 GB');
    expect(model).toHaveTextContent('no tools');
    expect(model).toHaveTextContent('Free · runs on your machine');
  });

  it('a local runtime with no models shows the exact `ollama pull` command', async () => {
    const user = userEvent.setup();
    const empty = db.createProvider({
      type: 'ollama',
      name: 'Fresh Ollama',
      baseUrl: 'http://localhost:11434',
    });
    db.setProviderStatus(empty.id, 'CONNECTED');
    // nothing pulled yet: the runtime lists no models
    server.use(
      http.get('*/models', ({ request }) =>
        new URL(request.url).searchParams.get('providerId') === empty.id
          ? HttpResponse.json({ items: [], refreshedAt: new Date().toISOString() })
          : undefined,
      ),
    );
    pickerDialog();
    await user.click(await screen.findByRole('option', { name: /Fresh Ollama/ }));

    expect(await screen.findByTestId('pull-model-hint')).toHaveTextContent('ollama pull llama3.2');
  });
});

describe('PG-1.4 the four main sections are always shown', () => {
  it('a kind of provider not added yet keeps its section, saying none is added', async () => {
    db.createProvider({ type: 'mock', name: 'Mock' });
    pickerDialog();
    await screen.findByRole('option', { name: /Mock/ });
    for (const name of ['Cloud APIs', 'Local & open models', 'CLI agents', 'Custom endpoints']) {
      expect(groupNamed(name)).toHaveTextContent('None added');
    }
  });
});

describe('PG-1.3 the provider-first dialog', () => {
  it('names the provider, waits for a provider and a model, then hands back both', async () => {
    const user = userEvent.setup();
    const { mock } = seedProviders();
    const { onConfirm } = pickerDialog();
    const dialog = await screen.findByRole('dialog', { name: /provider/i });
    const add = within(dialog).getByRole('button', { name: 'Add node' });
    expect(add).toBeDisabled();

    await user.click(await within(dialog).findByRole('option', { name: /Mock/ }));
    expect(add).toBeDisabled();
    await user.click(await within(dialog).findByRole('option', { name: /Mock JSON/ }));
    expect(add).toBeEnabled();
    await user.click(add);

    expect(onConfirm).toHaveBeenCalledWith({ providerId: mock.id, modelId: 'mock-json' });
  });

  it('Cancel hands back nothing', async () => {
    const user = userEvent.setup();
    seedProviders();
    const { onConfirm, onCancel } = pickerDialog();
    const dialog = await screen.findByRole('dialog', { name: /provider/i });
    await user.click(await within(dialog).findByRole('option', { name: /Mock/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('with no connected provider: "Connect a provider" and the detected Ollama, added in one click (FR-PRV-007)', async () => {
    const user = userEvent.setup();
    pickerDialog();
    const dialog = await screen.findByRole('dialog', { name: /provider/i });

    expect(await within(dialog).findByRole('link', { name: /Connect a provider/ })).toHaveAttribute(
      'href',
      '/providers',
    );
    await user.click(await within(dialog).findByRole('button', { name: 'Add Ollama' }));

    await waitFor(() => expect(db.listProviders().map((p) => p.type)).toContain('ollama'));
    const added = db.listProviders().find((p) => p.type === 'ollama')!;
    // the new runtime is chosen, under Local & open models
    expect(
      await within(groupNamed('Local & open models')).findByRole('option', {
        name: new RegExp(added.name),
      }),
    ).toHaveAttribute('aria-selected', 'true');
  });
});

describe('PG-1.4 the Providers page groups its providers', () => {
  it('lists a detected Ollama under "Local & open models" with its models, and the mock elsewhere', async () => {
    const { ollama } = seedProviders();
    renderApp('/providers');

    const local = await screen.findByRole('region', { name: 'Local & open models' });
    expect(within(local).getByTestId(`provider-name-${ollama.id}`)).toHaveTextContent(
      'Ollama here',
    );
    const row = await within(local).findByTestId('local-model-llama-mock');
    expect(row).toHaveTextContent('1.2 GB');
    expect(row).toHaveTextContent('Free · runs on your machine');
    for (const name of within(local).getAllByTestId(/^provider-name-/)) {
      expect(name).not.toHaveTextContent('Mock');
    }
    expect(screen.getByRole('region', { name: 'Test providers' })).toHaveTextContent('Mock');
    expect(screen.getByRole('region', { name: 'Cloud APIs' })).toHaveTextContent('Claude API');
  });

  it('keeps Local & open models with the `ollama pull` hint when there is no local runtime', async () => {
    db.createProvider({ type: 'mock', name: 'Mock' });
    renderApp('/providers');
    const local = await screen.findByRole('region', { name: 'Local & open models' });
    expect(within(local).getByTestId('pull-model-hint')).toHaveTextContent('ollama pull llama3.2');
  });
});
