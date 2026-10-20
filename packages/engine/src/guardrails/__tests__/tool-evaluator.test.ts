import type { GuardrailPolicy, ToolDefinition } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { createApprovalService, type ApprovalService } from '../../approvals/index.js';
import { LOCAL_SCOPE } from '../../ports/index.js';
import type { ToolGuardrailTarget, ToolPointInput } from '../../runs/tool-loop.js';
import type { CheckInput, CheckOutcome, CheckRunner } from '../checks.js';
import { createToolGuardrailEvaluator, type ToolArgsValidator } from '../evaluator.js';
import { FakeGuardrailStore, RecordingBus, check, fakeAnthropicKey, id, policy } from './fakes.js';

/**
 * The tool point (round 4 §2.2, FR-GRD-005/006, FR-TOOL-002, D217).
 *
 * The four tool-point checks reach the evaluator through a fake `CheckRunner` — the shape
 * `@ace/guardrails` implements — and argument validation through an injected function, exactly the
 * two seams the gateway wires. The tests exercise the evaluator's orchestration: the order, the
 * verdicts, the block/reject/allow steps and the destructive-tool approval.
 */

/* -------------------------------------------------------------------------- */
/* Fakes standing in for @ace/guardrails' tool checks                          */
/* -------------------------------------------------------------------------- */

const toolCheckRunner: CheckRunner = {
  evaluate(gc, input: CheckInput): CheckOutcome | undefined {
    const tool = input.tool;
    if (tool === undefined) return undefined;
    const args = (typeof tool.args === 'object' && tool.args !== null ? tool.args : {}) as Record<
      string,
      unknown
    >;

    switch (gc.type) {
      case 'tool_allowed':
        return tool.enabledTools.includes(tool.definition.name)
          ? { passed: true, reason: 'The tool is enabled.' }
          : { passed: false, reason: `Tool ${tool.definition.name} is not enabled for this agent.` };

      case 'path_confinement': {
        const path = typeof args['path'] === 'string' ? args['path'] : undefined;
        if (path === undefined) return { passed: true, reason: 'No path argument to confine.' };
        const escapes = path.includes('..') || (path.startsWith('/') && !path.startsWith(tool.sandboxDir));
        return escapes
          ? { passed: false, reason: 'A path argument escapes the sandbox.' }
          : { passed: true, reason: 'The path stays inside the sandbox.' };
      }

      case 'domain_allowlist': {
        const url = typeof args['url'] === 'string' ? args['url'] : undefined;
        if (url === undefined) return { passed: true, reason: 'No URL argument to check.' };
        let host: string | undefined;
        try {
          host = new URL(url).hostname.toLowerCase();
        } catch {
          host = undefined;
        }
        if (host === undefined) return { passed: false, reason: 'The URL argument is not a valid URL.' };
        const allowed = tool.allowedDomains.some(
          (domain) => host === domain || host!.endsWith(`.${domain}`),
        );
        return allowed
          ? { passed: true, reason: `Host ${host} is on the allow-list.` }
          : { passed: false, reason: `Host ${host} is not on the allow-list.` };
      }

      case 'destructive_action':
        return tool.definition.permissions.destructive
          ? { passed: false, reason: `Tool ${tool.definition.name} performs a destructive action.` }
          : { passed: true, reason: `Tool ${tool.definition.name} is not destructive.` };

      default:
        return undefined;
    }
  },
};

/** Validates the `required` keys of the tool's `inputSchema` — the shape of `checkToolArgs` (D217). */
const validateArgs: ToolArgsValidator = (definition, rawArgs) => {
  const required = Array.isArray((definition.inputSchema as { required?: unknown }).required)
    ? ((definition.inputSchema as { required: unknown[] }).required.filter(
        (key): key is string => typeof key === 'string',
      ))
    : [];
  const args = (typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}) as Record<
    string,
    unknown
  >;
  const missing = required.filter((key) => !(key in args));
  return missing.length === 0
    ? { passed: true, reason: `Arguments satisfy the input schema of ${definition.name}.` }
    : { passed: false, reason: `Arguments to ${definition.name} are invalid: missing ${missing.join(', ')}.` };
};

function toolDef(partial: Partial<ToolDefinition> & { name: string }): ToolDefinition {
  return {
    name: partial.name,
    description: partial.description ?? 'A test tool.',
    inputSchema: partial.inputSchema ?? { type: 'object' },
    outputSchema: partial.outputSchema ?? { type: 'object' },
    permissions: partial.permissions ?? { network: false, fsPaths: [], destructive: false },
    timeoutMs: partial.timeoutMs ?? 5_000,
    source: 'builtin',
  };
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

interface Harness {
  evaluate: (bag: ToolPointInput) => Promise<Awaited<ReturnType<ReturnType<typeof createToolGuardrailEvaluator>['evaluateTool']>>>;
  store: FakeGuardrailStore;
  bus: RecordingBus;
  approvals: ApprovalService;
  target: ToolGuardrailTarget;
}

function harness(
  active: GuardrailPolicy | null,
  options: { withApprovals?: boolean; withArgsValidation?: boolean } = {},
): Harness {
  const store = new FakeGuardrailStore();
  const bus = new RecordingBus();
  const approvals = createApprovalService({
    scope: LOCAL_SCOPE,
    approvals: store.approvals,
    nodeRuns: store.nodeRuns,
    bus,
  });

  const evaluator = createToolGuardrailEvaluator({
    scope: LOCAL_SCOPE,
    checks: toolCheckRunner,
    verdicts: store.verdicts,
    bus,
    ...(options.withArgsValidation === false ? {} : { validateArgs }),
    ...(options.withApprovals === false ? {} : { approvals }),
  });

  const target: ToolGuardrailTarget = {
    runId: id(),
    workflowId: id(),
    nodeRunId: id(),
    nodeId: id(),
    nodeName: 'Researcher',
    iteration: 1,
    policy: active,
  };

  return {
    evaluate: (bag) => evaluator.evaluateTool({ target, ...bag }),
    store,
    bus,
    approvals,
    target,
  };
}

/** A default-shaped tool policy: block an unenabled tool, ask on a destructive one, confine paths/hosts. */
const toolPolicy = (): GuardrailPolicy =>
  policy({
    checks: [
      check({ point: 'tool', type: 'tool_allowed', action: 'block' }),
      check({ point: 'tool', type: 'path_confinement', action: 'block' }),
      check({ point: 'tool', type: 'domain_allowlist', action: 'block' }),
      check({ point: 'tool', type: 'destructive_action', action: 'ask_user' }),
    ],
  });

const bag = (partial: Partial<ToolPointInput> & { definition: ToolDefinition }): ToolPointInput => ({
  definition: partial.definition,
  args: partial.args ?? {},
  enabledTools: partial.enabledTools ?? [partial.definition.name],
  sandboxDir: partial.sandboxDir ?? '/tmp/ace/sandbox/run-1',
  allowedDomains: partial.allowedDomains ?? [],
});

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe('FR-TOOL-002 an enabled, valid, non-destructive call runs', () => {
  it('allows the call, records nothing and asks nobody', async () => {
    const { evaluate, store, bus } = harness(toolPolicy());
    const definition = toolDef({ name: 'read_file', inputSchema: { type: 'object' } });

    const step = await evaluate(bag({ definition }));

    expect(step.kind).toBe('allow');
    expect(store.allVerdicts()).toHaveLength(0);
    expect(bus.ofType('guardrail.verdict')).toHaveLength(0);
    expect(bus.ofType('node.approval_required')).toHaveLength(0);
  });
});

describe('FR-TOOL-002 a tool the agent did not enable is blocked', () => {
  it('blocks with a verdict on the wire (FR-GRD-012)', async () => {
    const { evaluate, store, bus } = harness(toolPolicy());
    const definition = toolDef({ name: 'delete_all' });

    const step = await evaluate(bag({ definition, enabledTools: ['read_file'] }));

    expect(step.kind).toBe('block');
    if (step.kind !== 'block') return;
    expect(step.reason).toContain('not enabled');
    expect(step.verdicts).toHaveLength(1);
    expect(step.verdicts?.[0]).toMatchObject({ point: 'tool', checkType: 'tool_allowed', passed: false });
    expect(store.allVerdicts()).toHaveLength(1);
    expect(bus.ofType('guardrail.verdict')).toHaveLength(1);
  });
});

describe('FR-GRD-005/D217 arguments are validated as a precondition, not a policy check', () => {
  it('blocks a call whose arguments miss a required field, recording no verdict', async () => {
    const { evaluate, store } = harness(toolPolicy());
    const definition = toolDef({
      name: 'read_file',
      inputSchema: { type: 'object', required: ['path'] },
    });

    const step = await evaluate(bag({ definition, args: {} }));

    expect(step.kind).toBe('block');
    if (step.kind !== 'block') return;
    expect(step.reason).toContain('invalid');
    // Args validation is a precondition (D217): a block, but not a policy verdict.
    expect(store.allVerdicts()).toHaveLength(0);
  });

  it('validates arguments even when the policy has no tool_allowed check', async () => {
    const { evaluate } = harness(
      policy({ checks: [check({ point: 'tool', type: 'path_confinement', action: 'block' })] }),
    );
    const definition = toolDef({
      name: 'read_file',
      inputSchema: { type: 'object', required: ['path'] },
    });

    const step = await evaluate(bag({ definition, args: {} }));
    expect(step.kind).toBe('block');
  });
});

describe('FR-GRD-006 path confinement and domain allow-list', () => {
  it('blocks a path that escapes the sandbox', async () => {
    const { evaluate } = harness(toolPolicy());
    const definition = toolDef({ name: 'read_file' });

    const step = await evaluate(bag({ definition, args: { path: '/etc/passwd' } }));
    expect(step.kind).toBe('block');
    if (step.kind !== 'block') return;
    expect(step.reason).toContain('sandbox');
  });

  it('blocks a host that is not on the allow-list', async () => {
    const { evaluate } = harness(toolPolicy());
    const definition = toolDef({ name: 'web_fetch', permissions: { network: true, fsPaths: [], destructive: false } });

    const step = await evaluate(
      bag({ definition, args: { url: 'https://evil.example.com/x' }, allowedDomains: ['trusted.com'] }),
    );
    expect(step.kind).toBe('block');
    if (step.kind !== 'block') return;
    expect(step.reason).toContain('allow-list');
  });

  it('allows a host that is on the allow-list', async () => {
    const { evaluate } = harness(toolPolicy());
    const definition = toolDef({ name: 'web_fetch', permissions: { network: true, fsPaths: [], destructive: false } });

    const step = await evaluate(
      bag({ definition, args: { url: 'https://api.trusted.com/x' }, allowedDomains: ['trusted.com'] }),
    );
    expect(step.kind).toBe('allow');
  });
});

describe('FR-GRD-006/BR-14 a destructive tool asks for approval', () => {
  const destructiveDef = (): ToolDefinition =>
    toolDef({ name: 'sandbox_delete', permissions: { network: false, fsPaths: [], destructive: true } });

  it('allows the call when the reviewer approves', async () => {
    const h = harness(toolPolicy());
    void approveWhenAsked(h, 'approve');

    const step = await h.evaluate(bag({ definition: destructiveDef() }));

    expect(step.kind).toBe('allow');
    // The destructive check triggered, so its verdict is recorded and emitted.
    expect(h.store.allVerdicts()).toHaveLength(1);
    expect(h.store.allVerdicts()[0]).toMatchObject({ checkType: 'destructive_action', passed: false });
    expect(h.bus.ofType('node.approval_required')).toHaveLength(1);
  });

  it('rejects the call when the reviewer rejects, failing the node', async () => {
    const h = harness(toolPolicy());
    void approveWhenAsked(h, 'reject');

    const step = await h.evaluate(bag({ definition: destructiveDef() }));

    expect(step.kind).toBe('reject');
    if (step.kind !== 'reject') return;
    expect(step.reason).toContain('rejected');
    expect(step.verdicts).toHaveLength(1);
  });

  it('blocks instead of waiting forever when no approver is wired (safe by default)', async () => {
    const { evaluate } = harness(toolPolicy(), { withApprovals: false });

    const step = await evaluate(bag({ definition: destructiveDef() }));

    expect(step.kind).toBe('block');
    if (step.kind !== 'block') return;
    expect(step.reason).toContain('No approver is available');
  });
});

describe('D376 an agentic run_command asks only when its gate says so', () => {
  const runCommandDef = (): ToolDefinition =>
    toolDef({
      name: 'run_command',
      inputSchema: { type: 'object', required: ['command'] },
      permissions: { network: true, fsPaths: ['<project>'], destructive: true },
    });

  it('a command the allowlist covers runs with no card, and only a pass verdict says why', async () => {
    const h = harness(toolPolicy());

    const step = await h.evaluate({
      ...bag({ definition: runCommandDef(), args: { command: 'pnpm test' } }),
      command: { text: 'pnpm test', gate: { kind: 'allow' } },
    });

    expect(step.kind).toBe('allow');
    expect(h.bus.ofType('node.approval_required')).toHaveLength(0);
    expect(h.bus.ofType('guardrail.verdict')).toHaveLength(0);
    expect(h.store.allVerdicts()).toHaveLength(1);
    expect(h.store.allVerdicts()[0]).toMatchObject({
      checkType: 'destructive_action',
      action: 'pass',
      passed: true,
    });
    expect(h.store.allVerdicts()[0]?.reason).toContain('allowed commands');
    expect(step.verdicts).toEqual(h.store.allVerdicts());
  });

  it('a command it does not cover opens the card with the command and the prefix on it', async () => {
    const h = harness(toolPolicy());
    void approveWhenAsked(h, 'approve');

    const step = await h.evaluate({
      ...bag({ definition: runCommandDef(), args: { command: 'npm run build' } }),
      command: {
        text: 'npm run build',
        gate: { kind: 'ask', allowPrefix: 'npm run build', denylisted: false },
      },
    });

    expect(step.kind).toBe('allow');
    const [required] = h.bus.ofType('node.approval_required');
    const request = (required?.payload as { request: { command?: unknown; preview: string } })
      .request;
    expect(request.command).toEqual({
      text: 'npm run build',
      allowPrefix: 'npm run build',
      denylisted: false,
    });
    // The preview is what it always was.
    expect(request.preview).toBe('run_command {"command":"npm run build"}');
  });

  it('a denylisted command asks with no prefix on the card', async () => {
    const h = harness(toolPolicy());
    void approveWhenAsked(h, 'reject');

    const step = await h.evaluate({
      ...bag({ definition: runCommandDef(), args: { command: 'git push --force' } }),
      command: { text: 'git push --force', gate: { kind: 'ask', denylisted: true } },
    });

    expect(step.kind).toBe('reject');
    const [required] = h.bus.ofType('node.approval_required');
    expect((required?.payload as { request: { command?: unknown } }).request.command).toEqual({
      text: 'git push --force',
      denylisted: true,
    });
  });

  it('masks a secret in the command on the card, and offers no prefix that would carry one', async () => {
    const h = harness(toolPolicy());
    void approveWhenAsked(h, 'approve');
    const key = fakeAnthropicKey();
    const text = `${key} --version`;

    await h.evaluate({
      ...bag({ definition: runCommandDef(), args: { command: text } }),
      command: { text, gate: { kind: 'ask', allowPrefix: key, denylisted: false } },
    });

    const [required] = h.bus.ofType('node.approval_required');
    const command = (required?.payload as { request: { command: { text: string } } }).request
      .command;
    expect(command.text).not.toContain(key);
    expect(command).not.toHaveProperty('allowPrefix');
  });

  it('an allowlist never overrides a policy that blocks destructive tools', async () => {
    const h = harness(
      policy({ checks: [check({ point: 'tool', type: 'destructive_action', action: 'block' })] }),
    );

    const step = await h.evaluate({
      ...bag({ definition: runCommandDef(), args: { command: 'pnpm test' } }),
      command: { text: 'pnpm test', gate: { kind: 'allow' } },
    });

    expect(step.kind).toBe('block');
  });

  it('a call with no command in the bag asks exactly as before, with no command on the card', async () => {
    const h = harness(toolPolicy());
    void approveWhenAsked(h, 'approve');

    await h.evaluate(bag({ definition: runCommandDef(), args: { command: 'pnpm test' } }));

    const [required] = h.bus.ofType('node.approval_required');
    expect((required?.payload as { request: object }).request).not.toHaveProperty('command');
  });
});

describe('§2.2 no policy leaves the tool unchecked but still validates arguments', () => {
  it('allows any tool when the project has no policy', async () => {
    const { evaluate, store } = harness(null);
    const definition = toolDef({
      name: 'sandbox_delete',
      permissions: { network: false, fsPaths: [], destructive: true },
    });

    const step = await evaluate(bag({ definition, enabledTools: [] }));

    expect(step.kind).toBe('allow');
    expect(store.allVerdicts()).toHaveLength(0);
  });
});

describe('§2.2 toolCallCap reads the policy max_tool_calls', () => {
  it('returns the configured cap and undefined when there is none', () => {
    const evaluator = createToolGuardrailEvaluator({
      scope: LOCAL_SCOPE,
      checks: toolCheckRunner,
      verdicts: new FakeGuardrailStore().verdicts,
      bus: new RecordingBus(),
    });

    const capped = policy({
      checks: [check({ point: 'loop', type: 'max_tool_calls', action: 'block', params: { max: 7 } })],
    });
    expect(evaluator.toolCallCap(capped)).toBe(7);
    expect(evaluator.toolCallCap(policy({ checks: [] }))).toBeUndefined();
    expect(evaluator.toolCallCap(null)).toBeUndefined();
  });
});

/** Approve or reject the first pending request on the target's run, then return. */
async function approveWhenAsked(h: Harness, decision: 'approve' | 'reject'): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [pending] = await h.approvals.listPending(h.target.runId);
    if (pending !== undefined) {
      await h.approvals.decide(h.target.nodeRunId, decision);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
