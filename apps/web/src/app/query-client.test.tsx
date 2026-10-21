import { toast } from '@ace/ui';
import { QueryClientProvider, useMutation, type UseMutationOptions } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { createQueryClient } from './query-client';

const fail = () => Promise.reject(new Error('The engine said no.'));

/** One button firing one failing mutation, built with `options`, and called with `call`. */
function Harness({
  options = {},
  perCall,
  inline = false,
}: {
  options?: Partial<UseMutationOptions<unknown, Error, void>>;
  perCall?: (error: Error) => void;
  inline?: boolean;
}) {
  const mutation = useMutation({ mutationFn: fail, ...options });
  return (
    <>
      <button
        type="button"
        onClick={() => mutation.mutate(undefined, perCall ? { onError: perCall } : undefined)}
      >
        Go
      </button>
      {inline && mutation.error && <p role="alert">{mutation.error.message}</p>}
    </>
  );
}

async function press(ui: JSX.Element) {
  render(<QueryClientProvider client={createQueryClient()}>{ui}</QueryClientProvider>);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Go' }));
}

/** Past the global handler's wait, so a toast that was going to come has come. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 250));

describe('audit W-1/W-2 a failed mutation nobody handles says so in a toast', () => {
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    toast.dismiss();
    error = vi.spyOn(toast, 'error');
  });
  afterEach(() => error.mockRestore());

  it('toasts the engine’s words when the mutation has no onError', async () => {
    await press(<Harness />);
    await waitFor(() => expect(error).toHaveBeenCalledWith('The engine said no.'));
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('stays quiet for a mutation with its own onError', async () => {
    await press(<Harness options={{ onError: () => undefined }} />);
    await settled();
    expect(error).not.toHaveBeenCalled();
  });

  it('stays quiet for meta.silentError', async () => {
    await press(<Harness options={{ meta: { silentError: true } }} />);
    await settled();
    expect(error).not.toHaveBeenCalled();
  });

  it('does not double a per-call onError that toasted the same words', async () => {
    await press(<Harness perCall={(e) => toast.error(e.message)} />);
    await settled();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('does not repeat an error the screen already shows inline', async () => {
    await press(<Harness inline />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The engine said no.');
    await settled();
    expect(error).not.toHaveBeenCalled();
  });
});
