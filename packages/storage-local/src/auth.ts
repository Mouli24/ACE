import { timingSafeEqual } from 'node:crypto';

import type { Auth, Scope } from '@ace/engine';

/**
 * The local session token (Arch §7 local adapter; accounts and API keys when hosted).
 *
 * FR-SYS-002: every REST request and WebSocket connection carries it. The comparison is constant
 * time; a length mismatch is answered first because `timingSafeEqual` throws on unequal lengths,
 * and length is not the secret.
 */
export class SessionTokenAuth implements Auth {
  readonly #expected: Buffer;

  constructor(token: string) {
    this.#expected = Buffer.from(token, 'utf8');
  }

  async verifyToken(_scope: Scope, token: string | undefined): Promise<boolean> {
    if (token === undefined || token === '') return false;

    const given = Buffer.from(token, 'utf8');
    if (given.length !== this.#expected.length) return false;

    return timingSafeEqual(given, this.#expected);
  }
}
