/**
 * The desktop preload (D294).
 *
 * It runs sandboxed, so it is CommonJS and one self-contained file: at run time it may `require`
 * `electron` and nothing local — not `./bridge.js`, not `@ace/contracts`. That is why the channel, the
 * window key and the bridge's shape are written out below; `bridge.test.ts` pins them to the
 * contract. Under `verbatimModuleSyntax` the only import form a `.cts` file may use is
 * `import x = require(…)`.
 */
import electron = require('electron');

/** `DESKTOP_BRIDGE_CHANNEL` and `DESKTOP_BRIDGE_KEY` in `@ace/contracts`. */
const BRIDGE_CHANNEL = 'ace-desktop:bridge';
const BRIDGE_KEY = 'aceDesktop';

/** `DesktopBridge` in `@ace/contracts`: engineUrl, token, mode. */
interface DesktopBridge {
  engineUrl: string;
  token: string;
  mode: 'dev' | 'packaged';
}

function isBridge(value: unknown): value is DesktopBridge {
  if (value === null || typeof value !== 'object') return false;
  const bridge = value as Record<string, unknown>;
  return (
    typeof bridge['engineUrl'] === 'string' &&
    typeof bridge['token'] === 'string' &&
    (bridge['mode'] === 'dev' || bridge['mode'] === 'packaged')
  );
}

// One synchronous ask, before any page script runs: the main process answers with the engine's
// current address and token, or null on a page that is not the app (the "Starting…" page). The web
// app validates what it gets against the contract again and ignores it if it does not parse.
const bridge: unknown = electron.ipcRenderer.sendSync(BRIDGE_CHANNEL);
if (isBridge(bridge)) electron.contextBridge.exposeInMainWorld(BRIDGE_KEY, bridge);

// FR-DSK-004: a file dropped where the page does not take it would navigate the window to
// file://… . Cancel the default at the window, after the page's own handlers have run — and never
// stop propagation, so InputDropZone and AttachmentPicker still receive their drops.
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());
