import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

/**
 * Writes the tiny sample media files the round 4 acceptance suite uploads (round 4 §4 item 6). Run
 * from the repo root:
 *
 *   node tests/acceptance/fixtures/round-4/media/generate.mjs
 *
 * The outputs are committed (they are tiny — a few hundred bytes each) so a test needs no build step
 * to read them. Each is a real file of its type with the correct magic bytes, so the artifact
 * store's MIME/extension allow-list (NFR-SEC-05) accepts it and a download round-trips byte-for-byte
 * (FR-MM-009, TC-MM-008). They are minimal, not rich: enough to upload, hash and download, and to
 * cover one of each of the seven data types (FR-MM-003). The oversized 413 fixture is NOT here — it
 * is 150 MB and generated at test time by `oversized.mjs`.
 */

const OUT = fileURLToPath(new URL('.', import.meta.url));
mkdirSync(OUT, { recursive: true });

const write = (file, bytes) => {
  writeFileSync(`${OUT}${file}`, bytes);
  console.log('wrote', file, `(${bytes.length} bytes)`);
};

/* CRC-32 (IEEE), for the PNG chunk trailers. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** image — a 1x1 transparent PNG, built from real chunks so the CRCs and the IDAT stream are valid. */
const png = () => {
  const chunk = (type, body) => {
    const typeAndBody = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndBody), 0);
    return Buffer.concat([len, typeAndBody, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // width
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  // bytes 10..12 (compression, filter, interlace) stay 0
  const raw = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]); // filter byte + one transparent RGBA pixel
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), // PNG signature
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

/* audio — an ID3v2 tag then one silent MPEG-1 Layer III frame (FF FB 90 00, 128 kbps / 44.1 kHz). */
const mp3 = () => {
  const id3 = Buffer.from('4944330300000000000a', 'hex'); // ID3v2.3, 10-byte header, size 10
  const id3Pad = Buffer.alloc(10, 0);
  const frameHeader = Buffer.from('fffb9000', 'hex');
  const frameBody = Buffer.alloc(417 - 4, 0); // 144 * 128000 / 44100 = 417-byte frame, padding 0
  return Buffer.concat([id3, id3Pad, frameHeader, frameBody]);
};

/* video — a minimal MP4: an `ftyp` box (isom/iso2) followed by an empty `free` box. */
const mp4 = () => {
  const box = (type, body) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + body.length, 0);
    header.write(type, 4, 'ascii');
    return Buffer.concat([header, body]);
  };
  const ftypBody = Buffer.concat([
    Buffer.from('isom', 'ascii'),
    Buffer.from([0x00, 0x00, 0x02, 0x00]), // minor version 0x200
    Buffer.from('isom', 'ascii'),
    Buffer.from('iso2', 'ascii'),
    Buffer.from('mp41', 'ascii'),
  ]);
  return Buffer.concat([box('ftyp', ftypBody), box('free', Buffer.alloc(16, 0))]);
};

/* file — a valid empty ZIP (End Of Central Directory record only, 22 bytes). */
const ZIP = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');

write('sample.png', png());
write('sample.mp3', mp3());
write('sample.mp4', mp4());
write('sample.zip', ZIP);

/* The three text-family types, so every one of the seven data types has an upload (FR-MM-003). */
write('sample.txt', Buffer.from('A tiny text sample for the round 4 upload tests.\n', 'utf8'));
write('sample.json', Buffer.from(`${JSON.stringify({ kind: 'sample', ok: true }, null, 2)}\n`, 'utf8'));
write(
  'sample.code.js',
  Buffer.from('// a tiny code sample for the round 4 upload tests\nexport const answer = 42;\n', 'utf8'),
);
