import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { useLayoutStore } from '../app/stores/layout';
import { db, installMockServer, renderApp } from '../test/app';

installMockServer();

function seed() {
  const project = db.createProject({ name: 'Shop' });
  const workflow = db.createWorkflow(project.id, 'Main');
  db.seedFiles(project.id, { 'src/app.ts': 'export {};', 'README.md': '# Shop' });
  return `/projects/${project.id}/workflows/${workflow.id}/forge`;
}

describe('D299 FR-GIT-003 the Forge workbench', () => {
  it('lays out the activity bar, the Explorer with the project’s files, the editor and the status bar', async () => {
    renderApp(seed());
    const forge = await screen.findByTestId('forge');
    expect(within(forge).getByRole('navigation', { name: 'Forge views' })).toBeInTheDocument();
    expect(await within(forge).findByRole('tree', { name: 'Files of Shop' })).toBeInTheDocument();
    expect(within(forge).getByRole('region', { name: 'Editor' })).toBeInTheDocument();
    expect(within(forge).getByTestId('status-bar')).toBeInTheDocument();
    expect(within(forge).queryByRole('region', { name: 'Panel' })).toBeNull();
  });

  it('hides and shows the side bar and the panel by button and by key, and remembers', async () => {
    const user = userEvent.setup();
    renderApp(seed());
    await screen.findByRole('tree', { name: 'Files of Shop' });

    await user.click(screen.getByRole('button', { name: 'Explorer' }));
    expect(screen.queryByRole('tree', { name: 'Files of Shop' })).toBeNull();
    await user.keyboard('{Control>}b{/Control}');
    expect(await screen.findByRole('tree', { name: 'Files of Shop' })).toBeInTheDocument();

    await user.keyboard('{Control>}j{/Control}');
    expect(screen.getByRole('region', { name: 'Panel' })).toBeInTheDocument();
    expect(useLayoutStore.getState().panelOpen).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Close panel' }));
    expect(screen.queryByRole('region', { name: 'Panel' })).toBeNull();
  });
});
