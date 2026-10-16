import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { createNode } from '../../nodes/factory';
import { db, installMockServer, renderApp } from '../../test/app';
import { THEME_KEY, setThemeMode } from '../../theme/mode';
import { useLayoutStore } from '../stores/layout';

installMockServer();

vi.mock('../../canvas/Canvas', () => ({
  Canvas: ({ workflowId }: { workflowId: string }) => <div data-testid="canvas">{workflowId}</div>,
}));

afterEach(() => setThemeMode('light'));

function seed() {
  const project = db.createProject({ name: 'Shop' });
  const workflow = db.createWorkflow(project.id, 'Main');
  return { project, workflow, ideate: `/projects/${project.id}/workflows/${workflow.id}` };
}

const header = () => screen.getByRole('banner');

describe('D330 the workspace header', () => {
  it('is the theme’s 44px header: ACE to Home, the mode switch, Split, agents, theme toggle', async () => {
    renderApp(seed().ideate);
    await screen.findByTestId('canvas');
    expect(header()).toHaveClass(
      'h-[44px]',
      'grid-cols-[1fr_auto_1fr]',
      'bg-[var(--hdr)]',
      'border-[var(--line)]',
    );
    const home = within(header()).getByRole('link', { name: 'ACE' });
    expect(home).toHaveAttribute('href', '/projects');
    expect(within(header()).getByTestId('mode-switch')).toBeInTheDocument();
    expect(within(header()).getByTestId('chat-toggle')).toBeInTheDocument();
    expect(within(header()).getByTestId('theme-toggle')).toBeInTheDocument();
    // what the old top bar carried is gone from it (D330)
    for (const gone of ['new-node-button', 'sheet-toggle', 'run-bar', 'topbar-more']) {
      expect(screen.queryByTestId(gone)).toBeNull();
    }
    expect(within(header()).queryByRole('tablist')).toBeNull();
  });

  describe('the mode switch', () => {
    it('is a radio group in the segmented pill, the active one inked', async () => {
      renderApp(seed().ideate);
      await screen.findByTestId('canvas');
      const ideate = screen.getByRole('radio', { name: 'Ideate' });
      const forge = screen.getByRole('radio', { name: 'Forge' });
      expect(ideate).toHaveAttribute('aria-checked', 'true');
      expect(ideate).toHaveAttribute('tabindex', '0');
      expect(ideate).toHaveClass('bg-[var(--seg)]', 'text-[var(--segInk)]', 'h-[26px]', 'px-4');
      expect(forge).toHaveAttribute('aria-checked', 'false');
      expect(forge).toHaveAttribute('tabindex', '-1');
      expect(forge).toHaveClass('bg-transparent', 'text-[var(--muted)]');
      expect(forge).toHaveAttribute('title', 'Forge (Ctrl+Shift+2)');
      expect(screen.getByTestId('mode-switch')).toHaveClass(
        'rounded-full',
        'bg-[var(--soft)]',
        'p-[3px]',
      );
    });

    // D370: skipped until updated to the product-gaps behaviour — see docs/team-prompts/product-gaps/tests-todo.md
    it.skip('moves by click and by the arrow keys', async () => {
      const user = userEvent.setup();
      const { ideate } = seed();
      const { router } = renderApp(ideate);
      await screen.findByTestId('canvas');
      await user.click(screen.getByRole('radio', { name: 'Domain' }));
      await waitFor(() => expect(router.state.location.pathname).toBe(`${ideate}/domain`));
      screen.getByRole('radio', { name: 'Domain' }).focus();
      await user.keyboard('{ArrowLeft}');
      await waitFor(() => expect(router.state.location.pathname).toBe(`${ideate}/forge`));
      await user.keyboard('{ArrowRight}');
      await waitFor(() => expect(router.state.location.pathname).toBe(`${ideate}/domain`));
      await user.keyboard('{ArrowRight}');
      await waitFor(() => expect(router.state.location.pathname).toBe(ideate));
    });
  });

  // D356: the one Split became two toggles, Chat and Team, each remembered on its own.
  describe('Chat and Team', () => {
    it('Chat toggles the chat column in Ideate', async () => {
      const user = userEvent.setup();
      renderApp(seed().ideate);
      const split = await screen.findByTestId('chat-toggle');
      expect(split).toHaveAccessibleName('Chat');
      expect(split).toHaveAttribute('title', 'Chat (Ctrl+Alt+B)');
      expect(split).toHaveAttribute('aria-pressed', 'true');
      expect(split).toHaveClass('border-[#ef6b3f]', 'bg-[rgba(239,107,63,0.10)]');
      await user.click(split);
      expect(useLayoutStore.getState().chatOpen).toBe(false);
      expect(split).toHaveAttribute('aria-pressed', 'false');
      expect(split).toHaveClass('border-[var(--line)]', 'bg-transparent');
      expect(screen.queryByTestId('chat-column')).toBeNull();
      await user.click(split);
      expect(useLayoutStore.getState().chatOpen).toBe(true);
      expect(await screen.findByTestId('chat-column')).toBeInTheDocument();
    });

    it('Team drives Domain’s Team aside, by click and by Ctrl+Alt+B, leaving Chat as it was', async () => {
      const user = userEvent.setup();
      renderApp(`${seed().ideate}/domain`);
      const split = await screen.findByTestId('team-toggle');
      expect(split).toHaveAccessibleName('Team');
      await user.click(split);
      expect(useLayoutStore.getState().teamOpen).toBe(false);
      expect(useLayoutStore.getState().chatOpen).toBe(true);
      await user.keyboard('{Control>}{Alt>}b{/Alt}{/Control}');
      expect(useLayoutStore.getState().teamOpen).toBe(true);
      expect(useLayoutStore.getState().chatOpen).toBe(true);
    });
  });

  it('shows one avatar per agent or model node, in graph order and colour, named for screen readers', async () => {
    const { workflow, ideate } = seed();
    const writer = { ...createNode('agent', workflow.id, { x: 0, y: 0 }), name: 'Writer' };
    const input = { ...createNode('input', workflow.id, { x: 0, y: 0 }), name: 'Brief' };
    const critic = { ...createNode('model', workflow.id, { x: 0, y: 0 }), name: 'critic' };
    db.commitGraph(workflow.id, [writer, input, critic], []);
    renderApp(ideate);

    const stack = await screen.findByRole('list', { name: 'Agents' });
    const avatars = within(stack).getAllByRole('listitem');
    expect(avatars).toHaveLength(2);
    expect(avatars[0]).toHaveTextContent('WWriter');
    expect(avatars[1]).toHaveTextContent('Ccritic');
    expect(avatars[0]).toHaveClass('-ml-[6px]');
    const first = avatars[0]!.firstElementChild as HTMLElement;
    expect(first).toHaveStyle({ width: '22px', height: '22px', fontSize: '10px' });
    expect(first.style.background).toBe('rgb(239, 107, 63)');
    expect((avatars[1]!.firstElementChild as HTMLElement).style.background).toBe(
      'rgb(122, 98, 214)',
    );
    expect(within(avatars[0]!).getByText('Writer')).toHaveClass('sr-only');
    // not interactive
    expect(within(stack).queryByRole('button')).toBeNull();
  });

  it('has no agent stack when the workflow has no agents', async () => {
    renderApp(seed().ideate);
    await screen.findByTestId('canvas');
    expect(screen.queryByRole('list', { name: 'Agents' })).toBeNull();
  });

  it('the theme toggle writes ace-theme and applies it (D329)', async () => {
    const user = userEvent.setup();
    renderApp(seed().ideate);
    const toggle = within(await screen.findByRole('banner')).getByTestId('theme-toggle');
    await user.click(toggle);
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
    await user.click(toggle);
    expect(localStorage.getItem(THEME_KEY)).toBe('light');
  });
});
