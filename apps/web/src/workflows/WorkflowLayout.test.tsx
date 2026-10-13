import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { useLayoutStore } from '../app/stores/layout';
import { usePanelsStore } from '../app/stores/panels';
import { useComposerChips } from '../chat/composer-chips';
import { createNode } from '../nodes/factory';
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

  it('lays the chat column beside the main area as a fixed aside, not a resizable pane (D330)', async () => {
    renderApp(seed().ideate);
    await screen.findByTestId('canvas');
    const column = screen.getByTestId('chat-column');
    expect(column).toHaveClass('flex', 'shrink-0');
    const main = column.previousElementSibling as HTMLElement;
    expect(main).toHaveClass('flex', 'min-w-0', 'flex-1');
    expect(main).toContainElement(screen.getByTestId('canvas'));
    expect(screen.queryByRole('separator')).toBeNull();
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
    expect(screen.getByTestId('chat-toggle')).toHaveAttribute('aria-pressed', 'false');
  });

  it('Split shows in all three modes: CHAT in Ideate and Forge, TEAM in Domain', async () => {
    const user = userEvent.setup();
    renderApp(seed().ideate);
    expect(await screen.findByTestId('chat-toggle')).toHaveAccessibleName('CHAT Split');
    await user.click(screen.getByRole('radio', { name: /Forge/ }));
    await screen.findByTestId('forge');
    expect(screen.getByTestId('chat-toggle')).toHaveAccessibleName('CHAT Split');
    await user.click(screen.getByRole('radio', { name: /Domain/ }));
    await screen.findByTestId('domain-page');
    expect(screen.getByTestId('chat-toggle')).toHaveAccessibleName('TEAM Split');
  });

  it('drops a chat target that is not in the workflow, with the chat column closed (F-I2)', async () => {
    const { project, main, second } = seed();
    const writer = createNode('agent', main.id, { x: 0, y: 0 });
    db.commitGraph(main.id, [writer], []);
    usePanelsStore.getState().chatWith(writer.id);
    useLayoutStore.setState({ chatOpen: false });
    const { router } = renderApp(`/projects/${project.id}/workflows/${main.id}`);
    await screen.findByTestId('canvas');
    expect(usePanelsStore.getState().chatNodeId).toBe(writer.id);

    await act(() => router.navigate(`/projects/${project.id}/workflows/${second.id}/forge`));
    await waitFor(() => expect(usePanelsStore.getState().chatNodeId).toBeUndefined());
    expect(screen.queryByTestId('chat-aside')).toBeNull();
  });

  it('clears the composer’s chips and draft when the project changes (B-M7)', async () => {
    const { project, main, second } = seed();
    const other = db.createProject({ name: 'Other' });
    const elsewhere = db.createWorkflow(other.id, 'Elsewhere');
    useComposerChips.getState().reset();
    const { router } = renderApp(`/projects/${project.id}/workflows/${main.id}`);
    await screen.findByTestId('canvas');
    act(() => {
      useComposerChips.getState().add({ path: 'src/a.ts', language: 'typescript' });
      useComposerChips.getState().prefill('Fix this problem: x');
    });

    // another workflow of the same project: the chip's path still means the same file
    await act(() => router.navigate(`/projects/${project.id}/workflows/${second.id}`));
    await screen.findByText(second.id);
    expect(useComposerChips.getState().chips).toHaveLength(1);

    await act(() => router.navigate(`/projects/${other.id}/workflows/${elsewhere.id}`));
    await screen.findByText(elsewhere.id);
    expect(useComposerChips.getState().chips).toEqual([]);
    expect(useComposerChips.getState().draft).toBeUndefined();
  });

  it('says so when the workflow does not exist', async () => {
    const { project } = seed();
    renderApp(`/projects/${project.id}/workflows/01J9ZZZZZZZZZZZZZZZZZZZZZZ/forge`);
    expect(await screen.findByRole('alert')).toHaveTextContent('Workflow not found.');
  });

  it('the timeline is outside the workspace: Home’s header, no switch, and a way back to the Canvas', async () => {
    const user = userEvent.setup();
    const { project, main, ideate } = seed();
    const { router } = renderApp(`${ideate}/timeline`);
    expect(await screen.findByTestId('section-label')).toHaveTextContent('TIMELINE');
    expect(screen.queryByTestId('mode-switch')).toBeNull();
    expect(screen.queryByTestId('chat-toggle')).toBeNull();
    await user.click(screen.getByRole('link', { name: 'open the Canvas' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/projects/${project.id}/workflows/${main.id}`),
    );
  });
});
