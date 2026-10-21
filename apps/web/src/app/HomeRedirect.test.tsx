import { waitFor } from '@testing-library/react';

import { db, installMockServer, renderApp } from '../test/app';

installMockServer();

describe('FR-ONB-001 / opens the wizard for a brand-new user only', () => {
  it('no project and onboarding not completed → /onboarding', async () => {
    const { router } = renderApp('/');
    await waitFor(() => expect(router.state.location.pathname).toBe('/onboarding'));
  });

  it('onboarding completed (or skipped) → /projects', async () => {
    db.patchSettings({ onboardingCompleted: true });
    const { router } = renderApp('/');
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects'));
  });

  it('a project already exists → /projects, even without onboarding', async () => {
    db.createProject({ name: 'Old' });
    const { router } = renderApp('/');
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects'));
  });

  it('TC-PRJ-004 still wins: the last project reopens', async () => {
    const p = db.createProject({ name: 'Last' });
    db.patchSettings({ lastProjectId: p.id });
    const { router } = renderApp('/');
    await waitFor(() => expect(router.state.location.pathname).toBe(`/projects/${p.id}`));
  });

  it('audit U-4: a deleted last project does not hijack / — Home opens instead', async () => {
    db.createProject({ name: 'Kept' });
    const gone = db.createProject({ name: 'Gone' });
    db.deleteProject(gone.id);
    // the engine keeps the id after the delete (the mock forgets it, so it is put back here)
    db.patchSettings({ lastProjectId: gone.id });
    const { router } = renderApp('/');
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects'));
  });
});
