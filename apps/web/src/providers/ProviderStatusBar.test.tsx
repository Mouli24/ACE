import { screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { db, installMockServer, renderWithQuery } from '../test/app';
import { ProviderStatusBar } from './ProviderStatusBar';

installMockServer();

describe('FR-PRV-004 provider status in the top bar', () => {
  it('below xl each provider is just its dot; name and state stay in the title and for screen readers', async () => {
    const provider = db.createProvider({ type: 'mock', name: 'Mock' });
    renderWithQuery(
      <MemoryRouter>
        <ProviderStatusBar />
      </MemoryRouter>,
    );
    const chip = await screen.findByTestId(`provider-status-${provider.id}`);
    expect(chip).toHaveAttribute('title', expect.stringMatching(/^Mock: /));
    // the name and state spans (every span after the dot) are visually hidden below xl only
    expect(chip).toHaveClass('max-xl:[&>span+span]:sr-only');
    expect(chip).toHaveTextContent('Mock');
  });

  it('with two or more providers the chips stay dots up to 2xl, so a full set cannot push the bar wide', async () => {
    const providers = [
      db.createProvider({ type: 'mock', name: 'Mock' }),
      db.createProvider({ type: 'ollama', name: 'Local Ollama' }),
    ];
    renderWithQuery(
      <MemoryRouter>
        <ProviderStatusBar />
      </MemoryRouter>,
    );
    for (const provider of providers) {
      const chip = await screen.findByTestId(`provider-status-${provider.id}`);
      expect(chip).toHaveClass('max-2xl:[&>span+span]:sr-only');
      expect(chip).not.toHaveClass('max-xl:[&>span+span]:sr-only');
    }
  });
});
