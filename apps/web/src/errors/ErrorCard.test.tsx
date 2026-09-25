import { ERROR_KINDS, type ErrorKind, type NodeError } from '@ace/contracts';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ErrorCard } from './ErrorCard';
import { NEXT_STEP_BY_ERROR_KIND } from './next-steps';

const NODE = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const PROVIDER = '01BRZ3NDEKTSV4RRFFQ69G5FAV';

const error = (kind: ErrorKind, extra: Partial<NodeError> = {}): NodeError => ({
  kind,
  code: `${kind}_code`,
  message: `something went wrong (${kind})`,
  retryable: kind === 'provider' || kind === 'network',
  providerId: PROVIDER,
  ...extra,
});

describe('TC-ERR-002 the error card shows node, kind, message, provider, state and Retry', () => {
  it('has every item FR-ERR-002 lists, plus what to do next (NFR-USE-03)', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <ErrorCard
        nodeId={NODE}
        nodeName="Writer"
        state="FAILED"
        failureReason="RUN_FAILED"
        error={error('provider', { code: 'provider_503', message: 'Service Unavailable' })}
        providerName="Mock"
        attempt={2}
        onRetry={onRetry}
      />,
    );

    const card = screen.getByTestId(`error-card-${NODE}`);
    expect(card).toHaveTextContent('Writer'); // the failed node
    expect(screen.getByTestId(`error-kind-${NODE}`)).toHaveTextContent('provider'); // the kind
    expect(card).toHaveTextContent('provider_503'); // the code
    expect(card).toHaveTextContent('Service Unavailable'); // the message
    expect(screen.getByTestId(`error-provider-${NODE}`)).toHaveTextContent('Mock'); // the provider
    expect(screen.getByTestId('status-ring')).toHaveAttribute('data-state', 'FAILED'); // the state
    expect(card).toHaveTextContent('attempt 2');
    expect(card).toHaveTextContent('RUN_FAILED');

    await user.click(screen.getByRole('button', { name: 'Retry' })); // …and Retry
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('falls back to the provider id when the app has no name for it', () => {
    render(<ErrorCard nodeId={NODE} nodeName="Writer" state="FAILED" error={error('auth')} />);
    expect(screen.getByTestId(`error-provider-${NODE}`)).toHaveTextContent(PROVIDER);
  });
});

describe('NFR-USE-03 every error kind says what to do next', () => {
  /*
   * The point of this test: a kind added to the contract must not be able to render a card with a
   * blank next step. `NEXT_STEP_BY_ERROR_KIND` is typed `Record<ErrorKind, string>` so the build
   * catches it, and this walks `ERROR_KINDS` so a run-time hole is caught too.
   */
  it.each(ERROR_KINDS)('%s has a non-empty next step on the card', (kind) => {
    render(<ErrorCard nodeId={NODE} nodeName="Writer" state="FAILED" error={error(kind)} />);
    const step = screen.getByTestId(`error-next-step-${NODE}`);
    expect(step.textContent?.trim().length ?? 0).toBeGreaterThan(10);
    expect(step).toHaveTextContent(NEXT_STEP_BY_ERROR_KIND[kind]);
  });

  it('says the thing §5 item 3 asks for, per kind', () => {
    expect(NEXT_STEP_BY_ERROR_KIND.auth).toContain('provider key in Providers');
    expect(NEXT_STEP_BY_ERROR_KIND.provider).toContain('fallback model');
    expect(NEXT_STEP_BY_ERROR_KIND.invalid_config).toContain('node settings');
    expect(NEXT_STEP_BY_ERROR_KIND.guardrail).toMatch(/verdicts|policy/);
    expect(NEXT_STEP_BY_ERROR_KIND.network).toContain('endpoint');
    expect(NEXT_STEP_BY_ERROR_KIND.agent).toContain('contract');
    expect(NEXT_STEP_BY_ERROR_KIND.workflow).toContain('upstream');
    expect(NEXT_STEP_BY_ERROR_KIND.user_cancelled).toContain('Nothing failed');
  });

  it('lists a next step for exactly the eight contract kinds and no invented ninth', () => {
    expect(Object.keys(NEXT_STEP_BY_ERROR_KIND).sort()).toEqual([...ERROR_KINDS].sort());
  });
});
