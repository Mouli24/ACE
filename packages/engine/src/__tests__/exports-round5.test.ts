import { describe, expect, it } from 'vitest';

import * as engine from '../index.js';

/**
 * Round 5 (Task 13): everything `apps/server` composes the knowledge, memory, context, trace,
 * usage, template and backup features from is reachable from `@ace/engine` itself.
 */
describe('Round 5 services are exported from @ace/engine', () => {
  it.each([
    'createKnowledgeService',
    'createIngestionWorker',
    'createSearchService',
    'KnowledgeBaseMissingError',
    'runRetrievalNode',
    'buildNodeContext',
    'createContextGuard',
    'createModelSummariser',
    'createMemoryService',
    'extractMemoryOps',
    'createTraceService',
    'foldTrace',
    'createUsageService',
    'requireUsageRepository',
    'healthMetrics',
    'createTemplateService',
    'createBackupService',
  ])('%s is a function', (name) => {
    expect(typeof (engine as Record<string, unknown>)[name]).toBe('function');
  });

  it('TEMPLATE_DEFINITIONS lists the four wizard templates, then the two parity teams (D279)', () => {
    expect(engine.TEMPLATE_DEFINITIONS.map((template) => template.id)).toEqual([
      'linear-chain',
      'review-fix',
      'parallel-research',
      'rag-qa',
      'single-builder',
      'plan-build-review',
    ]);
  });

  it('the types the server composes with are exported too', () => {
    // Compile-time: each of these resolves from the package root.
    const names: [
      engine.IngestJob | undefined,
      engine.ContextGuard | undefined,
      engine.KnowledgeService | undefined,
      engine.SearchService | undefined,
      engine.MemoryService | undefined,
      engine.TraceService | undefined,
      engine.UsageService | undefined,
      engine.TemplateService | undefined,
      engine.BackupService | undefined,
      engine.IngestionWorker | undefined,
    ] = [
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ];
    expect(names).toHaveLength(10);
  });
});
