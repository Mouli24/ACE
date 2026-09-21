import { monotonicFactory } from 'ulid';

/**
 * The engine's only id generator (§2.4: `Id = string (ULID)`).
 *
 * `monotonicFactory` rather than plain `ulid()` on purpose: two plain ULIDs minted in the same
 * millisecond get independent random tails, so they can sort in either order. Cursor pagination
 * orders by id and treats that order as creation order, so a non-monotonic id would let two
 * projects created in the same millisecond come back in the wrong order — or, worse, let a cursor
 * skip one. The monotonic factory increments the random tail within a millisecond instead.
 */
const nextUlid = monotonicFactory();

export function newId(): string {
  return nextUlid();
}
