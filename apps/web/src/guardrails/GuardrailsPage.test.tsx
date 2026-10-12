import {
  GUARDRAIL_ACTIONS,
  PolicyGuardrailPointSchema,
  SESSION_TOKEN_STORAGE_KEY,
  type GuardrailPolicy,
} from '@ace/contracts';
import { GUARDRAIL_ACTION_LABEL } from '@ace/ui';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { createNode } from '../nodes/factory';
import { db, installMockServer, renderWithQuery } from '../test/app';
import { GuardrailsPage } from './GuardrailsPage';

installMockServer();

let projectId: string;
let defaultPolicy: GuardrailPolicy;

beforeEach(() => {
  // The one REST client is configured with a token by the harness; this screen's calls read the
  // token from where round 1 §2.10 keeps it.
  sessionStorage.setItem(SESSION_TOKEN_STORAGE_KEY, 'mock');
  // Every project is born with the §2.2 default policy, which is the thing FR-GRD-018 is about —
  // so the screen is tested against the policy the mock engine actually created, not a seeded fake.
  projectId = db.createProject({ name: 'Demo' }).id;
  defaultPolicy = db.projectDefaultPolicy(projectId) as GuardrailPolicy;
});

/** The route is `/guardrails` (Arch §33.3); it is not in `routes.tsx` yet, so it is mounted here. */
function renderGuardrails(search = '') {
  return renderWithQuery(
    <MemoryRouter initialEntries={[`/guardrails${search}`]}>
      <Routes>
        <Route path="/guardrails" element={<GuardrailsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const user = () => userEvent.setup();

/** Radix needs a click on the trigger and then on the option, not `selectOptions`. */
async function pick(
  actor: ReturnType<typeof userEvent.setup>,
  triggerName: string | RegExp,
  optionName: string,
) {
  await actor.click(screen.getByRole('combobox', { name: triggerName }));
  await actor.click(await screen.findByRole('option', { name: optionName }));
}

/** An Agent node that overrides the project default with `policyId`; returns the node's id. */
function useThePolicy(policyId: string): string {
  const workflow = db.createWorkflow(projectId, 'Uses the policy');
  const agent = createNode('agent', workflow.id, { x: 0, y: 0 });
  agent.config = { ...agent.config, guardrailPolicyId: policyId } as typeof agent.config;
  db.commitGraph(workflow.id, [agent], []);
  return agent.id;
}

describe('TC-GRD-001 policy lifecycle', () => {
  it('lists the project default with its version and a default badge (FR-GRD-018)', async () => {
    renderGuardrails();

    const row = await screen.findByTestId(`policy-row-${defaultPolicy.id}`);
    expect(within(row).getByTestId(`policy-name-${defaultPolicy.id}`)).toHaveTextContent('Default');
    expect(within(row).getByTestId(`policy-version-${defaultPolicy.id}`)).toHaveTextContent(
      'version 1',
    );
    expect(within(row).getByTestId(`policy-default-${defaultPolicy.id}`)).toHaveTextContent(
      'default',
    );
    expect(await screen.findByTestId('selected-policy-heading')).toHaveTextContent(
      'Default · version 1',
    );
  });

  it('creates a policy, saves a new version, makes it the default and deletes it', async () => {
    const actor = user();
    renderGuardrails(`?projectId=${projectId}`);
    await screen.findByTestId(`policy-row-${defaultPolicy.id}`);

    /* Create (POST /guardrail-policies → version 1). */
    await actor.click(screen.getByRole('button', { name: /new policy/i }));
    const dialog = screen.getByRole('dialog');
    await actor.type(within(dialog).getByLabelText('Name'), 'Strict');
    await actor.click(within(dialog).getByRole('button', { name: 'Create policy' }));

    const created = await waitFor(() => {
      const found = db.listPolicies(projectId).find((policy) => policy.name === 'Strict');
      if (!found) throw new Error('not created yet');
      return found;
    });
    expect(created.version).toBe(1);
    expect(await screen.findByTestId('selected-policy-heading')).toHaveTextContent(
      'Strict · version 1',
    );

    /* Edit: a stricter action and a changed param, then save — a PATCH writes version + 1. */
    await pick(actor, 'Action for pii at input', GUARDRAIL_ACTION_LABEL.block);
    const maxChars = screen.getByLabelText('Max characters for size_limit');
    await actor.clear(maxChars);
    await actor.type(maxChars, '1000');
    await actor.click(screen.getByRole('button', { name: 'Save as new version' }));

    expect(await screen.findByTestId('policy-saved-version')).toHaveTextContent(
      'saved as version 2',
    );
    await waitFor(() =>
      expect(screen.getByTestId(`policy-version-${created.id}`)).toHaveTextContent('version 2'),
    );
    const saved = db.getPolicy(created.id);
    expect(saved?.version).toBe(2);
    expect(saved?.checks.find((check) => check.type === 'pii')?.action).toBe('block');
    expect(saved?.checks.find((check) => check.type === 'size_limit')?.params['maxChars']).toBe(
      1000,
    );

    /* Set as project default (FR-GRD-018): the badge moves, and only one policy carries it. */
    const createdRow = screen.getByTestId(`policy-row-${created.id}`);
    await actor.click(within(createdRow).getByRole('button', { name: 'Set as project default' }));
    expect(await screen.findByTestId(`policy-default-${created.id}`)).toHaveTextContent('default');
    await waitFor(() =>
      expect(screen.queryByTestId(`policy-default-${defaultPolicy.id}`)).toBeNull(),
    );

    /*
     * Delete: 409 `policy_in_use` first, then the same call with confirm=true (§2.5). What makes it
     * in use is an Agent node naming it — the same thing the engine counts (FR-GRD-002).
     */
    const usingNodeId = useThePolicy(created.id);
    await actor.click(
      within(screen.getByTestId(`policy-row-${created.id}`)).getByRole('button', {
        name: 'Delete',
      }),
    );
    const confirmDialog = screen.getByRole('dialog');
    await actor.click(within(confirmDialog).getByRole('button', { name: 'Delete' }));

    const inUse = await screen.findByTestId('policy-in-use');
    // The engine's own 409 message is what is shown, so the screen never invents a count.
    expect(inUse).toHaveTextContent('1 node still uses this policy.');
    expect(inUse).toHaveTextContent(usingNodeId);

    await actor.click(screen.getByRole('button', { name: 'Delete anyway' }));
    await waitFor(() => expect(db.getPolicy(created.id)).toBeUndefined());
    await waitFor(() => expect(screen.queryByTestId(`policy-row-${created.id}`)).toBeNull());
  });
});

describe('TC-GRD-016 all five actions are configurable on a check', () => {
  it('offers the five contract actions, with ask_user labelled "ask user"', async () => {
    const actor = user();
    renderGuardrails(`?projectId=${projectId}`);
    await screen.findByTestId('policy-editor');

    await actor.click(screen.getByRole('combobox', { name: 'Action for pii at input' }));
    const options = await screen.findAllByRole('option');
    // The theme's dropdown marks the current action in its ✓ column (D328); names are the labels.
    expect(options.map((option) => option.textContent?.replace(/^✓/, ''))).toEqual([
      'pass',
      'warn',
      'redact',
      'ask user',
      'block',
    ]);
    expect(screen.getByRole('option', { name: 'warn' })).toHaveTextContent('✓warn');
    expect(GUARDRAIL_ACTIONS).toHaveLength(options.length);
  });

  it.each(GUARDRAIL_ACTIONS)('saves %s as the action of a check', async (action) => {
    const actor = user();
    renderGuardrails(`?projectId=${projectId}`);
    await screen.findByTestId('policy-editor');

    await pick(actor, 'Action for pii at input', GUARDRAIL_ACTION_LABEL[action]);
    await actor.click(screen.getByRole('button', { name: 'Save as new version' }));

    await waitFor(() => expect(db.getPolicy(defaultPolicy.id)?.version).toBe(2));
    const patched = db.getPolicy(defaultPolicy.id)?.checks.find((check) => check.type === 'pii');
    expect(patched?.action).toBe(action);
  });

  it('turns a check off without removing it, and offers only the types the point allows', async () => {
    const actor = user();
    renderGuardrails(`?projectId=${projectId}`);
    await screen.findByTestId('policy-editor');

    const enabled = screen.getByRole('switch', { name: 'Enable pii at input' });
    expect(enabled).toHaveAttribute('aria-checked', 'true');
    await actor.click(enabled);
    expect(enabled).toHaveAttribute('aria-checked', 'false');
    await actor.click(screen.getByRole('button', { name: 'Add a input check' }));
    const offered = await screen.findAllByRole('menuitem');
    // input allows size_limit, pii, prompt_injection, blocked_topics (§2.2); three are already
    // there, so only blocked_topics is left to add.
    expect(offered.map((item) => item.textContent)).toEqual(['blocked_topics']);
    await actor.click(offered[0] as HTMLElement);

    await actor.click(screen.getByRole('button', { name: 'Save as new version' }));
    await waitFor(() => expect(db.getPolicy(defaultPolicy.id)?.version).toBe(2));
    const checks = db.getPolicy(defaultPolicy.id)?.checks ?? [];
    expect(checks.find((check) => check.type === 'pii')?.enabled).toBe(false);
    expect(checks.find((check) => check.type === 'blocked_topics')?.point).toBe('input');
  });
});

describe('TC-GRD-015 data guardrails cannot be disabled', () => {
  it('shows them always on, not switchable, and says why (FR-GRD-010, BR-15)', async () => {
    renderGuardrails(`?projectId=${projectId}`);

    const section = await screen.findByTestId('data-guardrails-always-on');
    expect(section).toHaveTextContent('Data guardrails cannot be switched off');
    for (const name of ['Secret redaction (always on)', 'File confinement (always on)']) {
      const toggle = within(section).getByRole('switch', { name });
      expect(toggle).toBeDisabled();
      expect(toggle).toHaveAttribute('aria-checked', 'true');
    }
  });

  it('has no policy group for the data point, because the contract has none', async () => {
    renderGuardrails(`?projectId=${projectId}`);
    await screen.findByTestId('policy-editor');

    expect(screen.queryByTestId('point-group-data')).toBeNull();
    expect(PolicyGuardrailPointSchema.safeParse('data').success).toBe(false);
  });
});
