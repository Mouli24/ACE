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
    // severity is a shape, not colour alone (WCAG 1.4.1)
    expect(within(list).getAllByLabelText('error')[0]!.tagName.toLowerCase()).toBe('svg');
    // D285: an Agent with nothing upstream starts from its goal — and this one has none yet
    expect(within(list).getByText('missing_input')).toBeInTheDocument();
    expect(within(list).queryByText('unconnected_required_input')).toBeNull();
    // Round 2 changed this one: an agent with no model used to be a warning ("providers arrive in
    // round 2"); now that providers exist it blocks the run, so pre-flight and the panel both call
    // it an error (R2 §2.7 item 2, D50).
    expect(within(list).getByText('missing_model')).toBeInTheDocument();
    expect(within(list).queryAllByLabelText('warning')).toHaveLength(0);
    await user.click(within(list).getAllByRole('button', { name: 'show node' })[0]!);
    expect(useSelectionStore.getState().focusedNodeId).toBe(agent.id);

    // Events, Errors and now Timeline (round 4) are all real panes — no "later" placeholders remain.
    await user.click(screen.getByRole('tab', { name: 'Timeline' }));
    expect(screen.queryByText('Timeline — available in Round 4.')).not.toBeInTheDocument();
    // D-072: the tab links to the full page, filters in the URL (FR-CHAT-002)
    expect(await screen.findByTestId('timeline-open-full')).toHaveAttribute(
      'href',
      `/projects/${project.id}/workflows/${workflow.id}/timeline`,
    );
    act(() => usePanelsStore.getState().setBottomTab('validation'));
  });
});

describe('FR-MOD-005 the validation panel shows the model-catalogue issues', () => {
  it('reports provider_missing, unavailable_model and incompatible_model with their nodes', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'P' });
    const workflow = db.createWorkflow(project.id, 'F');
    const provider = db.createProvider({ type: 'mock', name: 'Mock' });

    // One node per issue the round file names, so the panel is asserted on all three.
    const gone = createNode('agent', workflow.id, { x: 0, y: 0 });
    gone.config = {
      ...gone.config,
      providerId: '01ZZZ00000000000000000000Z',
      modelId: 'mock-text',
    } as typeof gone.config;
    const retired = createNode('agent', workflow.id, { x: 300, y: 0 });
    retired.config = {
      ...retired.config,
      providerId: provider.id,
      modelId: 'mock-retired',
    } as typeof retired.config;
    const wrongTypes = createNode('agent', workflow.id, { x: 600, y: 0 });
    wrongTypes.config = {
      ...wrongTypes.config,
      providerId: provider.id,
      modelId: 'mock-text',
      inputTypes: ['image'],
    } as typeof wrongTypes.config;

    db.commitGraph(workflow.id, [gone, retired, wrongTypes], []);
    renderApp(`/projects/${project.id}/workflows/${workflow.id}`);
    await screen.findByTestId('canvas');

    await user.click(screen.getByRole('button', { name: 'Validate' }));
    const list = await screen.findByRole('list');

    expect(within(list).getByText('provider_missing')).toBeInTheDocument();
    expect(within(list).getByText('unavailable_model')).toBeInTheDocument();
    expect(within(list).getByText('incompatible_model')).toBeInTheDocument();

    // Each one links to the node it is about, so "fix this" has a where (FR-WF-006).
    await user.click(within(list).getAllByRole('button', { name: 'show node' })[0]!);
    expect(useSelectionStore.getState().focusedNodeId).toBe(gone.id);
  });
});
