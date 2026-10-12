import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { db, installMockServer, renderApp } from '../../test/app';
import { THEME_KEY, setThemeMode } from '../../theme/mode';
import { sectionLabel } from './SiteHeader';

installMockServer();

afterEach(() => setThemeMode('light'));

describe('sectionLabel', () => {
  it.each([
    ['/projects/P1', 'PROJECT'],
    ['/projects/P1/runs', 'RUNS'],
    ['/projects/P1/knowledge', 'KNOWLEDGE'],
    ['/knowledge/K1', 'KNOWLEDGE'],
    ['/projects/P1/workflows/W1/timeline', 'TIMELINE'],
    ['/runs/R1', 'RUN'],
    ['/providers', 'PROVIDERS'],
    ['/guardrails', 'GUARDRAILS'],
    ['/library/tools', 'TOOLS'],
    ['/usage', 'USAGE'],
    ['/settings', 'SETTINGS'],
    ['/help/getting-started', 'HELP'],
    ['/onboarding', 'ONBOARDING'],
  ])('%s reads %s', (path, label) => {
    expect(sectionLabel(path)).toBe(label);
  });

  it('has none for a path it does not know', () => {
    expect(sectionLabel('/')).toBeUndefined();
  });
});

describe('D330 Home’s header on every other route', () => {
  it('is the Home header: ACE to Home, the section label, the theme toggle', async () => {
    renderApp('/settings');
    const header = await screen.findByRole('banner');
    expect(header).toHaveClass(
      'sticky',
      'h-[44px]',
      'gap-[10px]',
      'px-9',
      'bg-[var(--hdr)]',
      'backdrop-blur-[10px]',
      'shadow-[0_1px_0_var(--line)]',
    );
    expect(within(header).getByRole('link', { name: 'ACE' })).toHaveAttribute('href', '/projects');
    const label = within(header).getByTestId('section-label');
    expect(label).toHaveTextContent('SETTINGS');
    expect(label).toHaveClass(
      'text-[9px]',
      'tracking-[0.12em]',
      'font-semibold',
      'text-[var(--muted)]',
    );
    // nothing else of the old top bar
    expect(within(header).queryByRole('link', { name: 'Usage' })).toBeNull();
    expect(screen.queryByTestId('provider-status-bar')).toBeNull();
    expect(screen.queryByTestId('day-totals-chip')).toBeNull();
    expect(screen.queryByRole('contentinfo')).toBeNull();
  });

  it('labels a project page PROJECT', async () => {
    const project = db.createProject({ name: 'P' });
    renderApp(`/projects/${project.id}`);
    expect(await screen.findByTestId('section-label')).toHaveTextContent('PROJECT');
    expect(screen.queryByTestId('mode-switch')).toBeNull();
  });

  it('labels a workflow’s timeline TIMELINE, with no mode switch', async () => {
    const project = db.createProject({ name: 'P' });
    const workflow = db.createWorkflow(project.id, 'F');
    renderApp(`/projects/${project.id}/workflows/${workflow.id}/timeline`);
    expect(await screen.findByTestId('section-label')).toHaveTextContent('TIMELINE');
    expect(screen.queryByTestId('mode-switch')).toBeNull();
    expect(screen.queryByTestId('chat-toggle')).toBeNull();
  });

  it('carries the Home-size theme toggle, which writes ace-theme', async () => {
    const user = userEvent.setup();
    renderApp('/usage');
    const toggle = within(await screen.findByRole('banner')).getByTestId('theme-toggle');
    expect(toggle).toHaveClass('gap-1');
    await user.click(toggle);
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
  });
});
