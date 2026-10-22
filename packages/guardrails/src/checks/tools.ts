/**
 * The tool-point checks (round 4 §2.2, FR-GRD-005/006, FR-TOOL-002, Arch §13.1, D10 defaults).
 *
 * Five things are judged when a `tool_call` chunk arrives, and the contract gives four of them a
 * `GuardrailCheckType` — `tool_allowed`, `path_confinement`, `domain_allowlist`,
 * `destructive_action` — each dispatched by `evaluateCheck` and carrying its own `action`. The
 * fifth, **arguments valid against the tool's `inputSchema`**, has no check type of its own:
 * FR-GRD-005 groups "arguments valid" with "tool allowed", and the contract's tool point has exactly
 * four types (`GUARDRAIL_CHECK_TYPES_BY_POINT.tool`). So `checkToolArgs` is exported as a standalone
 * function the engine runs at the tool point next to the policy checks — a correctness precondition
 * on the call, not something a policy switches off — and a failure is a `block` (FR-GRD-012).
 *
 * Every function here is pure and every one follows the family rule: handed no `tool` bag, it says
 * `undefined` — silence, not a pass. And no `reason` ever quotes an argument value (FR-GRD-014):
 * the reasons name the tool, the offending field, or the host, never the value the model passed.
 */

import { hostIsAllowed, type JsonSchema, type ToolDefinition } from '@ace/contracts';

import type { CheckResult, GuardrailInput } from '../types.js';

/* -------------------------------------------------------------------------- */
/* tool_allowed — the tool is one the agent switched on (FR-TOOL-002)          */
/* -------------------------------------------------------------------------- */

/**
 * `tool_allowed`: the tool being called is in the agent's `tools.enabled` set. A call to a tool the
 * agent did not enable fails, and on the default policy that is a `block` → `blocked` ToolCall and
 * node `GUARDRAIL_VIOLATION` (FR-TOOL-002, round 4 §2.2). Enablement only; the arguments are
 * `checkToolArgs`'s job.
 */
export function checkToolAllowed(input: GuardrailInput): CheckResult | undefined {
  const tool = input.tool;
  if (tool === undefined) return undefined;

  const name = tool.definition.name;
  if (tool.enabledTools.includes(name)) {
    return { passed: true, reason: `Tool ${name} is enabled for this agent.` };
  }
  return { passed: false, reason: `Tool ${name} is not enabled for this agent.` };
}

/* -------------------------------------------------------------------------- */
/* Arguments valid against the tool's inputSchema (FR-GRD-005)                 */
/* -------------------------------------------------------------------------- */

/**
 * The tool call's arguments satisfy the tool's declared `inputSchema` (round 4 §2.2, FR-GRD-005).
 * Invalid arguments are a `block`. Not a policy check type — the engine runs it at the tool point
 * itself — so it takes the definition and args directly rather than reading them off a
 * `GuardrailInput`, and answers `undefined` only when there is nothing to check.
 *
 * The JSON-schema subset it understands is the one the contract's own validator uses
 * (`SUPPORTED_JSON_SCHEMA_KEYWORDS`): `type`, `enum`, `const`, `required`, `properties`,
 * `additionalProperties`, `items`, `minimum`, `maximum`. Unknown keywords are ignored, never
 * rejected, so a richer schema still validates on the part this subset knows.
 */
export function checkToolArgs(definition: ToolDefinition, args: unknown): CheckResult | undefined {
  const schema = definition.inputSchema;
  const reason = validateAgainstJsonSchema(args, schema, '');
  if (reason === null) {
    return { passed: true, reason: `Arguments satisfy the input schema of ${definition.name}.` };
  }
  return {
    passed: false,
    reason: `Arguments to ${definition.name} are invalid: ${reason}.`,
  };
}

/* -------------------------------------------------------------------------- */
/* path_confinement — every path argument stays inside <sandbox> (FR-GRD-006)  */
/* -------------------------------------------------------------------------- */

/** The argument keys treated as filesystem paths: a single `path`, or a list under `paths`. */
const PATH_KEYS = ['path', 'paths'] as const;

/**
 * `path_confinement`: every path argument resolves inside the run's `<sandbox>` folder
 * (round 4 §2.2, FR-GRD-006, TC-GRD-006). A `../../x` that climbs out, or an absolute path
 * pointing elsewhere, fails — a `block`. Resolution is pure string arithmetic (no `node:path`,
 * which this package may not import): segments are normalised, `.` dropped and `..` popped, and the
 * result must sit at or below the sandbox at a segment boundary.
 */
export function checkPathConfinement(input: GuardrailInput): CheckResult | undefined {
  const tool = input.tool;
  if (tool === undefined) return undefined;

  const paths = pathArguments(tool.args);
  if (paths.length === 0) {
    return { passed: true, reason: 'No path argument to confine to the sandbox.' };
  }

  for (const candidate of paths) {
    if (!resolvesInside(tool.sandboxDir, candidate)) {
      return {
        passed: false,
        reason: `A path argument to ${tool.definition.name} resolves outside the run sandbox.`,
      };
    }
  }
  return { passed: true, reason: `Every path argument to ${tool.definition.name} stays in the sandbox.` };
}

/** Pull the string values under `path`/`paths` out of an args object; anything else is ignored. */
function pathArguments(args: unknown): string[] {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return [];
  const record = args as Record<string, unknown>;
  const found: string[] = [];
  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value === 'string') found.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string') found.push(item);
    }
  }
  return found;
}

/**
 * Whether `candidate`, joined to `baseDir` when relative, stays at or below `baseDir`. Pure and
 * separator-agnostic: `/` and `\` both split segments, so a Windows sandbox and a POSIX one are
 * judged the same way. An absolute candidate (leading separator, `C:` drive, or UNC) is resolved
 * from its own root, so it lands inside only when it is literally under the sandbox.
 */
function resolvesInside(baseDir: string, candidate: string): boolean {
  const base = normalizeSegments(splitPath(baseDir));
  const joined = isAbsolute(candidate)
    ? normalizeSegments(splitPath(candidate))
    : normalizeSegments([...splitPath(baseDir), ...splitPath(candidate)]);

  // A `..` that climbed above its own root is never inside anything.
  if (joined === null) return false;
  if (base === null) return false;

  if (joined.length < base.length) return false;
  for (let i = 0; i < base.length; i += 1) {
    if (joined[i] !== base[i]) return false;
  }
  return true;
}

/** Split on both separators and drop empty segments (so leading/trailing/`//` collapse away). */
function splitPath(value: string): string[] {
  return value.split(/[/\\]+/).filter((segment) => segment.length > 0);
}

function isAbsolute(value: string): boolean {
  return /^[/\\]/.test(value) || /^[A-Za-z]:[/\\]?/.test(value);
}

/**
 * Resolve `.` and `..` inside an already-split path. Returns `null` when a `..` would pop above the
 * root — that is an escape, and the caller treats it as "not inside".
 */
function normalizeSegments(segments: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* domain_allowlist — a URL's host is on the agent's list (FR-GRD-007)         */
/* -------------------------------------------------------------------------- */

/** The argument key treated as a request URL — the built-in `http_request`/`web_fetch` shape. */
const URL_KEY = 'url';

/**
 * `domain_allowlist`: when the call carries a `url` argument, its host is on the agent's
 * `allowedDomains` list (round 4 §2.2, FR-GRD-007, TC-GRD-007). An **empty list allows nothing**,
 * so every URL is blocked until a host is added. A URL that will not parse is blocked too — a host
 * that cannot be read cannot be allow-listed. A call with no `url` argument has nothing to judge and
 * passes. On the default policy a failure is a `block`.
 *
 * A host matches an entry exactly, or as a subdomain of it (`api.example.com` matches `example.com`)
 * — the contract's `hostIsAllowed`, which `http_request`/`web_fetch` re-run on every redirect.
 */
export function checkDomainAllowlist(input: GuardrailInput): CheckResult | undefined {
  const tool = input.tool;
  if (tool === undefined) return undefined;

  const url = urlArgument(tool.args);
  if (url === undefined) {
    return { passed: true, reason: 'No URL argument to check against the allow-list.' };
  }

  const host = hostOf(url);
  if (host === undefined) {
    return { passed: false, reason: `The URL argument to ${tool.definition.name} is not a valid URL.` };
  }

  if (hostIsAllowed(host, tool.allowedDomains)) {
    return { passed: true, reason: `Host ${host} is on the allow-list.` };
  }
  return { passed: false, reason: `Host ${host} is not on the allow-list.` };
}

function urlArgument(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>)[URL_KEY];
  return typeof value === 'string' ? value : undefined;
}

/** The lower-cased host of a URL, or `undefined` when it does not parse. `URL` is a JS global. */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* destructive_action — a destructive tool always asks (FR-GRD-006)            */
/* -------------------------------------------------------------------------- */

/**
 * `destructive_action`: a tool whose `permissions.destructive` is true always trips, so the engine
 * applies its action — `ask_user` on the default policy, which pauses the node for the Round 3
 * approval card (round 4 §2.2, FR-GRD-006, BR-14, Arch §13.1 "destructive always asks"). A reject
 * fails the node `GUARDRAIL_VIOLATION`. A non-destructive tool passes.
 */
export function checkDestructiveAction(input: GuardrailInput): CheckResult | undefined {
  const tool = input.tool;
  if (tool === undefined) return undefined;

  const name = tool.definition.name;
  if (tool.definition.permissions.destructive) {
    return { passed: false, reason: `Tool ${name} performs a destructive action and needs approval.` };
  }
  return { passed: true, reason: `Tool ${name} is not destructive.` };
}

/* -------------------------------------------------------------------------- */
/* A minimal JSON-schema validator (the SUPPORTED_JSON_SCHEMA_KEYWORDS subset)  */
/* -------------------------------------------------------------------------- */

/*
 * The same subset and reasoning the contract's `validateAgainstContract` uses, applied to a raw
 * arguments value rather than to output `Part`s. It lives here because `packages/contracts` does not
 * export its internal `checkJsonSchema` and this package may only import `@ace/contracts`; the
 * keyword list is imported from the contract so the two cannot drift on *which* keywords exist. No
 * reason string ever includes the actual value — only paths and schema-side expectations
 * (FR-GRD-014).
 */

function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(actual: string, expected: string): boolean {
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return actual === expected;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The first reason `value` does not satisfy `schema`, or `null` when it does. Pure, value-free. */
function validateAgainstJsonSchema(value: unknown, schema: JsonSchema, path: string): string | null {
  const at = path === '' ? 'the arguments' : `"${path}"`;

  if ('const' in schema && !sameValue(value, schema.const)) {
    return `${at} must equal ${JSON.stringify(schema.const)}`;
  }

  const allowed = schema.enum;
  if (Array.isArray(allowed) && !allowed.some((option) => sameValue(value, option))) {
    return `${at} must be one of ${JSON.stringify(allowed)}`;
  }

  const expectedTypes =
    typeof schema.type === 'string'
      ? [schema.type]
      : Array.isArray(schema.type)
        ? schema.type.filter((t): t is string => typeof t === 'string')
        : [];

  const actualType = jsonTypeOf(value);
  if (expectedTypes.length > 0 && !expectedTypes.some((t) => typeMatches(actualType, t))) {
    return `${at} must be ${expectedTypes.join(' or ')}, got ${actualType}`;
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      return `${at} must be >= ${schema.minimum}`;
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      return `${at} must be <= ${schema.maximum}`;
    }
  }

  if (isPlainObject(value)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === 'string' && !(key in value)) {
        return `${at} is missing required field "${key}"`;
      }
    }

    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const [key, subSchema] of Object.entries(properties)) {
      if (!(key in value) || !isPlainObject(subSchema)) continue;
      const reason = validateAgainstJsonSchema(
        value[key],
        subSchema,
        path === '' ? key : `${path}.${key}`,
      );
      if (reason !== null) return reason;
    }

    if (schema.additionalProperties === false) {
      const declared = new Set(Object.keys(properties));
      const extra = Object.keys(value).find((key) => !declared.has(key));
      if (extra !== undefined) return `${at} has an unexpected field "${extra}"`;
    }
  }

  if (Array.isArray(value) && isPlainObject(schema.items)) {
    for (const [index, item] of value.entries()) {
      const reason = validateAgainstJsonSchema(
        item,
        schema.items,
        `${path === '' ? 'items' : path}[${index}]`,
      );
      if (reason !== null) return reason;
    }
  }

  return null;
}
