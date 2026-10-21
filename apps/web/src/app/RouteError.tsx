import { Button } from '@ace/ui';
import type { ReactNode } from 'react';
import { Link, isRouteErrorResponse, useLocation, useRouteError } from 'react-router-dom';

/**
 * One centred theme card on the canvas colour (TokenMissing's look, D328) for a screen that cannot
 * show what was asked: a title, a few lines and the ways out.
 */
export function RouteNotice({
  title,
  testId,
  actions,
  children,
}: {
  title: string;
  testId: string;
  actions: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className="flex h-full w-full items-center justify-center bg-[var(--canvas)] px-4 py-8 text-[var(--ink)]"
    >
      <div className="flex w-full max-w-[520px] flex-col gap-4 rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-5">
        <h1 className="text-[20px] font-bold tracking-[-0.01em]">{title}</h1>
        {children}
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      </div>
    </div>
  );
}

const BODY = 'text-[13px] leading-[1.55] text-[var(--muted)]';

function BackToProjects({ variant }: { variant: 'default' | 'secondary' }) {
  return (
    <Button asChild variant={variant} size="sm">
      <Link to="/projects">Back to projects</Link>
    </Button>
  );
}

/** Audit U-1 (L-8): the `*` route — an address nothing in ACE answers, inside the app's chrome. */
export function NotFound() {
  const { pathname } = useLocation();
  return (
    <RouteNotice
      title="Page not found"
      testId="not-found"
      actions={<BackToProjects variant="default" />}
    >
      <p className={BODY}>
        Nothing in ACE lives at{' '}
        <code className="break-all rounded-[4px] bg-[var(--hover)] px-[5px] py-px font-machine text-[12px] text-[var(--ink)]">
          {pathname}
        </code>
        . The link may be old, or what it pointed to was deleted.
      </p>
    </RouteNotice>
  );
}

/**
 * Audit U-1 (L-8): a route's `errorElement`, in place of React Router's developer page. Under the
 * shell it draws where the screen was, so the header (and its way out) stays; `standalone` is the
 * shell's own, when there is no chrome left to keep.
 */
export function RouteError({ standalone = false }: { standalone?: boolean }) {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) {
    return standalone ? (
      <div className="h-screen">
        <NotFound />
      </div>
    ) : (
      <NotFound />
    );
  }
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : String(error);
  const notice = (
    <RouteNotice
      title="This screen ran into a problem"
      testId="route-error"
      actions={
        <>
          <Button size="sm" onClick={() => window.location.reload()}>
            Reload
          </Button>
          <BackToProjects variant="secondary" />
        </>
      }
    >
      <p className={BODY}>
        Something on this screen failed while it was drawn. Your work is kept by the engine, so
        reloading usually brings it back.
      </p>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-[8px] border border-[var(--line)] bg-[var(--soft)] px-3 py-[10px] font-machine text-[12px] leading-[1.55] text-[var(--danger-ink)]">
        {message}
      </pre>
    </RouteNotice>
  );
  return standalone ? <div className="h-screen">{notice}</div> : notice;
}
