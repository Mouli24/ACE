import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  ipcMain,
  session,
  shell,
  type IpcMainEvent,
  type WebContents,
} from 'electron';

import { BRIDGE_CHANNEL, type DesktopBridge } from './bridge.js';
import { resolveDevConfig, type DevConfig } from './dev-config.js';
import {
  EngineStartError,
  startEngineProcess,
  type EngineExit,
  type EngineProcess,
} from './engine-process.js';
import { appMenuTemplate, contextMenuTemplate } from './menus.js';
import { decideLink, engineOrigins, type LinkAction, type ShellOrigins } from './navigation.js';
import {
  engineFailureDetail,
  packagedEngineEnv,
  packagedFolders,
  packagedLayout,
  type PackagedFolders,
  type PackagedLayout,
} from './packaged.js';
import { permissionAllowed } from './permissions.js';
import { pickFreePort } from './ports.js';
import { waitForDev, waitForEngine, type DevWaitState } from './readiness.js';
import { startingPageUrl } from './starting-page.js';
import { readTokenFile, watchSessionToken } from './token-watch.js';

/**
 * The ACE desktop shell's main process (D292): a thin layer of Electron wiring. Every decision it
 * makes — where the engine is, when it is ready, where a link may go, which permission is granted,
 * what a menu holds — is made by an Electron-free module beside it, tested on its own.
 *
 * The engine never runs in this process. In dev the shell attaches to the engine and Vite that
 * `pnpm dev` (or Start ACE.cmd) started, and never starts or stops them. Packaged, it starts the
 * bundled `node.exe` on the deployed engine, talks to it over IPC, and stops it on quit (D296, D298).
 */

/** `appId` in electron-builder.yml: the taskbar and Start-menu identity of the installed app. */
const APP_ID = 'local.ace.desktop';

const PRELOAD = fileURLToPath(new URL('./preload.cjs', import.meta.url));
const mode: DesktopBridge['mode'] = app.isPackaged ? 'packaged' : 'dev';

/** The engine as the shell knows it now. The preload asks for it on every page load. */
let bridge: DesktopBridge | undefined;
/** Where the app is served and where the engine is, once known. */
let origins: ShellOrigins | undefined;
let mainWindow: BrowserWindow | undefined;

/* --------------------------------------------------------------- the window */

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 380,
    minHeight: 480,
    show: false,
    title: 'ACE',
    backgroundColor: '#0a0a0b',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = undefined;
  });
  return win;
}

function focusWindow(): void {
  if (mainWindow === undefined) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * Load a page. A rejected load never ends the app: the commonest is ERR_ABORTED, a navigation that
 * another one replaced — and a load still pending when the next starts can hand the next one its
 * rejection, so every load is awaited before the next and every rejection is only logged.
 */
async function load(win: BrowserWindow, url: string): Promise<void> {
  if (win.isDestroyed()) return;
  try {
    await win.loadURL(url);
  } catch (error) {
    if (!url.startsWith('data:')) console.warn(`[ace-desktop] could not load ${url}:`, error);
  }
}

/** Show the local "Starting…" page. */
function showStatus(win: BrowserWindow, title: string, detail?: string): Promise<void> {
  return load(win, startingPageUrl(title, detail));
}

/* ------------------------------------------------- bridge, links, permissions */

/** The bridge goes to the app's own page in this shell's window, and to nothing else. */
function bridgeFor(event: IpcMainEvent): DesktopBridge | null {
  if (bridge === undefined || origins === undefined) return null;
  if (mainWindow === undefined || event.sender !== mainWindow.webContents) return null;
  try {
    return new URL(event.senderFrame?.url ?? '').origin === origins.app ? bridge : null;
  } catch {
    return null;
  }
}

function linkAction(url: string): LinkAction {
  if (origins === undefined) return 'deny';
  return decideLink(url, bridge === undefined ? origins : { ...origins, token: bridge.token });
}

function follow(contents: WebContents, url: string, action: LinkAction): void {
  if (action === 'download') contents.downloadURL(url);
  else if (action === 'external') void shell.openExternal(url);
}

function wireContents(contents: WebContents): void {
  contents.on('will-navigate', (event) => {
    const action = linkAction(event.url);
    if (action === 'allow') return;
    event.preventDefault();
    follow(contents, event.url, action);
  });

  contents.setWindowOpenHandler(({ url }) => {
    const action = linkAction(url);
    // The app's own URL in a "new window" loads here: a second window is never needed.
    if (action === 'allow') {
      const window = BrowserWindow.fromWebContents(contents);
      if (window !== null) void load(window, url);
    } else follow(contents, url, action);
    return { action: 'deny' };
  });

  contents.on('will-attach-webview', (event) => event.preventDefault());

  contents.on('context-menu', (_event, params) => {
    const template = contextMenuTemplate(params);
    if (template.length === 0) return;
    const window = BrowserWindow.fromWebContents(contents);
    Menu.buildFromTemplate(template).popup(window === null ? {} : { window });
  });
}

function installPermissionHandlers(): void {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) =>
    callback(permissionAllowed(permission, details.requestingUrl, origins?.app)),
  );
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    permissionAllowed(permission, requestingOrigin, origins?.app),
  );
}

/* ----------------------------------------------------------- dev: attach */

const WAITING = 'Waiting for the engine and Vite';

function waitingDetail(state: DevWaitState, config: DevConfig): string {
  const on = {
    token: `no session token in ${config.dataDir} yet`,
    engine: `the engine at ${config.engineUrl} does not answer with the current token`,
    web: `Vite at ${config.webUrl} does not answer`,
  }[state];
  return `Run Start ACE.cmd or pnpm dev. (Still waiting: ${on}.)`;
}

let reauthenticating: AbortController | undefined;

/**
 * The engine restarted (`tsx watch` after an `apps/server` edit) and wrote a new token: wait until
 * it accepts that token, then hand it to the page and reload, so the window stays signed in and its
 * WebSocket reconnects. A newer token arriving meanwhile cancels the wait for this one.
 */
async function reauthenticate(engineUrl: string, token: string): Promise<void> {
  reauthenticating?.abort(new Error('superseded by a newer token'));
  const controller = new AbortController();
  reauthenticating = controller;
  try {
    await waitForEngine({ engineUrl, token, fetch, signal: controller.signal });
  } catch {
    return;
  }
  if (bridge === undefined) return;
  bridge = { ...bridge, token };
  console.info('[ace-desktop] the engine restarted with a new session token; reloading');
  mainWindow?.webContents.reload();
}

async function startDev(win: BrowserWindow): Promise<void> {
  const config = resolveDevConfig({ env: process.env });
  origins = { app: config.webUrl, engine: engineOrigins(config.engineUrl) };
  console.info(
    `[ace-desktop] dev: engine ${config.engineUrl}, web ${config.webUrl}, data ${config.dataDir}`,
  );

  let shown: DevWaitState | undefined;
  let status: Promise<void> = Promise.resolve();
  const token = await waitForDev({
    readToken: () => readTokenFile(config.tokenFile),
    engineUrl: config.engineUrl,
    webUrl: config.webUrl,
    fetch,
    onWaiting: (state) => {
      if (state === shown) return;
      shown = state;
      status = showStatus(win, WAITING, waitingDetail(state, config));
    },
  });

  bridge = { engineUrl: config.engineUrl, token, mode: 'dev' };
  await status;
  await load(win, config.webUrl);

  watchSessionToken({
    file: config.tokenFile,
    current: token,
    onChange: (next) => void reauthenticate(config.engineUrl, next),
  });
}

/* ------------------------------------------------------------- packaged */

/** The engine this shell started (packaged only). */
let engine: EngineProcess | undefined;
/** A quit is under way: the engine is being asked to stop. */
let quitting = false;
/** The engine has been stopped for the quit; the next `before-quit` goes through. */
let engineStopped = false;

function engineDialogParent(): BrowserWindow | undefined {
  return mainWindow !== undefined && !mainWindow.isDestroyed() ? mainWindow : undefined;
}

/**
 * Start the bundled engine on a free port and load the SPA from it. A start that fails — the engine
 * exits first, or says nothing for 60 s — shows its last stderr lines and the log folder, then quits.
 */
async function launchEngine(
  win: BrowserWindow,
  layout: PackagedLayout,
  folders: PackagedFolders,
): Promise<void> {
  const port = await pickFreePort();
  const started = startEngineProcess({
    nodePath: layout.nodePath,
    mainPath: layout.engineMain,
    cwd: folders.workDir,
    env: packagedEngineEnv(process.env, { dataDir: folders.dataDir, port, webDir: layout.webDir }),
  });
  engine = started;

  let ready;
  try {
    ready = await started.ready;
  } catch (error) {
    if (quitting) return;
    const stderr = error instanceof EngineStartError ? error.stderr : started.tail();
    const options = {
      type: 'error' as const,
      title: 'ACE could not start',
      message: error instanceof Error ? error.message : 'The engine did not start.',
      detail: engineFailureDetail(stderr, folders.logDir),
      buttons: ['Quit'],
    };
    const parent = engineDialogParent();
    if (parent === undefined) dialog.showMessageBoxSync(options);
    else dialog.showMessageBoxSync(parent, options);
    app.quit();
    return;
  }

  origins = { app: ready.url, engine: engineOrigins(ready.url) };
  bridge = { engineUrl: ready.url, token: ready.token, mode: 'packaged' };
  void started.exited.then((exit) => {
    if (!quitting && engine === started) void engineStoppedUnexpectedly(win, layout, folders, exit);
  });
  await load(win, ready.url);
}

/** The engine died after it was ready: say so, and offer to start it again. */
async function engineStoppedUnexpectedly(
  win: BrowserWindow,
  layout: PackagedLayout,
  folders: PackagedFolders,
  exit: EngineExit,
): Promise<void> {
  bridge = undefined;
  const how = exit.code === null ? `signal ${exit.signal ?? 'unknown'}` : `exit code ${exit.code}`;
  const options = {
    type: 'error' as const,
    title: 'ACE',
    message: `The ACE engine stopped (${how}).`,
    detail: engineFailureDetail(engine?.tail() ?? [], folders.logDir),
    buttons: ['Restart', 'Quit'],
    defaultId: 0,
    cancelId: 1,
  };
  const parent = engineDialogParent();
  const { response } =
    parent === undefined
      ? await dialog.showMessageBox(options)
      : await dialog.showMessageBox(parent, options);
  if (response !== 0 || quitting || win.isDestroyed()) {
    app.quit();
    return;
  }
  await showStatus(win, 'Restarting ACE…');
  await launchEngine(win, layout, folders);
}

async function startPackaged(win: BrowserWindow): Promise<void> {
  const layout = packagedLayout(process.resourcesPath);
  // D408: the person's own ACE data, where `pnpm dev` keeps it — not a folder of the app's own.
  const folders = packagedFolders({
    dataDir: resolveDevConfig({ env: process.env }).dataDir,
    documents: app.getPath('documents'),
  });
  mkdirSync(folders.dataDir, { recursive: true });
  mkdirSync(folders.workDir, { recursive: true });
  console.info(
    `[ace-desktop] packaged: data ${folders.dataDir}, projects under ${folders.workDir}`,
  );
  await launchEngine(win, layout, folders);
}

/**
 * Quit = stop the engine first: the same shutdown Ctrl-C runs (active runs end HALTED `shutdown`,
 * the database closes), asked over IPC; after 10 s it is killed. Only then does the app exit.
 */
function stopEngineBeforeQuit(event: Electron.Event): void {
  if (engine === undefined || engineStopped) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  const running = engine;
  void running
    .shutdown(10_000)
    .then((result) => console.info(`[ace-desktop] engine stopped: ${result}`))
    .finally(() => {
      engineStopped = true;
      app.quit();
    });
}

/* ------------------------------------------------------------ lifecycle */

async function start(): Promise<void> {
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate()));
  installPermissionHandlers();
  const win = createWindow();
  mainWindow = win;
  await showStatus(win, 'Starting ACE…');
  if (mode === 'dev') await startDev(win);
  else await startPackaged(win);
}

function fatal(error: unknown): void {
  console.error('[ace-desktop]', error);
  dialog.showErrorBox(
    'ACE could not start',
    error instanceof Error ? error.message : String(error),
  );
  app.exit(1);
}

// A dev window and the installed app must never take each other's single-instance lock or profile:
// the lock is per user-data folder, and the installed app's is %APPDATA%\ACE.
if (mode === 'dev') app.setPath('userData', join(app.getPath('appData'), 'ACE Dev'));
else app.setAppUserModelId(APP_ID);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', focusWindow);
  app.on('web-contents-created', (_event, contents) => wireContents(contents));
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', stopEngineBeforeQuit);
  ipcMain.on(BRIDGE_CHANNEL, (event) => {
    event.returnValue = bridgeFor(event);
  });
  app.whenReady().then(start).catch(fatal);
}
