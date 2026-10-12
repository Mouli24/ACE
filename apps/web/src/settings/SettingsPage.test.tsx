import { aceError } from '@ace/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { backupZip, readBackup } from '../mocks/handlers-round5';
import { db, installMockServer, renderApp, server } from '../test/app';
import { THEME_KEY, setThemeMode } from '../theme/mode';

installMockServer();

// D329: the theme is this browser's `ace-theme`; every test starts from the default, light.
beforeEach(() => {
  localStorage.removeItem(THEME_KEY);
  setThemeMode('light');
  localStorage.removeItem(THEME_KEY);
});
afterAll(() => setThemeMode('light'));

/**
 * The download's bytes. Which `Blob` arrives depends on where `fetch` comes from: Node's (CI, Linux)
 * has `arrayBuffer()` and is refused by jsdom's FileReader; jsdom's has no `arrayBuffer()` but its
 * FileReader reads it. Use whichever the blob supports.
 */
function readBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

async function settled(testId: string): Promise<HTMLElement> {
  const element = await screen.findByTestId(testId);
  await waitFor(() => expect(element).not.toBeDisabled());
  return element;
}

describe('TC-SYS-006 Settings persist', () => {
  it('changing concurrency to 5 saves through PATCH /settings, and a fresh read shows 5', async () => {
    const user = userEvent.setup();
    const first = renderApp('/settings');
    const concurrency = await settled('settings-concurrency');
    await waitFor(() => expect(concurrency).toHaveValue(20));

    await user.clear(concurrency);
    await user.type(concurrency, '5{Enter}');
    await waitFor(() => expect(db.settings.concurrency).toBe(5));
    expect(await screen.findByText('Settings saved')).toBeInTheDocument();

    // "Restart": a new tree reads the engine again rather than any local draft.
    first.unmount();
    renderApp('/settings');
    await waitFor(() => expect(screen.getByTestId('settings-concurrency')).toHaveValue(5));
  });
});

describe('FR-SYS-005 Settings screen', () => {
  it('shows the data folder read-only, in monospace, with a copy button', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderApp('/settings');
    const dataDir = await screen.findByTestId('settings-data-dir');
    await waitFor(() => expect(dataDir).toHaveValue('/mock/.ace'));
    expect(dataDir).toHaveAttribute('readonly');
    expect(dataDir.className).toContain('font-machine');
    await user.click(screen.getByRole('button', { name: 'Copy data folder path' }));
    expect(writeText).toHaveBeenCalledWith('/mock/.ace');
  });

  it('refuses a concurrency outside 1–64 inline and never saves it', async () => {
    const user = userEvent.setup();
    renderApp('/settings');
    const concurrency = await settled('settings-concurrency');
    for (const bad of ['0', '65', '2.5']) {
      await user.clear(concurrency);
      await user.type(concurrency, bad);
      fireEvent.blur(concurrency);
      expect(await screen.findByText('Must be a whole number from 1 to 64.')).toBeInTheDocument();
    }
    expect(db.settings.concurrency).toBe(20);
  });

  it('saves the upload limit and refuses one below 1', async () => {
    const user = userEvent.setup();
    renderApp('/settings');
    const limit = await settled('settings-upload-limit');
    await waitFor(() => expect(limit).toHaveValue(100));
    await user.clear(limit);
    await user.type(limit, '0');
    fireEvent.blur(limit);
    expect(await screen.findByText('Must be a whole number of at least 1.')).toBeInTheDocument();
    expect(db.settings.maxUploadMb).toBe(100);

    await user.clear(limit);
    await user.type(limit, '250');
    fireEvent.blur(limit);
    await waitFor(() => expect(db.settings.maxUploadMb).toBe(250));
  });

  it('saves a SearXNG URL and refuses one that is not a URL', async () => {
    const user = userEvent.setup();
    renderApp('/settings');
    const searxng = await settled('settings-searxng');
    await user.type(searxng, 'not a url');
    fireEvent.blur(searxng);
    expect(
      await screen.findByText('Must be a full URL, like http://localhost:8080.'),
    ).toBeInTheDocument();
    expect(db.settings.searxngUrl).toBeUndefined();

    await user.clear(searxng);
    await user.type(searxng, 'http://localhost:8080{Enter}');
    await waitFor(() => expect(db.settings.searxngUrl).toBe('http://localhost:8080'));
  });

  it('saves the theme, the Docker sandbox mode and the default provider from their selects', async () => {
    const user = userEvent.setup();
    const provider = db.createProvider({ type: 'mock', name: 'Mock' });
    db.patchSettings({ theme: 'system' });
    renderApp('/settings');

    // D329: the select shows this browser's choice (default Light), not the engine's value.
    const theme = await settled('settings-theme');
    expect(theme).toHaveTextContent('Light');
    await user.click(theme);
    const options = await screen.findAllByRole('option');
    // the theme's ✓ column marks the current one
    expect(options.map((option) => option.textContent)).toEqual(['Dark', '✓Light', 'System']);
    await user.click(screen.getByRole('option', { name: 'Dark' }));
    // …applied at once and remembered in the browser, and still patched to the engine.
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'dark'));
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
    await waitFor(() => expect(db.settings.theme).toBe('dark'));
    expect(theme).toHaveTextContent('Dark');
    expect(screen.queryByText(/render in a later round/)).not.toBeInTheDocument();

    const docker = await settled('settings-docker');
    await user.click(docker);
    await user.click(await screen.findByRole('option', { name: 'off' }));
    await waitFor(() => expect(db.settings.dockerSandbox).toBe('off'));

    const defaultProvider = await settled('settings-default-provider');
    expect(defaultProvider).toHaveTextContent('none');
    await user.click(defaultProvider);
    await user.click(await screen.findByRole('option', { name: 'Mock' }));
    await waitFor(() => expect(db.settings.defaultProviderId).toBe(provider.id));
  });

  it('saves the MCP switch and says telemetry is off without offering a toggle', async () => {
    const user = userEvent.setup();
    renderApp('/settings');
    const mcp = await settled('settings-mcp');
    expect(mcp).toHaveAttribute('role', 'switch');
    expect(mcp).toHaveAccessibleName('Allow MCP servers');
    expect(mcp).toHaveAttribute('aria-checked', 'true');
    await user.click(mcp);
    await waitFor(() => expect(db.settings.mcpEnabled).toBe(false));
    await waitFor(() => expect(mcp).toHaveAttribute('aria-checked', 'false'));

    const privacy = screen.getByTestId('settings-privacy');
    expect(privacy).toHaveTextContent('Telemetry is off');
    expect(within(privacy).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(privacy).queryByRole('switch')).not.toBeInTheDocument();
  });

  it('shows an error toast and keeps the server value when the engine refuses a save', async () => {
    const user = userEvent.setup();
    server.use(
      http.patch('*/api/v1/settings', () =>
        HttpResponse.json(aceError('invalid_config', 'invalid', 'Nope.'), { status: 400 }),
      ),
    );
    renderApp('/settings');
    const concurrency = await settled('settings-concurrency');
    await user.clear(concurrency);
    await user.type(concurrency, '7{Enter}');
    expect(
      await screen.findByText('Settings not saved', {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    await waitFor(() => expect(concurrency).toHaveValue(20), { timeout: 5000 });
    expect(db.settings.concurrency).toBe(20);
  });

  it('keeps the provider chips, the daily budget and the health panel', async () => {
    renderApp('/settings');
    expect(await screen.findByTestId('settings-providers')).toBeInTheDocument();
    expect(screen.getByTestId('daily-budget')).toBeInTheDocument();
    expect(screen.getByTestId('budget-fields')).toBeInTheDocument();
  });
});

describe('FR-SYS-012 Backup', () => {
  it('Export downloads the zip as ace-backup-YYYY-MM-DD.zip through an object URL', async () => {
    const user = userEvent.setup();
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:mock-backup';
    });
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const downloads: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push(this.download);
    });

    renderApp('/settings');
    await user.click(await screen.findByTestId('backup-export'));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0]).toMatch(/^ace-backup-\d{4}-\d{2}-\d{2}\.zip$/);
    const bytes = await readBytes(blobs[0]!);
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]); // "PK"
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-backup');
    expect(await screen.findByText('Backup downloaded')).toBeInTheDocument();
    click.mockRestore();
  });

  it('Export shows the error when the engine refuses', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('*/api/v1/backup/export', () =>
        HttpResponse.json(aceError('invalid_config', 'disk_full', 'The disk is full.'), {
          status: 500,
        }),
      ),
    );
    renderApp('/settings');
    await user.click(await screen.findByTestId('backup-export'));
    expect(await screen.findByTestId('backup-export-error')).toHaveTextContent('The disk is full.');
  });

  it('Import asks first, warns it replaces current data, then shows what was restored', async () => {
    const user = userEvent.setup();
    db.createProject({ name: 'Kept in backup' });
    const zip = backupZip(db);
    db.reset();
    db.createProject({ name: 'About to be replaced' });
    // jsdom's File does not survive Node's multipart encoding byte for byte, so the restore itself
    // is stood in for here; the real handler is covered with raw multipart in handlers-round5.test,
    // and end to end with a real zip in e2e/settings.spec.ts.
    const uploads: string[] = [];
    server.use(
      http.post('*/api/v1/backup/import', ({ request }) => {
        uploads.push(request.headers.get('content-type') ?? '');
        const backup = readBackup(zip)!;
        db.importBackup(backup);
        return HttpResponse.json({
          restored: {
            projects: backup.projects.length,
            runs: backup.runs.length,
            artifacts: backup.artifacts.length,
          },
        });
      }),
    );

    renderApp('/settings');
    const input = await screen.findByTestId('backup-import-file');
    expect(input).toHaveAttribute('accept', expect.stringContaining('.zip'));
    await user.upload(
      input,
      new File([new Uint8Array(zip)], 'ace-backup.zip', { type: 'application/zip' }),
    );

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('replaces');
    expect(db.listProjects().map((project) => project.name)).toEqual(['About to be replaced']);
    await user.click(within(dialog).getByRole('button', { name: 'Replace and restore' }));

    const restored = await screen.findByTestId('backup-restored');
    expect(restored).toHaveTextContent('1 project');
    expect(restored).toHaveTextContent('0 runs');
    expect(restored).toHaveTextContent('0 artifacts');
    expect(uploads).toEqual([expect.stringContaining('multipart/form-data')]);
    expect(db.listProjects().map((project) => project.name)).toEqual(['Kept in backup']);
  });

  it('Import cancelled from the dialog changes nothing', async () => {
    const user = userEvent.setup();
    const zip = backupZip(db);
    db.createProject({ name: 'Still here' });
    renderApp('/settings');
    await user.upload(
      await screen.findByTestId('backup-import-file'),
      new File([new Uint8Array(zip)], 'ace-backup.zip', { type: 'application/zip' }),
    );
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(db.listProjects().map((project) => project.name)).toEqual(['Still here']);
    expect(screen.queryByTestId('backup-restored')).not.toBeInTheDocument();
  });

  it('Import of a file that is not a backup shows the engine’s reason', async () => {
    const user = userEvent.setup();
    renderApp('/settings');
    await user.upload(
      await screen.findByTestId('backup-import-file'),
      new File([new Uint8Array([1, 2, 3])], 'junk.zip', { type: 'application/zip' }),
    );
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Replace and restore',
      }),
    );
    expect(await screen.findByTestId('backup-import-error')).toHaveTextContent(
      'That file is not an ACE backup.',
    );
  });
});
