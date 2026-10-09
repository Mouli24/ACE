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

/* -------------------------------------------------------------------------- */
/* Engine IPC (D296)                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The messages between the packaged desktop app and the engine it starts on its bundled Node, over
 * the IPC channel of `child_process.spawn` (`stdio: [..., 'ipc']`). Without a channel the engine
 * sends and listens to nothing — a terminal or `pnpm dev` run is unchanged.
 *
 * - `ready` (engine → shell): sent where the CLI prints its ready line, once the engine listens and
 *   can shut down cleanly. `url` is the engine's own origin, which serves the SPA when `ACE_WEB_DIR`
 *   is set (D297); `token` is this start's session token.
 * - `shutdown` (shell → engine): run the same shutdown Ctrl-C runs — active runs end `HALTED
 *   shutdown`, the database closes — then exit 0. The channel closing (`disconnect`, the shell
 *   died) does the same.
 */
export const EngineIpcReadySchema = z.object({
  type: z.literal('ready'),
  url: z.url({ protocol: /^http$/, hostname: /^(127\.0\.0\.1|localhost)$/ }),
  port: z.number().int().min(1).max(65_535),
  token: z.string().min(1),
});
export type EngineIpcReady = z.infer<typeof EngineIpcReadySchema>;

/** Engine → shell. One message today; a union so a later one is an addition, not a change. */
export const EngineToShellMessageSchema = z.discriminatedUnion('type', [EngineIpcReadySchema]);
export type EngineToShellMessage = z.infer<typeof EngineToShellMessageSchema>;

export const EngineIpcShutdownSchema = z.object({ type: z.literal('shutdown') });
export type EngineIpcShutdown = z.infer<typeof EngineIpcShutdownSchema>;

/** Shell → engine. */
export const ShellToEngineMessageSchema = z.discriminatedUnion('type', [EngineIpcShutdownSchema]);
export type ShellToEngineMessage = z.infer<typeof ShellToEngineMessageSchema>;
