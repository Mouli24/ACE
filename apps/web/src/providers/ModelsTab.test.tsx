import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { db, installMockServer, renderApp } from '../test/app';

installMockServer();

async function openModelsTab(user: ReturnType<typeof userEvent.setup>) {
  renderApp('/providers');
  await user.click(await screen.findByRole('tab', { name: 'Models' }));
  return screen.findByTestId('models-table');
}

async function pick(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(screen.getByRole('combobox', { name: label }));
  await user.click(await screen.findByRole('option', { name: option }));
}

const rowIds = () =>
  screen
    .getAllByTestId(/^model-row-/)
    .map((row) => row.getAttribute('data-testid')?.replace('model-row-', ''));

describe('TC-MOD-003 the catalog is filterable by provider, data type and availability', () => {
  it('lists every column the catalog carries', async () => {
    const user = userEvent.setup();
    db.createProvider({ type: 'mock', name: 'Mock' });
    const table = await openModelsTab(user);

    const row = within(table).getByTestId('model-row-mock-vision');
    expect(row).toHaveTextContent('Mock vision');
    expect(row).toHaveTextContent('text/image → text');
    expect(row).toHaveTextContent('8,192');
    expect(row).toHaveTextContent('manifest');
    expect(row).toHaveTextContent('$0.0010 / $0.0020');
  });

  it('narrows by input type', async () => {
    const user = userEvent.setup();
    db.createProvider({ type: 'mock', name: 'Mock' });
    await openModelsTab(user);
    expect(rowIds()).toContain('mock-text');

    await pick(user, 'Input type', 'image');

    await waitFor(() => expect(rowIds()).toEqual(['mock-vision']));
  });

  it('narrows by output type', async () => {
    const user = userEvent.setup();
    db.createProvider({ type: 'mock', name: 'Mock' });
    await openModelsTab(user);

    await pick(user, 'Output type', 'json');

    await waitFor(() => expect(rowIds()).toEqual(['mock-json', 'mock-bad-json']));
  });

  it('narrows by availability, and an unavailable model is labelled', async () => {
    const user = userEvent.setup();
    db.createProvider({ type: 'mock', name: 'Mock' });
    await openModelsTab(user);

    await pick(user, 'Availability', 'Unavailable');

    await waitFor(() => expect(rowIds()).toEqual(['mock-retired']));
    expect(screen.getByTestId('model-row-mock-retired')).toHaveTextContent('unavailable');
    expect(screen.getByTestId('model-row-mock-retired')).toHaveAttribute('data-available', 'false');
  });

  it('narrows by provider', async () => {
    const user = userEvent.setup();
    db.createProvider({ type: 'mock', name: 'Mock' });
    db.createProvider({ type: 'anthropic', name: 'Anthropic', apiKey: 'good' });
    await openModelsTab(user);
    expect(rowIds()).toContain('mock-text');
    expect(rowIds()).toContain('claude-sonnet-5');

    await pick(user, 'Provider', 'Anthropic');

    await waitFor(() => expect(rowIds()).toEqual(['claude-sonnet-5', 'claude-haiku-4-5']));
  });

  it('says so when no model matches', async () => {
    const user = userEvent.setup();
    db.createProvider({ type: 'mock', name: 'Mock' });
    await openModelsTab(user);

    await pick(user, 'Input type', 'video');

    expect(await screen.findByText('No model matches these filters.')).toBeInTheDocument();
  });
});

describe('FR-MOD-006 the catalog can be refreshed and says when it last was', () => {
  it('re-reads the provider catalog and shows when it last refreshed', async () => {
    const user = userEvent.setup();
    const provider = db.createProvider({ type: 'mock', name: 'Mock' });
    await openModelsTab(user);
    expect(screen.getByTestId('models-refreshed-at')).toHaveTextContent(/refreshed /);

    // A stale row the engine's own listing would replace: the refresh must overwrite it.
    const stale = db.listModels().find((model) => model.modelId === 'mock-text')!;
    stale.available = false;
    stale.displayName = 'stale name';

    await user.click(screen.getByRole('button', { name: /refresh models/i }));

    await waitFor(() =>
      expect(screen.getByTestId('model-row-mock-text')).toHaveAttribute('data-available', 'true'),
    );
    expect(screen.getByTestId('model-row-mock-text')).toHaveTextContent('Mock text');
    expect(db.listModels().every((model) => model.providerId === provider.id)).toBe(true);
  });
});

describe('D380 a person can mark a model as tool-capable', () => {
  it('the Tools switch sends { supportsTools: true } and the row shows the new state', async () => {
    const user = userEvent.setup();
    const provider = db.createProvider({ type: 'mock', name: 'Mock' });
    await openModelsTab(user);
    const toggle = await screen.findByRole('switch', { name: 'Tools for mock-text' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    await user.click(toggle);

    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Tools for mock-text' })).toHaveAttribute(
        'aria-checked',
        'true',
      ),
    );
    const stored = db.listModels().find((m) => m.providerId === provider.id && m.modelId === 'mock-text');
    expect(stored).toMatchObject({ supportsTools: true, capabilitiesSetByPerson: true });
    expect(screen.getByTestId('model-row-mock-text')).toHaveTextContent('set by you');

    // and it survives Refresh models
    db.refreshModels(provider.id);
    expect(
      db.listModels().find((m) => m.providerId === provider.id && m.modelId === 'mock-text'),
    ).toMatchObject({ supportsTools: true, capabilitiesSetByPerson: true });
  });
});
