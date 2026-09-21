import { DEFAULT_ENGINE_ORIGIN, WS_PATH } from '@ace/contracts';

export interface WebEnv {
  VITE_ACE_URL?: string;
  VITE_ACE_MOCK?: string;
}

const current = (): WebEnv => import.meta.env as unknown as WebEnv;

/** Engine origin: `VITE_ACE_URL` at build time (D27), else the contract default. */
export function engineOrigin(env: WebEnv = current()): string {
  return (env.VITE_ACE_URL || DEFAULT_ENGINE_ORIGIN).replace(/\/+$/, '');
}

export function wsUrl(env: WebEnv = current()): string {
  const origin = new URL(engineOrigin(env));
  origin.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';
  origin.pathname = WS_PATH;
  return origin.toString();
}

/** `VITE_ACE_MOCK=1`: MSW mocks + FakeSocket instead of the engine (round 1 §5). */
export function isMockMode(env: WebEnv = current()): boolean {
  const value = (env.VITE_ACE_MOCK ?? '').trim().toLowerCase();
  return value !== '' && value !== '0' && value !== 'false';
}
