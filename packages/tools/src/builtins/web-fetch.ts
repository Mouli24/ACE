import { z } from 'zod';

import { type ToolDefinition } from '@ace/contracts';

import { ToolError, isToolError } from '../errors.js';
import { type RegisteredTool } from '../registry.js';
import { type ToolContext } from '../tool.js';
import { guardedFetch, readCappedText } from './guarded-fetch.js';

/**
 * `web_fetch { url } → { title, text }` (§2.2, FR-TOOL-005). Fetches a page and returns its readable
 * text, capped at {@link WEB_FETCH_TEXT_CAP} characters. `mock-search` calls it on the first search
 * result (§2.6).
 *
 * The extraction is deliberately dependency-free readability, not a full DOM parse: drop `<script>`,
 * `<style>`, `<head>` and comments, take `<title>`, strip the remaining tags, decode the handful of
 * entities that matter and collapse whitespace. It is enough to hand a model the words on a page,
 * which is what the tool is for; a heavier parser (unpdf/mammoth/readability proper) arrives with
 * document ingestion in Round 5 (§9).
 *
 * Redirects are followed by `guardedFetch`, each hop re-checked against the agent's allow-list and
 * kept off private addresses, and the body is read to {@link WEB_FETCH_BODY_CAP_BYTES} at most
 * [audit S-2].
 */

export const WEB_FETCH_TEXT_CAP = 100_000;

/**
 * The most of a page's raw body read before extraction (5 MB) [audit S-2]: room for a heavy page's
 * markup around its text, never a whole multi-gigabyte response held in memory.
 */
export const WEB_FETCH_BODY_CAP_BYTES = 5 * 1024 * 1024;

const FetchArgs = z.strictObject({ url: z.string().url() });

export const WEB_FETCH_DEFINITION: ToolDefinition = {
  name: 'web_fetch',
  description: 'Fetches a web page and returns its title and readable text.',
  inputSchema: {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { title: { type: 'string' }, text: { type: 'string' } },
    required: ['title', 'text'],
  },
  permissions: { network: true, fsPaths: [], destructive: false },
  timeoutMs: 30_000,
  source: 'builtin',
};

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

/** Extracts the title and readable text from an HTML string. Exported so a test can pin it directly. */
export function extractReadable(html: string): { title: string; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(stripTags(titleMatch[1] ?? '')).trim() : '';

  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ');

  const text = decodeEntities(stripTags(body)).replace(/\s+/g, ' ').trim();
  return { title, text };
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ');
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&[a-z]+;|&#39;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? entity);
}

function timeoutSignal(context: ToolContext, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
}

export function createWebFetchTool(options: { timeoutMs?: number } = {}): RegisteredTool {
  const timeoutMs = options.timeoutMs ?? WEB_FETCH_DEFINITION.timeoutMs;

  return {
    definition: WEB_FETCH_DEFINITION,
    implementation: async (args, context) => {
      const parsed = FetchArgs.safeParse(args);
      if (!parsed.success) {
        throw new ToolError('invalid_args', 'web_fetch', 'web_fetch needs { url: string }.', {
          issues: parsed.error.issues.map((issue) => issue.message),
        });
      }

      const scheme = new URL(parsed.data.url).protocol;
      if (scheme !== 'http:' && scheme !== 'https:') {
        throw new ToolError('invalid_args', 'web_fetch', `web_fetch only speaks http(s), not ${scheme}`, {
          scheme,
        });
      }

      let response: Response;
      try {
        response = await guardedFetch(
          'web_fetch',
          parsed.data.url,
          { headers: { Accept: 'text/html,text/plain' }, signal: timeoutSignal(context, timeoutMs) },
          context,
        );
      } catch (error) {
        if (isToolError(error)) throw error;
        const aborted = (error as { name?: string }).name === 'TimeoutError';
        throw new ToolError(
          aborted ? 'timeout' : 'failed',
          'web_fetch',
          `web_fetch of ${parsed.data.url} failed: ${(error as Error).message}`,
          { url: parsed.data.url },
        );
      }

      const raw = await readCappedText(response, WEB_FETCH_BODY_CAP_BYTES);
      const { title, text } = extractReadable(raw);
      return { title, text: text.slice(0, WEB_FETCH_TEXT_CAP) };
    },
  };
}
