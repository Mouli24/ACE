import { screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { db, installMockServer, renderWithQuery } from '../test/app';
import { RunBar } from './RunBar';
import { useRunStore } from './run-store';

installMockServer();

afterEach(() => useRunStore.getState().reset());

function haltRun(workflowId: string) {
  useRunStore.setState({
    workflowId,
    runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    status: 'HALTED',
    haltReason: 'stopped',
    allowedActions: ['restart'],
    active: false,
  });
}

function renderBar(haltInline?: boolean) {
  const project = db.createProject({ name: 'P' });
  const workflow = db.createWorkflow(project.id, 'F');
  haltRun(workflow.id);
  renderWithQuery(
    <MemoryRouter>
      <RunBar workflowId={workflow.id} {...(haltInline === undefined ? {} : { haltInline })} />
    </MemoryRouter>,
  );
}

describe('RunBar halt note placement (Review Focus 5)', () => {
  it('shows the halt note inline by default, as the compact header does', () => {
    renderBar();
    expect(screen.getByTestId('halt-reason')).toBeInTheDocument();
  });

  it('shows no halt note when haltInline is false, the Canvas carries it', () => {
    renderBar(false);
    expect(screen.queryByTestId('halt-reason')).toBeNull();
    expect(screen.getByTestId('run-status')).toHaveAttribute('data-status', 'HALTED');
  });

  it('keeps Start reachable by name while no run is active', () => {
    renderBar();
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
  });
});
