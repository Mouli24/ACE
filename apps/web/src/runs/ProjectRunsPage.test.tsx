import { screen } from '@testing-library/react';

import { db, installMockServer, renderApp } from '../test/app';

installMockServer();

describe('FR-EXE-012 the project runs page', () => {
  it('lists each workflow’s runs in a padded card (RunsList carries no padding of its own)', async () => {
    const project = db.createProject({ name: 'P' });
    db.createWorkflow(project.id, 'Launch post');
    renderApp(`/projects/${project.id}/runs`);

    expect(await screen.findByRole('heading', { name: 'Launch post' })).toBeInTheDocument();
    const empty = await screen.findByText(/No runs yet/);
    expect(empty.className).not.toMatch(/(^|\s)p-\d/);
    expect(empty.parentElement).toHaveClass('rounded-card', 'border', 'p-4');
  });
});
