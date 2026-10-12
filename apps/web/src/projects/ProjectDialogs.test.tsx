import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { db, installMockServer, renderWithQuery } from '../test/app';
import { DeleteProjectDialog, RenameProjectDialog } from './ProjectDialogs';

installMockServer();
// `test/app` loads the route tree; these dialogs render no route, so Forge's page stays out of it.
vi.mock('../forge/ForgePage', () => ({ ForgePage: () => null }));

/*
 * Rename and Delete left Home's project rows for the workspace "…" menu (D331, D337); the dialogs
 * that menu opens are these, so their behaviour is asserted here.
 */
describe('project dialogs (FR-PRJ-002/003)', () => {
  it('renames a project (FR-PRJ-002)', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'Old' });
    const onClose = vi.fn();
    renderWithQuery(<RenameProjectDialog project={project} onClose={onClose} />);
    const dialog = await screen.findByRole('dialog', { name: 'Rename project' });
    const input = within(dialog).getByLabelText(/name/i);
    await user.clear(input);
    await user.type(input, 'New');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(db.listProjects()[0]?.name).toBe('New');
  });

  it('TC-PRJ-003: delete asks for confirmation, then removes the project', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'Gone' });
    const onDeleted = vi.fn();
    renderWithQuery(
      <DeleteProjectDialog project={project} onClose={() => undefined} onDeleted={onDeleted} />,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Delete “Gone”?' });
    expect(db.listProjects()).toHaveLength(1);
    expect(dialog).toHaveTextContent(project.folderPath);
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(db.listProjects()).toHaveLength(0);
  });

  it('Cancel closes without deleting', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'Kept' });
    const onClose = vi.fn();
    renderWithQuery(<DeleteProjectDialog project={project} onClose={onClose} />);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(db.listProjects()).toHaveLength(1);
  });
});
