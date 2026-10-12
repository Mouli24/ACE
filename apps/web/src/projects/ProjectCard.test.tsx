import type { Project } from '@ace/contracts';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { T } from '../theme/constants';
import { setThemeMode } from '../theme/mode';
import { ProjectCard, TINTS, tintOf } from './ProjectCard';

const project = (id: string): Project => ({
  id,
  name: 'Tinted',
  folderPath: '/mock/projects/tinted',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
});

function renderCard(id: string) {
  render(
    <MemoryRouter>
      <ProjectCard project={project(id)} summary={undefined} onOpen={() => undefined} />
    </MemoryRouter>,
  );
  return screen.getByRole('link', { name: 'Tinted' });
}

afterEach(() => setThemeMode('light'));

describe('ProjectCard tint (D337)', () => {
  it('is deterministic per project id and one of the theme’s seven tints', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `01JPROJECT${String(i).padStart(16, '0')}`);
    for (const id of ids) {
      expect(TINTS).toContain(tintOf(id));
      expect(tintOf(id)).toBe(tintOf(id));
    }
    // A hash, not a constant: forty ids land on more than one tint.
    expect(new Set(ids.map(tintOf)).size).toBeGreaterThan(1);
  });

  it('paints the light preview with the tint’s gradient and the dark one from its accent', () => {
    const id = '01JPROJECTAAAAAAAAAAAAAAAA';
    const [light, accent] = T[tintOf(id)];
    const preview = () => renderCard(id).firstElementChild as HTMLElement;
    // jsdom serialises colours as rgb(), so compare against its reading of the theme's value.
    const asStyled = (background: string) => {
      const probe = document.createElement('div');
      probe.style.background = background;
      expect(probe.style.background).toContain('linear-gradient');
      return probe.style.background;
    };

    expect(preview().style.background).toBe(asStyled(light));
    document.body.innerHTML = '';

    setThemeMode('dark');
    expect(preview().style.background).toBe(
      asStyled(`linear-gradient(135deg,${accent}33,#1d1b1a 75%)`),
    );
  });
});
