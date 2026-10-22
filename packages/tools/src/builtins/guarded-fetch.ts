import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

import { hostIsAllowed } from '@ace/contracts';

import { ToolError } from '../errors.js';
import { type ToolContext } from '../tool.js';

/**
 * The one way `http_request` and `web_fetch` reach the network [audit S-2] (FR-GRD-007, NFR-SEC-04).
 *
 * The tool point checks the URL a call names against the agent's `allowedDomains` — and nothing
 * after it. With `redirect: 'follow'`, an allow-listed host could answer `302 Location:
 * http://127.0.0.1:4747/...` or `http://169.254.169.254/` and the tool went wherever it was sent. So
 * redirects are followed here, by hand, at most {@link MAX_REDIRECTS} of them, and every hop is
 * judged again:
 *
 * - **the allow-list** — a hop lands on the host the call was let through for, or on a host the
 *   contract's `hostIsAllowed` (the guardrail's own matcher) accepts. Anything else is not followed:
 *   the model is told where it was sent, and asking for that URL itself goes through the tool point.
 * - **private addresses** — every hop's host is resolved, and loopback, private, carrier-grade NAT,
 *   link-local and unique-local addresses are refused, unless the allow-list entry that admits the
 *   host is itself an IP or `localhost`: reaching a local service takes naming it, never a DNS name
 *   or a redirect that happens to point there.
 *
 * Credentials (`Authorization`, `Cookie`) never follow a redirect to another origin, and a 303 — or a
 * POST answered 301/302 — continues as a body-less GET, as `fetch` itself does.
 *
 * Residual: the name is resolved here and again by `fetch`, so a DNS answer that changes between the
 * two (rebinding) is not caught; a connect-time check needs a dispatcher this package does not ship.
 */

/** The most redirects one call follows (`fetch`'s own limit is 20). */
export const MAX_REDIRECTS = 5;

/** What every refusal here logs, so one grep finds them (the network sibling of `project path refused`). */
export const NETWORK_REFUSED_MESSAGE = 'network target refused';

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Headers that carry a credential, dropped when a redirect leaves the origin they were sent to. */
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'] as const;

/** Addresses no allow-listed *name* may reach. IPv4-mapped IPv6 forms are judged by the IPv4 rules. */
const PRIVATE_RANGES = ((): BlockList => {
  const list = new BlockList();
  // "This network" (0.0.0.0 reaches the local host), RFC 1918, carrier-grade NAT, loopback, and
  // link-local — where cloud metadata services live.
  list.addSubnet('0.0.0.0', 8, 'ipv4');
  list.addSubnet('10.0.0.0', 8, 'ipv4');
  list.addSubnet('100.64.0.0', 10, 'ipv4');
  list.addSubnet('127.0.0.0', 8, 'ipv4');
  list.addSubnet('169.254.0.0', 16, 'ipv4');
  list.addSubnet('172.16.0.0', 12, 'ipv4');
  list.addSubnet('192.168.0.0', 16, 'ipv4');
  // Unspecified, loopback, unique-local, link-local and the retired site-local.
  list.addAddress('::', 'ipv6');
  list.addAddress('::1', 'ipv6');
  list.addSubnet('fc00::', 7, 'ipv6');
  list.addSubnet('fe80::', 10, 'ipv6');
  list.addSubnet('fec0::', 10, 'ipv6');
  return list;
})();

/** Whether `address` (an IP literal) is loopback, private, link-local or unique-local. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return PRIVATE_RANGES.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/** A URL hostname without the brackets an IPv6 literal carries in a URL. */
function bare(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** An allow-list entry that names a local target outright: an IP literal, or `localhost`. */
function isLocalEntry(entry: string): boolean {
  const domain = bare(entry.trim().toLowerCase());
  return domain === 'localhost' || isIP(domain) !== 0;
}

/** `promise`, or the signal's reason the moment it aborts — `dns.lookup` takes no signal itself. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error as Error);
      },
    );
  });
}

function refuse(
  tool: string,
  context: ToolContext,
  host: string,
  reason: string,
  message: string,
): never {
  // The host and the reason, never the path or query the model asked for (FR-GRD-014).
  context.logger.warn({ tool, host, reason, runId: context.runId }, NETWORK_REFUSED_MESSAGE);
  throw new ToolError('denied', tool, message, { host, reason });
}

/** Refuses a hop whose host resolves to a private address, unless a local entry admits the host. */
async function assertPublicTarget(
  tool: string,
  url: URL,
  context: ToolContext,
  signal: AbortSignal | undefined,
): Promise<void> {
  const host = url.hostname.toLowerCase();
  const allowed = context.allowedDomains ?? [];
  if (allowed.some((entry) => isLocalEntry(entry) && hostIsAllowed(host, [entry]))) return;

  let addresses: string[];
  if (isIP(bare(host)) !== 0) {
    addresses = [bare(host)];
  } else {
    try {
      const found = await untilAborted(lookup(bare(host), { all: true, verbatim: true }), signal);
      addresses = found.map((entry) => entry.address);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ToolError(
        'failed',
        tool,
        `${tool} could not resolve ${host}: ${(error as Error).message}`,
        {
          host,
        },
      );
    }
  }

  if (addresses.some(isPrivateAddress)) {
    refuse(
      tool,
      context,
      host,
      'private_address',
      `${tool} may not reach ${host}: it is a loopback or private-network address. Add the address itself (or localhost) to the agent's allowed domains to reach a local service.`,
    );
  }
}

export interface GuardedFetchInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

/**
 * `fetch(url)`, with every redirect followed by hand and every hop judged against the allow-list and
 * the private ranges. Throws a `denied` ToolError for a refused hop and a `failed` one for a redirect
 * chain past {@link MAX_REDIRECTS}; `fetch`'s own errors (a refused connection, the timeout) pass
 * through untouched for the tool to word.
 */
export async function guardedFetch(
  tool: string,
  url: string,
  init: GuardedFetchInit,
  context: ToolContext,
): Promise<Response> {
  const allowed = context.allowedDomains ?? [];
  const firstHost = new URL(url).hostname.toLowerCase();
  const headers = new Headers(init.headers);
  let current = new URL(url);
  let method = init.method ?? 'GET';
  let body = init.body;

  for (let redirects = 0; ; redirects += 1) {
    await assertPublicTarget(tool, current, context, init.signal);
    const response = await fetch(current, {
      method,
      headers,
      body,
      redirect: 'manual',
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    });

    const location = REDIRECT_STATUSES.has(response.status)
      ? response.headers.get('location')
      : null;
    if (location === null) return response;
    await response.body?.cancel().catch(() => undefined);

    if (redirects >= MAX_REDIRECTS) {
      throw new ToolError('failed', tool, `${tool} gave up after ${MAX_REDIRECTS} redirects.`, {
        redirects: MAX_REDIRECTS,
      });
    }

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new ToolError(
        'failed',
        tool,
        `${tool} was redirected to a location that is not a URL.`,
        {},
      );
    }
    const host = next.hostname.toLowerCase();
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      refuse(
        tool,
        context,
        host,
        'redirect_scheme',
        `${tool} will not follow a redirect to ${next.protocol}.`,
      );
    }
    if (host !== firstHost && !hostIsAllowed(host, allowed)) {
      refuse(
        tool,
        context,
        host,
        'redirect_off_allowlist',
        `${tool} was redirected to ${next.href}, whose host ${host} is not on the allow-list; it was not followed. Call ${tool} with that URL to have it checked.`,
      );
    }

    if (
      (response.status === 303 && method !== 'HEAD') ||
      ((response.status === 301 || response.status === 302) && method === 'POST')
    ) {
      method = 'GET';
      body = undefined;
      headers.delete('content-type');
      headers.delete('content-length');
    }
    if (next.origin !== current.origin) {
      for (const name of CREDENTIAL_HEADERS) headers.delete(name);
    }
    current = next;
  }
}

/** Reads at most `maxBytes` of a response body as text, then stops pulling from the stream. */
export async function readCappedText(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    read += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (read >= maxBytes) {
      await reader.cancel();
      break;
    }
  }
  text += decoder.decode();
  return text.length > maxBytes ? text.slice(0, maxBytes) : text;
}
