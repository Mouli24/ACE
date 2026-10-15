import { IdSchema } from '@ace/contracts';

import { newId } from './ulid';

describe('newId (D21: ids are Crockford ULIDs)', () => {
  it('produces ids that satisfy the contract IdSchema', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(IdSchema.safeParse(newId()).success).toBe(true);
    }
  });

  it('produces unique ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId()));
    expect(ids.size).toBe(1000);
  });

  it('encodes the timestamp so later ids sort after earlier ones', () => {
    const a = newId(1_000_000);
    const b = newId(2_000_000);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
  });

  it('PG-1.6: ids minted in one millisecond keep the order they were made in (monotonic)', () => {
    const ids = Array.from({ length: 500 }, () => newId());
    expect([...ids].sort()).toEqual(ids);
    expect(ids.every((id) => IdSchema.safeParse(id).success)).toBe(true);
  });
});
