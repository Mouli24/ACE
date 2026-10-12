import type { DomainMessage, DomainUsageSnapshot, Run } from '@ace/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { useLayoutStore } from '../app/stores/layout';
import { useWorkspaceStatus } from '../app/stores/workspace-status';
import { useEditorStore } from '../forge/editor/editor-store';
import { newId } from '../lib/ulid';
import { domainMock } from '../mocks/handlers-domain';
import { createNode } from '../nodes/factory';
import { db, installMockServer, renderApp, server } from '../test/app';

/*
 * Domain Gate 5, the page (D3–D9, D307, D310, D323), in the theme's team-chat view (D336): the
 * conversation renders every kind of message, held envelopes can be approved, edited or rejected,
 * the composer sends, the filter pills are the lenses, the run pill holds the runs, Run details and
 * End (which makes the run read-only), past runs open read-only, output cards open in Forge, the
 * "live" pill follows the stream, the Team aside follows Split, and with no run the first message
 * starts one. Everything against the mock engine.
 */

installMockServer();

const NOW = '2026-10-10T09:00:00.000Z';

function seedTeam(status: Run['status'] = 'RUNNING') {
  const project = db.createProject({ name: 'P' });
  const workflow = db.createWorkflow(project.id, 'Team');
  const writer = { ...createNode('agent', workflow.id, { x: 0, y: 0 }), name: 'Writer' };
  const review = { ...createNode('agent', workflow.id, { x: 200, y: 0 }), name: 'Review' };
  db.commitGraph(workflow.id, [writer, review], []);
  const live = status === 'RUNNING';
  const run: Run = {
    id: newId(),
    workflowId: workflow.id,
    projectId: project.id,
    status,
    snapshot: { version: 1, nodes: [writer, review], edges: [] },
    inputs: {},
    preflightIssues: [],
    totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    startedAt: NOW,
    allowedActions: live ? ['pause', 'stop', 'end'] : ['restart'],
    domain: { routing: 'manual', loopGuardLimit: 3, tokenBudget: null, stayOpen: true },
    goal: 'A tagline for ACE',
  };
  db.addRun(run);

  const at = (seq: number) => ({ runId: run.id, cursor: `${seq}.0`, at: NOW });
  const ENV_HANDOFF = newId();
  const ENV_FLAG = newId();
  const ARTIFACT = newId();
  const messages: DomainMessage[] = [
    { ...at(1), id: 'sys:1.0', author: { kind: 'system' }, type: 'system', text: 'Run started.' },
    {
      ...at(2),
      id: newId(),
      author: { kind: 'human' },
      type: 'human',
      text: 'A tagline for ACE',
    },
    {
      ...at(3),
      id: `turn:${newId()}`,
      author: { kind: 'node', nodeId: writer.id },
      type: 'agent',
      text: 'Draft: Go further.',
      textSource: 'auto',
      turn: {
        turnId: newId(),
        trigger: 'dispatch',
        iteration: 1,
        attempt: 1,
        steps: [
          { id: 's1', label: 'Read brief.md', status: 'ok', durationMs: 600, at: NOW },
          { id: 's2', label: 'Write tagline.md', status: 'ok', durationMs: 900, at: NOW },
          { id: 's3', label: 'Fetch a style guide', status: 'error', at: NOW },
        ],
        durationMs: 1200,
        outcome: 'OK',
      },
      output: [{ type: 'text', text: 'Draft: Go further. And then some.' }],
      artifacts: [{ path: 'tagline.md', bytes: 120, commit: null, artifactId: ARTIFACT }],
    },
    {
      ...at(4),
      id: `env:${ENV_HANDOFF}`,
      author: { kind: 'node', nodeId: writer.id },
      type: 'envelope',
      text: 'First draft.',
      textSource: 'summary',
      to: [review.id],
      envelope: {
        id: ENV_HANDOFF,
        kind: 'HANDOFF',
        from: writer.id,
        routing: 'FORWARDED',
        history: [{ decision: 'FORWARDED', by: 'human', at: NOW }],
      },
    },
    {
      ...at(5),
      id: `env:${ENV_FLAG}`,
      author: { kind: 'node', nodeId: review.id },
      type: 'envelope',
      text: 'The hook is weak.',
      textSource: 'summary',
      to: [writer.id],
      envelope: {
        id: ENV_FLAG,
        kind: 'FLAG',
        from: review.id,
        routing: 'HELD',
        history: [{ decision: 'HELD', by: 'brain', reason: 'manual routing', at: NOW }],
      },
    },
    {
      ...at(6),
      id: newId(),
      author: { kind: 'human' },
      type: 'human',
      text: 'Review, be strict',
      to: [review.id],
      delivery: [{ nodeId: review.id, state: 'DELIVERED' }],
    },
    {
      ...at(7),
      id: 'sys:7.0',
      author: { kind: 'system' },
      type: 'system',
      text: '80% of the token budget used: 800 of 1,000 tokens.',
      level: 'warn',
    },
  ];
  const usage: DomainUsageSnapshot = {
    runId: run.id,
    budget: { limit: 1000, used: 800, level: 'WARN' },
    total: { input: 600, output: 200, cachedInput: 0, estimatedShare: 0.25 },
    costEst: null,
    perNode: [
      {
        nodeId: writer.id,
        handle: 'writer',
        name: 'Writer',
        brain: false,
        state: 'COMPLETED',
        activity: 'done',
        input: 450,
        output: 150,
        source: 'reported',
        costEst: null,
        budgetShare: 0.6,
      },
      {
        nodeId: review.id,
        handle: 'review',
        name: 'Review',
        brain: false,
        state: 'RUNNING',
        activity: 'reviewing',
        input: 150,
        output: 50,
        source: 'estimated',
        costEst: null,
        budgetShare: 0.2,
      },
    ],
    perTurn: [],
  };
  domainMock.seed(run.id, messages, usage);
  return { project, workflow, writer, review, run, ENV_FLAG, ARTIFACT };
}

const pathOf = (team: ReturnType<typeof seedTeam>, query = `?run=${team.run.id}`) =>
  `/projects/${team.project.id}/workflows/${team.workflow.id}/domain${query}`;

const requestsTo = (suffix: string) =>
  domainMock.requests.filter((request) => request.path.endsWith(suffix));

describe('Domain page', () => {
  it('renders every kind of message, delivery states, and from → to on envelopes', async () => {
    const team = seedTeam();
    renderApp(pathOf(team));
    expect(await screen.findByText('Draft: Go further.')).toBeInTheDocument();
    expect(screen.getByText('Run started.')).toBeInTheDocument();
    expect(screen.getByText('A tagline for ACE')).toBeInTheDocument();

    const direct = screen.getByText('Review, be strict').closest('[data-testid="domain-message"]');
    expect(direct).toHaveTextContent('→ @review');
    expect(within(direct as HTMLElement).getByTestId('delivery-review')).toHaveTextContent(
      'DELIVERED',
    );

    const handoff = screen.getByText('First draft.').closest('[data-testid="domain-message"]');
    expect(handoff).toHaveTextContent('@writer → @review');
    expect(handoff).toHaveTextContent('HANDOFF');
    expect(handoff).toHaveTextContent('FORWARDED');
    // An agent's text from the auto excerpt says so (D327).
    expect(
      screen.getByText('Draft: Go further.').closest('[data-testid="domain-message"]'),
    ).toHaveTextContent('auto');
    expect(screen.getByText(/80% of the token budget/)).toBeInTheDocument();
  });

  it('"What it did" expands to the steps with their durations, then the full output (D327)', async () => {
    const user = userEvent.setup();
    const team = seedTeam();
    renderApp(pathOf(team));
    const message = (await screen.findByText('Draft: Go further.')).closest(
      '[data-testid="domain-message"]',
    ) as HTMLElement;
    const toggle = within(message).getByRole('button', { name: /What it did/ });
    // Three steps; the two that were timed took 1.5 s between them.
    expect(toggle).toHaveTextContent('3 steps · 2s');
    expect(toggle).toHaveTextContent('▸ show');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(message).queryByText('Read brief.md')).not.toBeInTheDocument();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveTextContent('▾ hide');
    expect(within(message).getByText('Read brief.md')).toBeVisible();
    expect(within(message).getByText('Read brief.md').closest('li')).toHaveTextContent('1s');
    // A step that failed says so, with "—" for a duration nobody measured.
    expect(within(message).getByText('Fetch a style guide').closest('li')).toHaveTextContent(
      'error · —',
    );
    expect(within(message).getByText('Draft: Go further. And then some.')).toBeVisible();
    await user.click(toggle);
    expect(within(message).queryByText('Read brief.md')).not.toBeInTheDocument();
  });

  it('an output card opens a project file in Forge (D336)', async () => {
    const user = userEvent.setup();
    const team = seedTeam();
    const { router } = renderApp(pathOf(team));
    const message = (await screen.findByText('Draft: Go further.')).closest(
      '[data-testid="domain-message"]',
    ) as HTMLElement;
    const card = within(message).getByTestId('domain-output');
    expect(card).toHaveTextContent('tagline.md · 120 bytes');
    await user.click(within(card).getByRole('button', { name: 'Open tagline.md' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        `/projects/${team.project.id}/workflows/${team.workflow.id}/forge`,
      ),
    );
    expect(useEditorStore.getState().projects[team.project.id]?.files['tagline.md']).toBeDefined();
  });

  it('an output card outside the project opens the artifact through the D307 seam', async () => {
    const team = seedTeam();
    const ARTIFACT = newId();
    domainMock.seed(team.run.id, [
      {
        id: `turn:${newId()}`,
        runId: team.run.id,
        cursor: '1.0',
        author: { kind: 'node', nodeId: team.writer.id },
        type: 'agent',
        text: 'Saved it elsewhere.',
        at: NOW,
        artifacts: [
          { path: '/elsewhere/notes.md', bytes: null, commit: null, artifactId: ARTIFACT },
          { path: '/elsewhere/scratch.md', bytes: null, commit: null },
        ],
      },
    ]);
    renderApp(pathOf(team));
    const message = (await screen.findByText('Saved it elsewhere.')).closest(
      '[data-testid="domain-message"]',
    ) as HTMLElement;
    const link = within(message).getByRole('link', { name: 'Open notes.md' });
    expect(link.getAttribute('href')).toContain(`/artifacts/${ARTIFACT}/content`);
    expect(link).toHaveAttribute('target', '_blank');
    // A path outside the project with no stored artifact has nowhere to open: no button.
    const cards = within(message).getAllByTestId('domain-output');
    expect(cards[1]).toHaveTextContent('scratch.md');
    expect(within(cards[1]!).queryByRole('button')).not.toBeInTheDocument();
    expect(within(cards[1]!).queryByRole('link')).not.toBeInTheDocument();
  });

  it('a held envelope can be approved, edited or rejected, and leaves HELD when decided', async () => {
    const user = userEvent.setup();
    const team = seedTeam();
    renderApp(pathOf(team));
    const held = (await screen.findByText('The hook is weak.')).closest(
      '[data-testid="domain-message"]',
    ) as HTMLElement;
    expect(held).toHaveTextContent('HELD');

    await user.click(within(held).getByRole('button', { name: 'Edit' }));
    const summary = within(held).getByRole('textbox', { name: 'Edited summary' });
    await user.clear(summary);
    await user.type(summary, 'The hook needs a verb.');
    await user.click(within(held).getByRole('button', { name: 'Forward edited' }));
    await waitFor(() => expect(requestsTo(`/envelopes/${team.ENV_FLAG}/route`)).toHaveLength(1));
    expect(requestsTo(`/envelopes/${team.ENV_FLAG}/route`)[0]?.body).toEqual({
      decision: 'edit',
      edit: { summary: 'The hook needs a verb.' },
    });
    await waitFor(() =>
      expect(within(held).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument(),
    );
    expect(held).toHaveTextContent('EDITED');
  });

  it('rejecting sends the reason', async () => {
    const user = userEvent.setup();
    const team = seedTeam();
    renderApp(pathOf(team));
    const held = (await screen.findByText('The hook is weak.')).closest(
      '[data-testid="domain-message"]',
    ) as HTMLElement;
    await user.type(within(held).getByRole('textbox', { name: 'Reason' }), 'It is fine.');
    await user.click(within(held).getByRole('button', { name: 'Reject' }));
    await waitFor(() =>
      expect(requestsTo(`/envelopes/${team.ENV_FLAG}/route`)[0]?.body).toEqual({
        decision: 'reject',
        reason: 'It is fine.',
      }),
    );
  });

  it('the composer sends to the nodes it previews, and the message arrives live', async () => {
    const user = userEvent.setup();
    const team = seedTeam();
    renderApp(pathOf(team));
    await screen.findByText('Draft: Go further.');
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Writer, make it shorter');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(requestsTo('/messages')).toHaveLength(1));
    expect(requestsTo('/messages')[0]?.body).toEqual({
      text: 'Writer, make it shorter',
      deliveryMode: 'queue',
    });
    const sent = (await screen.findByText('Writer, make it shorter')).closest(
      '[data-testid="domain-message"]',
    ) as HTMLElement;
    expect(within(sent).getByTestId('delivery-writer')).toHaveTextContent('PENDING');
  });

  it("a filter pill shows one node's view, through ?node=", async () => {
    const user = userEvent.setup();
    const team = seedTeam();
    const { router } = renderApp(pathOf(team));
    await screen.findByText('Draft: Go further.');
    const lenses = screen.getByRole('navigation', { name: 'Lenses' });
    // "All", then one pill per agent: its avatar's initial and its name.
    const pills = within(lenses)
      .getAllByRole('button')
      .map((pill) => pill.textContent);
    expect(pills[0]).toBe('✳All');
    expect(pills.slice(1).sort()).toEqual(['RReview', 'WWriter']);
    expect(within(lenses).getByRole('button', { name: 'All' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(within(lenses).getByRole('button', { name: 'Review' }));
    await waitFor(() => expect(router.state.location.search).toContain(`node=${team.review.id}`));
    await waitFor(() => expect(screen.queryByText('Draft: Go further.')).not.toBeInTheDocument());
    expect(screen.getByText('The hook is weak.')).toBeInTheDocument();
    expect(
      domainMock.requests.some(
        (request) => request.path.endsWith('/chat/stream') && request.query.node === team.review.id,
      ),
    ).toBe(true);
    expect(within(lenses).getByRole('button', { name: 'Review' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(within(lenses).getByRole('button', { name: 'All' }));
    expect(await screen.findByText('Draft: Go further.')).toBeInTheDocument();
  });

  it('the header counts the messages; the footer gets the count and the tokens', async () => {
    const team = seedTeam();
    const { unmount } = renderApp(pathOf(team));
    await screen.findByText('Draft: Go further.');
    expect(
      within(screen.getByRole('region', { name: 'Domain' })).getByText('7 messages'),
    ).toBeInTheDocument();
    await waitFor(() => expect(useWorkspaceStatus.getState().messageCount).toBe(7));
    await waitFor(() =>
      expect(useWorkspaceStatus.getState().tokens).toEqual({ in: 600, out: 200 }),
    );
    unmount();
    expect(useWorkspaceStatus.getState().messageCount).toBeNull();
    expect(useWorkspaceStatus.getState().tokens).toBeNull();
  });

  it('the "live" pill shows while the stream is open, and goes when the run ends', async () => {
    const user = userEvent.setup();
    const team = seedTeam();
    renderApp(pathOf(team));
    await screen.findByText('Draft: Go further.');
    expect(await screen.findByTestId('domain-live')).toHaveTextContent('live');
    await user.click(screen.getByRole('button', { name: /^Run ·/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'End run' }));
    await waitFor(() => expect(screen.queryByTestId('domain-live')).not.toBeInTheDocument());
  });

  it('a run that has ended has no stream, so no "live" pill', async () => {
    const team = seedTeam('COMPLETE');
    renderApp(pathOf(team));
    await screen.findByText('Draft: Go further.');
    expect(screen.queryByTestId('domain-live')).not.toBeInTheDocument();
  });

  it('the run pill shows the run and its status, and offers Run details', async () => {
    const user = userEvent.setup();
    const team = seedTeam();
    const { router } = renderApp(pathOf(team));
    await screen.findByText('Draft: Go further.');
    const pill = screen.getByRole('button', { name: /^Run ·/ });
    expect(within(pill).getByTestId('domain-run-status')).toHaveTextContent('RUNNING');
    await user.click(pill);
    expect(await screen.findByRole('menuitem', { name: /^RUNNING/ })).toHaveTextContent('✓');
    // A live run offers End, not New run.
    expect(screen.getByRole('menuitem', { name: 'End run' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'New run' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Run details' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/runs/${team.run.id}`));
  });

  it("an ended run's pill offers New run: a fresh goal, whatever ran before", async () => {
    const user = userEvent.setup();
    const team = seedTeam('COMPLETE');
    const { router } = renderApp(pathOf(team));
    await screen.findByText('Draft: Go further.');
    await user.click(screen.getByRole('button', { name: /^Run ·/ }));
    await screen.findByRole('menuitem', { name: 'Run details' });
    expect(screen.queryByRole('menuitem', { name: 'End run' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'New run' }));
    await waitFor(() => expect(router.state.location.search).toBe('?run=new'));
    expect(await screen.findByText('This workflow has no runs yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New run' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start team run' })).toBeInTheDocument();
  });

  it('the Team aside follows Split, and its ✕ closes it', async () => {
    const user = userEvent.setup();
    const team = seedTeam();
    renderApp(pathOf(team));
    await screen.findByText('Draft: Go further.');
    const aside = screen.getByRole('complementary', { name: 'Team' });
    expect(aside).toHaveTextContent('2 agents · 1 working');
    expect(within(aside).getByTestId('team-node-review')).toHaveTextContent('Working');
    await user.click(within(aside).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('complementary', { name: 'Team' })).not.toBeInTheDocument();
    expect(useLayoutStore.getState().chatOpen).toBe(false);
    act(() => useLayoutStore.getState().toggleChat());
    expect(screen.getByRole('complementary', { name: 'Team' })).toBeInTheDocument();
  });

  it('End ends the run: its conversation becomes read-only, and the composer starts a new one', async () => {
    const user = userEvent.setup();
    const team = seedTeam();
    renderApp(pathOf(team));
    await screen.findByText('The hook is weak.');
    await user.click(screen.getByRole('button', { name: /^Run ·/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'End run' }));
    await waitFor(() => expect(requestsTo('/end')).toHaveLength(1));
    expect(await screen.findByText(/read-only/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    // The run pill no longer offers End.
    await user.click(screen.getByRole('button', { name: /^Run ·/ }));
    await screen.findByRole('menuitem', { name: 'Run details' });
    expect(screen.queryByRole('menuitem', { name: 'End run' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    // You can still write: the message starts a new run, with itself as the goal.
    const box = screen.getByRole('textbox', { name: 'Message' });
    expect(box).toBeEnabled();
    await user.type(box, 'Again, shorter');
    expect(screen.getByRole('button', { name: 'Start team run' })).toBeEnabled();
  });

  it("an ended run's composer starts a new run with the message as its goal", async () => {
    const user = userEvent.setup();
    const team = seedTeam('COMPLETE');
    const bodies: unknown[] = [];
    server.events.on('request:start', async ({ request }) => {
      if (
        request.method === 'POST' &&
        request.url.endsWith(`/workflows/${team.workflow.id}/runs`)
      ) {
        bodies.push(await request.clone().json());
      }
    });
    const { router } = renderApp(pathOf(team));
    await screen.findByText('Draft: Go further.');
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Write it again, shorter');
    await user.click(screen.getByRole('button', { name: 'Start team run' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({
      goal: 'Write it again, shorter',
      domain: { stayOpen: true },
    });
    await waitFor(() => expect(router.state.location.search).not.toContain(team.run.id));
    server.events.removeAllListeners();
  });

  it('the run switcher opens a past run read-only, from pages', async () => {
    const user = userEvent.setup();
    const team = seedTeam();
    const past: Run = {
      ...team.run,
      id: newId(),
      status: 'COMPLETE',
      allowedActions: ['restart'],
      startedAt: '2026-10-09T09:00:00.000Z',
    };
    db.addRun(past);
    domainMock.seed(past.id, [
      {
        id: 'sys:1.0',
        runId: past.id,
        cursor: '1.0',
        author: { kind: 'system' },
        type: 'system',
        text: 'An older run.',
        at: NOW,
      },
    ]);
    const { router } = renderApp(pathOf(team));
    await screen.findByText('Draft: Go further.');
    await user.click(screen.getByRole('button', { name: /^Run ·/ }));
    await user.click(await screen.findByRole('menuitem', { name: /^COMPLETE/ }));
    expect(await screen.findByText('An older run.')).toBeInTheDocument();
    expect(router.state.location.search).toContain(`run=${past.id}`);
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    expect(requestsTo(`/runs/${past.id}/chat`).length).toBeGreaterThan(0);
  });

  it('with no run yet, the first message starts one, with it as the goal', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'P' });
    const workflow = db.createWorkflow(project.id, 'Fresh');
    const agent = { ...createNode('agent', workflow.id, { x: 0, y: 0 }), name: 'Writer' };
    db.commitGraph(workflow.id, [agent], []);
    const bodies: unknown[] = [];
    server.events.on('request:start', async ({ request }) => {
      if (request.method === 'POST' && request.url.endsWith(`/workflows/${workflow.id}/runs`)) {
        bodies.push(await request.clone().json());
      }
    });
    const { router } = renderApp(`/projects/${project.id}/workflows/${workflow.id}/domain`);
    await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'Write a tagline');
    await user.click(screen.getByRole('button', { name: 'Start team run' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ goal: 'Write a tagline', domain: { stayOpen: true } });
    await waitFor(() => expect(router.state.location.search).toMatch(/run=/));
    server.events.removeAllListeners();
  });
});

describe('Domain entry points (D303)', () => {
  const nodeEl = (id: string) =>
    document.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement | null;

  it('Domain sits in the mode switch beside Ideate and Forge, by click and by Ctrl+Shift+3', async () => {
    const user = userEvent.setup();
    const team = seedTeam();
    const board = `/projects/${team.project.id}/workflows/${team.workflow.id}`;
    const { router } = renderApp(board);
    await screen.findByTestId('canvas');
    const switcher = screen.getByRole('radiogroup', { name: 'Mode' });
    expect(
      within(switcher)
        .getAllByRole('radio')
        .map((radio) => radio.textContent),
    ).toEqual(['Ideate', 'Forge', 'Domain']);

    await user.click(within(switcher).getByRole('radio', { name: /Domain/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`${board}/domain`));
    expect(await screen.findByTestId('domain-page')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Domain/ })).toHaveAttribute('aria-checked', 'true');

    // From Domain, Ctrl+Shift+1 goes back to Ideate; from Ideate, Ctrl+Shift+3 comes back.
    await user.keyboard('{Control>}{Shift>}1{/Shift}{/Control}');
    expect(await screen.findByTestId('canvas')).toBeInTheDocument();
    await user.keyboard('{Control>}{Shift>}3{/Shift}{/Control}');
    expect(await screen.findByTestId('domain-page')).toBeInTheDocument();
    // The run bar no longer carries a separate Domain link.
    expect(screen.queryByRole('link', { name: 'Domain' })).not.toBeInTheDocument();
  });

  it('an agent node menu opens its lens in Domain', async () => {
    const user = userEvent.setup();
    const team = seedTeam();
    const { router } = renderApp(`/projects/${team.project.id}/workflows/${team.workflow.id}`);

    await waitFor(() => expect(nodeEl(team.writer.id)).not.toBeNull());
    fireEvent.contextMenu(nodeEl(team.writer.id) as HTMLElement);
    await user.click(await screen.findByRole('menuitem', { name: 'Open in Domain' }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/\/domain$/));
    expect(router.state.location.search).toContain(`node=${team.writer.id}`);
  });

  it("a run's page opens that run in Domain", async () => {
    const team = seedTeam('COMPLETE');
    renderApp(`/runs/${team.run.id}`);
    const link = await screen.findByRole('link', { name: 'Open in Domain' });
    expect(link.getAttribute('href')).toBe(
      `/projects/${team.project.id}/workflows/${team.workflow.id}/domain?run=${team.run.id}`,
    );
  });
});
