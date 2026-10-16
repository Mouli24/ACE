import { screen, within } from '@testing-library/react';

import { installMatchMedia, uninstallMatchMedia } from '../../responsive/test-support';
import { db, installMockServer, renderApp } from '../../test/app';

installMockServer();

vi.mock('../../canvas/Canvas', () => ({
  Canvas: ({ workflowId }: { workflowId: string }) => <div data-testid="canvas">{workflowId}</div>,
}));

afterEach(() => uninstallMatchMedia());

function seed() {
  const project = db.createProject({ name: 'Shop' });
  const workflow = db.createWorkflow(project.id, 'Main');
  return { project, workflow, ideate: `/projects/${project.id}/workflows/${workflow.id}` };
}

describe('D330 the shell picks its chrome by route', () => {
  it('Ideate: the workspace header and footer around a full-height, non-scrolling main', async () => {
    renderApp(seed().ideate);
    await screen.findByTestId('canvas');
    const main = screen.getAllByRole('main')[0]!;
    expect(main).toHaveClass('flex', 'min-h-0', 'flex-1');
    const root = main.parentElement!;
    expect(root).toHaveClass('h-screen', 'flex-col', 'overflow-hidden', 'bg-[var(--canvas)]');
    expect(root.firstElementChild).toBe(screen.getByRole('banner'));
    expect(root.lastElementChild).toBe(screen.getByRole('contentinfo'));
    expect(screen.queryByTestId('section-label')).toBeNull();
    expect(screen.queryByTestId('topbar-compact')).toBeNull();
  });

  it('Forge: the same header and footer', async () => {
    renderApp(`${seed().ideate}/forge`);
    expect(await screen.findByTestId('forge')).toBeInTheDocument();
    expect(screen.getByTestId('mode-switch')).toBeInTheDocument();
    expect(within(screen.getByRole('contentinfo')).getByTestId('footer-mode')).toHaveTextContent(
      'Forge',
    );
  });

  // D370: skipped until updated to the product-gaps behaviour — see docs/team-prompts/product-gaps/tests-todo.md
  it.skip('Domain, inside the workflow layout (D354), gets the same header and footer', async () => {
    renderApp(`${seed().ideate}/domain`);
    expect(await screen.findByTestId('domain-page')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Domain' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('team-toggle')).toHaveAccessibleName('Team');
    expect(within(screen.getByRole('contentinfo')).getByTestId('footer-mode')).toHaveTextContent(
      'Domain',
    );
  });

  it('Home draws its own header: the shell adds none, only a scrolling outlet', async () => {
    renderApp('/projects');
    await screen.findAllByText(/./);
    expect(screen.queryByTestId('section-label')).toBeNull();
    expect(screen.queryByTestId('mode-switch')).toBeNull();
    expect(screen.queryByRole('contentinfo')).toBeNull();
    expect(screen.queryByTestId('topbar-compact')).toBeNull();
  });

  it('every other route: Home’s header with a section label, and the page scrolls', async () => {
    renderApp('/guardrails');
    expect(await screen.findByTestId('section-label')).toHaveTextContent('GUARDRAILS');
    const header = screen.getByTestId('section-label').closest('header')!;
    expect(header.nextElementSibling).toHaveClass('min-h-0', 'flex-1', 'overflow-auto');
    expect(screen.queryByRole('contentinfo')).toBeNull();
  });

  describe('at phone width (FR-MOB-001)', () => {
    it('keeps the compact bar in the workspace, with no theme header and no footer', async () => {
      installMatchMedia(true);
      renderApp(seed().ideate);
      expect(await screen.findByTestId('topbar-compact')).toBeInTheDocument();
      expect(screen.queryByTestId('chat-toggle')).toBeNull();
      expect(screen.queryByRole('contentinfo')).toBeNull();
    });

    it('keeps the compact bar on every other route too', async () => {
      installMatchMedia(true);
      renderApp('/settings');
      expect(await screen.findByTestId('topbar-compact')).toBeInTheDocument();
      expect(screen.queryByTestId('section-label')).toBeNull();
    });

    it('leaves Home to its own header (no compact bar stacked above it)', async () => {
      installMatchMedia(true);
      renderApp('/projects');
      expect(
        await screen.findByRole('heading', { name: 'What would you like to make?' }),
      ).toBeInTheDocument();
      expect(screen.queryByTestId('topbar-compact')).toBeNull();
    });
  });
});

describe('D338 the settings gear sits in the bottom-left corner', () => {
  it('in the workspace it opens the footer, before the connection status', async () => {
    renderApp(seed().ideate);
    await screen.findByTestId('canvas');
    const footer = screen.getByRole('contentinfo');
    const gear = within(footer).getByTestId('settings-menu');
    expect(gear).toHaveAttribute('data-placement', 'footer');
    expect(gear.parentElement?.firstElementChild).toBe(gear);
    expect(screen.getAllByTestId('settings-menu')).toHaveLength(1);
  });

  it('on Home and every other page it floats in the corner', async () => {
    renderApp('/projects');
    const home = await screen.findByTestId('settings-menu');
    expect(home).toHaveAttribute('data-placement', 'corner');
    expect(home).toHaveClass('fixed', 'bottom-[16px]', 'left-[16px]');
  });

  it('on another page too', async () => {
    renderApp('/guardrails');
    await screen.findByTestId('section-label');
    expect(screen.getByTestId('settings-menu')).toHaveAttribute('data-placement', 'corner');
  });

  it('at phone width it floats only on Home; elsewhere the phone bar’s menu has its links', async () => {
    installMatchMedia(true);
    const { unmount } = renderApp('/settings');
    await screen.findByTestId('topbar-compact');
    expect(screen.queryByTestId('settings-menu')).toBeNull();
    unmount();

    renderApp('/projects');
    expect(await screen.findByTestId('settings-menu')).toHaveAttribute('data-placement', 'corner');
  });
});
