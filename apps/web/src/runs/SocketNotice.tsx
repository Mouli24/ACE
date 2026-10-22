import type { AceSocketStatus } from '@ace/sdk';

/**
 * What the connection says when something is wrong with it: reconnecting while the socket retries
 * (FR-EXE-014), or that this page's address may not connect at all (FR-SYS-003, D301), which no
 * retry fixes. Drawn as the workspace footer's connection indicator (D330) draws a state — a 6px
 * dot and a label — in the theme's colours: the muted grey, and the danger red of Disconnected.
 *
 * The footer draws its 4403 with it (`forbidden_origin`, an alert that says how to fix it). Its own
 * "Reconnecting…", and the phone run bar's, are the re-skin's, kept as they were (D330).
 */
export function SocketNotice({ status }: { status: AceSocketStatus }) {
  if (status === 'reconnecting') {
    return (
      <span
        role="status"
        data-testid="socket-reconnecting"
        data-status={status}
        className="flex min-w-0 items-center gap-[6px] text-[var(--muted)]"
      >
        <span aria-hidden className="h-[6px] w-[6px] shrink-0 rounded-full bg-[#a39d97]" />
        reconnecting…
      </span>
    );
  }
  if (status === 'forbidden_origin') {
    return (
      <span
        role="alert"
        data-testid="socket-forbidden-origin"
        data-status={status}
        title="This page's address is not on the engine's allowed origins (settings.allowedOrigins). Add it there, then reload."
        className="flex min-w-0 items-center gap-[6px] text-danger"
      >
        <span aria-hidden className="h-[6px] w-[6px] shrink-0 rounded-full bg-current" />
        <span className="truncate">this address may not connect to the engine</span>
      </span>
    );
  }
  return null;
}
