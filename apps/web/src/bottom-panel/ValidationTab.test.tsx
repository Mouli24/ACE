import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { usePanelsStore } from '../app/stores/panels';
import { useSelectionStore } from '../app/stores/selection';
import { createNode } from '../nodes/factory';
import { db, installMockServer, renderApp } from '../test/app';

installMockServer();
vi.mock('../canvas/Canvas', () => ({ Canvas: () => <div data-testid="canvas" /> }));

describe('Bottom panel (round 1 §5 step 3, FR-WF-006)', () => {
  it('Validation lists issues with severity, code, message and a node link; later tabs say their round', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'P' });
    const workflow = db.createWorkflow(project.id, 'F');
    const agent = createNode('agent', workflow.id, { x: 0, y: 0 });
    db.commitGraph(workflow.id, [agent], []);
    renderApp(`/projects/${project.id}/workflows/${workflow.id}`);
    await screen.findByTestId('canvas');

    await user.click(screen.getByRole('button', { name: 'Validate' }));
    const list = await screen.findByRole('list');
    expect(within(list).getAllByLabelText('error').length).toBeGreaterThan(0);
    expect(within(list).getAllByLabelText('warning')).toHaveLength(1);
    expect(within(list).getByText('unconnected_required_input')).toBeInTheDocument();
    await user.click(within(list).getAllByRole('button', { name: 'show node' })[0]!);
    expect(useSelectionStore.getState().focusedNodeId).toBe(agent.id);

    for (const [tab, round] of [
      ['Events', 'Round 3'],
      ['Errors', 'Round 3'],
      ['Timeline', 'Round 4'],
    ] as const) {
      await user.click(screen.getByRole('tab', { name: tab }));
      expect(await screen.findByText(`${tab} — available in ${round}.`)).toBeInTheDocument();
    }
    act(() => usePanelsStore.getState().setBottomTab('validation'));
  });
});
