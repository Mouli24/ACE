import { z } from 'zod';

import { type ToolDefinition } from '@ace/contracts';

import { ToolError, isToolError } from '../errors.js';
import { type RegisteredTool } from '../registry.js';
import { type ToolContext } from '../tool.js';
import { guardedFetch, readCappedText } from './guarded-fetch.js';

/**
 * `http_request { method, url, headers?, body? } → { status, headers, body }` (§2.2, FR-TOOL-006).
 *
 * The tool does the call; it does **not** decide whether the host it is asked for is allowed — that
 * is the tool guardrail point's `domain_allowlist` (§2.2), which runs in the executor against
 * `AgentConfig.tools.allowedDomains` before this ever runs. What happens *after* that check is the
 * tool's: every redirect is re-checked against the same list and no hop may reach a private address
 * (`guardedFetch`, [audit S-2]). The other limits protect the engine regardless of policy: a scheme
 * that must be http/https (no `file:`), a fetch timeout, and a 1 MB cap on the body it reads back (a
 * reply larger than that is truncated, not loaded whole).
 */

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/** The response body cap (§2.2: `body ≤ 1 MB text`). */
export const HTTP_BODY_CAP_BYTES = 1024 * 1024;

const HttpArgs = z.strictObject({
  method: z.enum(HTTP_METHODS),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
});

export const HTTP_REQUEST_DEFINITION: ToolDefinition = {
  name: 'http_request',
  description: 'Makes an HTTP request to an allow-listed domain and returns the status and body.',
  inputSchema: {
    type: 'object',
    properties: {
      method: { type: 'string', enum: [...HTTP_METHODS] },
      url: { type: 'string' },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      body: { type: 'string' },
    },
    required: ['method', 'url'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      status: { type: 'number' },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      body: { type: 'string' },
    },
    required: ['status', 'headers', 'body'],
  },
  permissions: { network: true, fsPaths: [], destructive: false },
  timeoutMs: 30_000,
  source: 'builtin',
};

function timeoutSignal(context: ToolContext, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
}

export function createHttpRequestTool(options: { timeoutMs?: number } = {}): RegisteredTool {
  const timeoutMs = options.timeoutMs ?? HTTP_REQUEST_DEFINITION.timeoutMs;

  return {
    definition: HTTP_REQUEST_DEFINITION,
    implementation: async (args, context) => {
      const parsed = HttpArgs.safeParse(args);
      if (!parsed.success) {
        throw new ToolError('invalid_args', 'http_request', 'http_request needs { method, url }.', {
          issues: parsed.error.issues.map((issue) => issue.message),
        });
      }

      const { method, url, headers, body } = parsed.data;
      const scheme = new URL(url).protocol;
      if (scheme !== 'http:' && scheme !== 'https:') {
        throw new ToolError('invalid_args', 'http_request', `http_request only speaks http(s), not ${scheme}`, {
          scheme,
        });
      }

      let response: Response;
      try {
        response = await guardedFetch(
          'http_request',
          url,
          {
            method,
            ...(headers === undefined ? {} : { headers }),
            ...(method === 'GET' || method === 'HEAD' || body === undefined ? {} : { body }),
            signal: timeoutSignal(context, timeoutMs),
          },
          context,
        );
      } catch (error) {
        if (isToolError(error)) throw error;
        const aborted = (error as { name?: string }).name === 'TimeoutError';
        throw new ToolError(
          aborted ? 'timeout' : 'failed',
          'http_request',
          `http_request to ${url} failed: ${(error as Error).message}`,
          { url },
        );
      }

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      return {
        status: response.status,
        headers: responseHeaders,
        body: await readCappedText(response, HTTP_BODY_CAP_BYTES),
      };
    },
  };
}
