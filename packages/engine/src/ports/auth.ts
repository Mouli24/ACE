import type { Scope } from './scope.js';

/**
 * Who is calling (Arch §7: a random session token locally, accounts and API keys when hosted).
 *
 * FR-SYS-002: every REST request and WebSocket connection carries the token; a missing or wrong one
 * is a 401 on REST and close code 4401 on the socket.
 */
export interface Auth {
  verifyToken(scope: Scope, token: string | undefined): Promise<boolean>;
}
