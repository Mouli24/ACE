import { DESKTOP_BRIDGE_KEY, DesktopBridgeSchema, type DesktopBridge } from '@ace/contracts';

/**
 * The desktop bridge (D294): in the ACE desktop app the Electron preload puts the engine's address
 * and current session token at `window.aceDesktop`. In a browser — and in every test that does not
 * set it — there is none, and the web app reads `?token=` and `VITE_ACE_URL` exactly as before.
 *
 * The object comes from outside the bundle, so it is checked against the contract: one that does
 * not parse is ignored, and the screen says the desktop app handed over something unusable.
 */
export type DesktopBridgeState =
  { status: 'absent' } | { status: 'valid'; bridge: DesktopBridge } | { status: 'invalid' };

type BridgeSource = Partial<Record<typeof DESKTOP_BRIDGE_KEY, unknown>>;

function windowSource(): BridgeSource {
  return typeof window === 'undefined' ? {} : (window as unknown as BridgeSource);
}

export function readDesktopBridge(source: BridgeSource = windowSource()): DesktopBridgeState {
  const value = source[DESKTOP_BRIDGE_KEY];
  if (value === undefined) return { status: 'absent' };
  const parsed = DesktopBridgeSchema.safeParse(value);
  return parsed.success ? { status: 'valid', bridge: parsed.data } : { status: 'invalid' };
}

/** The bridge when this page runs in the desktop app and it is usable; otherwise `undefined`. */
export function desktopBridge(source?: BridgeSource): DesktopBridge | undefined {
  const state = readDesktopBridge(source);
  return state.status === 'valid' ? state.bridge : undefined;
}
