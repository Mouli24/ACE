/**
 * PG-2.3 No silent Full auto (docs/team-prompts/product-gaps-fix-prompt.md, X6, D342).
 *
 * Phase 0 red test: no code path in `@ace/providers` builds a CLI flag that bypasses every ACE
 * approval, budget and guardrail. Today `full_auto` maps to Claude Code's
 * `--permission-mode bypassPermissions` (`adapters/cli/claude-code.ts` ~39), Codex's
 * `--dangerously-bypass-approvals-and-sandbox` (`adapters/cli/codex.ts` ~30) and Gemini's
 * `--approval-mode yolo` (`adapters/cli/gemini.ts` ~34). A scan over the shipped source — test
 * files excluded — is the guard that keeps a later change from bringing one back.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

const relativeToSrc = (file: string): string => relative(SRC, file).replaceAll('\\', '/');

function filesContaining(pattern: RegExp): string[] {
  return sourceFiles(SRC)
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))
    .map(relativeToSrc);
}

describe('PG-2.3 no code path builds a bypass-everything CLI flag', () => {
  it('the scan sees the CLI adapters (guards the scan itself; passes today)', () => {
    const files = sourceFiles(SRC).map(relativeToSrc);
    expect(files).toContain('adapters/cli/claude-code.ts');
    expect(files).toContain('adapters/cli/codex.ts');
  });

  it('no source file builds Claude Code’s bypassPermissions', () => {
    expect(filesContaining(/bypassPermissions/)).toEqual([]);
  });

  it('no source file builds Codex’s --dangerously-bypass-approvals-and-sandbox', () => {
    expect(filesContaining(/--dangerously-bypass-approvals-and-sandbox/)).toEqual([]);
  });

  it('no source file builds Gemini’s yolo approval mode', () => {
    expect(filesContaining(/['"]yolo['"]/)).toEqual([]);
  });
});
