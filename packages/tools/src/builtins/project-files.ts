import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { type ToolDefinition } from '@ace/contracts';
import { z } from 'zod';

import { contentHash } from '../agent/ledger.js';
import { type AgentSession } from '../agent/session.js';
import { ToolError } from '../errors.js';
import { assertInsideProject, assertWritable, projectRelative } from '../project/paths.js';
import { type RegisteredTool } from '../registry.js';
import { type ToolContext } from '../tool.js';

/**
 * The project file tools (X1, FR-TOOL-008): list, read, write and edit files in the run's project
 * folder. Every path is confined by {@link assertInsideProject} (TC-TOOL-009); writes stay out of
 * `.git` and `.ace`. None is destructive — a write is recoverable through git — so none waits for an
 * approval; `run_command` is the one that does.
 */

const PROJECT = '<project>';
const READ_LIMIT_CHARS = 256 * 1024;
/** Agentic nodes: lines `read_file` shows when no `limit` is given. */
const AGENT_READ_LINES = 2000;
/** Agentic nodes: a line longer than this is cut, and marked. */
const AGENT_LINE_CHARS = 2000;
const LINE_CUT_MARK = '… [line truncated]';
const SKIPPED = new Set(['.git', 'node_modules', '.ace']);

function definition(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    outputSchema: { type: 'object' },
    permissions: { network: false, fsPaths: [PROJECT], destructive: false },
    timeoutMs: 10_000,
    source: 'builtin',
  };
}

function parse<T>(schema: z.ZodType<T>, args: unknown, tool: string, usage: string): T {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    throw new ToolError('invalid_args', tool, `${tool} needs ${usage}.`, {
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  }
  return parsed.data;
}

const where = (context: ToolContext, tool: string, operation: string, path: string | undefined) =>
  assertInsideProject({
    projectDir: context.projectDir,
    candidate: path,
    toolName: tool,
    operation,
    logger: context.logger,
    runId: context.runId,
  });

/* ------------------------------------------------------------------ list_files */

const ListArgs = z.strictObject({
  path: z.string().optional(),
  recursive: z.boolean().optional(),
  maxEntries: z.number().int().min(1).max(2000).optional(),
});

export const LIST_FILES_DEFINITION = definition(
  'list_files',
  'Lists files and folders in the project folder (skips .git, node_modules and .ace). Folders end in "/".',
  {
    path: {
      type: 'string',
      description: 'Folder relative to the project; the project root when omitted.',
    },
    recursive: { type: 'boolean' },
    maxEntries: { type: 'integer', minimum: 1, maximum: 2000 },
  },
  [],
);

export function createListFilesTool(): RegisteredTool {
  return {
    definition: LIST_FILES_DEFINITION,
    implementation: async (args, context) => {
      const {
        path,
        recursive = false,
        maxEntries = 500,
      } = parse(ListArgs, args, 'list_files', '{ path?, recursive?, maxEntries? }');
      const start = where(context, 'list_files', 'list', path);
      const projectDir = context.projectDir as string;
      const entries: string[] = [];
      let truncated = false;

      const walk = (dir: string): void => {
        const children = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
          a.name.localeCompare(b.name),
        );
        for (const child of children) {
          if (child.isDirectory() && SKIPPED.has(child.name)) continue;
          if (entries.length >= maxEntries) {
            truncated = true;
            return;
          }
          const full = join(dir, child.name);
          entries.push(`${projectRelative(projectDir, full)}${child.isDirectory() ? '/' : ''}`);
          if (recursive && child.isDirectory()) walk(full);
        }
      };
      walk(start);
      return { entries, truncated };
    },
  };
}

/* ------------------------------------------------------------------- read_file */

const ReadArgs = z.strictObject({
  path: z.string(),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(5000).optional(),
});

export const READ_FILE_DEFINITION = definition(
  'read_file',
  'Reads a UTF-8 text file in the project folder. Use offset/limit (1-based lines) for a window.',
  {
    path: { type: 'string', description: 'File path relative to the project folder.' },
    offset: { type: 'integer', minimum: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 5000 },
  },
  ['path'],
);

export function createReadFileTool(): RegisteredTool {
  return {
    definition: READ_FILE_DEFINITION,
    implementation: async (args, context) => {
      const { path, offset, limit } = parse(
        ReadArgs,
        args,
        'read_file',
        '{ path, offset?, limit? }',
      );
      const target = where(context, 'read_file', 'read', path);
      if (!existsSync(target) || !statSync(target).isFile()) {
        throw new ToolError('invalid_args', 'read_file', `read_file: ${path} is not a file.`);
      }
      const bytes = readFileSync(target);
      const agent = agentOf(context);
      // The whole file's hash, even for a window: the rule is "unchanged since you looked".
      agent?.session.ledger.record(agent.nodeId, target, contentHash(bytes));
      if (bytes.includes(0)) {
        if (agent !== undefined) {
          return {
            path: projectRelative(context.projectDir as string, target),
            content: '',
            binary: true,
            bytes: bytes.length,
            notice: `${path} is a binary file (${bytes.length} bytes); read_file shows text only.`,
          };
        }
        throw new ToolError(
          'invalid_args',
          'read_file',
          `read_file: ${path} looks binary; it reads text only.`,
        );
      }
      if (agent !== undefined) return readForAgent(context, target, bytes, offset, limit);
      const lines = bytes.toString('utf8').split(/\r?\n/);
      const from = (offset ?? 1) - 1;
      const window = limit === undefined ? lines.slice(from) : lines.slice(from, from + limit);
      let content =
        offset === undefined && limit === undefined ? bytes.toString('utf8') : window.join('\n');
      const truncated = content.length > READ_LIMIT_CHARS;
      if (truncated) content = content.slice(0, READ_LIMIT_CHARS);
      return {
        path: projectRelative(context.projectDir as string, target),
        content,
        totalLines: lines.length,
        truncated,
      };
    },
  };
}

/**
 * `read_file` for an agentic node (a session and a node id): the same `content` as a chat turn
 * gets — raw text, not numbered — but bounded the way a model's context needs: at most
 * {@link AGENT_READ_LINES} lines unless `limit` says otherwise, and no line longer than
 * {@link AGENT_LINE_CHARS} characters. A file that fits is returned byte-for-byte, line endings
 * and all; a cut one is joined with `\n` and says where to continue.
 */
function readForAgent(
  context: ToolContext,
  target: string,
  bytes: Buffer,
  offset: number | undefined,
  limit: number | undefined,
): Record<string, unknown> {
  const text = bytes.toString('utf8');
  const lines = text.split(/\r?\n/);
  const from = (offset ?? 1) - 1;
  const window = lines.slice(from, from + (limit ?? AGENT_READ_LINES));
  let cutLine = false;
  const shown = window.map((line) => {
    if (line.length <= AGENT_LINE_CHARS) return line;
    cutLine = true;
    return `${line.slice(0, AGENT_LINE_CHARS)}${LINE_CUT_MARK}`;
  });
  const whole = offset === undefined && limit === undefined && window.length === lines.length;
  let content = whole && !cutLine ? text : shown.join('\n');
  const moreLines = from + window.length < lines.length;
  let truncated = moreLines || cutLine;
  if (content.length > READ_LIMIT_CHARS) {
    content = content.slice(0, READ_LIMIT_CHARS);
    truncated = true;
  }
  return {
    path: projectRelative(context.projectDir as string, target),
    content,
    totalLines: lines.length,
    truncated,
    ...(moreLines ? { nextOffset: from + window.length + 1 } : {}),
  };
}

/** The node and the run's shared session, when the call comes from an agentic node. */
function agentOf(context: ToolContext): { session: AgentSession; nodeId: string } | undefined {
  const { session, nodeId } = context;
  return session !== undefined && nodeId !== undefined && nodeId !== ''
    ? { session, nodeId }
    : undefined;
}

/** Runs `fn` under the run's per-path write lock, or directly without a session. */
const underLock = <T>(context: ToolContext, target: string, fn: () => Promise<T>): Promise<T> =>
  context.session === undefined ? fn() : context.session.locks.withLock(target, fn);

/**
 * Read-before-edit (agentic nodes): an existing file may be overwritten or edited only by a node
 * that has seen its current content — read it, or wrote it last itself. Anything else (another
 * node's edit, a command, the person in Forge) changed it under the node, which must read it again
 * rather than overwrite a change it never saw. A no-op without a session.
 */
function assertSeenCurrent(context: ToolContext, tool: string, target: string, path: string): void {
  const agent = agentOf(context);
  if (agent === undefined || !existsSync(target)) return;
  const seen = agent.session.ledger.seen(agent.nodeId, target);
  if (seen === undefined) {
    throw new ToolError(
      'invalid_args',
      tool,
      `${tool}: this node has not read ${path} yet. Call read_file on it first, then retry.`,
      { reason: 'not_read' },
    );
  }
  if (seen !== contentHash(readFileSync(target))) {
    throw new ToolError(
      'invalid_args',
      tool,
      `${tool}: ${path} has changed since this node last read it. Call read_file on it again, then retry.`,
      { reason: 'changed_since_read' },
    );
  }
}

/** After a successful write: the node has seen what it wrote, so it may keep editing it. */
function recordWrite(context: ToolContext, target: string, written: string): void {
  const agent = agentOf(context);
  agent?.session.ledger.record(agent.nodeId, target, contentHash(written));
}

/* ------------------------------------------------------------------ write_file */

const WriteArgs = z.strictObject({ path: z.string(), content: z.string() });

export const WRITE_FILE_DEFINITION = definition(
  'write_file',
  'Creates or overwrites a text file in the project folder, creating its folders.',
  {
    path: { type: 'string', description: 'File path relative to the project folder.' },
    content: { type: 'string' },
  },
  ['path', 'content'],
);

export function createWriteFileTool(): RegisteredTool {
  return {
    definition: WRITE_FILE_DEFINITION,
    implementation: async (args, context) => {
      const { path, content } = parse(WriteArgs, args, 'write_file', '{ path, content }');
      const target = where(context, 'write_file', 'write', path);
      assertWritable(context.projectDir as string, target, 'write_file');
      return underLock(context, target, async () => {
        assertSeenCurrent(context, 'write_file', target, path);
        const created = !existsSync(target);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content, 'utf8');
        recordWrite(context, target, content);
        return {
          path: projectRelative(context.projectDir as string, target),
          bytes: Buffer.byteLength(content, 'utf8'),
          created,
        };
      });
    },
  };
}

/* ------------------------------------------------------------------- edit_file */

/** Every line break in `text` is CRLF (and there is at least one). Mixed files are left alone. */
const isCrlf = (text: string): boolean => text.includes('\r\n') && !/(^|[^\r])\n/.test(text);
/** `\n` → `\r\n`, leaving any `\r\n` already there as it is. */
const toCrlf = (text: string): string => text.replace(/\r?\n/g, '\r\n');

const EditArgs = z.strictObject({
  path: z.string(),
  oldString: z.string().min(1),
  newString: z.string(),
  replaceAll: z.boolean().optional(),
});

export const EDIT_FILE_DEFINITION = definition(
  'edit_file',
  'Replaces exact text in a file in the project folder. oldString must match exactly once unless replaceAll is true.',
  {
    path: { type: 'string', description: 'File path relative to the project folder.' },
    oldString: { type: 'string' },
    newString: { type: 'string' },
    replaceAll: { type: 'boolean' },
  },
  ['path', 'oldString', 'newString'],
);

export function createEditFileTool(): RegisteredTool {
  return {
    definition: EDIT_FILE_DEFINITION,
    implementation: async (args, context) => {
      const {
        path,
        oldString,
        newString,
        replaceAll = false,
      } = parse(EditArgs, args, 'edit_file', '{ path, oldString, newString, replaceAll? }');
      const target = where(context, 'edit_file', 'edit', path);
      assertWritable(context.projectDir as string, target, 'edit_file');
      return underLock(context, target, async () => {
        if (!existsSync(target) || !statSync(target).isFile()) {
          throw new ToolError('invalid_args', 'edit_file', `edit_file: ${path} is not a file.`);
        }
        assertSeenCurrent(context, 'edit_file', target, path);
        const text = readFileSync(target, 'utf8');
        // A CRLF file stays CRLF: the model writes `\n`, so its strings follow the file's endings.
        const crlf = isCrlf(text);
        const find = crlf ? toCrlf(oldString) : oldString;
        const put = crlf ? toCrlf(newString) : newString;
        const matches = text.split(find).length - 1;
        if (matches === 0) {
          throw new ToolError(
            'invalid_args',
            'edit_file',
            'edit_file: oldString was not found in the file (found 0 times); read the file and copy the text exactly.',
            { matches },
          );
        }
        if (matches > 1 && !replaceAll) {
          throw new ToolError(
            'invalid_args',
            'edit_file',
            `edit_file: oldString matches ${matches} times; give more context or set replaceAll.`,
            { matches },
          );
        }
        // A function replacement, so `$&` and friends in newString stay literal.
        const next = replaceAll ? text.split(find).join(put) : text.replace(find, () => put);
        writeFileSync(target, next, 'utf8');
        recordWrite(context, target, next);
        return {
          path: projectRelative(context.projectDir as string, target),
          replacements: replaceAll ? matches : 1,
        };
      });
    },
  };
}
