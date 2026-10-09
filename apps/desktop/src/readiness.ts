/**
 * Readiness polling for the dev window (D295): Electron-free, so it is tested with a fake `fetch`.
 */

/** `API_BASE_PATH` + `/health` (`@ace/contracts`); every route, health included, needs the token. */
export const HEALTH_PATH = '/api/v1/health';
const PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_INTERVAL_MS = 1_000;

/** The slice of `fetch` the probes use. */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ status: number }>;

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Resolve after `ms`, or reject at once with the signal's reason when it aborts. */
export const sleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** A 200 from `/api/v1/health` with this token: this token's engine is up. */
export async function engineAccepts(
  engineUrl: string,
  token: string,
  fetchImpl: FetchLike,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`${engineUrl}${HEALTH_PATH}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** Vite answers its index: the web app can be loaded. */
export async function webAnswers(webUrl: string, fetchImpl: FetchLike): Promise<boolean> {
  try {
    const res = await fetchImpl(webUrl, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** What the dev window is still waiting for, in the order it is checked. */
export type DevWaitState = 'token' | 'engine' | 'web';

export interface WaitForDevOptions {
  /** Read `<dataDir>/session-token` afresh — a stale file is replaced when the engine starts. */
  readToken: () => string | undefined;
  engineUrl: string;
  webUrl: string;
  fetch: FetchLike;
  intervalMs?: number;
  signal?: AbortSignal;
  /** Told each time a round of checks stops short, with what it stopped on. */
  onWaiting?: (state: DevWaitState) => void;
  sleep?: Sleep;
}

/**
 * Wait until the token file exists, the engine accepts that token, and Vite answers — then answer
 * the token. It never gives up (the window says what it waits for and keeps waiting; the launcher or
 * `pnpm dev` may come later), and stops only when `signal` aborts.
 */
export async function waitForDev(options: WaitForDevOptions): Promise<string> {
  const pause = options.sleep ?? sleep;
  const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS;

  for (;;) {
    options.signal?.throwIfAborted();
    const token = options.readToken();
    let waitingOn: DevWaitState | undefined;
    if (token === undefined) waitingOn = 'token';
    else if (!(await engineAccepts(options.engineUrl, token, options.fetch))) waitingOn = 'engine';
    else if (!(await webAnswers(options.webUrl, options.fetch))) waitingOn = 'web';

    if (waitingOn === undefined && token !== undefined) return token;
    if (waitingOn !== undefined) options.onWaiting?.(waitingOn);
    await pause(interval, options.signal);
  }
}

export interface WaitForEngineOptions {
  engineUrl: string;
  token: string;
  fetch: FetchLike;
  intervalMs?: number;
  signal?: AbortSignal;
  sleep?: Sleep;
}

/** Wait until the engine accepts `token` — after a restart wrote a new one. Stops only on abort. */
export async function waitForEngine(options: WaitForEngineOptions): Promise<void> {
  const pause = options.sleep ?? sleep;
  for (;;) {
    options.signal?.throwIfAborted();
    if (await engineAccepts(options.engineUrl, options.token, options.fetch)) return;
    await pause(options.intervalMs ?? DEFAULT_INTERVAL_MS, options.signal);
  }
}
