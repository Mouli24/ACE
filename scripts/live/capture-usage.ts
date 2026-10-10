/**
 * Capture what each CLI really prints for one tiny prompt (Domain Phase 4, D313, D316).
 *
 *   pnpm exec tsx scripts/live/capture-usage.ts [--model <id>] [--only claude_code|codex|gemini]
 *
 * LIVE: it runs the real CLIs, signed in as whoever is signed in, and spends a few tokens on each.
 * It never runs in `pnpm test`. Each CLI is invoked exactly as its ACE adapter invokes it — the same
 * dialect arguments, stdin, environment, read-only preset and throwaway folder — and its raw stdout
 * is saved, line for line, to the providers' fixture folder:
 *
 *   packages/providers/src/adapters/cli/__tests__/fixtures/cli-output/<type>-tiny.jsonl
 *
 * The user's home folder, the throwaway folder and the user name are replaced by `<HOME>`, `<CWD>`
 * and `<USER>`, and anything key-shaped is masked, before anything is written. A CLI that is not installed is
 * skipped and reported, and its provider stays estimated-only.
 *
 * It then says where in that output usage and cost appear, if anywhere, and what the adapter's own
 * parser makes of it — the evidence the usage parsers are written against.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  claudeCodeDialect,
  codexDialect,
  geminiDialect,
  resolveCommand,
  runCli,
  type CliDialect,
} from '../../packages/providers/src/index.js';
import { maskSecrets } from '../../packages/engine/src/security/secret-patterns.js';

const { values } = parseArgs({
  options: {
    model: { type: 'string' },
    only: { type: 'string' },
  },
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'packages/providers/src/adapters/cli/__tests__/fixtures/cli-output');
const PROMPT = 'Reply with exactly the word: ok';
/** The cheapest model each CLI takes by name; `default` lets the CLI choose. */
const MODELS: Record<string, string> = {
  claude_code: 'haiku',
  codex: 'default',
  gemini: 'default',
};

const dialects: CliDialect[] = [claudeCodeDialect, codexDialect, geminiDialect].filter(
  (dialect) => values.only === undefined || dialect.type === values.only,
);

/** Every JSON path in a value whose key mentions usage, tokens or cost. */
function usagePaths(value: unknown, path = '$'): string[] {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value))
    return value.flatMap((each, index) => usagePaths(each, `${path}[${index}]`));
  return Object.entries(value).flatMap(([key, inner]) => {
    const here = `${path}.${key}`;
    const hit = /usage|token|cost/i.test(key) ? [`${here} = ${JSON.stringify(inner)}`] : [];
    return [
      ...hit,
      ...(typeof inner === 'object' && inner !== null && !/usage/i.test(key)
        ? usagePaths(inner, here)
        : []),
    ];
  });
}

function scrub(line: string, cwd: string): string {
  const variants = (path: string): string[] => [
    path,
    path.replaceAll('\\', '/'),
    path.replaceAll('\\', '\\\\'),
  ];
  let out = line;
  for (const value of variants(cwd)) out = out.split(value).join('<CWD>');
  for (const value of variants(homedir())) out = out.split(value).join('<HOME>');
  // The CLI also writes paths as slugs (C--Users-<name>-…), so the user name goes on its own.
  out = out.split(userInfo().username).join('<USER>');
  return maskSecrets(out);
}

mkdirSync(OUT, { recursive: true });
const report: string[] = [];

for (const dialect of dialects) {
  const command = resolveCommand(dialect.bin);
  if (command === undefined) {
    report.push(`${dialect.type}: not installed — skipped; usage stays estimated-only (D313).`);
    continue;
  }

  const modelId = values.model ?? MODELS[dialect.type] ?? 'default';
  const req = { modelId, prompt: PROMPT, outputTypes: ['text' as const] };
  const cwd = mkdtempSync(join(tmpdir(), 'ace-cli-'));
  const lines: string[] = [];
  try {
    const run = runCli({
      command: command.command,
      args: [...command.prefixArgs, ...dialect.args(req, 'read_only')],
      cwd,
      env: dialect.env?.(process.env) ?? process.env,
      stdin: dialect.stdin(req),
      signal: AbortSignal.timeout(180_000),
    });
    for await (const line of run.lines) lines.push(scrub(line, cwd));
    const exit = await run.exit;

    const file = join(OUT, `${dialect.type}-tiny.jsonl`);
    writeFileSync(file, `${lines.join('\n')}\n`);

    const parser = dialect.createParser();
    const chunks = [];
    for (const line of lines) {
      try {
        chunks.push(...parser.onEvent(JSON.parse(line) as Record<string, unknown>));
      } catch {
        // Not a JSON line (a banner, say): the adapter skips those too.
      }
    }
    let finish: unknown;
    try {
      finish = parser.finish(exit);
    } catch (error) {
      finish = `threw: ${error instanceof Error ? error.message : String(error)}`;
    }

    report.push(
      `${dialect.type} (${modelId}): exit ${exit.code ?? exit.signal}, ${lines.length} lines → ${file}`,
      '  where the output reports usage or cost:',
      ...lines.flatMap((line, index) => {
        try {
          return usagePaths(JSON.parse(line)).map((hit) => `    line ${index + 1}: ${hit}`);
        } catch {
          return [];
        }
      }),
      `  the adapter's parser yields: ${JSON.stringify(finish)}`,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 3 });
  }
}

console.log(report.join('\n'));
