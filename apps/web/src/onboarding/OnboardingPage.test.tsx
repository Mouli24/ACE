import { TEMPLATE_IDS } from '@ace/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { startSocket, stopSocket } from '../app/socket';
import { createFakeWebSocket } from '../mocks/fake-socket';
import { setScenario } from '../mocks/handlers-round2';
import { useRunStore } from '../runs/run-store';
import { db, installMockServer, queryClient, renderApp } from '../test/app';
import { WIZARD_STORAGE_KEY } from './wizard-state';

installMockServer();

vi.mock('../canvas/Canvas', () => ({
  Canvas: ({ workflowId }: { workflowId: string }) => <div data-testid="canvas">{workflowId}</div>,
}));

beforeEach(() => {
  sessionStorage.clear();
  setScenario('linear-complete');
  startSocket({
    token: 'mock',
    queryClient,
    url: 'ws://mock.local/ws',
    WebSocket: createFakeWebSocket(db) as unknown as typeof WebSocket,
  });
});

afterEach(() => {
  stopSocket();
  useRunStore.getState().reset();
});

const step = () => screen.getByTestId('onboarding-page').getAttribute('data-step');

async function chooseMock(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByTestId('onboarding-use-mock'));
  await waitFor(() => expect(step()).toBe('2'));
}

async function chooseTemplate(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(await screen.findByRole('radio', { name }));
  await user.click(screen.getByTestId('onboarding-next'));
  await waitFor(() => expect(step()).toBe('3'));
}

const TEMPLATE_NAMES: Record<(typeof TEMPLATE_IDS)[number], RegExp> = {
  'linear-chain': /linear chain/i,
  'review-fix': /review and fix/i,
  'parallel-research': /parallel research/i,
  'rag-qa': /rag q&a/i,
  'single-builder': /single builder/i,
  'plan-build-review': /plan, build and review/i,
};

describe('TC-ONB-001 a new user reaches a completed run with no key', () => {
  it('Mock provider → RAG Q&A → create → Canvas → run COMPLETE', async () => {
    const user = userEvent.setup();
    const { router } = renderApp('/onboarding');

    expect(screen.getByTestId('onboarding-step-1')).toHaveAttribute('aria-current', 'step');
    await chooseMock(user);
    expect(db.listProviders().filter((p) => p.type === 'mock')).toHaveLength(1);
    expect(db.listProviders().every((p) => !p.keySet)).toBe(true);

    await chooseTemplate(user, TEMPLATE_NAMES['rag-qa']);
    const name = screen.getByLabelText('Project name');
    await user.clear(name);
    await user.type(name, 'Docs helper');
    const question = screen.getByLabelText('First question');
    await user.clear(question);
    await user.type(question, 'What travels between nodes?');
    await user.click(screen.getByRole('button', { name: 'Create project and run' }));

    await waitFor(() =>
      expect(router.state.location.pathname).toMatch(/^\/projects\/\w+\/workflows\/\w+$/),
    );
    await waitFor(
      () => expect(screen.getByTestId('run-status')).toHaveAttribute('data-status', 'COMPLETE'),
      { timeout: 8_000 },
    );

    const project = db.listProjects()[0]!;
    expect(project.name).toBe('Docs helper');
    const workflowId = router.state.location.pathname.split('/').pop()!;
    const run = db.listRuns(workflowId)[0]!;
    expect(run.status).toBe('COMPLETE');
    const inputNode = db.nodesOf(workflowId).find((n) => n.kind === 'input')!;
    expect(run.inputs[inputNode.id]).toEqual([
      { type: 'text', text: 'What travels between nodes?' },
    ]);
    expect(db.settings.onboardingCompleted).toBe(true);
    expect(sessionStorage.getItem(WIZARD_STORAGE_KEY)).toBeNull();
  });
});

describe('TC-ONB-002 (UI) every template instantiates from the wizard and completes', () => {
  it.each(TEMPLATE_IDS)('%s', async (id) => {
    const user = userEvent.setup();
    const { router } = renderApp('/onboarding');
    await chooseMock(user);
    await chooseTemplate(user, TEMPLATE_NAMES[id]);
    await user.click(screen.getByRole('button', { name: 'Create project and run' }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/\/workflows\//));
    await waitFor(
      () => expect(screen.getByTestId('run-status')).toHaveAttribute('data-status', 'COMPLETE'),
      { timeout: 8_000 },
    );
    expect(db.listProjects()).toHaveLength(1);
  });
});

describe('FR-ONB-001 the wizard', () => {
  it('shows a card per template, each with a thumbnail and a description', async () => {
    const user = userEvent.setup();
    renderApp('/onboarding');
    await chooseMock(user);
    const group = await screen.findByRole('radiogroup', { name: 'Templates' });
    await waitFor(() =>
      expect(within(group).getAllByRole('radio')).toHaveLength(TEMPLATE_IDS.length),
    );
    for (const id of TEMPLATE_IDS) {
      expect(screen.getByTestId(`template-thumbnail-${id}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('onboarding-next')).toBeDisabled();
  });

  it('reuses an existing Mock provider instead of adding a second', async () => {
    const existing = db.createProvider({ type: 'mock', name: 'My mock' });
    const user = userEvent.setup();
    renderApp('/onboarding');
    await chooseMock(user);
    expect(db.listProviders()).toHaveLength(1);
    expect(JSON.parse(sessionStorage.getItem(WIZARD_STORAGE_KEY) ?? '{}')).toMatchObject({
      providerId: existing.id,
    });
  });

  it('offers a detected Ollama and adds it in one click (FR-PRV-007)', async () => {
    const user = userEvent.setup();
    renderApp('/onboarding');
    await user.click(await screen.findByTestId('onboarding-add-ollama'));
    await waitFor(() => expect(step()).toBe('2'));
    expect(db.listProviders().map((p) => p.type)).toEqual(['ollama']);
  });

  it('never creates a project before "Create project and run"', async () => {
    const user = userEvent.setup();
    renderApp('/onboarding');
    await chooseMock(user);
    await chooseTemplate(user, TEMPLATE_NAMES['linear-chain']);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(step()).toBe('2'));
    expect(db.listProjects()).toHaveLength(0);
    expect(db.settings.onboardingCompleted).toBe(false);
  });

  it('keeps Create disabled while the project name is empty', async () => {
    const user = userEvent.setup();
    renderApp('/onboarding');
    await chooseMock(user);
    await chooseTemplate(user, TEMPLATE_NAMES['linear-chain']);
    await user.clear(screen.getByLabelText('Project name'));
    expect(screen.getByRole('button', { name: 'Create project and run' })).toBeDisabled();
  });

  it('is skippable: Skip setup marks onboarding done and opens the projects', async () => {
    const user = userEvent.setup();
    const { router } = renderApp('/onboarding');
    await user.click(screen.getByRole('button', { name: 'Skip setup' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects'));
    expect(db.settings.onboardingCompleted).toBe(true);
    expect(db.listProjects()).toHaveLength(0);
    expect(db.listProviders()).toHaveLength(0);
  });

  it('is resumable: reopening the wizard comes back to the same step and choice', async () => {
    const user = userEvent.setup();
    const first = renderApp('/onboarding');
    await chooseMock(user);
    await chooseTemplate(user, TEMPLATE_NAMES['parallel-research']);
    first.unmount();

    renderApp('/onboarding');
    expect(step()).toBe('3');
    expect(screen.getByTestId('onboarding-step-3')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByLabelText('First question')).toHaveValue(
      'What should a small team know before adopting local models?',
    );
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('radio', { name: /parallel research/i })).toBeChecked();
  });

  it('links each step to the user guide (FR-ONB-003)', async () => {
    const user = userEvent.setup();
    renderApp('/onboarding');
    expect(await screen.findByTestId('help-link-providers')).toHaveAttribute(
      'href',
      '/help/providers',
    );
    await chooseMock(user);
    expect(screen.getByTestId('help-link-building-a-workflow')).toBeInTheDocument();
    await chooseTemplate(user, TEMPLATE_NAMES['linear-chain']);
    expect(screen.getAllByTestId('help-link-getting-started').length).toBeGreaterThan(0);
  });
});
