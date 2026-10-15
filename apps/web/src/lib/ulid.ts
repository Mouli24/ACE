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

/** The random tail plus one, in base 32 — `undefined` when it would overflow. */
function incrementRandom(random: string): string | undefined {
  const digits = random.split('');
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const value = ENCODING.indexOf(digits[i] ?? '0');
    if (value < ENCODING.length - 1) {
      digits[i] = ENCODING[value + 1] ?? '0';
      return digits.join('');
    }
    digits[i] = '0';
  }
  return undefined;
}

let last: { time: number; random: string } | undefined;

/**
 * A Crockford base-32 ULID (26 chars) that satisfies the contract `IdSchema` (D21). The first
 * 10 characters encode the millisecond timestamp, so ids created later sort after earlier ones.
 *
 * Without an explicit `now` it is monotonic, as the engine's are (`monotonicFactory`): two ids
 * minted in the same millisecond keep the order they were made in, because the second one's random
 * tail is the first one's plus one. The mock engine leans on that — a reply's id sorts after the
 * message it answers (PG-1.6), as on the real engine.
 */
export function newId(now?: number): string {
  if (now !== undefined) return encodeTime(now) + encodeRandom();
  const time = Date.now();
  if (last !== undefined && time <= last.time) {
    const random = incrementRandom(last.random);
    if (random !== undefined) {
      last = { time: last.time, random };
      return encodeTime(last.time) + random;
    }
  }
  last = { time, random: encodeRandom() };
  return encodeTime(time) + last.random;
}
