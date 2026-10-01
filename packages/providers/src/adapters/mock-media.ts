/**
 * The bytes behind `mock-media`'s four media Parts (round 4 §2.6: "image (PNG fixture), audio (MP3
 * fixture), video (MP4 fixture), file (ZIP fixture) — fixtures stored as artifacts by the mock";
 * FR-MM-003, D213, D216, D-082).
 *
 * Each is a real, minimal file of its type, not a stand-in: the PNG decodes in a browser, the MP3
 * and the MP4 load and play to their end, and the ZIP opens to one file. They were checked in
 * Chromium (`<img>`, `<audio>`, `<video>`, `decodeAudioData`) and with Python's `zipfile`, and
 * `__tests__/mock-media.test.ts` walks each format's structure. They live here, in the package that
 * owns the mock, because product code never reads from `tests/**`.
 *
 * The mock hands the bytes to the engine *beside* each Part (`ProducedPart.bytes`) and the engine
 * stores them as artifacts; the Part itself stays a reference (FR-MM-004, BR-02, D204).
 */

/** The four media Part types, in the order `mock-media` emits them after text, json and code. */
export const MOCK_MEDIA_TYPES = ['image', 'audio', 'video', 'file'] as const;
export type MockMediaType = (typeof MOCK_MEDIA_TYPES)[number];

export interface MockMediaFixture {
  mime: string;
  name: string;
  bytes: Uint8Array;
}

const fromBase64 = (lines: readonly string[]): Uint8Array =>
  new Uint8Array(Buffer.from(lines.join(''), 'base64'));

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

/**
 * image — a 16×16 PNG, 8-bit RGB, in four 8×8 squares of indigo (#4F46E5) and white: `IHDR`, one
 * zlib-deflated `IDAT` and `IEND`, each with its CRC-32. 88 bytes.
 */
const PNG = [
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAH0lEQVR42mPwd3uKFf3HARhGNdBEAy4JXAaNaqCJ',
  'BgAHVTuf33PVDwAAAABJRU5ErkJggg==',
];

/**
 * video — an MP4 holding one second of 64×64 H.264 video (Constrained Baseline, level 1.0 —
 * `avc1.42E00A`, the profile every browser decodes): a single IDR frame, an indigo field with a
 * white square, shown for 1 s. `ftyp` (isom; isom iso2 avc1 mp41), then `moov` — `mvhd`, one `trak`
 * (`tkhd`, `mdia` → `mdhd` at 1000/s, `hdlr` vide, `minf` → `vmhd`, `dinf`, `stbl` with an `avc1`
 * sample entry and its `avcC`, `stts`, `stsc`, `stsz`, `stco`) — ahead of `mdat` so it plays as it
 * loads. The frame was encoded by Chromium's WebCodecs `VideoEncoder`; the boxes were written by
 * hand. 704 bytes.
 */
const MP4 = [
  'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAJibW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAA',
  'A+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAgAAAe50cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAA',
  'AAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAEAAAABAAAAAAAGKbWRpYQAAACBtZGhk',
  'AAAAAAAAAAAAAAAAAAAD6AAAA+hVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRs',
  'ZXIAAAABNW1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAA',
  'AQAAAPVzdGJsAAAAjXN0c2QAAAAAAAAAAQAAAH1hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAEAAQABIAAAA',
  'SAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAJ2F2Y0MBQsAK/+EAEGdCwAqM',
  'aEJJuAhoCDwiEagBAARozjyAAAAAGHN0dHMAAAAAAAAAAQAAAAEAAAPoAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAAB',
  'AAAAAQAAABhzdHN6AAAAAAAAAAAAAAABAAAANgAAABRzdGNvAAAAAAAAAAEAAAKKAAAAPm1kYXQAAAAyZbgABAn/',
  '//giigACAX44AAg9Rxk5OTr4h//giigACER44AAg9xzai6eunF109dra14A=',
];

/**
 * file — a ZIP holding one stored (uncompressed) file, `readme.txt` ("Produced by the ACE mock-media
 * model."): its local header and data, one central-directory entry, and the end-of-central-directory
 * record pointing at it. 156 bytes.
 */
const ZIP = [
  'UEsDBAoAAAAAAABgPl0BHPTXJgAAACYAAAAKAAAAcmVhZG1lLnR4dFByb2R1Y2VkIGJ5IHRoZSBBQ0UgbW9jay1t',
  'ZWRpYSBtb2RlbC4KUEsBAhQACgAAAAAAAGA+XQEc9NcmAAAAJgAAAAoAAAAAAAAAAAAAAAAAAAAAAHJlYWRtZS50',
  'eHRQSwUGAAAAAAEAAQA4AAAATgAAAAAA',
];

/**
 * audio — an MP3: an ID3v2.3 tag holding one `TIT2` (title) frame, then twelve silent MPEG-1 Layer
 * III frames — 32 kbit/s, 44.1 kHz, mono, no CRC, header `FF FB 10 C0`. Each frame is
 * ⌊144 × 32000 / 44100⌋ = 104 bytes: the header, 17 bytes of all-zero side information (no main
 * data, so silence) and zero-filled ancillary data. Twelve frames (0.31 s) rather than one, so a
 * demuxer probing the file finds a run of consecutive frames. Built rather than spelled out in
 * base64, because it is 1,283 bytes that are nearly all zero.
 */
function mp3(): Uint8Array {
  const FRAMES = 12;
  const FRAME_BYTES = 104;
  const title = [0x00, ...ascii('ACE mock audio')]; // text encoding ISO-8859-1, then the text
  const tit2 = [...ascii('TIT2'), 0, 0, 0, title.length, 0, 0, ...title];
  // ID3 v2.3.0, no flags, then the tag size as a syncsafe integer (under 128, so one byte).
  const tag = [...ascii('ID3'), 3, 0, 0, 0, 0, 0, tit2.length, ...tit2];

  const bytes = new Uint8Array(tag.length + FRAMES * FRAME_BYTES);
  bytes.set(tag);
  for (let frame = 0; frame < FRAMES; frame += 1) {
    bytes.set([0xff, 0xfb, 0x10, 0xc0], tag.length + frame * FRAME_BYTES);
  }
  return bytes;
}

const FIXTURES: Readonly<Record<MockMediaType, MockMediaFixture>> = {
  image: { mime: 'image/png', name: 'mock.png', bytes: fromBase64(PNG) },
  audio: { mime: 'audio/mpeg', name: 'mock.mp3', bytes: mp3() },
  video: { mime: 'video/mp4', name: 'mock.mp4', bytes: fromBase64(MP4) },
  file: { mime: 'application/zip', name: 'mock.zip', bytes: fromBase64(ZIP) },
};

/**
 * The fixture for one media Part type — a fresh copy of its bytes each call, so whoever stores or
 * inspects them cannot change what the next run is handed.
 */
export function mockMediaFixture(type: MockMediaType): MockMediaFixture {
  const { mime, name, bytes } = FIXTURES[type];
  return { mime, name, bytes: bytes.slice() };
}
