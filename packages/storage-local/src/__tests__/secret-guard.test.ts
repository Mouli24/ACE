import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assertNoSecrets, SecretWriteRejectedError } from '../secret-guard.js';
import { makeInputNode, makeProject, makeWorkflow, scope, type InputNode } from './fixtures.js';
import { createTempDb, type TempDb } from './temp-db.js';

/**
 * BR-07 / NFR-SEC-02 — the storage guard, on the shapes the shared engine list learned in round 3.
 *
 * Every key-shaped value is assembled at runtime (CLAUDE.md §2). `'Zm9vYmFy'.repeat(5)` is forty
 * characters of letters and digits: the shape of a key without being one.
 */

const VALUE = 'Zm9vYmFy'.repeat(5);

const marker = (edge: 'BEGIN' | 'END', kind: string): string =>
  ['-----', edge, ' ', kind, 'PRIVATE KEY', kind.startsWith('PGP') ? ' BLOCK' : '', '-----'].join(
    '',
  );

const PEM_BLOCK = [
  marker('BEGIN', ''),
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC' + 'S'.repeat(32),
  marker('END', ''),
].join('\n');

const PGP_BLOCK = [
  marker('BEGIN', 'PGP '),
  'Version: GnuPG v2',
  '',
  'lQOYBF4d3q4BCADqcJ8p0Ln2uW7r' + 'M'.repeat(36),
  marker('END', 'PGP '),
].join('\n');

let db: TempDb;

beforeEach(() => {
  db = createTempDb();
});

afterEach(() => {
  db.close();
});

async function saveInputNode(text: string): Promise<InputNode> {
  const project = makeProject();
  const workflow = makeWorkflow(project.id);
  await db.repository.projects.create(scope, project);
  await db.repository.workflows.create(scope, workflow);

  const node = makeInputNode(workflow.id);
  const withText: InputNode = { ...node, config: { ...node.config, text } };
  await db.repository.nodes.insert(scope, withText);
  return withText;
}

describe('BR-07 a private key or a labelled key never reaches SQLite', () => {
  it.each([
    ['a PEM private key block', PEM_BLOCK],
    ['a PGP private key block', PGP_BLOCK],
    ['a quoted key-like assignment', `api_key = "${VALUE}"`],
    ['an unquoted API_KEY', `API_KEY=${VALUE}`],
    ['an env-style OPENAI_API_KEY', `OPENAI_API_KEY=${VALUE}`],
    ['a JSON access token', `{"access_token": "${VALUE}"}`],
  ])('refuses %s in a node config and stores nothing', async (_label, secret) => {
    await expect(saveInputNode(`Use this:\n${secret}\nthanks`)).rejects.toThrow(
      SecretWriteRejectedError,
    );

    const stored = db.sqlite.prepare('SELECT config FROM nodes').all() as { config: string }[];
    expect(stored).toEqual([]);
  });

  it('never quotes the value it refused', () => {
    let thrown: unknown;
    try {
      assertNoSecrets({ instructions: `OPENAI_API_KEY=${VALUE}` });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SecretWriteRejectedError);
    expect((thrown as Error).message).not.toContain(VALUE);
  });

  it('stores code that only reads a key, as written', async () => {
    const code = 'const apiKey = getAnthropicApiKeyFromEnvironmentOrThrow();';

    const saved = await saveInputNode(code);

    const [stored] = await db.repository.nodes.listByWorkflow(scope, saved.workflowId);
    expect(stored?.kind === 'input' && stored.config.text).toBe(code);
  });
});
