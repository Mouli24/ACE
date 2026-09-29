/**
 * Test fixtures for the guardrail checks.
 *
 * **Every credential-shaped string here is assembled at runtime.** A literal would be a real-looking
 * key checked into the repository, which CLAUDE.md §2 forbids, which the shared ESLint config fails
 * on (`no-restricted-syntax` on `/^sk-[A-Za-z0-9_-]{16,}$/`), and which `packages/storage-local`
 * refuses to write to SQLite. `join`-ing the pieces keeps the *shape* — which is all a rule pack
 * matches on — without the repository ever containing the thing.
 */

import type {
  GuardrailAction,
  GuardrailCheck,
  GuardrailCheckType,
  JsonSchema,
  ToolDefinition,
  ToolPermissions,
} from '@ace/contracts';
import { GUARDRAIL_CHECK_TYPES_BY_POINT, POLICY_GUARDRAIL_POINTS } from '@ace/contracts';
import type { PolicyGuardrailPoint } from '@ace/contracts';

let sequence = 0;

/** The point a type legally belongs at, so a fixture check is one the contract would accept. */
function pointFor(type: GuardrailCheckType): PolicyGuardrailPoint {
  const point = POLICY_GUARDRAIL_POINTS.find((candidate) =>
    (GUARDRAIL_CHECK_TYPES_BY_POINT[candidate] as readonly GuardrailCheckType[]).includes(type),
  );
  if (point === undefined) throw new Error(`No policy point declares ${type}.`);
  return point;
}

/** A single check, enabled, with whatever params the test needs. */
export function makeCheck(
  type: GuardrailCheckType,
  params: Record<string, unknown> = {},
  overrides: Partial<Pick<GuardrailCheck, 'action' | 'enabled' | 'point'>> = {},
): GuardrailCheck {
  sequence += 1;
  return {
    // A ULID-shaped id, so a fixture check parses with `GuardrailCheckSchema` (see evaluate.test.ts).
    id: `01${'A'.repeat(20)}${String(sequence).padStart(4, '0')}`,
    point: overrides.point ?? pointFor(type),
    type,
    action: overrides.action ?? ('warn' satisfies GuardrailAction),
    enabled: overrides.enabled ?? true,
    params,
  };
}

/** A built-in tool definition for the tool-point checks, with sane defaults the test can override. */
export function makeTool(
  overrides: Partial<Pick<ToolDefinition, 'name' | 'inputSchema' | 'outputSchema' | 'timeoutMs'>> & {
    permissions?: Partial<ToolPermissions>;
  } = {},
): ToolDefinition {
  const permissions: ToolPermissions = {
    network: overrides.permissions?.network ?? false,
    fsPaths: overrides.permissions?.fsPaths ?? [],
    destructive: overrides.permissions?.destructive ?? false,
  };
  return {
    name: overrides.name ?? 'echo',
    description: 'a test tool',
    inputSchema: (overrides.inputSchema ?? {}) as JsonSchema,
    outputSchema: (overrides.outputSchema ?? {}) as JsonSchema,
    permissions,
    timeoutMs: overrides.timeoutMs ?? 5_000,
    source: 'builtin',
  };
}

/* -------------------------------------------------------------------------- */
/* Credential shapes — assembled, never written                               */
/* -------------------------------------------------------------------------- */

export const FAKE_OPENAI_KEY = ['sk', '-', 'A'.repeat(44)].join('');
export const FAKE_ANTHROPIC_KEY = ['sk', '-ant-', 'api03', '-', 'B'.repeat(32)].join('');
export const FAKE_GOOGLE_KEY = ['AIza', 'C'.repeat(35)].join('');
export const FAKE_GITHUB_TOKEN = ['ghp', '_', 'd'.repeat(36)].join('');
export const FAKE_GITHUB_PAT = ['github', '_pat_', 'e'.repeat(30)].join('');
export const FAKE_AWS_KEY_ID = ['AKIA', 'F'.repeat(16)].join('');
export const FAKE_SLACK_TOKEN = ['xox', 'b', '-', 'G'.repeat(24)].join('');
export const FAKE_BEARER_TOKEN = ['H'.repeat(32)].join('');
export const FAKE_GENERIC_TOKEN = ['i'.repeat(40)].join('');

/** A PEM block, marker included, built the same way. */
export const FAKE_PRIVATE_KEY_BLOCK = [
  ['-----BEGIN ', 'PRIVATE KEY', '-----'].join(''),
  'J'.repeat(64),
  'K'.repeat(64),
  ['-----END ', 'PRIVATE KEY', '-----'].join(''),
].join('\n');

/* -------------------------------------------------------------------------- */
/* Personal-data shapes                                                       */
/* -------------------------------------------------------------------------- */

export const SAMPLE_EMAIL = 'ada.lovelace@example.com';
/** A Luhn-valid test card number — the one card networks publish for exactly this purpose. */
export const SAMPLE_CARD = '4111 1111 1111 1111';
export const SAMPLE_PHONE_INTL = '+1 415 555 0132';
export const SAMPLE_PHONE_LOCAL = '(415) 555-0199';
export const SAMPLE_IBAN = 'DE89 3704 0044 0532 0130 00';
export const SAMPLE_SSN = '123-45-6789';
export const SAMPLE_PAN = 'ABCDE1234F';

/**
 * Zero-width joiner, zero-width space and a right-to-left override — built from their code points,
 * so this file does not itself contain invisible characters.
 */
export const HIDDEN_MARKERS = String.fromCodePoint(0x200d, 0x200b, 0x202e);
