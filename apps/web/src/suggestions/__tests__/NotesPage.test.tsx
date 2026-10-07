import { aceError } from '@ace/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';

import { createNote, listNotes } from '../../mocks/suggestions';
import { db, installMockServer, renderApp, server } from '../../test/app';

installMockServer();

/**
 * Team notes (ACE parity P2, D281): the list with Verified / Unverified, adding a note (verified),
 * confirming or un-confirming one, correcting its text (which confirms it) and Forget — against the
 * mock engine through the real SDK.
 */

/** The note's card, found by its text. */
async function note(text: string): Promise<HTMLElement> {
  const shown = await screen.findByText(text, { selector: 'p' });
  const row = shown.closest('article');
  if (row === null) throw new Error(`no note card around "${text}"`);
  return row;
}

describe('ACE-P2 D281 team notes', () => {
  it('says what the notes are for, and that runs get them', async () => {
    const project = db.createProject({ name: 'Shop' });
    renderApp(`/projects/${project.id}/notes`);
    expect(await screen.findByRole('heading', { name: 'Team notes', level: 1 })).toBeVisible();
    expect(screen.getByText(/gets these notes in its prompt/)).toBeInTheDocument();
    expect(await screen.findByTestId('notes-empty')).toBeInTheDocument();
    expect(
      within(screen.getByRole('navigation', { name: 'Project' })).getByRole('link', {
        name: 'Notes',
      }),
    ).toHaveAttribute('aria-current', 'page');
  });

  it('adds a note, verified, and refuses an empty one', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'Shop' });
    renderApp(`/projects/${project.id}/notes`);
    const form = await screen.findByRole('form', { name: 'Add a note' });
    await user.click(within(form).getByRole('button', { name: 'Add note' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('Write the note first.');
    expect(listNotes(db, project.id)).toEqual([]);

    await user.type(within(form).getByLabelText('New note'), 'Search lives in src/search.ts.');
    await user.click(within(form).getByRole('button', { name: 'Add note' }));
    await waitFor(() =>
      expect(listNotes(db, project.id)).toEqual([
        expect.objectContaining({
          text: 'Search lives in src/search.ts.',
          status: 'verified',
          source: 'user',
        }),
      ]),
    );
    const row = await note('Search lives in src/search.ts.');
    expect(row).toHaveAttribute('data-status', 'verified');
    expect(within(row).getByTestId('note-status')).toHaveTextContent('Verified');
    expect(within(row).getByText(/Written by you/)).toBeInTheDocument();
    expect(within(form).getByLabelText('New note')).toHaveValue('');
  });

  it('marks a note saved by a task verified, and back to unverified', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'Shop' });
    const saved = createNote(db, project.id, {
      text: 'The API is slow on Mondays.',
      source: 'task',
    });
    renderApp(`/projects/${project.id}/notes`);
    const row = await note('The API is slow on Mondays.');
    expect(row).toHaveAttribute('data-status', 'unverified');
    expect(within(row).getByText(/Saved from a task/)).toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: 'Mark verified' }));
    await waitFor(() => expect(listNotes(db, project.id)[0]?.status).toBe('verified'));
    await waitFor(() => expect(row).toHaveAttribute('data-status', 'verified'));
    await user.click(within(row).getByRole('button', { name: 'Mark unverified' }));
    await waitFor(() => expect(listNotes(db, project.id)[0]?.status).toBe('unverified'));
    expect(listNotes(db, project.id)[0]?.id).toBe(saved.id);
  });

  it('correcting a note’s text confirms it', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'Shop' });
    createNote(db, project.id, { text: 'The API is slow on Mondays.', source: 'chat' });
    renderApp(`/projects/${project.id}/notes`);
    const row = await note('The API is slow on Mondays.');
    await user.click(within(row).getByRole('button', { name: 'Edit' }));
    expect(within(row).getByText(/also verifies the note/)).toBeInTheDocument();
    const text = within(row).getByLabelText('Note text');
    await user.clear(text);
    await user.click(within(row).getByRole('button', { name: 'Save' }));
    expect(await within(row).findByRole('alert')).toHaveTextContent('cannot be empty');

    await user.type(text, 'The API is slow at 9:00.');
    await user.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(listNotes(db, project.id)[0]).toMatchObject({
        text: 'The API is slow at 9:00.',
        status: 'verified',
      }),
    );
    expect(await within(row).findByText('The API is slow at 9:00.')).toBeInTheDocument();
  });

  it('forgets a note after asking', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'Shop' });
    createNote(db, project.id, { text: 'Old fact.' });
    renderApp(`/projects/${project.id}/notes`);
    const row = await note('Old fact.');
    await user.click(within(row).getByRole('button', { name: 'Forget' }));
    const confirm = await screen.findByRole('dialog', { name: 'Forget this note?' });
    expect(within(confirm).getByText('Old fact.')).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Forget' }));
    await waitFor(() => expect(listNotes(db, project.id)).toEqual([]));
    expect(await screen.findByTestId('notes-empty')).toBeInTheDocument();
  });

  it('shows the engine refusal when a note cannot be saved', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'Shop' });
    server.use(
      http.post('*/api/v1/projects/:id/notes', () =>
        HttpResponse.json(
          aceError('invalid_config', 'validation_failed', 'The note looks like it holds a secret.'),
          { status: 400 },
        ),
      ),
    );
    renderApp(`/projects/${project.id}/notes`);
    const form = await screen.findByRole('form', { name: 'Add a note' });
    await user.type(within(form).getByLabelText('New note'), 'key sk-ant-xxxx');
    await user.click(within(form).getByRole('button', { name: 'Add note' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'The note looks like it holds a secret.',
    );
    expect(listNotes(db, project.id)).toEqual([]);
  });

  it('shows the error when the notes cannot be read', async () => {
    const project = db.createProject({ name: 'Shop' });
    server.use(
      http.get('*/api/v1/projects/:id/notes', () =>
        HttpResponse.json(aceError('provider', 'internal', 'The engine hit an unexpected error.'), {
          status: 500,
        }),
      ),
    );
    renderApp(`/projects/${project.id}/notes`);
    expect(await screen.findByText(/Could not load notes/)).toHaveTextContent(
      'The engine hit an unexpected error.',
    );
  });
});
