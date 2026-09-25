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

import { newId } from '../lib/ulid';
import { db, installMockServer, renderWithQuery, server } from '../test/app';
import { GuardrailsPage } from './GuardrailsPage';
import { createPolicyMockEngine, type PolicyMockEngine } from './policy-mock-handlers';

installMockServer();

let engine: PolicyMockEngine;
let projectId: string;
let defaultPolicy: GuardrailPolicy;

beforeEach(() => {
  // The one REST client is configured with a token by the harness; this screen's calls read the
  // token from where round 1 §2.10 keeps it.
  sessionStorage.setItem(SESSION_TOKEN_STORAGE_KEY, 'mock');
  engine = createPolicyMockEngine();
  server.use(...engine.handlers);
  projectId = db.createProject({ name: 'Demo' }).id;
  defaultPolicy = engine.seedDefault(projectId);
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
      const found = engine.list(projectId).find((policy) => policy.name === 'Strict');
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
    const saved = engine.get(created.id);
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

    /* Delete: 409 policy_in_use first, then the same call with confirm=true (§2.5). */
    engine.inUseNodeIds = [newId()];
    await actor.click(
      within(screen.getByTestId(`policy-row-${created.id}`)).getByRole('button', {
        name: 'Delete',
      }),
    );
    const confirmDialog = screen.getByRole('dialog');
    await actor.click(within(confirmDialog).getByRole('button', { name: 'Delete' }));

    const inUse = await screen.findByTestId('policy-in-use');
    expect(inUse).toHaveTextContent('Agents still use this policy.');
    expect(inUse).toHaveTextContent(engine.inUseNodeIds[0] as string);

    await actor.click(screen.getByRole('button', { name: 'Delete anyway' }));
    await waitFor(() => expect(engine.get(created.id)).toBeUndefined());
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
    expect(options.map((option) => option.textContent)).toEqual([
      'pass',
      'warn',
      'redact',
      'ask user',
      'block',
    ]);
    expect(GUARDRAIL_ACTIONS).toHaveLength(options.length);
  });

  it.each(GUARDRAIL_ACTIONS)('saves %s as the action of a check', async (action) => {
    const actor = user();
    renderGuardrails(`?projectId=${projectId}`);
    await screen.findByTestId('policy-editor');

    await pick(actor, 'Action for pii at input', GUARDRAIL_ACTION_LABEL[action]);
    await actor.click(screen.getByRole('button', { name: 'Save as new version' }));

    await waitFor(() => expect(engine.patches).toHaveLength(1));
    const patched = engine.patches[0]?.body.checks?.find((check) => check.type === 'pii');
    expect(patched?.action).toBe(action);
    expect(engine.get(defaultPolicy.id)?.version).toBe(2);
  });

  it('turns a check off without removing it, and offers only the types the point allows', async () => {
    const actor = user();
    renderGuardrails(`?projectId=${projectId}`);
    await screen.findByTestId('policy-editor');

    await actor.click(screen.getByRole('checkbox', { name: 'Enable pii at input' }));
    await actor.click(screen.getByRole('button', { name: 'Add a input check' }));
    const offered = await screen.findAllByRole('menuitem');
    // input allows size_limit, pii, prompt_injection, blocked_topics (§2.2); three are already
    // there, so only blocked_topics is left to add.
    expect(offered.map((item) => item.textContent)).toEqual(['blocked_topics']);
    await actor.click(offered[0] as HTMLElement);

    await actor.click(screen.getByRole('button', { name: 'Save as new version' }));
    await waitFor(() => expect(engine.patches).toHaveLength(1));
    const checks = engine.patches[0]?.body.checks ?? [];
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
      const box = within(section).getByRole('checkbox', { name });
      expect(box).toBeDisabled();
      expect(box).toHaveAttribute('data-state', 'checked');
    }
  });

  it('has no policy group for the data point, because the contract has none', async () => {
    renderGuardrails(`?projectId=${projectId}`);
    await screen.findByTestId('policy-editor');

    expect(screen.queryByTestId('point-group-data')).toBeNull();
    expect(PolicyGuardrailPointSchema.safeParse('data').success).toBe(false);
  });
});
