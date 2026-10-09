import type { DesktopBridge } from '@ace/contracts';

/**
 * The preload bridge (D294): what the page finds at `window.aceDesktop`.
 *
 * The shell imports `@ace/contracts` for types only — it ships with no runtime dependencies (D292) —
 * so the two values it needs at run time are written out here, and `bridge.test.ts` pins them to
 * `DESKTOP_BRIDGE_CHANNEL` and `DESKTOP_BRIDGE_KEY`. The sandboxed preload cannot import even this
 * file, so it carries its own copy, pinned by the same test.
 */
export const BRIDGE_CHANNEL = 'ace-desktop:bridge';
export const BRIDGE_KEY = 'aceDesktop';

export type { DesktopBridge };
