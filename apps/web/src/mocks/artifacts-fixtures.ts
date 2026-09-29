import { base64ToBytes } from './sha256';

/**
 * Tiny byte fixtures for the media-producing scenarios (round 4 §2.6 `mock-media`, §2.4). The mock
 * stores each of the seven Part types as an artifact so the typed renderers have real bytes to load
 * from `GET /artifacts/:id/content` — a valid 1×1 PNG so the image actually shows, and small, well
 * formed headers for the rest so the audio/video/download elements mount without a decode error
 * derailing the page. They are fixtures, not real media, and that is all the UI scenarios need.
 */

/** A 1×1 transparent PNG — the smallest thing an `<img>` will render. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** One silent MPEG-1 Layer III frame header followed by padding. */
const MP3_BASE64 = 'SUQzAwAAAAAAF1RTU0UAAAANAAAATGF2ZjU4Ljc2LjEwMAAAAAAA//tQAAAA';

/** A minimal `ftyp` box — enough for a `<video>` element to accept the source. */
const MP4_BASE64 = 'AAAAGGZ0eXBpc29tAAAAAGlzb21tcDQy';

/** The end-of-central-directory record of an empty ZIP (22 bytes). */
const ZIP_BASE64 = 'UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==';

export interface MediaFixture {
  bytes: Uint8Array;
  mime: string;
  name: string;
}

/** The four binary fixtures `mock-media` stores as artifacts, by Part type. */
export const MEDIA_FIXTURES: Record<'image' | 'audio' | 'video' | 'file', MediaFixture> = {
  image: { bytes: base64ToBytes(PNG_BASE64), mime: 'image/png', name: 'diagram.png' },
  audio: { bytes: base64ToBytes(MP3_BASE64), mime: 'audio/mpeg', name: 'narration.mp3' },
  video: { bytes: base64ToBytes(MP4_BASE64), mime: 'video/mp4', name: 'clip.mp4' },
  file: { bytes: base64ToBytes(ZIP_BASE64), mime: 'application/zip', name: 'bundle.zip' },
};
