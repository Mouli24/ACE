import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { usePanelsStore } from '../app/stores/panels';
import { createNode } from '../nodes/factory';
import { installMatchMedia, uninstallMatchMedia } from '../responsive/test-support';
import { useRunStore } from '../runs/run-store';
import { db, installMockServer, renderApp } from '../test/app';

installMockServer();

const canvas = vi.hoisted(() => ({ addNode: vi.fn() }));

// A stand-in Canvas that publishes the one action the page wires (New node → addNode).
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
    sheetTab: 'configure',
    newNodeOpen: false,
    bottomOpen: true,
    chatNodeId: undefined,
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
  return { project, workflow, path: `/projects/${project.id}/workflows/${workflow.id}` };
}

describe('FR-CAN-002 / FR-CHAT-004 the Canvas screen in the V2 layout', () => {
  it('Canvas and bottom panel on the left, Chat as a column on the right, no palette', async () => {
    const { path } = seed();
    renderApp(path);
    const surface = await screen.findByTestId('canvas');

    const page = screen.getByTestId('workflow-page');
    // the Canvas sits in its own positioned box, so the sheet and the halt note float over it
    expect(surface.parentElement).toHaveClass('relative', 'min-h-0');

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
    expect(chat).toHaveClass('border-l', 'border-border', 'bg-panel');

    expect(screen.queryByLabelText('Node palette')).toBeNull();
    expect(screen.queryByTestId('palette-agent')).toBeNull();
    // Chat is the column now, not a tab of the sheet
    expect(screen.queryByRole('tab', { name: 'Chat' })).toBeNull();
  });

  it('the sheet is closed until the top bar’s panel toggle opens it', async () => {
    const user = userEvent.setup();
    const { path } = seed();
    renderApp(path);
    await screen.findByTestId('canvas');
    expect(screen.queryByTestId('workflow-sheet')).toBeNull();

    await user.click(screen.getByTestId('sheet-toggle'));
    const sheet = await screen.findByTestId('workflow-sheet');
    expect(within(sheet).getByRole('tab', { name: 'Configure' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await user.click(screen.getByTestId('sheet-toggle'));
    expect(screen.queryByTestId('workflow-sheet')).toBeNull();
  });

  it('closing the sheet from its own Close button hands focus back to the panel toggle', async () => {
    const user = userEvent.setup();
    const { path } = seed();
    renderApp(path);
    await screen.findByTestId('canvas');
    const toggle = screen.getByTestId('sheet-toggle');

    await user.click(toggle);
    const sheet = await screen.findByRole('region', { name: 'Workflow panel' });
    // the toggle names what it opens
    expect(toggle).toHaveAttribute('aria-controls', sheet.id);
    expect(sheet.id).not.toBe('');

    // keyboard-activate Close: focus must not fall to <body> when the sheet unmounts
    within(sheet).getByRole('button', { name: 'Close panel' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.queryByTestId('workflow-sheet')).toBeNull();
    expect(toggle).toHaveFocus();
  });

  it('New node opens the dialog; adding a kind calls the Canvas’s addNode and closes it', async () => {
    const user = userEvent.setup();
    const { path } = seed();
    renderApp(path);
    await screen.findByTestId('canvas');

    await user.click(screen.getByTestId('new-node-button'));
    const dialog = await screen.findByRole('dialog', { name: 'New node' });
    expect(dialog).toHaveTextContent('Launch post');

    // D285: the one node the Canvas offers is an Agent
    await user.dblClick(within(dialog).getByTestId('palette-agent'));
    expect(canvas.addNode).toHaveBeenCalledWith('agent', expect.any(Object));
    expect(usePanelsStore.getState().newNodeOpen).toBe(false);
    expect(screen.queryByRole('dialog', { name: 'New node' })).toBeNull();
  });

  it('the bottom panel collapses to its 40 px tab row and opens to 232 px', async () => {
    const user = userEvent.setup();
    const { path } = seed();
    renderApp(path);
    await screen.findByTestId('canvas');

    const section = screen.getByTestId('bottom-section');
    expect(section).toHaveStyle({ height: '232px' });
    expect(section).toHaveClass('transition-[height]', 'duration-200');
    await user.click(within(section).getByTestId('bottom-toggle'));
    expect(section).toHaveStyle({ height: '40px' });
    await user.click(within(section).getByTestId('bottom-toggle'));
    expect(section).toHaveStyle({ height: '232px' });
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
    expect(screen.getByTestId('run-bar')).not.toContainElement(note);
  });
});

describe('FR-MOB-001 the phone layout mounts none of the desktop chrome', () => {
  it('no sheet, no Chat column and no New node dialog, even with their flags set', async () => {
    installMatchMedia(true);
    const { path } = seed();
    usePanelsStore.setState({ sheetOpen: true, newNodeOpen: true });
    renderApp(path);
    expect(await screen.findByTestId('compact-workflow')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('canvas')).toHaveAttribute('data-readonly', 'true'),
    );
    expect(screen.queryByTestId('workflow-sheet')).toBeNull();
    expect(screen.queryByTestId('chat-column')).toBeNull();
    expect(screen.queryByTestId('chat-aside')).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'New node' })).toBeNull();
  });
});
