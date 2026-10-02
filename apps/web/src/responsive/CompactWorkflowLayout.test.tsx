import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { createNode } from '../nodes/factory';
import { db, installMockServer, renderApp } from '../test/app';
import { installMatchMedia, uninstallMatchMedia } from './test-support';

installMockServer();
afterEach(() => uninstallMatchMedia());

function seedWorkflow() {
  const project = db.createProject({ name: 'Phone project' });
  const workflow = db.createWorkflow(project.id, 'Phone flow');
  const agent = createNode('agent', workflow.id, { x: 0, y: 0 });
  db.commitGraph(workflow.id, [agent], []);
  return `/projects/${project.id}/workflows/${workflow.id}`;
}

describe('FR-MOB-001 / FR-MOB-003 the Canvas screen at phone width', () => {
  it('renders the monitoring layout: read-only Canvas with the banner, and tabs instead of panes', async () => {
    installMatchMedia(true);
    renderApp(seedWorkflow());

    expect(await screen.findByTestId('compact-workflow')).toBeInTheDocument();
    expect(screen.getByTestId('readonly-banner')).toHaveTextContent(
      'Editing is available on a larger screen.',
    );
    expect(await screen.findByTestId('canvas')).toHaveAttribute('data-readonly', 'true');
    for (const name of ['Canvas', 'Runs', 'Inspector', 'Chat', 'Memory']) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument();
    }
    // The editor's panes are not there: no palette, no Configure tab.
    expect(screen.queryByTestId('palette-agent')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Configure' })).not.toBeInTheDocument();
    // The top bar folds its links into the menu.
    expect(screen.getByTestId('topbar-menu')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Usage' })).not.toBeInTheDocument();
  });

  it('switches to the runs tab', async () => {
    installMatchMedia(true);
    renderApp(seedWorkflow());
    await userEvent.click(await screen.findByRole('tab', { name: 'Runs' }));
    expect(await screen.findByText(/No runs yet/)).toBeInTheDocument();
  });

  it('keeps the desktop editor above 640 px', async () => {
    installMatchMedia(false);
    renderApp(seedWorkflow());
    expect(await screen.findByRole('tab', { name: 'Configure' })).toBeInTheDocument();
    expect(screen.queryByTestId('compact-workflow')).not.toBeInTheDocument();
    expect(screen.queryByTestId('readonly-banner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('topbar-menu')).not.toBeInTheDocument();
    expect(await screen.findByTestId('canvas')).not.toHaveAttribute('data-readonly');
  });
});
