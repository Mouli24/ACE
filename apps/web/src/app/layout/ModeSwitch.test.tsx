import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { ModeSwitch } from './ModeSwitch';

const P = '01J9ZZZZZZZZZZZZZZZZZZZZZP';
const W = '01J9ZZZZZZZZZZZZZZZZZZZZZW';
const BASE = `/projects/${P}/workflows/${W}`;

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

function renderAt(path: string) {
  const element = (
    <>
      <ModeSwitch projectId={P} workflowId={W} />
      <Where />
    </>
  );
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/projects/:projectId/workflows/:workflowId" element={element} />
        <Route path="/projects/:projectId/workflows/:workflowId/:mode" element={element} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('[audit F-12] the mode switch always has one tab stop', () => {
  it('in Forge, the checked radio', () => {
    renderAt(`${BASE}/forge`);
    expect(screen.getByRole('radio', { name: 'Forge' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Ideate' })).toHaveAttribute('tabindex', '-1');
  });

  it('in Domain, where no radio is checked, Ideate; the arrows move on from it', async () => {
    const user = userEvent.setup();
    renderAt(`${BASE}/domain`);
    const ideate = screen.getByRole('radio', { name: 'Ideate' });
    expect(ideate).toHaveAttribute('tabindex', '0');
    expect(ideate).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Forge' })).toHaveAttribute('tabindex', '-1');

    await user.tab();
    expect(ideate).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByTestId('where')).toHaveTextContent(`${BASE}/forge`);
  });
});
