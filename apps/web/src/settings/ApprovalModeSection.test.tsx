import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { db, installMockServer, renderApp } from '../test/app';

installMockServer();

describe('ACE-P0 Settings › Approval mode (D270)', () => {
  it('reads absent as Ask, and saves Full access through PATCH /settings', async () => {
    const user = userEvent.setup();
    renderApp('/settings');
    const section = await screen.findByTestId('settings-approval');
    const group = within(section).getByRole('radiogroup', { name: 'Approval mode' });
    const ask = within(group).getByRole('radio', { name: /^Ask for approval/ });
    await waitFor(() => expect(ask).toBeEnabled());
    expect(ask).toBeChecked();
    expect(within(group).getAllByRole('radio')).toHaveLength(3);
    expect(within(group).getByRole('radio', { name: /^Approve for me/ })).toHaveAccessibleName(
      /final actions still wait for you/,
    );

    await user.click(within(group).getByRole('radio', { name: /^Full access/ }));
    await waitFor(() => expect(db.settings.approvalMode).toBe('full_access'));
    expect(await screen.findByText('Settings saved')).toBeInTheDocument();
    expect(within(group).getByRole('radio', { name: /^Full access/ })).toBeChecked();
  });

  it('shows the mode the engine holds', async () => {
    db.patchSettings({ approvalMode: 'auto_review' });
    renderApp('/settings');
    const section = await screen.findByTestId('settings-approval');
    await waitFor(() =>
      expect(within(section).getByRole('radio', { name: /^Approve for me/ })).toBeChecked(),
    );
  });
});
