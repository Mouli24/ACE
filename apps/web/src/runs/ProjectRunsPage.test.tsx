import { screen } from '@testing-library/react';

import { db, installMockServer, renderApp } from '../test/app';

installMockServer();

describe('FR-EXE-012 the project runs page', () => {
  it('lists each workflow’s runs in a theme card (RunsList carries no frame of its own)', async () => {
    const project = db.createProject({ name: 'P' });
    db.createWorkflow(project.id, 'Launch post');
    renderApp(`/projects/${project.id}/runs`);

    expect(await screen.findByRole('heading', { name: 'Launch post' })).toBeInTheDocument();
    const empty = await screen.findByText(/No runs yet/);
    expect(empty.className).not.toMatch(/(^|\s)(p|px)-|border|rounded/);
    expect(empty.parentElement).toHaveClass('rounded-[12px]', 'border', 'bg-[var(--surface)]');
  });
});
