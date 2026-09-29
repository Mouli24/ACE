import type { Context } from 'hono';

import { validationFailed } from './errors.js';

/**
 * Read a request body as JSON, for every route that takes one (FR-SYS-006, §2.3).
 *
 * An empty body reads as `{}`: starting a run or re-running a node needs none. A body that is not
 * JSON is the §2.3 `validation_failed` refusal, never an empty object — every field of a PATCH is
 * optional, so a truncated `{"maxCostPerRunUsd": 0.01` read as `{}` would answer 200 and change
 * nothing, and the client would believe the cap was set.
 *
 * One copy, shared by the gateway and the routers it mounts, so they cannot disagree about it.
 */
export async function readJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === '') return {};

  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Not the parser's message: it quotes the body back. The refusal says what is wrong instead.
    throw validationFailed('The request body is not valid JSON.', []);
  }
}
