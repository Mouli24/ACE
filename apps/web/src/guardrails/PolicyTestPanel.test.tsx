import { SESSION_TOKEN_STORAGE_KEY, type GuardrailPolicy, type Verdict } from '@ace/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { newId } from '../lib/ulid';
import { db, installMockServer, renderWithQuery, server } from '../test/app';
import { PolicyTestPanel } from './PolicyTestPanel';
import { VerdictList } from './VerdictList';
import { createPolicyMockEngine, testVerdict, type PolicyMockEngine } from './policy-mock-handlers';

installMockServer();

/** The address of a person, as a value a redaction must never put on screen (FR-GRD-014). */
const EMAIL_IN_THE_TEXT = 'ada@example.com';

let engine: PolicyMockEngine;
let policy: GuardrailPolicy;

beforeEach(() => {
  sessionStorage.setItem(SESSION_TOKEN_STORAGE_KEY, 'mock');
  engine = createPolicyMockEngine();
  server.use(...engine.handlers);
  policy = engine.seedDefault(db.createProject({ name: 'Demo' }).id);
});

async function runTest(text: string, point?: 'as input' | 'as output') {
  const actor = userEvent.setup();
  renderWithQuery(<PolicyTestPanel policy={policy} />);
  await actor.type(screen.getByLabelText('Text'), text);
  if (point) {
    await actor.click(screen.getByRole('combobox', { name: 'Check it' }));
    await actor.click(await screen.findByRole('option', { name: point }));
  }
  await actor.click(screen.getByRole('button', { name: 'Run test' }));
  return actor;
}

describe('TC-GRD-019 verdicts are visible', () => {
  it('renders the check, the point, the action, whether it passed and the reason', async () => {
    engine.testVerdicts = [
      testVerdict({
        point: 'output',
        checkType: 'moderation',
        action: 'warn',
        passed: false,
        reason: 'Language that the moderation rule pack flags.',
      }),
      testVerdict({ point: 'output', checkType: 'contract', action: 'block', passed: true }),
    ];

    await runTest('anything at all', 'as output');

    const list = await screen.findByTestId('policy-test-verdicts');
    expect(list).toHaveTextContent('2 verdicts');

    const first = within(list).getByTestId('verdict-row-test-0');
    expect(within(first).getByTestId('verdict-test-0')).toHaveTextContent('warn');
    expect(within(first).getByTestId('verdict-test-0')).toHaveTextContent('moderation');
    expect(within(first).getByTestId('verdict-test-0')).toHaveTextContent('output');
    expect(within(first).getByTestId('verdict-passed-test-0')).toHaveTextContent('did not pass');
    expect(first).toHaveTextContent('Language that the moderation rule pack flags.');

    expect(within(list).getByTestId('verdict-passed-test-1')).toHaveTextContent('passed');
    expect(engine.tests).toEqual([
      { id: policy.id, body: { text: 'anything at all', point: 'output' } },
    ]);
  });

  it('says so when the policy found nothing to report', async () => {
    engine.testVerdicts = [];
    await runTest('hello');
    expect(await screen.findByTestId('verdicts-empty')).toHaveTextContent('No verdicts.');
  });
});

describe('TC-GRD-018 a redaction records the type, never the value', () => {
  it('shows the types removed and no trace of the value in the verdict', async () => {
    engine.testVerdicts = [
      testVerdict({
        point: 'input',
        checkType: 'pii',
        action: 'redact',
        passed: true,
        reason: 'One email address was removed.',
        redactedTypes: ['email'],
      }),
    ];

    await runTest(`write to ${EMAIL_IN_THE_TEXT} today`);

    // Scoped to the verdicts: the pasted text is still in the textarea, which is the person's own
    // input, while the verdict is what the engine recorded — and it carries types only.
    const verdicts = await screen.findByTestId('policy-test-verdicts');
    expect(verdicts).toHaveTextContent('types removed: email');
    expect(verdicts.textContent).not.toContain(EMAIL_IN_THE_TEXT);
    expect(verdicts.textContent).not.toContain('ada');
  });

  it('never renders a value anywhere in a verdict list', () => {
    const verdict: Verdict = {
      id: newId(),
      nodeRunId: newId(),
      point: 'output',
      checkType: 'pii',
      action: 'redact',
      passed: true,
      reason: 'One email address was removed.',
      redactedTypes: ['email', 'phone'],
      at: new Date().toISOString(),
    };

    const { container } = renderWithQuery(<VerdictList verdicts={[verdict]} />);

    expect(container).toHaveTextContent('types removed: email, phone');
    expect(container.textContent).not.toContain(EMAIL_IN_THE_TEXT);
    expect(container.textContent).not.toContain('@');
  });
});

describe('FR-GRD-001 the test panel calls the endpoint with what was typed', () => {
  it('sends the text and the point, and refuses to send nothing', async () => {
    const actor = userEvent.setup();
    renderWithQuery(<PolicyTestPanel policy={policy} />);
    expect(screen.getByRole('button', { name: 'Run test' })).toBeDisabled();

    await actor.type(screen.getByLabelText('Text'), 'a secret key');
    await actor.click(screen.getByRole('button', { name: 'Run test' }));

    await waitFor(() => expect(engine.tests).toHaveLength(1));
    expect(engine.tests[0]?.body).toEqual({ text: 'a secret key', point: 'input' });
  });
});
