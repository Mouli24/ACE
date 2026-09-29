import { base64ToBytes, bytesToBase64, sha256Hex } from './sha256';

const enc = new TextEncoder();

describe('sha256Hex (round 4 §2.1 content addressing)', () => {
  it('matches the FIPS-180-4 vectors', () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex(enc.encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex(enc.encode('The quick brown fox jumps over the lazy dog'))).toBe(
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
    );
  });

  it('hashes a multi-block message correctly', () => {
    const long = enc.encode('a'.repeat(1000));
    expect(sha256Hex(long)).toBe(
      '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3',
    );
  });

  it('is deterministic — the same bytes always hash the same (FR-MM-002)', () => {
    const bytes = enc.encode('same file');
    expect(sha256Hex(bytes)).toBe(sha256Hex(enc.encode('same file')));
  });
});

describe('base64 round-trip (persisting the blob store)', () => {
  it('survives a round trip for every remainder length', () => {
    for (const text of ['', 'a', 'ab', 'abc', 'abcd', 'hello world 12345']) {
      const bytes = enc.encode(text);
      expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes]);
    }
  });

  it('round-trips binary bytes, not just text', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 128, 64]);
    expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes]);
  });
});
