import { fileURLToPath, pathToFileURL } from 'node:url';

import { MOCK_MODELS } from '@ace/providers';
import { describe, expect, it } from 'vitest';

/**
 * The round 5 acceptance fixtures (RAG corpus, labelled questions, workflows), checked in CI.
 *
 * The assertions live in `tests/acceptance/fixtures/round-5/check.mjs`, which is also a script
 * (`node check.mjs`); this test runs the same function against the mock adapter's model list read
 * from source, so a fixture that drifts out of shape fails `pnpm test` rather than halfway through
 * an acceptance run. Regenerate with `node tests/acceptance/fixtures/round-5/generate.mjs`.
 */

interface CheckModule {
  checkRound5Fixtures(options: { modelIds: Iterable<string> }): string[];
}

const CHECK = fileURLToPath(
  new URL('../../../../tests/acceptance/fixtures/round-5/check.mjs', import.meta.url),
);

describe('round 5 fixtures (TC-RAG-*)', () => {
  it('parse as WorkflowExport, name only mock models, and keep the corpus and questions intact', async () => {
    // A computed specifier: the script is plain JavaScript outside this package's TypeScript project.
    const { checkRound5Fixtures } = (await import(pathToFileURL(CHECK).href)) as CheckModule;

    const failures = checkRound5Fixtures({ modelIds: MOCK_MODELS.map((model) => model.modelId) });

    expect(failures).toEqual([]);
  });
});
