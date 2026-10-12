import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installMatchMedia, uninstallMatchMedia } from '../responsive/test-support';
import { db, installMockServer, renderApp } from '../test/app';
import { useEditorStore } from './editor/editor-store';
import { useExplorerStore } from './explorer/explorer-store';

installMockServer();
let media: ReturnType<typeof installMatchMedia>;
beforeEach(() => {
  media = installMatchMedia(true);
});
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
    // No editing. Each negative is paired with a signal that the event really landed.
    expect(item).not.toHaveAttribute('draggable', 'true');
    fireEvent.contextMenu(item);
    expect(item).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('menu')).toBeNull();
    act(() => item.focus());
    expect(item).toHaveFocus();
    await user.keyboard('{F2}');
    expect(screen.queryByRole('textbox')).toBeNull();
    await user.keyboard('{Delete}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(item);
    expect(await screen.findByLabelText('Contents of README.md')).toHaveTextContent('# Shop');
    expect(screen.queryByRole('textbox')).toBeNull();

    await user.click(screen.getByRole('button', { name: /Files/ }));
    expect(await screen.findByTestId('compact-forge')).toBeInTheDocument();
  });

  it('an inline name left open at desktop width never shows on the phone', async () => {
    const project = db.createProject({ name: 'Shop' });
    const workflow = db.createWorkflow(project.id, 'Main');
    db.seedFiles(project.id, { 'README.md': '# Shop' });
    act(() => useExplorerStore.getState().startRename(project.id, 'README.md'));
    renderApp(`/projects/${project.id}/workflows/${workflow.id}/forge`);
    await screen.findByTestId('tree-item-README.md');
    expect(screen.queryByRole('textbox')).toBeNull();

    act(() => {
      useExplorerStore.getState().startCreate(project.id, '', 'file');
    });
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('an unsaved buffer survives desktop, phone, desktop', async () => {
    const user = userEvent.setup();
    media.set(false);
    const project = db.createProject({ name: 'Shop' });
    const workflow = db.createWorkflow(project.id, 'Main');
    db.seedFiles(project.id, { 'README.md': '# Shop' });
    renderApp(`/projects/${project.id}/workflows/${workflow.id}/forge`);

    await user.click(await screen.findByTestId('tree-item-README.md'));
    const editor = await screen.findByLabelText('Editing README.md');
    await user.type(editor, '!');
    expect(await screen.findByTestId('dirty-README.md')).toBeInTheDocument();
    const edited = (editor as HTMLTextAreaElement).value;
    expect(edited).toContain('!');

    act(() => media.set(true));
    expect(await screen.findByTestId('compact-forge')).toBeInTheDocument();
    expect(screen.queryByTestId('forge')).toBeNull();
    expect(useEditorStore.getState().projects[project.id]?.files['README.md']?.dirty).toBe(true);

    act(() => media.set(false));
    expect(await screen.findByTestId('forge')).toBeInTheDocument();
    expect(await screen.findByTestId('dirty-README.md')).toBeInTheDocument();
    expect(await screen.findByLabelText('Editing README.md')).toHaveValue(edited);
  });
});
