import type { AceSocketStatus } from '@ace/sdk';

/**
 * What the run bar says about the connection: reconnecting while the socket retries (FR-EXE-014),
 * or that this page's address may not connect at all (FR-SYS-003, D301), which no retry fixes.
 */
export function SocketNotice({ status }: { status: AceSocketStatus }) {
  if (status === 'reconnecting') {
    return (
      <span
        role="status"
        data-testid="socket-reconnecting"
        className="font-machine text-xs text-fg-muted"
      >
        reconnecting…
      </span>
    );
  }
  if (status === 'forbidden_origin') {
    return (
      <span
        role="alert"
        data-testid="socket-forbidden-origin"
        title="This page's address is not on the engine's allowed origins (settings.allowedOrigins). Add it there, then reload."
        className="font-machine text-xs text-danger"
      >
        this address may not connect to the engine
      </span>
    );
  }
  return null;
}
