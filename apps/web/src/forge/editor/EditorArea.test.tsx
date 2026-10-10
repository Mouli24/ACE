import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { db, installMockServer, renderWithQuery } from '../../test/app';
import { openFile } from './actions';
import { EditorArea } from './EditorArea';
import { useEditorStore } from './editor-store';
import { getModel } from './models';

installMockServer();

let projectId: string;
beforeEach(() => {
  projectId = db.createProject({ name: 'Shop' }).id;
  db.seedFiles(projectId, {
    'src/app.ts': 'export const app = 1;\n',
    'src/index.ts': '',
    'lib/index.ts': '',
    'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'blob.bin': 'a\u0000b',
  });
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => vi.restoreAllMocks());

describe('D299 FR-GIT-004 the editor area', () => {
  it('opens a file in a tab and shows its text', async () => {
    renderWithQuery(<EditorArea projectId={projectId} />);
    act(() => openFile(projectId, 'src/app.ts'));
    expect(await screen.findByRole('tab', { name: /app\.ts/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await screen.findByLabelText('Editing src/app.ts')).toHaveValue(
      'export const app = 1;\n',
    );
  });

  it('a preview tab is italic, replaced by the next preview, and pinned by an edit', async () => {
    const user = userEvent.setup();
    renderWithQuery(<EditorArea projectId={projectId} />);
    act(() => openFile(projectId, 'src/app.ts', { preview: true }));
    expect(await screen.findByTestId('tab-src/app.ts')).toHaveClass('italic');
    act(() => openFile(projectId, 'src/index.ts', { preview: true }));
    expect(await screen.findByTestId('tab-src/index.ts')).toBeInTheDocument();
    expect(screen.queryByTestId('tab-src/app.ts')).toBeNull();
    expect(
      getModel(projectId, 'src/app.ts'),
      'the replaced preview’s model is disposed',
    ).toBeUndefined();

    await user.type(await screen.findByLabelText('Editing src/index.ts'), 'x');
    expect(screen.getByTestId('tab-src/index.ts')).not.toHaveClass('italic');
    expect(screen.getByTestId('dirty-src/index.ts')).toBeInTheDocument();
  });

  it('closes a tab with its button or a middle click, and shows the next one', async () => {
    const user = userEvent.setup();
    renderWithQuery(<EditorArea projectId={projectId} />);
    act(() => {
      openFile(projectId, 'src/app.ts');
      openFile(projectId, 'src/index.ts');
    });
    await user.click(await screen.findByRole('button', { name: 'Close index.ts' }));
    expect(screen.queryByTestId('tab-src/index.ts')).toBeNull();
    expect(useEditorStore.getState().projects[projectId]?.active).toBe('src/app.ts');
  });

  it('tells two files of the same name apart by their folder', async () => {
    renderWithQuery(<EditorArea projectId={projectId} />);
    act(() => {
      openFile(projectId, 'src/index.ts');
      openFile(projectId, 'lib/index.ts');
    });
    expect(
      within(await screen.findByTestId('tab-src/index.ts')).getByText('src'),
    ).toBeInTheDocument();
    expect(within(screen.getByTestId('tab-lib/index.ts')).getByText('lib')).toBeInTheDocument();
  });

  it('shows an image as a picture and a binary file as a notice, never as text', async () => {
    renderWithQuery(<EditorArea projectId={projectId} />);
    act(() => openFile(projectId, 'logo.svg'));
    expect(await screen.findByRole('img', { name: 'logo.svg' })).toHaveAttribute(
      'src',
      'blob:preview',
    );
    act(() => openFile(projectId, 'blob.bin'));
    expect(await screen.findByTestId('file-notice')).toHaveTextContent(/binary/);
    expect(screen.queryByTestId('fake-editor')).toBeNull();
  });
});
