import type { Secret } from '@ace/contracts';

import type { Scope } from './scope.js';

/**
 * ACE parity P1 (D274): where a secret's **row** is kept — its name, description and project scope.
 *
 * Never its value. A value lives only in the `SecretStore` (the OS keychain), under
 * `secret:env:<NAME>`, so the table behind this port has no column that could hold one and nothing
 * here can carry one (BR-07, NFR-SEC-02). `packages/storage-local` implements it.
 */
export interface SecretRepository {
  /** Every secret of the workspace, by name. */
  list(scope: Scope): Promise<Secret[]>;
  get(scope: Scope, name: string): Promise<Secret | null>;
  /** Throws when the name is already taken; the service checks first and answers 409 `name_taken`. */
  create(scope: Scope, secret: Secret): Promise<Secret>;
  /** Replaces the stored row with this one (same name); throws if it does not exist. */
  save(scope: Scope, secret: Secret): Promise<Secret>;
  /** `false` when there was nothing to remove. */
  delete(scope: Scope, name: string): Promise<boolean>;
}
