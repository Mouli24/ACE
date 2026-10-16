import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';

import { renderWithQuery } from '../../test/app';
import { SettingsMenu } from './SettingsMenu';

function renderGear(placement: 'footer' | 'corner') {
  const router = createMemoryRouter(
    [
      { path: '/', element: <SettingsMenu placement={placement} /> },
      { path: '*', element: <p data-testid="landed" /> },
    ],
    { initialEntries: ['/'] },
  );
  const { unmount } = renderWithQuery(<RouterProvider router={router} />);
  return { router, unmount };
}

describe('D338 SettingsMenu', () => {
  it('is a gear named "Settings menu" that opens upward on Providers, Onboarding and Settings', async () => {
    const user = userEvent.setup();
    renderGear('corner');
    const gear = screen.getByTestId('settings-menu');
    expect(gear).toHaveAccessibleName('Settings menu');
    // PG-1.2 (D360): an SVG gear, not the ⚙︎ glyph — a glyph draws as a box on some Windows setups
    expect(gear.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(gear.textContent?.trim()).toBe('');

    await user.click(gear);
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => [item.textContent, item.getAttribute('href')])).toEqual([
      ['Providers', '/providers'],
      ['Onboarding', '/onboarding'],
      ['Settings', '/settings'],
    ]);
    expect(screen.getByRole('menu')).toHaveAttribute('data-side', 'top');
  });

  it('Onboarding opens the first-run wizard', async () => {
    const user = userEvent.setup();
    const { router } = renderGear('footer');
    await user.click(screen.getByTestId('settings-menu'));
    await user.click(await screen.findByRole('menuitem', { name: 'Onboarding' }));
    expect(router.state.location.pathname).toBe('/onboarding');
    expect(await screen.findByTestId('landed')).toBeInTheDocument();
  });

  it('is small in the footer and a floating pill in the corner', () => {
    const { unmount } = renderGear('footer');
    expect(screen.getByTestId('settings-menu')).toHaveClass('h-[18px]', 'w-[18px]');
    expect(screen.getByTestId('settings-menu')).not.toHaveClass('fixed');
    unmount();
    renderGear('corner');
    expect(screen.getByTestId('settings-menu')).toHaveClass('fixed', 'h-[34px]', 'w-[34px]');
  });
});
