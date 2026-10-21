import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';

import { installMockServer, renderApp } from '../test/app';
import { RouteError } from './RouteError';

installMockServer();

function Boom(): never {
  throw new Error('canvas exploded');
}

describe('audit U-1 a real 404 page and a route error boundary', () => {
  it('an unknown address shows "Page not found" inside the shell, with a way back', async () => {
    const { router } = renderApp('/no/such/page');
    const page = await screen.findByTestId('not-found');
    expect(within(page).getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(page).toHaveTextContent('/no/such/page');
    // the shell's header stays: the mark leads Home
    expect(screen.getByRole('link', { name: 'ACE' })).toHaveAttribute('href', '/projects');
    await userEvent.setup().click(within(page).getByRole('link', { name: 'Back to projects' }));
    expect(router.state.location.pathname).toBe('/projects');
  });

  it('an unknown page under a workflow is not found either', async () => {
    renderApp('/projects/p1/workflows/w1/nowhere');
    expect(await screen.findByTestId('not-found')).toBeInTheDocument();
  });

  it('a screen that throws shows the message, Reload and Back to projects', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const router = createMemoryRouter([
      { path: '/', element: <Boom />, errorElement: <RouteError /> },
      { path: '/projects', element: <p data-testid="home" /> },
    ]);
    render(<RouterProvider router={router} />);
    const card = await screen.findByTestId('route-error');
    expect(card).toHaveTextContent('canvas exploded');
    expect(within(card).getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    await userEvent.setup().click(within(card).getByRole('link', { name: 'Back to projects' }));
    expect(await screen.findByTestId('home')).toBeInTheDocument();
    quiet.mockRestore();
  });
});
