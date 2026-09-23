import { AceApiError } from '@ace/sdk';
import { Link } from 'react-router-dom';

/**
 * What a failed engine query means for the person looking at the screen (D-009, NFR-USE-03).
 *
 * The screens used to render every failure as "… not found", so a stale session token, a blocked
 * origin and an engine that is not running all produced the same sentence — and the link they
 * offered failed for the same reason. Each case now says what happened and what to do next.
 */
export type ErrorKind = 'auth' | 'origin' | 'missing' | 'offline' | 'engine';

export interface DescribedError {
  kind: ErrorKind;
  title: string;
  detail: string;
  /** Navigating away only helps when the thing asked for is genuinely gone. */
  canNavigateAway: boolean;
}

const article = (what: string): string => what.charAt(0).toUpperCase() + what.slice(1);

export function describeError(error: unknown, what: string): DescribedError {
  if (AceApiError.is(error)) {
    if (error.status === 401 || error.code === 'unauthorized') {
      return {
        kind: 'auth',
        title: 'This session is no longer valid',
        detail:
          'The engine mints a new session token every time it starts, so a page left open across a restart holds a stale one. Reopen the ?token= URL the engine printed on start (or run pnpm dev again and use the URL it prints).',
        canNavigateAway: false,
      };
    }
    if (error.status === 403 || error.code === 'forbidden_origin') {
      return {
        kind: 'origin',
        title: 'The engine refused this address',
        detail: `This page is served from an origin that is not on the engine's allow-list (settings.allowedOrigins). Open the app from the address the engine printed, or add this one to the allow-list. Engine said: ${error.message}`,
        canNavigateAway: false,
      };
    }
    if (error.status === 404 || error.code === 'not_found') {
      return {
        kind: 'missing',
        title: `${article(what)} not found`,
        detail: `It may have been deleted, or the link may be out of date. ${error.message}`,
        canNavigateAway: true,
      };
    }
    if (error.kind === 'network' || error.status === 0) {
      return {
        kind: 'offline',
        title: 'Cannot reach the engine',
        detail:
          'The engine is not answering on its address. Check that it is still running — `pnpm dev` starts it — and this page will recover on its own once it is back.',
        canNavigateAway: false,
      };
    }
    return {
      kind: 'engine',
      title: `The engine could not load this ${what}`,
      detail: `${error.message} (${error.code})`,
      canNavigateAway: true,
    };
  }

  return {
    kind: 'engine',
    title: `Could not load this ${what}`,
    detail: error instanceof Error ? error.message : String(error),
    canNavigateAway: true,
  };
}

export interface QueryErrorProps {
  error: unknown;
  /** The thing that failed to load, lower case: "workflow", "project". */
  what: string;
  /** Where "back" goes when navigating away can help. */
  backTo?: string;
  backLabel?: string;
}

/** The one place a failed engine query is turned into something a person can act on. */
export function QueryError({
  error,
  what,
  backTo = '/projects',
  backLabel = 'Back to projects',
}: QueryErrorProps) {
  const described = describeError(error, what);
  return (
    <div role="alert" className="mx-auto flex max-w-lg flex-col gap-2 p-6">
      <h2 className="font-human text-lg font-semibold text-danger">{described.title}</h2>
      <p className="font-human text-sm text-fg-muted">{described.detail}</p>
      {described.canNavigateAway && (
        <Link to={backTo} className="text-sm text-accent underline-offset-2 hover:underline">
          {backLabel}
        </Link>
      )}
    </div>
  );
}
