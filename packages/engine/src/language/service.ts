import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { Id, LanguageRequest, LanguageResponse, LanguageServerLanguage } from '@ace/contracts';

import { HttpError, invalidPath, notFound, notImplemented } from '../gateway/errors.js';
import type { Logger } from '../logging/index.js';
import type { Repository, Scope } from '../ports/index.js';
import { connectRpc, type RpcConnection } from './rpc.js';

/**
 * Forge's Python IntelliSense: one Pyright language server per project, started on the first
 * question about one of its `.py` files and stopped when the project goes quiet. The editor asks
 * one thing at a time (`completion`, `hover`, …) with the file's text as it is now, saved or not;
 * the server is told about the text only when it changed. Monaco answers TS/JS/CSS/HTML/JSON
 * itself, so this is the only language that goes through the engine.
 */
export interface LanguageService {
  request(
    projectId: Id,
    language: LanguageServerLanguage,
    request: LanguageRequest,
    signal?: AbortSignal,
  ): Promise<LanguageResponse>;
  /** A project was deleted or moved: its server stops. */
  stopProject(projectId: Id): Promise<void>;
  /** Shutdown: every server stops. */
  stopAll(): Promise<void>;
}

export interface LanguageServiceDeps {
  repository: Repository;
  scope: Scope;
  logger: Logger;
  /** How Pyright's language server starts (`node …/langserver.index.js --stdio`); absent: 501. */
  pyright?: { command: string; args: readonly string[] };
  /** A server nobody asked anything for this long stops. */
  idleMs?: number;
  /** The most servers that run at once; the least recently used stops for a new one. */
  maxServers?: number;
  /** Open documents one server keeps; the least recently used is closed past this. */
  maxDocuments?: number;
  /** How long a question waits for its answer before it answers `null`. */
  requestTimeoutMs?: number;
  /** How long `diagnostics` waits for the server to check the text. */
  diagnosticsTimeoutMs?: number;
}

interface Document {
  uri: string;
  version: number;
  text: string;
}

interface Diagnostics {
  version: number | undefined;
  items: unknown[];
}

interface Server {
  folder: string;
  child: ChildProcessWithoutNullStreams;
  rpc: RpcConnection;
  ready: Promise<void>;
  /** Keyed by {@link docKey}; insertion order is least recently used first. */
  documents: Map<string, Document>;
  diagnostics: Map<string, Diagnostics>;
  /** Who waits for a file's next diagnostics. */
  waiting: Set<{ key: string; version: number; done: () => void }>;
  idle: ReturnType<typeof setTimeout> | undefined;
  stopped: Promise<void>;
}

const PYTHON_EXTENSIONS = new Set(['py', 'pyi']);

/** Pylance's defaults, as VS Code's Python users see them. */
const ANALYSIS = {
  typeCheckingMode: 'off',
  diagnosticMode: 'openFilesOnly',
  autoImportCompletions: true,
  autoSearchPaths: true,
  useLibraryCodeForTypes: true,
};

/** The same file from either side's spelling of its URI (`file:///D:/a` and `file:///d%3A/a`). */
function docKey(uri: string): string {
  let path = uri;
  try {
    path = fileURLToPath(uri);
  } catch {
    // Not a file URI: keyed as given.
  }
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

/** A virtual environment at the project's root, which VS Code's Python extension would pick. */
function projectPython(folder: string): string | undefined {
  for (const name of ['.venv', 'venv', 'env']) {
    const python =
      process.platform === 'win32'
        ? join(folder, name, 'Scripts', 'python.exe')
        : join(folder, name, 'bin', 'python');
    if (existsSync(python)) return python;
  }
  return undefined;
}

const unavailable = (reason: string): HttpError => new HttpError('workflow', 'internal', reason);

export function createLanguageService(deps: LanguageServiceDeps): LanguageService {
  const { repository, scope, logger } = deps;
  const idleMs = deps.idleMs ?? 10 * 60_000;
  const maxServers = deps.maxServers ?? 4;
  const maxDocuments = deps.maxDocuments ?? 64;
  const requestTimeoutMs = deps.requestTimeoutMs ?? 15_000;
  const diagnosticsTimeoutMs = deps.diagnosticsTimeoutMs ?? 8_000;
  /** Insertion order is least recently used first. */
  const servers = new Map<Id, Server>();

  async function folderOf(projectId: Id): Promise<string> {
    const project = await repository.projects.get(scope, projectId);
    if (project === null) throw notFound(`Project ${projectId}`);
    if (project.folderPath === '') throw invalidPath('(none)', 'this project has no folder.');
    return project.folderPath;
  }

  /** The file's absolute path, confined to the project and to Python sources. */
  function fileOf(folder: string, path: string): string {
    if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) {
      throw invalidPath(path, 'it must stay inside the project.');
    }
    const file = resolve(folder, path);
    const inside = relative(folder, file);
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
      throw invalidPath(path, 'it must stay inside the project.');
    }
    const extension = basename(file).split('.').pop()?.toLowerCase() ?? '';
    if (!PYTHON_EXTENSIONS.has(extension)) throw invalidPath(path, 'it is not a Python file.');
    return file;
  }

  function stop(projectId: Id, server: Server): Promise<void> {
    if (servers.get(projectId) === server) servers.delete(projectId);
    if (server.idle !== undefined) clearTimeout(server.idle);
    const { child, rpc } = server;
    if (child.exitCode === null && child.signalCode === null) {
      const kill = setTimeout(() => child.kill(), 2_000);
      kill.unref();
      rpc
        .request('shutdown', null, AbortSignal.timeout(1_500))
        .catch(() => undefined)
        .finally(() => {
          rpc.notify('exit', null);
          child.stdin.end();
        });
    }
    return server.stopped;
  }

  function touch(projectId: Id, server: Server): void {
    servers.delete(projectId);
    servers.set(projectId, server);
    if (server.idle !== undefined) clearTimeout(server.idle);
    server.idle = setTimeout(() => void stop(projectId, server), idleMs);
    server.idle.unref();
  }

  function start(projectId: Id, folder: string): Server {
    const pyright = deps.pyright;
    if (pyright === undefined) throw notImplemented('Python IntelliSense');
    const log = logger.child({ projectId });
    const child = spawn(pyright.command, [...pyright.args], {
      cwd: folder,
      stdio: 'pipe',
      windowsHide: true,
      // The engine's Node may be Electron's (the desktop shell): run it as plain Node.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    const rpc = connectRpc(child.stdout, child.stdin);
    const folderUri = pathToFileURL(folder).href;
    const python = projectPython(folder);

    const server: Server = {
      folder,
      child,
      rpc,
      ready: Promise.resolve(),
      documents: new Map(),
      diagnostics: new Map(),
      waiting: new Set(),
      idle: undefined,
      stopped: new Promise<void>((done) => {
        child.once('close', () => done());
      }),
    };

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (line: string) => log.debug({ stderr: line.slice(0, 500) }, 'pyright'));
    child.stdin.on('error', () => undefined);
    const gone = (error: Error): void => {
      rpc.close(error);
      if (servers.get(projectId) === server) servers.delete(projectId);
      if (server.idle !== undefined) clearTimeout(server.idle);
      for (const waiter of server.waiting) waiter.done();
      server.waiting.clear();
    };
    child.once('error', (error) => {
      log.warn({ err: error }, 'the Python language server could not start');
      gone(unavailable(`The Python language server could not start: ${error.message}`));
    });
    child.once('close', (code) => {
      log.info({ code }, 'the Python language server stopped');
      gone(unavailable('The Python language server stopped.'));
    });

    rpc.onRequest((method, params) => {
      switch (method) {
        case 'workspace/configuration': {
          const items = (params as { items?: { section?: string }[] } | null)?.items ?? [];
          return items.map(({ section }) => {
            if (section === 'python') {
              return {
                ...(python === undefined ? {} : { pythonPath: python }),
                analysis: ANALYSIS,
              };
            }
            if (section === 'python.analysis') return ANALYSIS;
            return {};
          });
        }
        case 'workspace/workspaceFolders':
          return [{ uri: folderUri, name: basename(folder) }];
        case 'client/registerCapability':
        case 'client/unregisterCapability':
        case 'window/workDoneProgress/create':
        case 'window/showMessageRequest':
          return null;
        default:
          throw new Error(`${method} is not handled`);
      }
    });

    rpc.onNotification((method, params) => {
      if (method !== 'textDocument/publishDiagnostics') return;
      const { uri, version, diagnostics } = params as {
        uri: string;
        version?: number;
        diagnostics: unknown[];
      };
      const key = docKey(uri);
      server.diagnostics.set(key, { version, items: diagnostics });
      const current = server.documents.get(key)?.version;
      for (const waiter of server.waiting) {
        if (waiter.key !== key) continue;
        // A publish for an older text is not the answer; one without a version is the latest.
        if (version !== undefined && current !== undefined && version < waiter.version) continue;
        server.waiting.delete(waiter);
        waiter.done();
      }
    });

    server.ready = rpc
      .request('initialize', {
        processId: process.pid,
        clientInfo: { name: 'ACE Forge' },
        rootUri: folderUri,
        rootPath: folder,
        workspaceFolders: [{ uri: folderUri, name: basename(folder) }],
        capabilities: {
          workspace: { configuration: true, workspaceFolders: true },
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: false },
            completion: {
              contextSupport: true,
              completionItem: {
                snippetSupport: true,
                commitCharactersSupport: true,
                documentationFormat: ['markdown', 'plaintext'],
                deprecatedSupport: true,
                tagSupport: { valueSet: [1] },
                labelDetailsSupport: true,
                resolveSupport: {
                  properties: ['documentation', 'detail', 'additionalTextEdits'],
                },
              },
            },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            signatureHelp: {
              contextSupport: true,
              signatureInformation: {
                documentationFormat: ['markdown', 'plaintext'],
                parameterInformation: { labelOffsetSupport: true },
                activeParameterSupport: true,
              },
            },
            publishDiagnostics: {
              versionSupport: true,
              tagSupport: { valueSet: [1, 2] },
            },
          },
          window: { workDoneProgress: false },
        },
      })
      .then(() => {
        rpc.notify('initialized', {});
        rpc.notify('workspace/didChangeConfiguration', {
          settings: { python: { analysis: ANALYSIS } },
        });
        log.info({ python: python ?? '(from PATH)' }, 'the Python language server is ready');
      });
    // A failed start answers every question with the reason, and the next one starts again.
    server.ready.catch(() => void stop(projectId, server));
    return server;
  }

  async function serverFor(projectId: Id): Promise<Server> {
    let server = servers.get(projectId);
    if (server === undefined) {
      const folder = await folderOf(projectId);
      server = servers.get(projectId) ?? start(projectId, folder);
      servers.set(projectId, server);
      while (servers.size > maxServers) {
        const [oldest, idle] = servers.entries().next().value as [Id, Server];
        void stop(oldest, idle);
      }
    }
    touch(projectId, server);
    await server.ready;
    return server;
  }

  /** Tells the server the file's text when it is new to it or changed; answers its version. */
  function sync(server: Server, uri: string, text: string): number {
    const key = docKey(uri);
    const known = server.documents.get(key);
    if (known === undefined) {
      server.documents.set(key, { uri, version: 1, text });
      server.rpc.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: 'python', version: 1, text },
      });
      while (server.documents.size > maxDocuments) {
        const [oldest] = server.documents;
        if (oldest === undefined) break;
        const [oldKey, { uri: oldUri }] = oldest;
        server.documents.delete(oldKey);
        server.diagnostics.delete(oldKey);
        server.rpc.notify('textDocument/didClose', {
          textDocument: { uri: oldUri },
        });
      }
      return 1;
    }
    server.documents.delete(key);
    server.documents.set(key, known);
    if (known.text !== text) {
      known.version += 1;
      known.text = text;
      server.rpc.notify('textDocument/didChange', {
        textDocument: { uri, version: known.version },
        contentChanges: [{ text }],
      });
    }
    return known.version;
  }

  function diagnosticsOf(server: Server, uri: string, version: number): Promise<unknown[]> {
    const key = docKey(uri);
    const now = server.diagnostics.get(key);
    if (now !== undefined && now.version !== undefined && now.version >= version) {
      return Promise.resolve(now.items);
    }
    return new Promise<unknown[]>((answer) => {
      const waiter = {
        key,
        version,
        done: () => {
          clearTimeout(timer);
          answer(server.diagnostics.get(key)?.items ?? []);
        },
      };
      const timer = setTimeout(() => {
        server.waiting.delete(waiter);
        waiter.done();
      }, diagnosticsTimeoutMs);
      server.waiting.add(waiter);
    });
  }

  async function ask(server: Server, method: string, params: unknown, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const both = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    try {
      return await server.rpc.request(method, params, both);
    } catch (error) {
      // The editor moved on, or the server took too long: no answer rather than an error.
      if (both.aborted) return null;
      throw error;
    }
  }

  return {
    async request(projectId, language, request, signal) {
      if (language !== 'python') throw notImplemented(`IntelliSense for ${String(language)}`);
      const server = await serverFor(projectId);
      const file = fileOf(server.folder, request.path);
      const uri = pathToFileURL(file).href;

      if (request.method === 'completionResolve') {
        return {
          result: await ask(server, 'completionItem/resolve', request.item, signal),
        };
      }
      if (request.text === undefined) {
        throw invalidPath(request.path, `${request.method} needs the file's text.`);
      }
      const version = sync(server, uri, request.text);
      if (request.method === 'diagnostics') {
        return { result: await diagnosticsOf(server, uri, version) };
      }
      if (request.position === undefined) {
        throw invalidPath(request.path, `${request.method} needs a position.`);
      }
      const at = { textDocument: { uri }, position: request.position };
      const context = request.context === undefined ? {} : { context: request.context };
      const method =
        request.method === 'completion'
          ? 'textDocument/completion'
          : request.method === 'hover'
            ? 'textDocument/hover'
            : 'textDocument/signatureHelp';
      return {
        result: await ask(server, method, { ...at, ...context }, signal),
      };
    },

    async stopProject(projectId) {
      const server = servers.get(projectId);
      if (server !== undefined) await stop(projectId, server);
    },

    async stopAll() {
      await Promise.all([...servers].map(([projectId, server]) => stop(projectId, server)));
    },
  };
}

/** `node <pyright>/langserver.index.js --stdio`, run by the engine's own Node. */
export function pyrightCommand(langserverScript: string): {
  command: string;
  args: string[];
} {
  return { command: process.execPath, args: [langserverScript, '--stdio'] };
}
