import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { HttpError } from './errors.js';

/**
 * How large a request body may be [audit S-9].
 *
 * Every body was read whole before anything looked at its size — `c.req.text()` for JSON,
 * `parseBody()` for an upload or a backup — so one request could make the engine hold gigabytes.
 * `hono/body-limit` refuses at the `Content-Length`, or counts a chunked body as it arrives and stops
 * at the limit, before any route reads it. A refusal is the §2.3 envelope's 413 `upload_too_large`
 * with the limit in `details.maxBytes`, as an oversized artifact always was (FR-MM-001).
 */

/** A JSON body: Forge's largest save is 2 MB (`FILE_EDIT_MAX_BYTES`), so this leaves ample room. */
export const JSON_BODY_MAX_BYTES = 10 * 1024 * 1024;

/** A backup zip on `POST /backup/import`. Its unpacked size has a cap of its own in the store. */
export const BACKUP_IMPORT_MAX_BYTES = 1024 * 1024 * 1024;

/** The multipart framing around an uploaded file — boundaries, part headers, a long file name. */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export const bodyTooLarge = (maxBytes: number): HttpError =>
  new HttpError(
    'invalid_config',
    'upload_too_large',
    `The request body is larger than the ${maxBytes}-byte limit.`,
    { maxBytes },
  );

/**
 * `hono/body-limit` with the limit read per request (a setting can change between two uploads).
 * `slack` is allowed on top of `maxBytes` and kept out of the refusal: a multipart body is the file
 * plus its framing, and the limit a person set is on the file.
 */
export function limitBody(
  maxBytes: (c: Context) => number | Promise<number>,
  slack = 0,
): MiddlewareHandler {
  return async (c, next) => {
    const max = await maxBytes(c);
    return bodyLimit({
      maxSize: max + slack,
      onError: () => {
        throw bodyTooLarge(max);
      },
    })(c, next);
  };
}
