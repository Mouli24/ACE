import { SecretWriteRejectedError as EngineSecretWriteRejectedError, newId } from '@ace/engine';
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

  it('refuses with the error the engine defines, so the gateway can answer 400 (NFR-USE-03)', () => {
    let thrown: unknown;
    try {
      assertNoSecrets({ instructions: `api_key = "${VALUE}"` }, 'node(x).config');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(EngineSecretWriteRejectedError);
    expect((thrown as EngineSecretWriteRejectedError).path).toBe('node(x).config.instructions');
  });

  it('stores code that only reads a key, as written', async () => {
    const code = 'const apiKey = getAnthropicApiKeyFromEnvironmentOrThrow();';

    const saved = await saveInputNode(code);

    const [stored] = await db.repository.nodes.listByWorkflow(scope, saved.workflowId);
    expect(stored?.kind === 'input' && stored.config.text).toBe(code);
  });
});

/* -------------------------------------------------------------------------- */
/* A key where a name goes                                                     */
/* -------------------------------------------------------------------------- */

/** A GitHub-token shape, built at runtime. */
const KEY = ['ghp', '_', 'a1B2'.repeat(9)].join('');

function refusalOf(write: () => void): SecretWriteRejectedError {
  try {
    write();
  } catch (error) {
    if (error instanceof SecretWriteRejectedError) return error;
    throw error;
  }
  throw new Error('the write was not refused');
}

describe('BR-07 a key used as a field name never reaches SQLite, nor the refusal', () => {
  it('refuses an object key that is itself a key, and masks it in the path it reports', () => {
    const refused = refusalOf(() => assertNoSecrets({ params: { [KEY]: true } }, 'check'));

    expect(refused.path).toBe('check.params.[REDACTED]');
    expect(refused.message).not.toContain(KEY);
  });

  it('refuses it however deep it is nested, and inside arrays', () => {
    const refused = refusalOf(() => assertNoSecrets([{ a: { b: [{ [`x ${KEY}`]: 1 }] } }]));

    expect(refused.message).not.toContain(KEY);
    expect(refused.path).toBe('$[0].a.b[0].x [REDACTED]');
  });

  it('refuses a policy whose check params use a key as a field name', async () => {
    const project = await db.repository.projects.create(scope, makeProject());
    const policy = await db.repository.guardrailPolicies.getProjectDefault(scope, project.id);
    if (policy === null) throw new Error('every project has a default policy');
    const [first, ...rest] = policy.checks;
    if (first === undefined) throw new Error('the default policy has checks');

    await expect(
      db.repository.guardrailPolicies.update(scope, policy.id, {
        checks: [{ ...first, params: { [KEY]: true } }, ...rest],
      }),
    ).rejects.toThrow(SecretWriteRejectedError);
    expect(JSON.stringify(dump())).not.toContain(KEY);
  });
});

/** Every guardrail policy row, raw, so a test can prove a key is nowhere in the table. */
function dump(): unknown[] {
  return db.sqlite.prepare('SELECT * FROM guardrail_policies').all();
}

describe('BR-07 a policy named with a key is refused on every write path', () => {
  it('refuses to create one, and stores nothing', async () => {
    const project = await db.repository.projects.create(scope, makeProject());
    const policy = await db.repository.guardrailPolicies.getProjectDefault(scope, project.id);
    if (policy === null) throw new Error('every project has a default policy');

    await expect(
      db.repository.guardrailPolicies.create(scope, {
        ...policy,
        id: newId(),
        name: KEY,
        isProjectDefault: false,
      }),
    ).rejects.toThrow(SecretWriteRejectedError);
    expect(JSON.stringify(dump())).not.toContain(KEY);
  });

  it('refuses a rename in place', async () => {
    const project = await db.repository.projects.create(scope, makeProject());
    const policy = await db.repository.guardrailPolicies.getProjectDefault(scope, project.id);
    if (policy === null) throw new Error('every project has a default policy');

    await expect(
      db.repository.guardrailPolicies.update(scope, policy.id, { name: KEY }),
    ).rejects.toThrow(SecretWriteRejectedError);
    expect(JSON.stringify(dump())).not.toContain(KEY);
  });

  it('refuses a rename that writes a new version, and leaves no version behind', async () => {
    const project = await db.repository.projects.create(scope, makeProject());
    const policy = await db.repository.guardrailPolicies.getProjectDefault(scope, project.id);
    if (policy === null) throw new Error('every project has a default policy');

    await expect(
      db.repository.guardrailPolicies.update(scope, policy.id, { name: KEY, version: 2 }),
    ).rejects.toThrow(SecretWriteRejectedError);
    expect(await db.repository.guardrailPolicies.getVersion(scope, policy.id, 2)).toBeNull();
    // The refused write cleared nothing: version 1 is still the project's default (D10).
    expect(
      await db.repository.guardrailPolicies.getProjectDefault(scope, project.id),
    ).toMatchObject({ id: policy.id, version: 1 });
    expect(JSON.stringify(dump())).not.toContain(KEY);
  });

  it('still stores an ordinary name', async () => {
    const project = await db.repository.projects.create(scope, makeProject());
    const policy = await db.repository.guardrailPolicies.getProjectDefault(scope, project.id);
    if (policy === null) throw new Error('every project has a default policy');

    const renamed = await db.repository.guardrailPolicies.update(scope, policy.id, {
      name: 'Strict — no tokens in outputs',
    });
    expect(renamed?.name).toBe('Strict — no tokens in outputs');
  });
});
