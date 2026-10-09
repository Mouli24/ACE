import { join } from 'node:path';

/**
 * Where the packaged app keeps things (D298). Electron-free, so the layout is tested on its own.
 *
 * electron-builder copies `apps/desktop/stage/` beside the asar as `extraResources`, so under
 * `process.resourcesPath` there are: `node/node.exe` (the Node that installed the native modules),
 * `engine/` (`pnpm deploy` of `apps/server`) and `web/` (`apps/web/dist`).
 */
export interface PackagedLayout {
  nodePath: string;
  engineMain: string;
  webDir: string;
}

export function packagedLayout(resourcesPath: string): PackagedLayout {
  return {
    nodePath: join(resourcesPath, 'node', 'node.exe'),
    engineMain: join(resourcesPath, 'engine', 'dist', 'main.js'),
    webDir: join(resourcesPath, 'web'),
  };
}

export interface PackagedFolders {
  /** `%APPDATA%\ACE\data` — never `~/.ace`, so the installed app and a dev setup stay apart. */
  dataDir: string;
  /** Where the engine's logs land (pino, `<dataDir>/logs`). */
  logDir: string;
  /**
   * The engine's working directory, `Documents\ACE`. A project with no folder of its own defaults
   * to `process.cwd()/ace-projects/<id>`, so this keeps those out of the install folder without an
   * engine change — a workaround until projects get a folder setting.
   */
  workDir: string;
}

export function packagedFolders(paths: { userData: string; documents: string }): PackagedFolders {
  const dataDir = join(paths.userData, 'data');
  return { dataDir, logDir: join(dataDir, 'logs'), workDir: join(paths.documents, 'ACE') };
}

/** The packaged engine's environment: the user's, plus where to keep data, listen, and serve the SPA. */
export function packagedEngineEnv(
  base: Record<string, string | undefined>,
  settings: { dataDir: string; port: number; webDir: string },
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...base,
    ACE_DATA_DIR: settings.dataDir,
    ACE_PORT: String(settings.port),
    ACE_WEB_DIR: settings.webDir,
  };
  delete env['ELECTRON_RUN_AS_NODE'];
  return env;
}

/** The text of the dialog shown when the engine does not start, or stops. */
export function engineFailureDetail(stderr: string[], logDir: string): string {
  const last = stderr.slice(-15).join('\n');
  return `${last === '' ? 'The engine printed nothing.' : `Last lines from the engine:\n${last}`}\n\nLogs: ${logDir}`;
}
