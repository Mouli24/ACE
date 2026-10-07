import { aceError } from '@ace/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';

import { db, installMockServer, renderApp, server } from '../../test/app';

installMockServer();

/**
 * The Ace Assistant on the projects page (ACE parity P2, D283): describe → propose (by the rules,
 * or by a chosen model, said honestly) → edit or ask for a change → Create project, which creates
 * the project and its team and opens the canvas. Nothing is written before the confirmation.
 */

const PROMPT = 'Build a booking app. Have one agent plan it and another review it, $2 per run.';

async function propose(user: ReturnType<typeof userEvent.setup>, prompt = PROMPT) {
  const panel = await screen.findByTestId('assistant-panel');
  await user.type(within(panel).getByLabelText('What do you want to build?'), prompt);
  await user.click(within(panel).getByRole('button', { name: 'Propose' }));
  return within(panel).findByTestId('assistant-proposal');
}

describe('ACE-P2 D283 the Ace Assistant', () => {
  it('proposes by the rules and says so, and creates nothing before the confirmation', async () => {
    const user = userEvent.setup();
    renderApp('/projects');
    const proposal = await propose(user);

    const source = within(proposal).getByTestId('proposal-source');
    expect(source).toHaveAttribute('data-source', 'rules');
    expect(source).toHaveTextContent('Drafted by ACE’s rules');
    expect(within(proposal).getByTestId('proposal-summary')).toHaveTextContent(
      'Set up Booking app with a planner, a builder and a reviewer',
    );
    expect(within(proposal).getByLabelText('Project name')).toHaveValue('Booking app');
    expect(within(proposal).getByTestId('proposal-team')).toHaveTextContent(
      'Plan, build and review',
    );
    expect(within(proposal).getByLabelText('Most a run may spend (USD)')).toHaveValue(2);
    for (const role of ['Planner', 'Builder', 'Reviewer']) {
      const agent = within(proposal).getByRole('group', { name: `${role} agent` });
      expect(within(agent).getByLabelText('Name')).toHaveValue(role);
      expect((within(agent).getByLabelText('Instructions') as HTMLTextAreaElement).value).toContain(
        'This team works on Booking app',
      );
    }
    expect(within(proposal).getByRole('list', { name: 'What Ace assumed' })).toHaveTextContent(
      'no-key Mock models',
    );
    expect(db.listProjects()).toEqual([]);
  });

  it('applies the edited proposal and opens the new team’s canvas', async () => {
    const user = userEvent.setup();
    const { router } = renderApp('/projects');
    const proposal = await propose(user);

    const name = within(proposal).getByLabelText('Project name');
    await user.clear(name);
    await user.type(name, 'Bookings');
    await user.type(within(proposal).getByLabelText('Folder (optional)'), '/work/bookings');
    const budget = within(proposal).getByLabelText('Most a run may spend (USD)');
    await user.clear(budget);
    await user.type(budget, '3');
    const reviewer = within(proposal).getByRole('group', { name: 'Reviewer agent' });
    const reviewerName = within(reviewer).getByLabelText('Name');
    await user.clear(reviewerName);
    await user.type(reviewerName, 'Critic');
    await user.click(within(proposal).getByRole('button', { name: 'Create project' }));

    await waitFor(() => expect(db.listProjects()).toHaveLength(1));
    const [project] = db.listProjects();
    expect(project).toMatchObject({
      name: 'Bookings',
      folderPath: '/work/bookings',
      maxCostPerRunUsd: 3,
    });
    const [workflow] = db.listWorkflows(project!.id);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        `/projects/${project!.id}/workflows/${workflow!.id}`,
      ),
    );
    expect(
      db
        .nodesOf(workflow!.id)
        .filter((node) => node.kind === 'agent')
        .map((node) => node.name)
        .sort(),
    ).toEqual(['Builder', 'Critic', 'Planner']);
  });

  it('asks Ace for a change, keeping the edits made so far', async () => {
    const user = userEvent.setup();
    renderApp('/projects');
    const proposal = await propose(user);
    const builder = within(proposal).getByRole('group', { name: 'Builder agent' });
    const builderName = within(builder).getByLabelText('Name');
    await user.clear(builderName);
    await user.type(builderName, 'Maker');

    await user.type(within(proposal).getByLabelText('Tell Ace what to change'), 'Just one agent.');
    await user.click(within(proposal).getByRole('button', { name: 'Revise' }));
    await waitFor(() =>
      expect(within(proposal).getByTestId('proposal-team')).toHaveTextContent('Single builder'),
    );
    expect(within(proposal).queryByRole('group', { name: 'Planner agent' })).toBeNull();
    expect(
      within(within(proposal).getByRole('group', { name: 'Builder agent' })).getByLabelText('Name'),
    ).toHaveValue('Maker');
    expect(within(proposal).getByLabelText('Tell Ace what to change')).toHaveValue('');
    expect(db.listProjects()).toEqual([]);
  });

  it('names the model that drafted a proposal, and an agent can be given a model', async () => {
    const user = userEvent.setup();
    const provider = db.createProvider({ type: 'mock', name: 'Local mock' });
    db.refreshModels(provider.id);
    renderApp('/projects');
    const panel = await screen.findByTestId('assistant-panel');
    const drafter = within(panel).getByLabelText('Drafted by');
    await waitFor(() =>
      expect(within(drafter).getByRole('option', { name: 'Local mock · Mock text' })).toBeVisible(),
    );
    await user.selectOptions(drafter, `${provider.id}|mock-text`);
    const proposal = await propose(user, 'Build a quiz game.');
    const source = within(proposal).getByTestId('proposal-source');
    expect(source).toHaveAttribute('data-source', 'model');
    expect(source).toHaveTextContent('Drafted by Local mock · Mock text');

    const builder = within(proposal).getByRole('group', { name: 'Builder agent' });
    await user.selectOptions(within(builder).getByLabelText('Model'), `${provider.id}|mock-text`);
    await user.click(within(proposal).getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(db.listProjects()).toHaveLength(1));
    const [workflow] = db.listWorkflows(db.listProjects()[0]!.id);
    const agent = db.nodesOf(workflow!.id).find((node) => node.kind === 'agent');
    expect(agent?.config).toMatchObject({ providerId: provider.id, modelId: 'mock-text' });
  });

  it('says when a chosen model did not draft the proposal', async () => {
    const user = userEvent.setup();
    const provider = db.createProvider({ type: 'mock', name: 'Local mock' });
    db.refreshModels(provider.id);
    server.use(
      http.post('*/api/v1/assistant/propose', () =>
        HttpResponse.json({
          summary: 'Set up Quiz game with one builder agent.',
          projectName: 'Quiz game',
          team: 'single-builder',
          agents: [{ role: 'builder', name: 'Builder', instructions: 'Make the change.' }],
          notes: [
            "The model's answer could not be used (no JSON object in the answer); this proposal comes from ACE's rules.",
          ],
          source: 'rules',
        }),
      ),
    );
    renderApp('/projects');
    const panel = await screen.findByTestId('assistant-panel');
    const drafter = within(panel).getByLabelText('Drafted by');
    await waitFor(() =>
      expect(within(drafter).getByRole('option', { name: 'Local mock · Mock text' })).toBeVisible(),
    );
    await user.selectOptions(drafter, `${provider.id}|mock-text`);
    const proposal = await propose(user, 'Build a quiz game.');
    expect(within(proposal).getByTestId('proposal-source')).toHaveTextContent(
      'Drafted by ACE’s rules',
    );
    expect(within(proposal).getByText(/You asked Local mock · Mock text/)).toBeInTheDocument();
    expect(within(proposal).getByText(/could not be used/)).toBeInTheDocument();
  });

  it('asks for a description first, and shows the engine refusal on apply', async () => {
    const user = userEvent.setup();
    renderApp('/projects');
    const panel = await screen.findByTestId('assistant-panel');
    await user.click(within(panel).getByRole('button', { name: 'Propose' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'Describe what you want to build first.',
    );

    const proposal = await propose(user, 'Build a booking app.');
    await user.type(within(proposal).getByLabelText('Folder (optional)'), '/readonly/booking');
    await user.click(within(proposal).getByRole('button', { name: 'Create project' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent('is not writable');
    expect(db.listProjects()).toEqual([]);
  });

  it('refuses to apply a proposal whose fields the contract refuses', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('*/api/v1/assistant/apply', () =>
        HttpResponse.json(aceError('provider', 'internal', 'should not be called'), {
          status: 500,
        }),
      ),
    );
    renderApp('/projects');
    const proposal = await propose(user, 'Build a booking app.');
    await user.clear(within(proposal).getByLabelText('Project name'));
    await user.click(within(proposal).getByRole('button', { name: 'Create project' }));
    expect(
      await within(screen.getByTestId('assistant-panel')).findByRole('alert'),
    ).toHaveTextContent('the project needs a name');
    expect(screen.queryByText('should not be called')).toBeNull();
  });
});
