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

describe('D328 FR-MOB-002 the phone’s Forge in the theme', () => {
  it('the read-only banner and the Explorer’s rows, then the file under mono crumbs with a 44px Back', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'Shop' });
    const workflow = db.createWorkflow(project.id, 'Main');
    db.seedFiles(project.id, { 'docs/guide.md': '# Guide' });
    renderApp(`/projects/${project.id}/workflows/${workflow.id}/forge`);

    const forge = await screen.findByTestId('compact-forge');
    expect(forge).toHaveClass('bg-[var(--panel)]');
    expect(screen.getByRole('note')).toHaveClass('text-[11.5px]', 'text-[var(--muted)]');
    await user.click(await screen.findByTestId('tree-item-docs'));
    const file = await screen.findByTestId('tree-item-docs/guide.md');
    expect(file).toHaveClass('h-[26px]', 'rounded-[6px]');
    await user.click(file);

    const page = await screen.findByTestId('compact-file');
    expect(page).toHaveClass('bg-[var(--surface)]');
    expect(screen.getByText('docs')).toHaveClass('text-[var(--muted)]');
    expect(screen.getByText('guide.md')).toHaveClass('text-[var(--ink)]');
    expect(screen.getByRole('button', { name: /Files/ }).parentElement).toHaveClass(
      '[&_button]:min-h-11',
    );
    expect(await screen.findByLabelText('Contents of docs/guide.md')).toHaveClass(
      'font-machine',
      'leading-[20px]',
    );
  });
});
