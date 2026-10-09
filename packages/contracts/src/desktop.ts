import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Desktop shell (D292, D294)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The desktop bridge: what the Electron shell's preload exposes to the web app at
 * `window.aceDesktop` (Arch §10.2: "hands the token to the renderer through a preload script").
 *
 * In the desktop window the token and the engine's address come from here, ahead of `?token=` and
 * `VITE_ACE_URL`, which stay as they are for the browser and the tests. The web app validates the
 * object against this schema and ignores it when it does not parse.
 */
export const DESKTOP_BRIDGE_KEY = 'aceDesktop';

/** The synchronous IPC channel the preload asks the main process on for the bridge. */
export const DESKTOP_BRIDGE_CHANNEL = 'ace-desktop:bridge';

/**
 * `dev`: attached to the engine and Vite that `pnpm dev` started. `packaged`: the installed app,
 * which runs its own engine and loads the SPA from it.
 */
export const DESKTOP_MODES = ['dev', 'packaged'] as const;
export type DesktopMode = (typeof DESKTOP_MODES)[number];

export const DesktopBridgeSchema = z.object({
  /** The engine's origin. Loopback only, like the engine itself (FR-SYS-001). */
  engineUrl: z.url({ protocol: /^https?$/, hostname: /^(127\.0\.0\.1|localhost)$/ }),
  /** The engine's current session token (§2.10). */
  token: z.string().regex(/^\S+$/),
  mode: z.enum(DESKTOP_MODES),
});
export type DesktopBridge = z.infer<typeof DesktopBridgeSchema>;
