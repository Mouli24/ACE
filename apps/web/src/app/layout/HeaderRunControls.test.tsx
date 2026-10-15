import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { useRunStore } from '../../runs/run-store';
import { db, installMockServer, renderApp, renderWithQuery } from '../../test/app';
import { HeaderRunControls } from './HeaderRunControls';

installMockServer();

vi.mock('../../canvas/Canvas', () => ({
  Canvas: ({ workflowId }: { workflowId: string }) => <div data-testid="canvas">{workflowId}</div>,
}));

afterEach(() => act(() => useRunStore.getState().reset()));

function seed() {
  const project = db.createProject({ name: 'Shop' });
  const workflow = db.createWorkflow(project.id, 'Main');
  return { project, workflow, base: `/projects/${project.id}/workflows/${workflow.id}` };
}

function mount(workflowId: string) {
  renderWithQuery(
    <MemoryRouter>
      <HeaderRunControls workflowId={workflowId} />
    </MemoryRouter>,
  );
  return within(screen.getByRole('group', { name: 'Run controls' }));
}

/** The overlay as the engine would leave it for a run of this workflow. */
function holdRun(workflowId: string, status: 'RUNNING' | 'PAUSED', allowed: string[]) {
  act(() =>
    useRunStore.setState({
      workflowId,
      runId: '01RUN000000000000000000001',
      status,
      active: true,
      allowedActions: allowed as never,
    }),
  );
}

describe('PG-1.2 run controls in the workspace header (D360)', () => {
  it.each([
    ['Ideate', ''],
    ['Forge', '/forge'],
    ['Domain', '/domain'],
  ])('sit in the header in %s: Run, Pause, Stop, Restart', async (_mode, suffix) => {
    const { base } = seed();
    renderApp(`${base}${suffix}`);
    // the workspace header comes first; Domain draws a header of its own below it
    const [header] = await screen.findAllByRole('banner');
    const group = within(await within(header!).findByRole('group', { name: 'Run controls' }));
    for (const name of ['Run', 'Pause', 'Stop', 'Restart']) {
      expect(group.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('with no run, only Run is enabled — the others wait for a run that allows them', () => {
    const { workflow } = seed();
    const group = mount(workflow.id);
    expect(group.getByRole('button', { name: 'Run' })).toBeEnabled();
    for (const name of ['Pause', 'Stop', 'Restart']) {
      expect(group.getByRole('button', { name })).toBeDisabled();
    }
  });

  it('enables exactly what the run’s allowedActions names (FR-CTL-006); Run waits while one is active', () => {
    const { workflow } = seed();
    holdRun(workflow.id, 'RUNNING', ['pause', 'stop']);
    const group = mount(workflow.id);
    expect(group.getByRole('button', { name: 'Run' })).toBeDisabled();
    expect(group.getByRole('button', { name: 'Pause' })).toBeEnabled();
    expect(group.getByRole('button', { name: 'Stop' })).toBeEnabled();
    expect(group.getByRole('button', { name: 'Restart' })).toBeDisabled();
  });

  it('Pause reads Resume while the run allows resuming', () => {
    const { workflow } = seed();
    holdRun(workflow.id, 'PAUSED', ['resume', 'stop']);
    const group = mount(workflow.id);
    expect(group.getByRole('button', { name: 'Resume' })).toBeEnabled();
    expect(group.queryByRole('button', { name: 'Pause' })).toBeNull();
  });

  it('another workflow’s run enables nothing here', () => {
    const { workflow } = seed();
    holdRun('01OTHERWORKFLOW00000000000', 'RUNNING', ['pause', 'stop']);
    const group = mount(workflow.id);
    expect(group.getByRole('button', { name: 'Pause' })).toBeDisabled();
    expect(group.getByRole('button', { name: 'Run' })).toBeEnabled();
  });

  it('Stop asks first (FR-CTL-003)', async () => {
    const { workflow } = seed();
    holdRun(workflow.id, 'RUNNING', ['pause', 'stop']);
    const group = mount(workflow.id);
    await userEvent.click(group.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByTestId('stop-confirm')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Keep running' }));
    await waitFor(() => expect(screen.queryByTestId('stop-confirm')).toBeNull());
  });
});
