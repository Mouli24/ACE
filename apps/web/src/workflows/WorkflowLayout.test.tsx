import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { useLayoutStore } from '../app/stores/layout';
import { db, installMockServer, renderApp } from '../test/app';

installMockServer();

vi.mock('../canvas/Canvas', () => ({
  Canvas: ({ workflowId }: { workflowId: string }) => <div data-testid="canvas">{workflowId}</div>,
}));

function seed() {
  const project = db.createProject({ name: 'Shop' });
  const main = db.createWorkflow(project.id, 'Main');
  const second = db.createWorkflow(project.id, 'Second');
  db.seedFiles(project.id, { 'README.md': '# Shop' });
  return { project, main, second, ideate: `/projects/${project.id}/workflows/${main.id}` };
}

describe('D299 Ideate and Forge, one click apart', () => {
  it('lands in Ideate with the switch on Ideate and the chat on the right', async () => {
    renderApp(seed().ideate);
    expect(await screen.findByTestId('canvas')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Ideate/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('chat-aside')).toBeInTheDocument();
  });

  it('switches to Forge and back by button, keeping the very same chat column mounted', async () => {
    const user = userEvent.setup();
    const { router } = renderApp(seed().ideate);
    const chat = await screen.findByTestId('chat-aside');

    await user.click(screen.getByRole('radio', { name: /Forge/ }));
    expect(await screen.findByTestId('forge')).toBeInTheDocument();
    expect(router.state.location.pathname).toMatch(/\/forge$/);
    expect(screen.getByTestId('chat-aside')).toBe(chat);

    await user.click(screen.getByRole('radio', { name: /Ideate/ }));
    expect(await screen.findByTestId('canvas')).toBeInTheDocument();
    expect(screen.getByTestId('chat-aside')).toBe(chat);
  });

  it('switches by Ctrl+Shift+2 and Ctrl+Shift+1, and hides the chat with Ctrl+Alt+B', async () => {
    const user = userEvent.setup();
    renderApp(seed().ideate);
    await screen.findByTestId('canvas');
    await user.keyboard('{Control>}{Shift>}2{/Shift}{/Control}');
    expect(await screen.findByTestId('forge')).toBeInTheDocument();
    await user.keyboard('{Control>}{Shift>}1{/Shift}{/Control}');
    expect(await screen.findByTestId('canvas')).toBeInTheDocument();
    await user.keyboard('{Control>}{Alt>}b{/Alt}{/Control}');
    expect(screen.queryByTestId('chat-aside')).toBeNull();
    expect(useLayoutStore.getState().chatOpen).toBe(false);
  });

  it('keeps the mode when another workflow’s tab is chosen', async () => {
    const user = userEvent.setup();
    const { project, second, ideate } = seed();
    const { router } = renderApp(`${ideate}/forge`);
    await screen.findByTestId('forge');
    await user.click(await screen.findByRole('tab', { name: 'Second' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        `/projects/${project.id}/workflows/${second.id}/forge`,
      ),
    );
  });

  it('shows New node and the workflow panel toggle in Ideate only', async () => {
    const user = userEvent.setup();
    renderApp(seed().ideate);
    expect(await screen.findByTestId('new-node-button')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Forge/ }));
    await screen.findByTestId('forge');
    expect(screen.queryByTestId('new-node-button')).toBeNull();
    expect(screen.queryByTestId('sheet-toggle')).toBeNull();
  });

  it('says so when the workflow does not exist', async () => {
    const { project } = seed();
    renderApp(`/projects/${project.id}/workflows/01J9ZZZZZZZZZZZZZZZZZZZZZZ/forge`);
    expect(await screen.findByRole('alert')).toHaveTextContent('Workflow not found.');
  });

  it('offers the switch on the timeline with neither mode checked, and Ideate leads back', async () => {
    const user = userEvent.setup();
    const { project, main, ideate } = seed();
    const { router } = renderApp(`${ideate}/timeline`);
    expect(await screen.findByTestId('mode-switch')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Ideate/ })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: /Forge/ })).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByTestId('chat-toggle')).toBeNull();
    expect(screen.queryByTestId('new-node-button')).toBeNull();
    await user.click(screen.getByRole('radio', { name: /Ideate/ }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/projects/${project.id}/workflows/${main.id}`),
    );
  });
});
