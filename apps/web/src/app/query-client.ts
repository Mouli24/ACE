import { toast } from '@ace/ui';
import { MutationCache, QueryClient, type Mutation } from '@tanstack/react-query';

/** An engine failure's words: the FR-SYS-006 envelope's message, or the error's own. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type AnyMutation = Mutation<unknown, unknown, unknown, unknown>;

/**
 * How long a failure waits before the global toast: long enough for a per-call `onError` to run
 * and for the screen to draw what it does with the error (TanStack notifies observers a tick
 * later), short enough to read as immediate.
 */
const SETTLE_MS = 120;

/** Whether `message` is already in front of the person: a toast with those words, or the page. */
function alreadyShown(message: string): boolean {
  const toasted = toast
    .getToasts()
    .some(
      (item) => !('dismiss' in item) && (item.title === message || item.description === message),
    );
  return toasted || (document.body.textContent ?? '').includes(message);
}

/**
 * Audit W-1/W-2: a mutation that fails with no `onError` of its own — and no
 * `meta: { silentError: true }` from a caller that handles the failure itself — says so in a
 * toast, in the engine's words. Run start, Retry, Re-run, approvals and thread delete used to fail
 * silently. A per-call `mutate(…, { onError })` or a dialog's inline error cannot be seen from the
 * cache, so the toast waits for them and stays away when the same words are already shown.
 */
export function reportMutationError(error: unknown, mutation: AnyMutation): void {
  if (mutation.options.onError !== undefined) return;
  if (mutation.meta?.['silentError'] === true) return;
  const message = errorMessage(error);
  setTimeout(() => {
    if (!alreadyShown(message)) toast.error(message);
  }, SETTLE_MS);
}

/** The app's one query client (Arch §10.1): engine data, and what happens when a call fails. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) =>
        reportMutationError(error, mutation as AnyMutation),
    }),
    defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
  });
}
