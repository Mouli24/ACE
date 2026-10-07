import { aceError } from '@ace/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';

import { BUILTIN_SKILL_IDS, BUILTIN_SKILLS } from '../../mocks/builtin-skills';
import { db, installMockServer, renderApp, server } from '../../test/app';

installMockServer();

/**
 * Library › Skills (ACE parity P1, D272, FR-SKL-001..003): the list with Built-in badges and
 * versions, New skill, editing a user skill, a read-only built-in with Duplicate, delete with a
 * confirmation, and the loading, empty and error states.
 */

const testFirstRow = () => screen.findByTestId(`skill-row-${BUILTIN_SKILL_IDS.testFirst}`);

async function openNewSkill(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /new skill/i }));
  return screen.findByRole('dialog', { name: 'New skill' });
}

describe('FR-SKL-001 D272 the skills list', () => {
  it('lists the five built-ins with their badge and version, built-ins first', async () => {
    renderApp('/library/skills');
    const list = await screen.findByRole('list', { name: 'Skills' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(5);
    for (const skill of BUILTIN_SKILLS) {
      const row = within(list).getByTestId(`skill-row-${skill.id}`);
      expect(row).toHaveAttribute('data-source', 'builtin');
      expect(within(row).getByText(skill.name)).toBeInTheDocument();
      expect(within(row).getByText('Built-in')).toBeInTheDocument();
      expect(within(row).getByText('v1')).toBeInTheDocument();
      expect(within(row).getByText(skill.description)).toBeInTheDocument();
      // A built-in cannot be deleted, only duplicated.
      expect(within(row).queryByRole('button', { name: `Delete ${skill.name}` })).toBeNull();
    }
  });

  it('says it is loading, then shows the list', async () => {
    db.setLatency(150);
    renderApp('/library/skills');
    expect(await screen.findByText('Loading skills…')).toBeInTheDocument();
    expect(await testFirstRow()).toBeInTheDocument();
    db.setLatency(0);
  });

  it('shows the error when the skills cannot be read', async () => {
    server.use(
      http.get('*/api/v1/skills', () =>
        HttpResponse.json(aceError('provider', 'internal', 'The engine hit an unexpected error.'), {
          status: 500,
        }),
      ),
    );
    renderApp('/library/skills');
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load skills');
  });

  it('shows an empty state when nothing is installed', async () => {
    server.use(http.get('*/api/v1/skills', () => HttpResponse.json({ items: [] })));
    renderApp('/library/skills');
    expect(await screen.findByTestId('skills-empty')).toHaveTextContent('No skills installed');
  });
});

describe('FR-SKL-002 D272 writing and editing skills', () => {
  it('creates a skill from the New skill dialog', async () => {
    const user = userEvent.setup();
    renderApp('/library/skills');
    const dialog = await openNewSkill(user);
    const create = within(dialog).getByRole('button', { name: 'Create skill' });
    expect(create).toBeDisabled();

    await user.type(within(dialog).getByLabelText('Name'), 'Plain words');
    await user.type(within(dialog).getByLabelText('Description'), 'For docs.');
    await user.type(within(dialog).getByLabelText('Instructions'), 'Write short sentences.');
    await user.click(create);

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const stored = db.findSkillByName('Plain words');
    expect(stored).toMatchObject({
      source: 'user',
      version: 1,
      description: 'For docs.',
      instructions: 'Write short sentences.',
    });
    const row = await screen.findByTestId(`skill-row-${stored!.id}`);
    expect(within(row).getByText('v1')).toBeInTheDocument();
    // A user skill is the user's: no source badge, and it can be deleted.
    expect(within(row).queryByText('Built-in')).toBeNull();
    expect(within(row).getByRole('button', { name: 'Delete Plain words' })).toBeInTheDocument();
  });

  it('shows the engine refusal when the name is taken', async () => {
    const user = userEvent.setup();
    renderApp('/library/skills');
    const dialog = await openNewSkill(user);
    await user.type(within(dialog).getByLabelText('Name'), 'test first');
    await user.type(within(dialog).getByLabelText('Instructions'), 'Mine.');
    await user.click(within(dialog).getByRole('button', { name: 'Create skill' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/already installed/);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('edits a user skill, and a new instruction makes a new version', async () => {
    const user = userEvent.setup();
    const at = new Date().toISOString();
    db.putSkill({
      id: db.nextId(),
      name: 'Plain words',
      description: '',
      instructions: 'Short.',
      version: 1,
      source: 'user',
      createdAt: at,
      updatedAt: at,
    });
    renderApp('/library/skills');
    await user.click(await screen.findByRole('button', { name: 'Edit Plain words' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit skill' });
    const instructions = within(dialog).getByLabelText('Instructions');
    await user.clear(instructions);
    await user.type(instructions, 'Shorter.');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(db.findSkillByName('Plain words')?.version).toBe(2));
    expect(db.findSkillByName('Plain words')?.instructions).toBe('Shorter.');
    const row = await screen.findByTestId(`skill-row-${db.findSkillByName('Plain words')!.id}`);
    await waitFor(() => expect(within(row).getByText('v2')).toBeInTheDocument());
  });

  it('opens a built-in read-only, and Duplicate opens an editable copy', async () => {
    const user = userEvent.setup();
    renderApp('/library/skills');
    await user.click(await screen.findByRole('button', { name: 'View Test first' }));
    const dialog = await screen.findByRole('dialog', { name: 'Test first' });
    expect(within(dialog).getByText(/read-only/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Name')).toHaveAttribute('readonly');
    expect(within(dialog).getByLabelText('Instructions')).toHaveAttribute('readonly');
    expect(within(dialog).queryByRole('button', { name: 'Save' })).toBeNull();

    await user.click(within(dialog).getByRole('button', { name: 'Duplicate' }));
    const copy = await screen.findByRole('dialog', { name: 'Edit skill' });
    expect(within(copy).getByLabelText('Name')).toHaveValue('Test first (copy)');
    expect(within(copy).getByLabelText('Name')).not.toHaveAttribute('readonly');
    expect(db.findSkillByName('Test first (copy)')).toMatchObject({ source: 'user', version: 1 });
  });

  it('duplicates from the list too', async () => {
    const user = userEvent.setup();
    renderApp('/library/skills');
    await testFirstRow();
    await user.click(screen.getByRole('button', { name: 'Duplicate Security review' }));
    await waitFor(() => expect(db.findSkillByName('Security review (copy)')).toBeDefined());
  });

  it('deletes a user skill after asking', async () => {
    const user = userEvent.setup();
    const at = new Date().toISOString();
    const skill = db.putSkill({
      id: db.nextId(),
      name: 'Gone soon',
      description: '',
      instructions: 'x',
      version: 1,
      source: 'user',
      createdAt: at,
      updatedAt: at,
    });
    renderApp('/library/skills');
    await user.click(await screen.findByRole('button', { name: 'Delete Gone soon' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete "Gone soon"?' });
    expect(within(confirm).getByText(/stopped at pre-flight/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Delete skill' }));

    await waitFor(() =>
      expect(screen.queryByTestId(`skill-row-${skill.id}`)).not.toBeInTheDocument(),
    );
    expect(db.getSkill(skill.id)).toBeUndefined();
  });
});
