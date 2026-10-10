import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { renderWithQuery } from '../../test/app';
import { openFile } from '../editor/actions';
import { useEditorStore } from '../editor/editor-store';
import { OpenEditors } from './OpenEditors';

const P = 'p1';
beforeEach(() => useEditorStore.setState({ projects: {} }));

describe('D299 Open editors from the keyboard', () => {
  it('each row is a button that activates its file; a dirty row still has a focusable close button', async () => {
    const user = userEvent.setup();
    renderWithQuery(<OpenEditors projectId={P} />);
    act(() => {
      openFile(P, 'src/a.ts');
      openFile(P, 'src/b.ts');
      useEditorStore.getState().setDirty(P, 'src/a.ts', true);
    });
    const row = screen.getByRole('button', { name: /a\.ts.*unsaved/i });
    await user.click(row);
    expect(useEditorStore.getState().projects[P]?.active).toBe('src/a.ts');
    const close = screen.getByRole('button', { name: 'Close a.ts' });
    expect(close.className).not.toMatch(/\bhidden\b/);
    close.focus();
    expect(close).toHaveFocus();
  });
});
