import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { checkpoints, db, installMockServer, renderWithQuery } from '../../test/app';
import { useChangesStore } from '../changes/changes-store';
import { ExplorerView } from './ExplorerView';
import { useSideViewStore } from './side-view-store';

installMockServer();

let projectId: string;
beforeEach(() => {
  projectId = db.createProject({ name: 'Shop' }).id;
  db.seedFiles(projectId, { 'README.md': '# shop\n' });
});

const switcher = () => screen.findByRole('tablist', { name: 'Side bar views' });

describe('D339 the Explorer header switches EXPLORER · SEARCH · CHANGES', () => {
  it('lists CHANGES last; it swaps the tree for the project’s Changes', async () => {
    const user = userEvent.setup();
    const seeded = checkpoints.seed(projectId, [{ path: 'notes.md', before: 'a\n', after: 'b\n' }]);
    renderWithQuery(<ExplorerView projectId={projectId} />);
    const tabs = await switcher();
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['EXPLORER', 'SEARCH', 'CHANGES']);
    expect(await screen.findByRole('tree', { name: 'Files of Shop' })).toBeInTheDocument();

    await user.click(within(tabs).getByRole('tab', { name: 'CHANGES' }));
    expect(useSideViewStore.getState().view).toBe('changes');
    const changes = await screen.findByRole('region', { name: 'Changes' });
    expect(await within(changes).findByTestId(`checkpoint-${seeded.id}`)).toHaveTextContent(
      'notes.md',
    );
    expect(screen.queryByRole('tree', { name: 'Files of Shop' })).toBeNull();

    await user.click(within(tabs).getByRole('tab', { name: 'EXPLORER' }));
    expect(await screen.findByRole('tree', { name: 'Files of Shop' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Changes' })).toBeNull();
  });

  it('an agent-change marker opens Changes on its checkpoint, and asks again next time', async () => {
    const user = userEvent.setup();
    const seeded = checkpoints.seed(projectId, [{ path: 'notes.md', before: 'a\n', after: 'b\n' }]);
    renderWithQuery(<ExplorerView projectId={projectId} />);

    await user.click(await screen.findByTestId('tree-change-notes.md'));
    const tabs = await switcher();
    expect(within(tabs).getByRole('tab', { name: 'CHANGES' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const changes = await screen.findByRole('region', { name: 'Changes' });
    expect(await within(changes).findByTestId(`checkpoint-${seeded.id}`)).toHaveClass(
      'shadow-[0_0_0_1.5px_#ef6b3f]',
    );
    // the request is settled once shown, so a later marker click opens Changes again
    expect(useChangesStore.getState().projects[projectId]?.requested).toBe(false);

    await user.click(within(tabs).getByRole('tab', { name: 'EXPLORER' }));
    await user.click(await screen.findByTestId('tree-change-notes.md'));
    await waitFor(() => expect(useSideViewStore.getState().view).toBe('changes'));
    expect(await screen.findByRole('region', { name: 'Changes' })).toBeInTheDocument();
  });
});
