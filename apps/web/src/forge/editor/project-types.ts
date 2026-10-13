import {
  SOURCE_EXTENSIONS,
  SOURCES_MAX_BYTES,
  SOURCES_MAX_FILES,
  type FileChange,
  type FileContent,
  type SourcesResult,
} from '@ace/contracts';
import type * as Monaco from 'monaco-editor';
import { useEffect } from 'react';

import { api } from '../../app/api';
import { getSocket } from '../../app/socket';
import {
  fileUri,
  getModel,
  isRegistryModel,
  onRegistryChange,
  pathOfUri,
  whenMonaco,
} from './models';

type MonacoApi = typeof Monaco;
type Defaults = Monaco.typescript.LanguageServiceDefaults;

/** What the loader reads from the engine: the batch of sources, and one file when it changes. */
export interface SourcesClient {
  projectSources(projectId: string): Promise<SourcesResult>;
  readFile(projectId: string, path: string): Promise<FileContent>;
}

export interface ProjectTypes {
  /** The first load has settled (tests, and nothing else, wait for it). */
  readonly ready: Promise<void>;
  /** One `files.changed` burst: changed and created sources are re-read, deleted ones dropped. */
  changed(changes: readonly FileChange[]): Promise<void>;
  /** A `resync`, or a reconnect: everything is read again. */
  reload(): Promise<void>;
  /** The project left Forge: every extra lib goes, and the compiler options are as they were. */
  dispose(): void;
}

const SOURCE = new Set<string>(SOURCE_EXTENSIONS);
const JAVASCRIPT = new Set(['js', 'jsx', 'mjs', 'cjs']);
const extensionOf = (path: string): string => path.slice(path.lastIndexOf('.') + 1).toLowerCase();
const isSource = (path: string): boolean =>
  path.lastIndexOf('.') > path.lastIndexOf('/') &&
  SOURCE.has(extensionOf(path)) &&
  !path.split('/').some((segment) => segment.toLowerCase() === 'node_modules');

/**
 * JSON with comments and trailing commas, as `tsconfig.json` is written: comments go first, then
 * a comma before a closing bracket — both only outside strings.
 */
export function parseJsonc(text: string): unknown {
  let bare = '';
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? '';
    const next = text[i + 1];
    if (char === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      bare += text.slice(i, end + 1);
      i = end;
    } else if (char === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      bare += '\n';
    } else if (char === '/' && next === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? text.length : close + 1;
    } else {
      bare += char;
    }
  }
  let json = '';
  for (let i = 0; i < bare.length; i += 1) {
    const char = bare[i] ?? '';
    if (char === '"') {
      let end = i + 1;
      while (end < bare.length && bare[end] !== '"') end += bare[end] === '\\' ? 2 : 1;
      json += bare.slice(i, end + 1);
      i = end;
    } else if (char === ',' && /^\s*[}\]]/.test(bare.slice(i + 1))) {
      continue;
    } else {
      json += char;
    }
  }
  return JSON.parse(json) as unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `compilerOptions.baseUrl` and `paths` from the root `tsconfig.json`, rebased under
 * `file:///<projectId>/` — where Forge's models and extra libs live — so imports like `@/x`
 * resolve. Paths with no baseUrl are relative to the tsconfig's folder, the project root.
 * Nothing when there is neither, or the file cannot be read.
 */
export function tsconfigOptions(
  projectId: string,
  tsconfig: string | undefined,
): { baseUrl: string; paths?: Record<string, string[]> } | undefined {
  if (tsconfig === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = parseJsonc(tsconfig);
  } catch {
    return undefined;
  }
  const options = isRecord(parsed) ? parsed['compilerOptions'] : undefined;
  if (!isRecord(options)) return undefined;
  const baseUrl = typeof options['baseUrl'] === 'string' ? options['baseUrl'] : undefined;
  const rawPaths = options['paths'];
  const paths: Record<string, string[]> = {};
  if (isRecord(rawPaths)) {
    for (const [key, targets] of Object.entries(rawPaths)) {
      if (Array.isArray(targets)) {
        paths[key] = targets.filter((target): target is string => typeof target === 'string');
      }
    }
  }
  if (baseUrl === undefined && Object.keys(paths).length === 0) return undefined;
  const folder = (baseUrl ?? '.')
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
  return {
    baseUrl: folder === '' ? `file:///${projectId}` : `file:///${projectId}/${folder}`,
    ...(Object.keys(paths).length === 0 ? {} : { paths }),
  };
}

/**
 * Cross-file TypeScript IntelliSense (D299 Phase 4, design §6.2): the project's TS/JS sources —
 * up to 1,500 files and 2 MB, as `GET /files/sources` caps them — registered with Monaco's
 * TypeScript service as extra libs at their model URIs (`file:///<projectId>/<path>`), JS files
 * with the JavaScript service too, so an open file's imports resolve to real types. A file open in
 * Forge is never also an extra lib (the two would declare everything twice): its lib goes when the
 * registry opens it and comes back, read fresh from disk, when it closes.
 *
 * Monaco makes real models of its own from extra libs — for go-to-definition, references, rename
 * and a diagnostic's related information — at the same URIs (fix C2). Those are never "open": the
 * registry does not adopt them (`ensureModel` replaces one with the disk's text), Problems leaves
 * out their markers, and this loader disposes one whenever it replaces or drops that file's lib,
 * and all of them when the project goes, so none is ever left holding older text.
 */
export function loadProjectTypes(
  monaco: Pick<MonacoApi, 'editor' | 'typescript'>,
  projectId: string,
  client: SourcesClient,
): ProjectTypes {
  const services: Defaults[] = [
    monaco.typescript.typescriptDefaults,
    monaco.typescript.javascriptDefaults,
  ];
  const original = services.map((defaults) => defaults.getCompilerOptions());
  const libs = new Map<string, Monaco.IDisposable[]>();
  const sizes = new Map<string, number>();
  let disposed = false;
  /** Bumped by every reload, so a slower, older load never lands after a newer one. */
  let generation = 0;

  /** Open in Forge: the registry made a model for it. Monaco's own models never count. */
  const isOpen = (path: string): boolean => getModel(projectId, path) !== undefined;

  /** Monaco's model of a lib at this path, if it made one: it holds the lib's text, which is going. */
  function disposeStray(path: string): void {
    const model = monaco.editor.getModel(fileUri(projectId, path));
    if (model !== null && !model.isDisposed() && !isRegistryModel(model)) model.dispose();
  }

  function unregister(path: string): void {
    for (const lib of libs.get(path) ?? []) lib.dispose();
    libs.delete(path);
    sizes.delete(path);
  }

  function register(path: string, content: string): void {
    unregister(path);
    if (disposed || isOpen(path)) return;
    disposeStray(path);
    const uri = fileUri(projectId, path).toString();
    const added = [monaco.typescript.typescriptDefaults.addExtraLib(content, uri)];
    if (JAVASCRIPT.has(extensionOf(path))) {
      added.push(monaco.typescript.javascriptDefaults.addExtraLib(content, uri));
    }
    libs.set(path, added);
    sizes.set(path, content.length);
  }

  /** Within the caps the sources route keeps, counting what is registered now. */
  function fits(path: string, content: string): boolean {
    if (libs.has(path)) return true;
    let bytes = content.length;
    for (const size of sizes.values()) bytes += size;
    return libs.size < SOURCES_MAX_FILES && bytes <= SOURCES_MAX_BYTES;
  }

  async function readFresh(path: string): Promise<void> {
    try {
      const file = await client.readFile(projectId, path);
      if (disposed) return;
      if (file.kind === 'text' && fits(path, file.content)) register(path, file.content);
      else unregister(path);
    } catch {
      unregister(path);
      disposeStray(path);
    }
  }

  /**
   * The services' options with this project's baseUrl and paths, or (`undefined`) with what they
   * had before it. Only those two are touched: every other option is the workbench's (I3).
   */
  function applyOptions(rebased: ReturnType<typeof tsconfigOptions>): void {
    services.forEach((defaults, index) => {
      const { baseUrl: _baseUrl, paths: _paths, ...rest } = defaults.getCompilerOptions();
      const before = original[index] ?? {};
      defaults.setCompilerOptions({
        ...rest,
        ...(before.baseUrl === undefined ? {} : { baseUrl: before.baseUrl }),
        ...(before.paths === undefined ? {} : { paths: before.paths }),
        ...(rebased ?? {}),
      });
    });
  }

  async function reload(): Promise<void> {
    generation += 1;
    const mine = generation;
    let sources: SourcesResult;
    try {
      sources = await client.projectSources(projectId);
    } catch {
      return;
    }
    if (disposed || mine !== generation) return;
    for (const path of [...libs.keys()]) unregister(path);
    for (const file of sources.files) register(file.path, file.content);
    applyOptions(tsconfigOptions(projectId, sources.tsconfig));
  }

  const stopFollowing = onRegistryChange((owner, path, open) => {
    if (owner !== projectId || disposed) return;
    if (open) unregister(path);
    // read once it is closed: the disk now holds what was saved, or what was never changed
    else if (isSource(path)) void readFresh(path);
  });

  return {
    ready: reload(),
    reload,
    async changed(changes) {
      await Promise.all(
        changes
          .filter((change) => isSource(change.path))
          .map((change) => {
            if (change.kind === 'deleted') {
              unregister(change.path);
              if (!isOpen(change.path)) disposeStray(change.path);
              return Promise.resolve();
            }
            return isOpen(change.path) ? Promise.resolve() : readFresh(change.path);
          }),
      );
    },
    dispose() {
      disposed = true;
      stopFollowing();
      for (const path of [...libs.keys()]) unregister(path);
      // Monaco's models of this project's libs: nothing will refresh them now
      for (const model of monaco.editor.getModels()) {
        if (pathOfUri(model.uri)?.projectId === projectId && !isRegistryModel(model)) {
          model.dispose();
        }
      }
      applyOptions(undefined);
    },
  };
}

/**
 * While Forge shows a project (D299 Phase 4): once Monaco has loaded, its sources are registered
 * for cross-file types and kept in step with `files.changed` — the changed paths, or everything on
 * `resync` and on a reconnect. Switching project disposes them all.
 */
export function useProjectTypes(projectId: string): void {
  useEffect(() => {
    if (projectId === '') return;
    let types: ProjectTypes | undefined;
    const offs: Array<() => void> = [];
    const cancel = whenMonaco((monaco) => {
      types = loadProjectTypes(monaco, projectId, api());
      const socket = getSocket();
      if (socket === undefined) return;
      offs.push(
        socket.on('files.changed', (payload) => {
          if (payload.projectId !== projectId) return;
          void (payload.resync ? types?.reload() : types?.changed(payload.changes));
        }),
        socket.on('hello', () => void types?.reload()),
      );
    });
    return () => {
      cancel();
      for (const off of offs) off();
      types?.dispose();
    };
  }, [projectId]);
}
