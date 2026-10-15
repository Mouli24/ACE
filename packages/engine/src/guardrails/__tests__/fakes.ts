import type { RunApprovalRequest } from '../../ports/index.js';
import {
  NodeSchema,
  SettingsSchema,
  derivePorts,
  type ApprovalDecision,
  
  type GuardrailCheck,
  type GuardrailPolicy,
  type Id,
  type Node,
  type NodeRun,
  type Project,
  type Settings,
  type Verdict,
} from '@ace/contracts';

import type { EmittedEvent, EventBus } from '../../events/index.js';
import { newId } from '../../ids.js';
import type { EngineEvent, Scope, Unsubscribe } from '../../ports/index.js';
import type { CheckInput, CheckOutcome, CheckRunner, MaskResult, SecretMasker } from '../checks.js';
import type { GuardrailStore, StoredApproval } from '../ports.js';

/**
 * In-memory doubles for everything the guardrail services depend on.
 *
 * The check runner here is a *fake*, not a copy of the real rule packs: those live in
 * `@ace/guardrails` and are another author's work. Its job is to be predictable enough that a test
 * can say "this check triggered with these types" and mean it — so every pattern below is the
 * smallest thing that makes its TC legible, and nothing in the engine reads them.
 *
 * Nothing in this file contains a real credential. The key-shaped strings are assembled at runtime
 * from pieces, so the repository never holds one (BR-07) and the lint rule has nothing to find.
 */

/* -------------------------------------------------------------------------- */
/* Key-shaped test strings, built at runtime                                   */
/* -------------------------------------------------------------------------- */

export const fakeOpenAiKey = (): string => ['sk', '-', 'a'.repeat(40)].join('');
export const fakeAnthropicKey = (): string => ['sk', '-', 'ant', '-', 'b'.repeat(48)].join('');
export const fakeAwsKey = (): string => ['AKIA', 'C'.repeat(16)].join('');

/**
 * The key shapes this fake recognises. Scanned with a regex over the whole text rather than word by
 * word, because a leaked key rarely stands alone: `AWS_ACCESS_KEY_ID=AKIA…` and `"key":"sk-…"` are
 * how one actually appears, and a whitespace split misses both. The real pack in `@ace/guardrails`
 * must do at least this much — the report says so.
 */
const KEY_PATTERN = /(sk-ant-|sk-|AIza|ghp_|AKIA)[A-Za-z0-9_-]{12,}/g;

/** Every key-shaped token in `text`. */
function keyMatches(text: string): { match: string; type: string }[] {
  return [...text.matchAll(KEY_PATTERN)].map((match) => ({ match: match[0], type: 'api_key' }));
}

/* -------------------------------------------------------------------------- */
/* The check runner                                                            */
/* -------------------------------------------------------------------------- */

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE = /\+?\d[\d\s-]{8,}\d/g;
const INJECTION = /(ignore (all )?previous instructions|disregard the system prompt|you are now)/i;
const MODERATION = /(kill|hate|bomb)/i;

function replaceAll(text: string, pattern: RegExp, label: string): string {
  return text.replace(pattern, `[${label} redacted]`);
}

/**
 * A stand-in for `@ace/guardrails`. Implements the round-3 input, output and loop checks; returns
 * `undefined` for the tool and context check types, exactly as the real runner must for rounds 4–5.
 */
export const fakeChecks: CheckRunner = {
  evaluate(check: GuardrailCheck, input: CheckInput): CheckOutcome | undefined {
    switch (check.type) {
      case 'size_limit': {
        const max = typeof check.params['maxChars'] === 'number' ? check.params['maxChars'] : 200_000;
        return input.text.length <= max
          ? { passed: true, reason: `${input.text.length} characters, within ${max}.` }
          : { passed: false, reason: `${input.text.length} characters, over the ${max} limit.` };
      }

      case 'pii': {
        const types: string[] = [];
        if (EMAIL.test(input.text)) types.push('email');
        EMAIL.lastIndex = 0;
        if (PHONE.test(input.text)) types.push('phone');
        PHONE.lastIndex = 0;

        if (types.length === 0) return { passed: true, reason: 'No personal data found.' };

        let sanitized = replaceAll(input.text, EMAIL, 'email');
        sanitized = replaceAll(sanitized, PHONE, 'phone');
        return {
          passed: false,
          reason: `Personal data found: ${types.join(', ')}.`,
          redactedTypes: types,
          sanitized,
        };
      }

      case 'prompt_injection':
        return INJECTION.test(input.text)
          ? { passed: false, reason: 'The text tries to override the system prompt.' }
          : { passed: true, reason: 'No injection pattern found.' };

      case 'blocked_topics': {
        const patterns = Array.isArray(check.params['patterns'])
          ? (check.params['patterns'] as unknown[]).filter(
              (pattern): pattern is string => typeof pattern === 'string',
            )
          : [];
        const hit = patterns.find((pattern) => input.text.toLowerCase().includes(pattern.toLowerCase()));
        return hit === undefined
          ? { passed: true, reason: 'No blocked topic found.' }
          : { passed: false, reason: `Blocked topic "${hit}".` };
      }

      case 'secret_leak': {
        const matches = keyMatches(input.text);
        if (matches.length === 0) return { passed: true, reason: 'No credential found.' };

        let sanitized = input.text;
        for (const { match } of matches) sanitized = sanitized.split(match).join('[api_key redacted]');

        return {
          passed: false,
          reason: 'The output contains a credential-shaped value.',
          redactedTypes: ['api_key'],
          sanitized,
        };
      }

      case 'moderation':
        return MODERATION.test(input.text)
          ? { passed: false, reason: 'The text matched a moderation category.' }
          : { passed: true, reason: 'Nothing matched a moderation category.' };

      case 'required_citations': {
        const hasMarker = input.text.includes('[source:');
        const hasSources = (input.parts ?? []).some(
          (part) =>
            part.type === 'json' &&
            typeof part.value === 'object' &&
            part.value !== null &&
            Array.isArray((part.value as { sources?: unknown }).sources),
        );
        return hasMarker || hasSources
          ? { passed: true, reason: 'The output cites its sources.' }
          : { passed: false, reason: 'The output cites no sources.' };
      }

      case 'max_iterations': {
        const max = typeof check.params['max'] === 'number' ? check.params['max'] : 50;
        const iteration = input.loop?.iteration ?? 1;
        return iteration < max
          ? { passed: true, reason: `Iteration ${iteration} of ${max}.` }
          : { passed: false, reason: `The loop reached its limit of ${max} iterations.` };
      }

      case 'max_tool_calls': {
        const max = typeof check.params['max'] === 'number' ? check.params['max'] : 25;
        const calls = input.loop?.toolCalls ?? 0;
        return calls < max
          ? { passed: true, reason: `${calls} tool calls of ${max}.` }
          : { passed: false, reason: `The node reached its limit of ${max} tool calls.` };
      }

      case 'repeated_output': {
        const times = typeof check.params['times'] === 'number' ? check.params['times'] : 3;
        const hashes = input.loop?.outputHashes ?? [];
        const tail = hashes.slice(-times);
        const repeated =
          tail.length === times && tail.every((hash) => hash === tail[0]) && times > 0;
        return repeated
          ? { passed: false, reason: `The same output came back ${times} times in a row.` }
          : { passed: true, reason: 'The output changed.' };
      }

      // Rounds 4 and 5: declared in a policy today, evaluated then.
      default:
        return undefined;
    }
  },
};

/** The data guardrail's stand-in: masks every key-shaped token, whatever any policy says (D86). */
export const fakeMasker: SecretMasker = {
  mask(text: string): MaskResult {
    const matches = keyMatches(text);
    if (matches.length === 0) return { text, types: [] };

    let masked = text;
    for (const { match } of matches) masked = masked.split(match).join('[api_key redacted]');
    return { text: masked, types: ['api_key'] };
  },
};

/* -------------------------------------------------------------------------- */
/* The event bus                                                               */
/* -------------------------------------------------------------------------- */

export class RecordingBus implements EventBus {
  readonly events: EngineEvent[] = [];
  private seq = 0;

  async emit(event: EmittedEvent): Promise<EngineEvent> {
    this.seq += 1;
    const stored: EngineEvent = {
      ...event,
      seq: this.seq,
      createdAt: event.createdAt ?? new Date().toISOString(),
    };
    this.events.push(stored);
    return stored;
  }

  async emitTransient(event: EmittedEvent): Promise<void> {
    this.events.push({ ...event, seq: 0, createdAt: new Date().toISOString(), transient: true });
  }

  async subscribe(): Promise<Unsubscribe> {
    return () => undefined;
  }

  ofType(type: string): EngineEvent[] {
    return this.events.filter((event) => event.type === type);
  }
}

/* -------------------------------------------------------------------------- */
/* The store                                                                   */
/* -------------------------------------------------------------------------- */

export class FakeGuardrailStore implements GuardrailStore {
  /** `${policyId}:${version}` → the row. A version is written once and never rewritten. */
  private readonly policyVersions = new Map<string, GuardrailPolicy>();
  private readonly approvalRows = new Map<Id, StoredApproval>();
  private readonly verdictRows: Verdict[] = [];
  readonly projectRows = new Map<Id, Project>();
  readonly nodeRows: Node[] = [];
  readonly nodeRunRows = new Map<Id, NodeRun>();
  settingsRow: Settings = SettingsSchema.parse({ dataDir: '/tmp/ace' });
  /** day → cost, what `costUsdForDay` answers. */
  readonly dailyCost = new Map<string, number>();

  private versionsOf(id: Id): GuardrailPolicy[] {
    return [...this.policyVersions.values()]
      .filter((policy) => policy.id === id)
      .sort((a, b) => a.version - b.version);
  }

  readonly policies: GuardrailStore['policies'] = {
    insert: async (_scope: Scope, policy: GuardrailPolicy) => {
      const key = `${policy.id}:${policy.version}`;
      if (this.policyVersions.has(key)) {
        throw new Error(`Version ${policy.version} of policy ${policy.id} already exists.`);
      }
      this.policyVersions.set(key, policy);
      return policy;
    },
    getLatest: async (_scope: Scope, id: Id) => this.versionsOf(id).at(-1) ?? null,
    getVersion: async (_scope: Scope, id: Id, version: number) =>
      this.policyVersions.get(`${id}:${version}`) ?? null,
    listLatest: async (_scope: Scope, projectId?: Id) => {
      const ids = [...new Set([...this.policyVersions.values()].map((policy) => policy.id))];
      return ids
        .map((id) => this.versionsOf(id).at(-1)!)
        .filter((policy) => projectId === undefined || policy.projectId === projectId);
    },
    getProjectDefault: async (_scope: Scope, projectId: Id) => {
      const ids = [...new Set([...this.policyVersions.values()].map((policy) => policy.id))];
      return (
        ids
          .map((id) => this.versionsOf(id).at(-1)!)
          .find((policy) => policy.projectId === projectId && policy.isProjectDefault) ?? null
      );
    },
    setProjectDefault: async (_scope: Scope, projectId: Id, id: Id) => {
      for (const [key, policy] of this.policyVersions) {
        if (policy.projectId !== projectId) continue;
        this.policyVersions.set(key, { ...policy, isProjectDefault: policy.id === id });
      }
    },
    deleteAllVersions: async (_scope: Scope, id: Id) => {
      let removed = false;
      for (const [key, policy] of [...this.policyVersions]) {
        if (policy.id !== id) continue;
        this.policyVersions.delete(key);
        removed = true;
      }
      return removed;
    },
  };

  readonly approvals: GuardrailStore['approvals'] = {
    create: async (_scope: Scope, request: RunApprovalRequest) => {
      this.approvalRows.set(request.id, { request });
      return request;
    },
    get: async (_scope: Scope, id: Id) => this.approvalRows.get(id) ?? null,
    listPendingByRun: async (_scope: Scope, runId: Id) =>
      [...this.approvalRows.values()]
        .filter((row) => row.request.runId === runId && row.decision === undefined)
        .map((row) => row.request),
    findPendingByNodeRun: async (_scope: Scope, nodeRunId: Id) =>
      [...this.approvalRows.values()].find(
        (row) => row.request.nodeRunId === nodeRunId && row.decision === undefined,
      )?.request ?? null,
    recordDecision: async (_scope: Scope, requestId: Id, decision: ApprovalDecision) => {
      const row = this.approvalRows.get(requestId);
      if (row === undefined || row.decision !== undefined) return false;
      this.approvalRows.set(requestId, { ...row, decision });
      return true;
    },
  };

  readonly verdicts: GuardrailStore['verdicts'] = {
    append: async (_scope: Scope, verdict: Verdict) => {
      this.verdictRows.push(verdict);
      return verdict;
    },
    listByNodeRun: async (_scope: Scope, nodeRunId: Id) =>
      this.verdictRows.filter((verdict) => verdict.nodeRunId === nodeRunId),
  };

  readonly usage: GuardrailStore['usage'] = {
    costUsdForDay: async (_scope: Scope, day: string) => this.dailyCost.get(day) ?? 0,
  };

  readonly projects: GuardrailStore['projects'] = {
    get: async (_scope: Scope, id: Id) => this.projectRows.get(id) ?? null,
  };

  readonly policyUsage: GuardrailStore['policyUsage'] = {
    listByGuardrailPolicy: async (_scope: Scope, policyId: Id) =>
      this.nodeRows.filter(
        (node) => node.kind === 'agent' && node.config.guardrailPolicyId === policyId,
      ),
  };

  readonly nodeRuns: GuardrailStore['nodeRuns'] = {
    get: async (_scope: Scope, id: Id) => this.nodeRunRows.get(id) ?? null,
  };

  readonly settings: GuardrailStore['settings'] = {
    get: async () => this.settingsRow,
  };

  /** Every verdict written so far, in order. */
  allVerdicts(): Verdict[] {
    return [...this.verdictRows];
  }
}

/* -------------------------------------------------------------------------- */
/* Small builders                                                              */
/* -------------------------------------------------------------------------- */

export const id = (): Id => newId();

export function check(partial: Partial<GuardrailCheck> & Pick<GuardrailCheck, 'point' | 'type'>): GuardrailCheck {
  return {
    id: id(),
    action: 'warn',
    enabled: true,
    params: {},
    ...partial,
  };
}

export function policy(partial: Partial<GuardrailPolicy> = {}): GuardrailPolicy {
  const at = '2026-09-26T09:00:00.000Z';
  return {
    id: id(),
    projectId: id(),
    name: 'Test policy',
    version: 1,
    isProjectDefault: false,
    checks: [],
    createdAt: at,
    updatedAt: at,
    ...partial,
  };
}

/**
 * An agent node, parsed through `NodeSchema` so a test can never assert against a shape the
 * contract would refuse — the ports come from `derivePorts`, the way the graph service builds them.
 */
export function agentNode(
  partial: { name?: string; guardrailPolicyId?: Id; maxTokens?: number } = {},
): Node {
  const nodeId = id();
  const config = {
    instructions: 'Write something.',
    inputTypes: ['text'],
    outputTypes: ['text'],
    routing: { policy: 'fixed', fallbackModelIds: [] },
    execution: {
      maxTokens: partial.maxTokens ?? 1_000,
      temperature: 0.2,
      timeoutMs: 30_000,
      retries: 1,
    },
    contextPolicy: { budgetTokens: 8_000 },
    ...(partial.guardrailPolicyId === undefined
      ? {}
      : { guardrailPolicyId: partial.guardrailPolicyId }),
    tools: { enabled: [], maxToolCalls: 5, allowedDomains: [] },
    knowledgeBaseIds: [],
    memory: { enabled: false },
    skillIds: [],
  };

  return NodeSchema.parse({
    id: nodeId,
    workflowId: id(),
    kind: 'agent',
    name: partial.name ?? 'Writer',
    position: { x: 0, y: 0 },
    config,
    ...derivePorts({ id: nodeId, kind: 'agent', config } as Parameters<typeof derivePorts>[0]),
    createdAt: '2026-09-26T09:00:00.000Z',
    updatedAt: '2026-09-26T09:00:00.000Z',
  });
}

/** An Input node — it calls no model, which is what makes it useful to the budget tests. */
export function inputNode(): Node {
  const nodeId = id();
  const config = { artifactIds: [], outputTypes: ['text'] };

  return NodeSchema.parse({
    id: nodeId,
    workflowId: id(),
    kind: 'input',
    name: 'Brief',
    position: { x: 0, y: 0 },
    config,
    ...derivePorts({ id: nodeId, kind: 'input', config } as Parameters<typeof derivePorts>[0]),
    createdAt: '2026-09-26T09:00:00.000Z',
    updatedAt: '2026-09-26T09:00:00.000Z',
  });
}

export function project(partial: Partial<Project> = {}): Project {
  const at = '2026-09-26T09:00:00.000Z';
  return {
    id: id(),
    name: 'Test project',
    folderPath: '/tmp/ace/project',
    createdAt: at,
    updatedAt: at,
    ...partial,
  };
}
