import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { type ToolDefinition } from '@ace/contracts';
import { z } from 'zod';

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
    path: { type: 'string', description: 'Folder relative to the project; the project root when omitted.' },
    recursive: { type: 'boolean' },
    maxEntries: { type: 'integer', minimum: 1, maximum: 2000 },
  },
  [],
);

export function createListFilesTool(): RegisteredTool {
  return {
    definition: LIST_FILES_DEFINITION,
    implementation: async (args, context) => {
      const { path, recursive = false, maxEntries = 500 } = parse(ListArgs, args, 'list_files', '{ path?, recursive?, maxEntries? }');
      const start = where(context, 'list_files', 'list', path);
      const projectDir = context.projectDir as string;
      const entries: string[] = [];
      let truncated = false;

      const walk = (dir: string): void => {
        const children = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
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
      const { path, offset, limit } = parse(ReadArgs, args, 'read_file', '{ path, offset?, limit? }');
      const target = where(context, 'read_file', 'read', path);
      if (!existsSync(target) || !statSync(target).isFile()) {
        throw new ToolError('invalid_args', 'read_file', `read_file: ${path} is not a file.`);
      }
      const bytes = readFileSync(target);
      if (bytes.includes(0)) {
        throw new ToolError('invalid_args', 'read_file', `read_file: ${path} looks binary; it reads text only.`);
      }
      const lines = bytes.toString('utf8').split(/\r?\n/);
      const from = (offset ?? 1) - 1;
      const window = limit === undefined ? lines.slice(from) : lines.slice(from, from + limit);
      let content = offset === undefined && limit === undefined ? bytes.toString('utf8') : window.join('\n');
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
      const created = !existsSync(target);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf8');
      return {
        path: projectRelative(context.projectDir as string, target),
        bytes: Buffer.byteLength(content, 'utf8'),
        created,
      };
    },
  };
}

/* ------------------------------------------------------------------- edit_file */

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
      const { path, oldString, newString, replaceAll = false } = parse(
        EditArgs,
        args,
        'edit_file',
        '{ path, oldString, newString, replaceAll? }',
      );
      const target = where(context, 'edit_file', 'edit', path);
      assertWritable(context.projectDir as string, target, 'edit_file');
      if (!existsSync(target) || !statSync(target).isFile()) {
        throw new ToolError('invalid_args', 'edit_file', `edit_file: ${path} is not a file.`);
      }
      const text = readFileSync(target, 'utf8');
      const matches = text.split(oldString).length - 1;
      if (matches === 0) {
        throw new ToolError('invalid_args', 'edit_file', 'edit_file: oldString was not found in the file.');
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
      const next = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, () => newString);
      writeFileSync(target, next, 'utf8');
      return {
        path: projectRelative(context.projectDir as string, target),
        replacements: replaceAll ? matches : 1,
      };
    },
  };
}
