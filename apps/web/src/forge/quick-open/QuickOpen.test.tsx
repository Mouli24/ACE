import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { db, installMockServer, renderApp, server } from '../../test/app';
import { openFile } from '../editor/actions';
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

  it('puts open files first, moves with the arrows, keeps the highlight in view, and closes with Escape', async () => {
    const user = userEvent.setup();
    const { projectId, path } = seed();
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    renderApp(path);
    await screen.findByTestId('forge');
    openFile(projectId, 'src/util/math.ts', { preview: false });
    await user.keyboard('{Control>}p{/Control}');
    await screen.findByRole('combobox', { name: 'Go to file' });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('data-path', 'src/util/math.ts');
    scroll.mockClear();
    await user.keyboard('{ArrowDown}');
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    expect(scroll).toHaveBeenLastCalledWith({ block: 'nearest' });
    await user.keyboard('{ArrowUp}');
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Go to file' })).toBeNull());
  });

  it('says when the file list failed, and Retry brings the files', async () => {
    const user = userEvent.setup();
    const { path } = seed();
    // The Explorer lists the files too, for its count (D334), so the list fails until Retry —
    // not just once, which the Explorer's own request would use up.
    let failing = true;
    server.use(
      http.get('*/api/v1/projects/:id/files/list', () =>
        failing
          ? HttpResponse.json(
              { error: { code: 'internal', message: 'disk on fire' } },
              { status: 500 },
            )
          : undefined,
      ),
    );
    renderApp(path);
    await screen.findByTestId('forge');
    await user.keyboard('{Control>}p{/Control}');
    expect(await screen.findByText(/Could not list the project’s files/)).toBeInTheDocument();
    expect(screen.queryByText('No file matches.')).toBeNull();
    failing = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
  });
});

describe('D328 quick open in the theme', () => {
  it('is the modal shell with the theme’s field, the matches as menu rows in the orange wash', async () => {
    const user = userEvent.setup();
    const { path } = seed();
    renderApp(path);
    await screen.findByTestId('forge');
    await user.keyboard('{Control>}p{/Control}');
    const input = await screen.findByRole('combobox', { name: 'Go to file' });
    expect(input).toHaveClass('h-[38px]', 'rounded-[9px]', 'focus:border-[#ef6b3f]');
    expect(screen.getByRole('dialog')).toHaveClass('rounded-[18px]', 'top-[12%]');
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
    const [first, second] = screen.getAllByRole('option');
    expect(first).toHaveAttribute('data-highlighted');
    expect(first).toHaveClass('h-8', 'data-[highlighted]:bg-[rgba(239,107,63,0.12)]');
    expect(second).not.toHaveAttribute('data-highlighted');
    await user.keyboard('{ArrowDown}');
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('data-highlighted');
    expect(within(screen.getAllByRole('option')[1]!).getByText('src')).toHaveClass('font-machine');
  });
});
