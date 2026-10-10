import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installMatchMedia, uninstallMatchMedia } from '../responsive/test-support';
import { db, installMockServer, renderApp } from '../test/app';

installMockServer();
beforeEach(() => installMatchMedia(true));
afterEach(() => uninstallMatchMedia());

describe('D299 FR-MOB-001 Forge on a phone is browse-only', () => {
  it('shows the tree, then a file read-only, and offers nothing that edits', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'Shop' });
    const workflow = db.createWorkflow(project.id, 'Main');
    db.seedFiles(project.id, { 'README.md': '# Shop' });
    renderApp(`/projects/${project.id}/workflows/${workflow.id}/forge`);

    expect(await screen.findByTestId('compact-forge')).toHaveTextContent('Browse only on a phone');
    expect(screen.queryByTestId('forge')).toBeNull();
    expect(screen.queryByRole('button', { name: 'New File' })).toBeNull();

    const item = await screen.findByTestId('tree-item-README.md');
    // No editing: no context menu and no rename on F2.
    fireEvent.contextMenu(item);
    expect(screen.queryByRole('menu')).toBeNull();
    item.focus();
    await user.keyboard('{F2}');
    expect(screen.queryByRole('textbox')).toBeNull();

    await user.click(item);
    expect(await screen.findByLabelText('Contents of README.md')).toHaveTextContent('# Shop');
    expect(screen.queryByRole('textbox')).toBeNull();

    await user.click(screen.getByRole('button', { name: /Files/ }));
    expect(await screen.findByTestId('compact-forge')).toBeInTheDocument();
  });
});
