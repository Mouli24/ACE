import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { usePanelsStore } from '../app/stores/panels';
import { createNode } from '../nodes/factory';
import { installMatchMedia, uninstallMatchMedia } from '../responsive/test-support';
import { useRunStore } from '../runs/run-store';
import { db, installMockServer, renderApp } from '../test/app';

installMockServer();

const canvas = vi.hoisted(() => ({ addNode: vi.fn() }));

// A stand-in Canvas: the page's own layout is under test here, not the board (Canvas*.test).
vi.mock('../canvas/Canvas', async () => {
  const { useEffect } = await import('react');
  const { useCanvasApi } = await import('../canvas/canvas-api');
  return {
    Canvas: ({ workflowId, readOnly }: { workflowId: string; readOnly?: boolean }) => {
      useEffect(
        () =>
          useCanvasApi.getState().register({
            addNode: canvas.addNode,
            deleteNodes: () => undefined,
            fitView: () => undefined,
            duplicateSelection: () => undefined,
            ...(readOnly === true ? { readOnly } : {}),
          }),
        [readOnly],
      );
      return (
        <div data-testid="canvas" data-readonly={readOnly === true ? 'true' : undefined}>
          {workflowId}
        </div>
      );
    },
  };
});

beforeEach(() => {
  canvas.addNode.mockReset();
  usePanelsStore.setState({
    sheetOpen: false,
    sheetTab: 'inspect',
    bottomOpen: false,
    chatNodeId: undefined,
    settings: undefined,
  });
});
afterEach(() => {
  uninstallMatchMedia();
  useRunStore.getState().reset();
});

function seed() {
  const project = db.createProject({ name: 'P' });
  const workflow = db.createWorkflow(project.id, 'Launch post');
  const agent = createNode('agent', workflow.id, { x: 0, y: 0 });
  db.commitGraph(workflow.id, [agent], []);
  return {
    project,
    workflow,
    agent,
    path: `/projects/${project.id}/workflows/${workflow.id}`,
  };
}

describe('D332 / FR-CHAT-004 the Ideate screen', () => {
  it('the Canvas fills the page, Chat is a column beside it, and there is no palette', async () => {
    const { path } = seed();
    renderApp(path);
    const surface = await screen.findByTestId('canvas');

    const page = screen.getByTestId('workflow-page');
    // the Canvas sits in its own positioned box, so the sheet and the halt note float over it
    expect(surface.parentElement).toHaveClass('relative', 'min-h-0', 'flex-1');

    // the chat column is the layout's (D299): beside the page, never inside it
    const column = screen.getByTestId('chat-column');
    expect(page.contains(column)).toBe(false);
    // one Chat landmark (ChatAside's own <aside aria-label="Chat">), not one nested in another
    expect(column.tagName).toBe('DIV');
    const chat = within(column).getByRole('complementary', { name: 'Chat' });
    expect(chat).toBe(within(column).getByTestId('chat-aside'));
    expect(within(column).getAllByRole('complementary')).toHaveLength(1);
    // the column's left rule is drawn once, by the Chat aside itself
    expect(column).not.toHaveClass('border-l');
    expect(chat).toHaveClass('border-l', 'border-[var(--line)]', 'bg-[var(--panel)]');

    expect(screen.queryByLabelText('Node palette')).toBeNull();
    expect(screen.queryByTestId('palette-agent')).toBeNull();
    // Chat is the column now, not a tab of the sheet
    expect(screen.queryByRole('tab', { name: 'Chat' })).toBeNull();
  });

  it('the sheet is closed until opened, opens on the Inspector, and its ✕ closes it', async () => {
    const user = userEvent.setup();
    const { path } = seed();
    renderApp(path);
    await screen.findByTestId('canvas');
    expect(screen.queryByTestId('workflow-sheet')).toBeNull();

    act(() => usePanelsStore.getState().openSheet());
    const sheet = await screen.findByRole('region', { name: 'Workflow panel' });
    expect(within(sheet).getByRole('tab', { name: 'Inspector' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // D332: Configure gave way to the node settings modal
    expect(within(sheet).queryByRole('tab', { name: 'Configure' })).toBeNull();

    within(sheet).getByRole('button', { name: 'Close panel' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.queryByTestId('workflow-sheet')).toBeNull();
  });

  it('D333 the node settings modal opens on openSettings', async () => {
    const { path, agent } = seed();
    renderApp(path);
    await screen.findByTestId('canvas');
    expect(screen.queryByTestId('config-panel')).toBeNull();

    act(() => usePanelsStore.getState().openSettings({ kind: 'node', id: agent.id }));
    const panel = await screen.findByTestId('config-panel');
    expect(panel.closest('[role="dialog"]')).not.toBeNull();
  });

  it('the New node dialog is gone: Add node is the Canvas’s own pill (D332)', async () => {
    const { path } = seed();
    renderApp(path);
    await screen.findByTestId('canvas');
    expect(screen.queryByRole('dialog', { name: 'New node' })).toBeNull();
  });

  it('the bottom panel is hidden until opened, then 232 px; there is no collapsed bar', async () => {
    const { path } = seed();
    renderApp(path);
    await screen.findByTestId('canvas');
    expect(screen.queryByTestId('bottom-section')).toBeNull();

    act(() => usePanelsStore.getState().setBottomTab('events'));
    const section = await screen.findByTestId('bottom-section');
    expect(section).toHaveStyle({ height: '232px' });
    expect(section).toHaveClass('border-[var(--line)]', 'bg-[var(--panel)]');

    act(() => usePanelsStore.getState().toggleBottom());
    expect(screen.queryByTestId('bottom-section')).toBeNull();
  });

  it('FR-GRD-008 the halt note floats over the Canvas', async () => {
    const { path, workflow } = seed();
    renderApp(path);
    const surface = await screen.findByTestId('canvas');
    act(() =>
      useRunStore.setState({ workflowId: workflow.id, status: 'HALTED', haltReason: 'stopped' }),
    );
    const note = await screen.findByTestId('halt-reason');
    expect(surface.parentElement).toContainElement(note);
  });
});

describe('FR-MOB-001 the phone layout mounts none of the desktop chrome', () => {
  it('no sheet, no Chat column, no modal and no bottom panel, even with their flags set', async () => {
    installMatchMedia(true);
    const { path, agent } = seed();
    usePanelsStore.setState({
      sheetOpen: true,
      bottomOpen: true,
      settings: { kind: 'node', id: agent.id },
    });
    renderApp(path);
    expect(await screen.findByTestId('compact-workflow')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('canvas')).toHaveAttribute('data-readonly', 'true'),
    );
    expect(screen.queryByTestId('workflow-sheet')).toBeNull();
    expect(screen.queryByTestId('chat-column')).toBeNull();
    expect(screen.queryByTestId('chat-aside')).toBeNull();
    expect(screen.queryByTestId('config-panel')).toBeNull();
    expect(screen.queryByTestId('bottom-section')).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'New node' })).toBeNull();
  });
});
