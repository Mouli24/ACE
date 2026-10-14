import { existsSync, statSync } from 'node:fs';

import {
  FileSearchRequestSchema,
  SEARCH_MAX_RESULTS,
  type FileSearchRequest,
  type ToolDefinition,
} from '@ace/contracts';
import { z } from 'zod';

import { ToolError } from '../errors.js';
import { assertInsideProject, projectRelative } from '../project/paths.js';
import { type RegisteredTool } from '../registry.js';
import { searchFiles } from '../workspace/search.js';

/**
 * `search` (agentic nodes, Phase 1 — FR-TOOL-008): a regex content search over the project folder
 * for a model, on Forge's own search (`searchFiles`, D299): gitignore-aware, never `node_modules`
 * or hidden folders, binary and oversized files skipped, a regex run in a worker with a hard
 * deadline. It answers one `path:line: text` line per matching line, capped (default
 * {@link DEFAULT_MAX_RESULTS}) with `truncated` when the cap or a deadline cut it short.
 */

const DEFAULT_MAX_RESULTS = 200;

const SearchArgs = z.strictObject({
  pattern: z.string().min(1),
  path: z.string().optional(),
  glob: z.string().optional(),
  maxResults: z.number().int().min(1).max(SEARCH_MAX_RESULTS).optional(),
});

export const SEARCH_DEFINITION: ToolDefinition = {
  name: 'search',
  description:
    'Searches file contents in the project folder with a regular expression (skips .gitignore’d files and node_modules). Answers "path:line: text" lines.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript regular expression, case-sensitive.' },
      path: {
        type: 'string',
        description: 'Folder or file relative to the project; the whole project when omitted.',
      },
      glob: { type: 'string', description: 'Only files matching this glob, e.g. "*.ts".' },
      maxResults: { type: 'integer', minimum: 1, maximum: SEARCH_MAX_RESULTS },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  outputSchema: { type: 'object' },
  permissions: { network: false, fsPaths: ['<project>'], destructive: false },
  timeoutMs: 15_000,
  source: 'builtin',
};

/**
 * The `include` list (gitignore syntax, comma separated) that keeps a search to `rel` — a folder
 * or a file below the project root — and to `glob`. A leading `/` anchors a rule at the root.
 */
function includeFor(rel: string, isFile: boolean, glob: string | undefined): string | undefined {
  const globs = (glob ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (rel === '.') return globs.length === 0 ? undefined : globs.join(',');
  if (isFile) return `/${rel}`;
  if (globs.length === 0) return `/${rel}/`;
  return globs
    .map((part) => (part.includes('/') ? `/${rel}/${part}` : `/${rel}/**/${part}`))
    .join(',');
}

export function createSearchTool(): RegisteredTool {
  return {
    definition: SEARCH_DEFINITION,
    implementation: async (args, context) => {
      const parsed = SearchArgs.safeParse(args ?? {});
      if (!parsed.success) {
        throw new ToolError(
          'invalid_args',
          'search',
          'search needs { pattern, path?, glob?, maxResults? }.',
          {
            issues: parsed.error.issues.map((issue) => issue.message),
          },
        );
      }
      const { pattern, path, glob, maxResults = DEFAULT_MAX_RESULTS } = parsed.data;
      const target = assertInsideProject({
        projectDir: context.projectDir,
        candidate: path,
        toolName: 'search',
        operation: 'search',
        logger: context.logger,
        runId: context.runId,
      });
      const projectDir = context.projectDir as string;
      const isFile = existsSync(target) && statSync(target).isFile();
      const include = includeFor(projectRelative(projectDir, target), isFile, glob);

      const request = FileSearchRequestSchema.safeParse({
        query: pattern,
        regex: true,
        matchCase: true,
        maxResults,
        ...(include === undefined ? {} : { include }),
      } satisfies FileSearchRequest);
      if (!request.success) {
        throw new ToolError(
          'invalid_args',
          'search',
          `search: ${request.error.issues[0]?.message ?? 'the pattern is not a valid regular expression.'}`,
        );
      }

      const result = await searchFiles(
        projectDir,
        request.data,
        context.signal === undefined ? {} : { signal: context.signal },
      );
      const lines: string[] = [];
      let matches = 0;
      for (const file of result.files) {
        let lastLine = 0;
        for (const match of file.matches) {
          matches += 1;
          // Two matches on one line are one line of output.
          if (match.line === lastLine) continue;
          lastLine = match.line;
          lines.push(`${file.path}:${match.line}: ${match.preview}`);
        }
      }
      return {
        output: lines.join('\n'),
        matches,
        truncated: result.truncated,
        ...(result.timedOut === true ? { timedOut: true } : {}),
      };
    },
  };
}
