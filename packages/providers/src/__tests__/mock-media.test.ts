import { crc32, inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { MOCK_MEDIA_TYPES, mockMediaFixture } from '../adapters/mock-media.js';

/**
 * D-082: the bytes behind `mock-media`'s image/audio/video/file Parts (round 4 §2.6 — "image (PNG
 * fixture), audio (MP3 fixture), video (MP4 fixture), file (ZIP fixture)"). Each must be a real file
 * of its type, not a zero-filled stand-in: these tests walk each format's own structure, so a file
 * that only carried the right magic bytes would still fail.
 */

const ascii = (bytes: Uint8Array, from: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(from, from + length));

const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

describe('FR-MM-003 D-082 mock-media fixtures are real files of their type', () => {
  it('names one fixture per media Part type, with the MIME and extension of its format', () => {
    expect([...MOCK_MEDIA_TYPES]).toEqual(['image', 'audio', 'video', 'file']);
    expect(MOCK_MEDIA_TYPES.map((type) => mockMediaFixture(type).mime)).toEqual([
      'image/png',
      'audio/mpeg',
      'video/mp4',
      'application/zip',
    ]);
    expect(MOCK_MEDIA_TYPES.map((type) => mockMediaFixture(type).name)).toEqual([
      'mock.png',
      'mock.mp3',
      'mock.mp4',
      'mock.zip',
    ]);
  });

  it('is small, and never a run of zero bytes', () => {
    for (const type of MOCK_MEDIA_TYPES) {
      const { bytes } = mockMediaFixture(type);
      expect(bytes.byteLength, type).toBeGreaterThan(0);
      expect(bytes.byteLength, type).toBeLessThan(4096);
      expect(
        bytes.some((byte) => byte !== 0),
        type,
      ).toBe(true);
    }
  });

  it('hands out a fresh copy each time, so nobody can corrupt the next run’s bytes', () => {
    const first = mockMediaFixture('image').bytes;
    first.fill(0);
    expect(mockMediaFixture('image').bytes.some((byte) => byte !== 0)).toBe(true);
  });

  it('image: a PNG (89 50 4E 47) whose chunks carry valid CRCs and whose IDAT inflates to its pixels', () => {
    const png = mockMediaFixture('image').bytes;
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const chunks: { type: string; body: Uint8Array }[] = [];
    let at = 8;
    while (at < png.byteLength) {
      const length = view(png).getUint32(at);
      const type = ascii(png, at + 4, 4);
      const body = png.subarray(at + 8, at + 8 + length);
      const crc = view(png).getUint32(at + 8 + length);
      expect(crc, `${type} CRC`).toBe(crc32(png.subarray(at + 4, at + 8 + length)));
      chunks.push({ type, body });
      at += 12 + length;
    }
    expect(at).toBe(png.byteLength);
    expect(chunks.map((chunk) => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND']);

    const ihdr = view(chunks[0]!.body);
    const width = ihdr.getUint32(0);
    const height = ihdr.getUint32(4);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    expect(ihdr.getUint8(8)).toBe(8); // bit depth
    expect(ihdr.getUint8(9)).toBe(2); // truecolour RGB
    // One filter byte per row, then three bytes per pixel.
    expect(inflateSync(chunks[1]!.body).byteLength).toBe(height * (1 + width * 3));
  });

  it('audio: an MP3 — an ID3v2 tag, then MPEG-1 Layer III frames (FF FB sync) that tile the rest of the file', () => {
    const mp3 = mockMediaFixture('audio').bytes;
    expect(ascii(mp3, 0, 3)).toBe('ID3');
    // The ID3v2 size is syncsafe: 7 bits per byte.
    const tagSize = mp3.subarray(6, 10).reduce((size, byte) => (size << 7) | (byte & 0x7f), 0);
    expect(ascii(mp3, 10, 4)).toBe('TIT2');

    const BITRATES_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
    const SAMPLE_RATES = [44_100, 48_000, 32_000];
    let at = 10 + tagSize;
    let frames = 0;
    while (at < mp3.byteLength) {
      expect(mp3[at], `frame ${frames} sync`).toBe(0xff);
      expect(mp3[at + 1]! & 0xfe, `frame ${frames} MPEG-1 Layer III`).toBe(0xfa);
      const bitrate = BITRATES_KBPS[mp3[at + 2]! >> 4]! * 1000;
      const sampleRate = SAMPLE_RATES[(mp3[at + 2]! >> 2) & 0x03]!;
      const padding = (mp3[at + 2]! >> 1) & 0x01;
      expect(bitrate, `frame ${frames} bitrate`).toBeGreaterThan(0);
      at += Math.floor((144 * bitrate) / sampleRate) + padding;
      frames += 1;
    }
    expect(at).toBe(mp3.byteLength);
    // Enough consecutive frames for a demuxer to be sure it is looking at MPEG audio.
    expect(frames).toBeGreaterThanOrEqual(7);
  });

  it('video: an MP4 — ftyp, moov and mdat boxes that tile the file, one H.264 track whose sample is the mdat payload', () => {
    const mp4 = mockMediaFixture('video').bytes;
    expect(ascii(mp4, 4, 4)).toBe('ftyp');

    const boxes: { type: string; start: number; size: number }[] = [];
    let at = 0;
    while (at < mp4.byteLength) {
      const size = view(mp4).getUint32(at);
      boxes.push({ type: ascii(mp4, at + 4, 4), start: at, size });
      at += size;
    }
    expect(at).toBe(mp4.byteLength);
    expect(boxes.map((box) => box.type)).toEqual(['ftyp', 'moov', 'mdat']);

    const text = ascii(mp4, 0, mp4.byteLength);
    for (const inner of [
      'mvhd',
      'trak',
      'tkhd',
      'mdhd',
      'hdlr',
      'vide',
      'stsd',
      'avc1',
      'avcC',
      'stco',
    ]) {
      expect(text, inner).toContain(inner);
    }
    // The one chunk offset points at the mdat payload, and the one sample fills it.
    const stco = text.indexOf('stco');
    const chunkOffset = view(mp4).getUint32(stco + 12);
    const stsz = text.indexOf('stsz');
    const sampleSize = view(mp4).getUint32(stsz + 16);
    const mdat = boxes[2]!;
    expect(chunkOffset).toBe(mdat.start + 8);
    expect(sampleSize).toBe(mdat.size - 8);
  });

  it('file: a ZIP (50 4B) — one stored entry whose CRC matches, and a central directory the end record points at', () => {
    const zip = mockMediaFixture('file').bytes;
    const le = view(zip);
    expect([...zip.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);

    const eocd = zip.byteLength - 22;
    expect(le.getUint32(eocd, true)).toBe(0x06054b50);
    const entries = le.getUint16(eocd + 10, true);
    const centralSize = le.getUint32(eocd + 12, true);
    const centralOffset = le.getUint32(eocd + 16, true);
    expect(entries).toBe(1);
    expect(centralOffset + centralSize).toBe(eocd);
    expect(le.getUint32(centralOffset, true)).toBe(0x02014b50);

    const method = le.getUint16(8, true);
    const crc = le.getUint32(14, true);
    const size = le.getUint32(18, true);
    const nameLength = le.getUint16(26, true);
    const extraLength = le.getUint16(28, true);
    const data = zip.subarray(30 + nameLength + extraLength, 30 + nameLength + extraLength + size);
    expect(method).toBe(0); // stored
    expect(ascii(zip, 30, nameLength)).toBe('readme.txt');
    expect(crc32(data)).toBe(crc);
    expect(new TextDecoder().decode(data)).toContain('mock-media');
  });
});
