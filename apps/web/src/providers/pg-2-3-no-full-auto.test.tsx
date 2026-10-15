import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { db, installMockServer, renderApp } from '../test/app';

/**
 * PG-2.3 No silent Full auto (docs/team-prompts/product-gaps-fix-prompt.md, X6).
 *
 * Phase 0 red tests: the provider dialogs no longer offer `full_auto` (it bypasses every ACE
 * approval, budget and guardrail). Today `PermissionField` lists every `CLI_PERMISSIONS` value,
 * labelled from `provider-meta.ts`, so "Full auto" is one of its options.
 *
 * `CliScan.test.tsx` still asserts that Full auto is offered (and saved); the fix changes those
 * tests, not this phase.
 */

installMockServer();

describe('PG-2.3 the provider dialogs do not offer Full auto', () => {
  it.fails(
    'Add provider → a CLI → Permission lists Read-only and Edit project files only',
    async () => {
      const user = userEvent.setup();
      renderApp('/providers');
      await user.click(await screen.findByRole('button', { name: /add provider/i }));
      const dialog = screen.getByRole('dialog');
      await user.click(await within(dialog).findByRole('button', { name: 'Add Claude Code' }));

      await user.click(within(dialog).getByRole('combobox', { name: 'Permission' }));
      // The list is open (the option the field already shows is there) …
      expect(await screen.findByRole('option', { name: 'Edit project files' })).toBeInTheDocument();
      // … and Full auto is not one of its options.
      expect(screen.queryByRole('option', { name: 'Full auto' })).toBeNull();
    },
  );

  it.fails('Edit provider on a CLI provider does not offer Full auto either', async () => {
    const user = userEvent.setup();
    db.createProvider({
      type: 'claude_code',
      name: 'Claude Code',
      concurrency: 1,
      cliPermission: 'read_only',
    });
    renderApp('/providers');

    await user.click(await screen.findByRole('button', { name: 'Actions for Claude Code' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('combobox', { name: 'Permission' }));
    expect(await screen.findByRole('option', { name: 'Read-only' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Full auto' })).toBeNull();
  });
});
