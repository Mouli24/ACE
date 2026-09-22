import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { db, installMockServer, renderApp } from '../test/app';

installMockServer();

describe('Settings — theme only in round 1', () => {
  it('shows the current theme and saves a change through PATCH /settings', async () => {
    const user = userEvent.setup();
    renderApp('/settings');
    const trigger = await screen.findByLabelText('Theme');
    await waitFor(() => expect(trigger).toHaveTextContent('dark'));
    await user.click(trigger);
    await user.click(await screen.findByRole('option', { name: 'light' }));
    await waitFor(() => expect(db.settings.theme).toBe('light'));
    expect(trigger).toHaveTextContent('light');
  });
});
