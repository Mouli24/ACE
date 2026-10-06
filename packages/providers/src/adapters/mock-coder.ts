import { lstat, mkdir, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { ProviderCallError, type GenerateRequest, type StreamChunk } from '../adapter.js';

/**
 * `mock-coder` (P0 §7): an agent-route stand-in on the mock provider. Like a coding-agent CLI
 * (X1 §4.2, D261) it edits files itself and reports each edit as an `activity` chunk; unlike one,
 * it does exactly what directives in its prompt say, so a test can script a task's changes:
 *
 * ```text
 * ace-mock:write <relative path>     ← the lines up to `ace-mock:end` become the file
 * <file content lines…>
 * ace-mock:end
 * ace-mock:delete <relative path>
 * ace-mock:fail <message>            ← ends the call with a provider error
 * ```
 *
 * A directive is a line that starts with one of these (leading whitespace ignored); content lines
 * are kept verbatim. Paths use `/` and may contain spaces. Directives run in order: whatever comes
 * before a `fail` has already happened, as it would for a real agent that gave up half way.
 *
 * Providers may not import `@ace/tools`, so the "stay inside the folder" rule is this file's own
 * {@link resolveInside}.
 */

export type CoderDirective =
  | {
      kind: 'write';
      path: string;
      lines: string[];
      /** False when no `ace-mock:end` followed: the write is refused, nothing is written. */
      closed: boolean;
    }
  | { kind: 'delete'; path: string }
  | { kind: 'fail'; message: string };

type ActivityChunk = Extract<StreamChunk, { type: 'activity' }>;

/** What `mock-coder` answers when the call has no working folder: it never touches the disk then. */
export const MOCK_CODER_NO_FOLDER = 'mock-coder has no working folder; nothing was changed.';

const DIRECTIVE = /^ace-mock:(write|delete|fail|end)(?:[ \t]+(.*))?$/;

/** The keyword and argument of a directive line, or `undefined` for any other line. */
function directiveOf(line: string): { keyword: string; argument: string } | undefined {
  const match = DIRECTIVE.exec(line.trimStart());
  if (match === null) return undefined;
  return { keyword: match[1]!, argument: (match[2] ?? '').trim() };
}

/**
 * Every directive in `text`, in order. A stray `ace-mock:end` and any `ace-mock:` word this does not
 * know are ignored. An unterminated `write` would swallow everything after it as content, so it is
 * the last directive read, and is marked `closed: false`.
 */
export function parseCoderDirectives(text: string): CoderDirective[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const directives: CoderDirective[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const directive = directiveOf(lines[index]!);
    if (directive === undefined) continue;
    const { keyword, argument } = directive;

    if (keyword === 'delete') directives.push({ kind: 'delete', path: argument });
    else if (keyword === 'fail') directives.push({ kind: 'fail', message: argument });
    else if (keyword === 'write') {
      const end = lines.findIndex((line, at) => at > index && directiveOf(line)?.keyword === 'end');
      if (end === -1) {
        directives.push({ kind: 'write', path: argument, lines: [], closed: false });
        break;
      }
      directives.push({
        kind: 'write',
        path: argument,
        lines: lines.slice(index + 1, end),
        closed: true,
      });
      index = end;
    }
  }
  return directives;
}

export type Resolved =
  { ok: true; absolute: string; relative: string } | { ok: false; reason: string };

const refused = (reason: string): Resolved => ({ ok: false, reason });

/** Whether a `path.relative` result leaves the folder it was taken from. */
const escapes = (rel: string): boolean =>
  rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);

/**
 * Resolve a directive's `/`-separated path inside `root`, or say why not.
 *
 * Refused: an empty path, a `\` (the format uses `/`, and on POSIX a `\` would silently be part of
 * a file name), an absolute or drive-letter path, anything that resolves to `root` itself or
 * outside it — and anything whose *real* location is outside the real `root`: the nearest part of
 * the path that exists is followed through symlinks and must still be inside, so a link to
 * elsewhere cannot carry a write out. The answer's `relative` is the normalised path, with `/`.
 */
export async function resolveInside(root: string, path: string): Promise<Resolved> {
  if (path === '') return refused('no path given');
  if (path.includes('\\')) return refused('paths use /, not \\');
  if (path.startsWith('/') || isAbsolute(path) || /^[A-Za-z]:/.test(path)) {
    return refused('absolute path refused');
  }

  const realRoot = await realpath(root);
  const target = resolve(realRoot, ...path.split('/'));
  const rel = relative(realRoot, target);
  if (rel === '') return refused('not a file path');
  if (escapes(rel)) return refused('outside the working folder');

  // The nearest part of the path that exists — at worst `realRoot` itself.
  let probe = target;
  while (!(await exists(probe))) {
    const parent = dirname(probe);
    if (parent === probe) return refused('outside the working folder');
    probe = parent;
  }
  let real: string;
  try {
    real = await realpath(probe);
  } catch {
    return refused('outside the working folder'); // a dangling link: it points somewhere else
  }
  if (real !== realRoot && escapes(relative(realRoot, real))) {
    return refused('outside the working folder');
  }

  return { ok: true, absolute: target, relative: rel.split(sep).join('/') };
}

/** A short reason for a failed file operation, without the absolute path Node puts in messages. */
function fsReason(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'EISDIR') return 'is a folder, not a file';
  return typeof code === 'string' ? `failed (${code})` : 'failed';
}

/** Carry out one write or delete in `root`, as the `activity` chunk that reports it. */
async function applyDirective(
  root: string,
  directive: Exclude<CoderDirective, { kind: 'fail' }>,
  now: () => number,
): Promise<{ chunk: ActivityChunk; changed?: string }> {
  const startedAt = now();
  const report = (
    status: ActivityChunk['status'],
    summary: string,
    changed?: string,
  ): { chunk: ActivityChunk; changed?: string } => ({
    chunk: {
      type: 'activity',
      tool: directive.kind === 'write' ? 'write_file' : 'delete_file',
      args: { path: directive.path },
      status,
      summary,
      durationMs: Math.max(0, now() - startedAt),
    },
    ...(changed === undefined ? {} : { changed }),
  });

  if (directive.kind === 'write' && !directive.closed)
    return report('error', 'missing ace-mock:end');

  const target = await resolveInside(root, directive.path);
  if (!target.ok) return report('error', target.reason);

  try {
    if (directive.kind === 'write') {
      const content = directive.lines.length === 0 ? '' : `${directive.lines.join('\n')}\n`;
      await mkdir(dirname(target.absolute), { recursive: true });
      await writeFile(target.absolute, content, 'utf8');
      return report('ok', `wrote ${Buffer.byteLength(content, 'utf8')} bytes`, target.relative);
    }

    let isFolder: boolean;
    try {
      isFolder = (await lstat(target.absolute)).isDirectory();
    } catch {
      return report('error', 'not found');
    }
    if (isFolder) return report('error', 'is a folder, not a file');
    await unlink(target.absolute);
    return report('ok', 'deleted', target.relative);
  } catch (error) {
    return report('error', fsReason(error));
  }
}

/**
 * `ace-mock:fail` as a provider error.
 *
 * `provider` with `retryable: false` — what the real CLI adapters raise for a run that failed
 * (`cliExitError`, `claudeResultError`): the engine never re-sends a non-retryable provider error
 * (`autoRetryDecision`). Not `agent`: that kind gets one contract-repair retry whatever `retryable`
 * says (`AUTO_RETRY_POLICY`), so the directive would run twice. Not `invalid_config`: nothing is
 * misconfigured, and that kind reads as a pre-flight problem in the UI.
 */
export function mockCoderFailure(message: string): ProviderCallError {
  return new ProviderCallError({
    kind: 'provider',
    code: 'mock_coder_failed',
    message: message === '' ? 'mock-coder was told to fail.' : message,
    retryable: false,
  });
}

/** The final answer: the files that really changed, each once, in the order they changed. */
export function mockCoderAnswer(changed: readonly string[], requested: number): string {
  if (requested === 0) return 'No changes requested.';
  if (changed.length === 0) return 'Changed 0 file(s).';
  return [`Changed ${changed.length} file(s):`, ...changed.map((path) => `- ${path}`)].join('\n');
}

/** `text` cut after each run of whitespace, so the pieces stream word by word and join back exactly. */
export function mockCoderPieces(text: string): string[] {
  return text.split(/(?<=\s)(?=\S)/);
}

export interface MockCoderDeps {
  now: () => number;
  /** Throws the adapter's abort error once the call's signal has aborted. */
  throwIfAborted: () => void;
}

/**
 * Run `mock-coder`: one `activity` chunk per write or delete, then the answer text as the return
 * value for the adapter to stream. Directives come from the system text (when the call has one) and
 * then the prompt. Without a working folder nothing touches the disk and no activity is reported.
 */
export async function* runMockCoder(
  req: GenerateRequest,
  deps: MockCoderDeps,
): AsyncGenerator<ActivityChunk, string, undefined> {
  deps.throwIfAborted();
  const directives = [
    ...(req.system === undefined ? [] : parseCoderDirectives(req.system)),
    ...parseCoderDirectives(req.prompt),
  ];

  const root = req.workingDir;
  if (root !== undefined && !(await isDirectory(root))) {
    // As the CLI adapters answer a project folder that has gone (X1 §4.2).
    throw new ProviderCallError({
      kind: 'invalid_config',
      code: 'project_folder_missing',
      message: `The project folder does not exist: ${root}`,
      retryable: false,
    });
  }

  const changed: string[] = [];
  let requested = 0;
  for (const directive of directives) {
    deps.throwIfAborted();
    if (directive.kind === 'fail') throw mockCoderFailure(directive.message);
    requested += 1;
    if (root === undefined) continue;

    const outcome = await applyDirective(root, directive, deps.now);
    yield outcome.chunk;
    if (outcome.changed !== undefined && !changed.includes(outcome.changed)) {
      changed.push(outcome.changed);
    }
  }

  deps.throwIfAborted();
  return root === undefined ? MOCK_CODER_NO_FOLDER : mockCoderAnswer(changed, requested);
}

/** Whether anything — a file, a folder, a link, even a dangling one — is at `path`. */
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
