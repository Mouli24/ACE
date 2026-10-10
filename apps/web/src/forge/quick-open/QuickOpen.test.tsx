import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { db, installMockServer, renderApp } from '../../test/app';
import { useEditorStore } from '../editor/editor-store';

installMockServer();

function seed() {
  const project = db.createProject({ name: 'Shop' });
  const workflow = db.createWorkflow(project.id, 'Main');
  db.seedFiles(project.id, {
    'src/app.ts': '',
    'src/util/math.ts': '',
    'README.md': '',
    'node_modules/x.js': '',
  });
  return { projectId: project.id, path: `/projects/${project.id}/workflows/${workflow.id}/forge` };
}

describe('D299 Ctrl/⌘+P opens any file by a few letters', () => {
  it('lists the project’s files, never the ignored ones, and opens the chosen one pinned', async () => {
    const user = userEvent.setup();
    const { projectId, path } = seed();
    renderApp(path);
    await screen.findByTestId('forge');

    await user.keyboard('{Control>}p{/Control}');
    const input = await screen.findByRole('combobox', { name: 'Go to file' });
    await waitFor(() =>
      expect(screen.getAllByRole('option').map((o) => o.getAttribute('data-path'))).toEqual([
        'README.md',
        'src/app.ts',
        'src/util/math.ts',
      ]),
    );

    await user.type(input, 'mth');
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('data-path', 'src/util/math.ts');
    await user.keyboard('{Enter}');

    expect(screen.queryByRole('combobox', { name: 'Go to file' })).toBeNull();
    expect(useEditorStore.getState().projects[projectId]).toMatchObject({
      active: 'src/util/math.ts',
      preview: undefined,
    });
  });

  it('puts open files first, moves with the arrows, and closes with Escape', async () => {
    const user = userEvent.setup();
    const { path } = seed();
    renderApp(path);
    await screen.findByTestId('forge');
    await user.click(screen.getByRole('button', { name: /Go to file/ }));
    await screen.findByRole('combobox', { name: 'Go to file' });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
    await user.keyboard('{ArrowDown}');
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Go to file' })).toBeNull());
  });
});
