import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { installMatchMedia, uninstallMatchMedia } from '../../responsive/test-support';
import { installMockServer, renderApp } from '../../test/app';

installMockServer();
afterEach(() => uninstallMatchMedia());

/**
 * The Library (ACE parity P1, D272, D273): `/library/:tab` with Tools, Skills, Plugins and
 * Bundles, `/library` and any unknown tab going to Tools, and — no longer orphaned — a link to it
 * in the top bar and the phone menu.
 */

describe('ACE parity P1 the Library has four tabs, each its own route', () => {
  it('/library opens on Tools, which still shows the registry and the MCP servers', async () => {
    const { router } = renderApp('/library');
    expect(await screen.findByRole('heading', { name: 'Library', level: 1 })).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe('/library/tools'));
    expect(screen.getByRole('tab', { name: 'Tools' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: 'Tools', level: 2 })).toBeInTheDocument();
    expect(await screen.findByTestId('tool-row-echo')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-servers-panel')).toBeInTheDocument();
  });

  it('keeps /library/tools working, and sends an unknown tab to Tools', async () => {
    renderApp('/library/tools');
    expect(await screen.findByTestId('tools-tab')).toBeInTheDocument();

    const { router } = renderApp('/library/nope');
    await waitFor(() => expect(router.state.location.pathname).toBe('/library/tools'));
  });

  it('moves between tabs through the URL', async () => {
    const user = userEvent.setup();
    const { router } = renderApp('/library/tools');
    await screen.findByTestId('tools-tab');

    await user.click(screen.getByRole('tab', { name: 'Skills' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/library/skills'));
    expect(await screen.findByTestId('skills-tab')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Plugins' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/library/plugins'));
    const plugins = await screen.findByTestId('plugins-tab');
    expect(within(plugins).getByTestId('mcp-servers-panel')).toBeInTheDocument();
    expect(within(plugins).getByText(/Connecting one enables nothing/)).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Bundles' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/library/bundles'));
    expect(await screen.findByTestId('bundles-tab')).toBeInTheDocument();
  });

  it('opens a tab straight from its address', async () => {
    renderApp('/library/bundles');
    expect(await screen.findByTestId('bundles-tab')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Bundles' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('ACE parity P1 the Library is reachable from every screen', () => {
  it('the top bar links to it', async () => {
    installMatchMedia(false);
    renderApp('/projects');
    const link = await screen.findByRole('link', { name: 'Library' });
    expect(link).toHaveAttribute('href', '/library');
  });

  it('the phone menu links to it', async () => {
    const user = userEvent.setup();
    installMatchMedia(true);
    const { router } = renderApp('/projects');
    await user.click(await screen.findByTestId('topbar-menu'));
    const item = await screen.findByRole('menuitem', { name: 'Library' });
    expect(item).toHaveAttribute('href', '/library');
    await user.click(item);
    await waitFor(() => expect(router.state.location.pathname).toBe('/library/tools'));
  });
});
