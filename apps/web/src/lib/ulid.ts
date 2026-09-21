const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function encodeTime(now: number): string {
  let value = now;
  let out = '';
  for (let i = 0; i < TIME_LEN; i += 1) {
    const mod = value % 32;
    out = ENCODING[mod] + out;
    value = (value - mod) / 32;
  }
  return out;
}

function encodeRandom(): string {
  const bytes = randomBytes(RANDOM_LEN);
  let out = '';
  for (let i = 0; i < RANDOM_LEN; i += 1) {
    out += ENCODING[(bytes[i] ?? 0) % 32];
  }
  return out;
}

/**
 * A Crockford base-32 ULID (26 chars) that satisfies the contract `IdSchema` (D21). The first
 * 10 characters encode the millisecond timestamp, so ids created later sort after earlier ones.
 */
export function newId(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}
