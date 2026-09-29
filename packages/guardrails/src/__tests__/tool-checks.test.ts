import { describe, expect, it } from 'vitest';

import {
  checkDestructiveAction,
  checkDomainAllowlist,
  checkPathConfinement,
  checkToolAllowed,
  checkToolArgs,
} from '../checks/tools.js';
import { evaluateCheck } from '../evaluate.js';
import type { GuardrailInput, ToolGuardrailInput } from '../types.js';
import { makeCheck, makeTool } from './fixtures.js';

/** A tool bag with the fields a test does not care about filled with harmless defaults. */
function toolInput(overrides: Partial<ToolGuardrailInput> = {}): GuardrailInput {
  const tool: ToolGuardrailInput = {
    definition: overrides.definition ?? makeTool(),
    args: overrides.args ?? {},
    enabledTools: overrides.enabledTools ?? [],
    sandboxDir: overrides.sandboxDir ?? '/project/.ace/sandbox/run1',
    allowedDomains: overrides.allowedDomains ?? [],
  };
  return { tool };
}

/* -------------------------------------------------------------------------- */
/* TC-TOOL-002 — tool_allowed (FR-TOOL-002)                                    */
/* -------------------------------------------------------------------------- */

describe('TC-TOOL-002 tool_allowed', () => {
  it('passes when the tool is in the agent enabled set', () => {
    const result = checkToolAllowed(
      toolInput({ definition: makeTool({ name: 'echo' }), enabledTools: ['echo'] }),
    );
    expect(result).toEqual({ passed: true, reason: 'Tool echo is enabled for this agent.' });
  });

  it('fails when the tool is not enabled — the node fails GUARDRAIL_VIOLATION', () => {
    const result = checkToolAllowed(
      toolInput({ definition: makeTool({ name: 'echo' }), enabledTools: ['web_search'] }),
    );
    expect(result).toEqual({ passed: false, reason: 'Tool echo is not enabled for this agent.' });
  });

  it('fails when the agent has no tools enabled at all', () => {
    expect(checkToolAllowed(toolInput({ enabledTools: [] }))?.passed).toBe(false);
  });

  it('says nothing when there is no tool bag — silence, not a pass', () => {
    expect(checkToolAllowed({ text: 'hello' })).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* FR-GRD-005 — arguments valid against inputSchema                            */
/* -------------------------------------------------------------------------- */

describe('FR-GRD-005 arguments against inputSchema', () => {
  const schema = {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  };

  it('passes valid arguments', () => {
    const tool = makeTool({ name: 'echo', inputSchema: schema });
    expect(checkToolArgs(tool, { text: 'hi' })).toEqual({
      passed: true,
      reason: 'Arguments satisfy the input schema of echo.',
    });
  });

  it('fails a missing required field', () => {
    const tool = makeTool({ name: 'echo', inputSchema: schema });
    const result = checkToolArgs(tool, {});
    expect(result?.passed).toBe(false);
    expect(result?.reason).toContain('missing required field "text"');
  });

  it('fails a wrong type', () => {
    const tool = makeTool({ name: 'echo', inputSchema: schema });
    const result = checkToolArgs(tool, { text: 42 });
    expect(result?.passed).toBe(false);
    expect(result?.reason).toContain('must be string, got integer');
  });

  it('fails an unexpected field when additionalProperties is false', () => {
    const tool = makeTool({ name: 'echo', inputSchema: schema });
    const result = checkToolArgs(tool, { text: 'hi', extra: 1 });
    expect(result?.passed).toBe(false);
    expect(result?.reason).toContain('unexpected field "extra"');
  });

  it('enforces enum, const and numeric bounds', () => {
    const langTool = makeTool({
      name: 'code_sandbox',
      inputSchema: { type: 'object', properties: { language: { enum: ['javascript', 'python'] } } },
    });
    expect(checkToolArgs(langTool, { language: 'ruby' })?.passed).toBe(false);

    const boundedTool = makeTool({
      name: 'web_search',
      inputSchema: { type: 'object', properties: { k: { type: 'number', minimum: 1, maximum: 10 } } },
    });
    expect(checkToolArgs(boundedTool, { k: 20 })?.passed).toBe(false);
    expect(checkToolArgs(boundedTool, { k: 5 })?.passed).toBe(true);
  });

  it('never quotes the offending value in the reason (FR-GRD-014)', () => {
    const tool = makeTool({
      name: 'echo',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    });
    const result = checkToolArgs(tool, { text: 'super-secret-value' });
    expect(JSON.stringify(result)).not.toContain('super-secret-value');
  });

  it('accepts anything when the schema is empty', () => {
    expect(checkToolArgs(makeTool({ inputSchema: {} }), { whatever: true })?.passed).toBe(true);
  });

  it('validates every item of an array against items', () => {
    const tool = makeTool({
      name: 'sandbox_delete',
      inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } } },
    });
    expect(checkToolArgs(tool, { paths: ['a', 'b'] })?.passed).toBe(true);
    const bad = checkToolArgs(tool, { paths: ['a', 3] });
    expect(bad?.passed).toBe(false);
    expect(bad?.reason).toContain('paths[1]');
  });

  it('accepts a union type given as an array of type names', () => {
    const tool = makeTool({
      name: 'echo',
      inputSchema: { type: 'object', properties: { text: { type: ['string', 'null'] } } },
    });
    expect(checkToolArgs(tool, { text: null })?.passed).toBe(true);
    expect(checkToolArgs(tool, { text: 5 })?.passed).toBe(false);
  });

  it('enforces a const argument', () => {
    const tool = makeTool({
      name: 'echo',
      inputSchema: { type: 'object', properties: { mode: { const: 'strict' } } },
    });
    expect(checkToolArgs(tool, { mode: 'strict' })?.passed).toBe(true);
    expect(checkToolArgs(tool, { mode: 'loose' })?.passed).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* TC-GRD-006 — path_confinement (FR-GRD-006)                                  */
/* -------------------------------------------------------------------------- */

describe('TC-GRD-006 path_confinement', () => {
  const sandboxDir = '/project/.ace/sandbox/run1';
  const del = makeTool({ name: 'sandbox_delete', permissions: { destructive: true } });

  it('blocks a ../../x escape', () => {
    const result = checkPathConfinement(
      toolInput({ definition: del, args: { path: '../../x' }, sandboxDir }),
    );
    expect(result?.passed).toBe(false);
    expect(result?.reason).toContain('resolves outside the run sandbox');
  });

  it('blocks an absolute path pointing elsewhere', () => {
    expect(
      checkPathConfinement(toolInput({ definition: del, args: { path: '/etc/passwd' }, sandboxDir }))
        ?.passed,
    ).toBe(false);
  });

  it('allows a relative path that stays inside the sandbox', () => {
    const result = checkPathConfinement(
      toolInput({ definition: del, args: { path: 'notes/output.txt' }, sandboxDir }),
    );
    expect(result?.passed).toBe(true);
  });

  it('allows an absolute path that is literally under the sandbox', () => {
    expect(
      checkPathConfinement(
        toolInput({ definition: del, args: { path: `${sandboxDir}/notes.txt` }, sandboxDir }),
      )?.passed,
    ).toBe(true);
  });

  it('allows a "." and inner ".." that never leave the sandbox', () => {
    expect(
      checkPathConfinement(toolInput({ definition: del, args: { path: 'a/b/../c' }, sandboxDir }))
        ?.passed,
    ).toBe(true);
  });

  it('checks every entry of a paths array and blocks if any escapes', () => {
    const result = checkPathConfinement(
      toolInput({ definition: del, args: { paths: ['ok.txt', '../../secret'] }, sandboxDir }),
    );
    expect(result?.passed).toBe(false);
  });

  it('treats a Windows-style sandbox and separators the same way', () => {
    const winSandbox = 'C:\\project\\.ace\\sandbox\\run1';
    expect(
      checkPathConfinement(toolInput({ definition: del, args: { path: '..\\..\\x' }, sandboxDir: winSandbox }))
        ?.passed,
    ).toBe(false);
    expect(
      checkPathConfinement(toolInput({ definition: del, args: { path: 'sub\\file.txt' }, sandboxDir: winSandbox }))
        ?.passed,
    ).toBe(true);
  });

  it('passes when the call carries no path argument', () => {
    const result = checkPathConfinement(toolInput({ definition: del, args: { text: 'hi' }, sandboxDir }));
    expect(result).toEqual({ passed: true, reason: 'No path argument to confine to the sandbox.' });
  });

  it('says nothing when there is no tool bag', () => {
    expect(checkPathConfinement({ value: 1 })).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* TC-GRD-007 — domain_allowlist (FR-GRD-007)                                  */
/* -------------------------------------------------------------------------- */

describe('TC-GRD-007 domain_allowlist', () => {
  const http = makeTool({ name: 'http_request', permissions: { network: true } });

  it('blocks a host that is not on the list', () => {
    const result = checkDomainAllowlist(
      toolInput({
        definition: http,
        args: { url: 'https://evil.example/steal' },
        allowedDomains: ['api.trusted.test'],
      }),
    );
    expect(result?.passed).toBe(false);
    expect(result?.reason).toContain('not on the allow-list');
  });

  it('blocks everything when the allow-list is empty (empty = nothing allowed)', () => {
    expect(
      checkDomainAllowlist(
        toolInput({ definition: http, args: { url: 'https://anything.test' }, allowedDomains: [] }),
      )?.passed,
    ).toBe(false);
  });

  it('allows an exact host match', () => {
    expect(
      checkDomainAllowlist(
        toolInput({
          definition: http,
          args: { url: 'https://api.trusted.test/v1' },
          allowedDomains: ['api.trusted.test'],
        }),
      )?.passed,
    ).toBe(true);
  });

  it('allows a subdomain of a listed domain', () => {
    expect(
      checkDomainAllowlist(
        toolInput({
          definition: http,
          args: { url: 'https://api.trusted.test/v1' },
          allowedDomains: ['trusted.test'],
        }),
      )?.passed,
    ).toBe(true);
  });

  it('blocks a URL that will not parse — an unreadable host cannot be allow-listed', () => {
    expect(
      checkDomainAllowlist(
        toolInput({ definition: http, args: { url: 'not a url' }, allowedDomains: ['trusted.test'] }),
      )?.passed,
    ).toBe(false);
  });

  it('passes a call with no url argument (nothing to judge)', () => {
    const result = checkDomainAllowlist(
      toolInput({ definition: makeTool({ name: 'web_search' }), args: { query: 'hi' } }),
    );
    expect(result).toEqual({ passed: true, reason: 'No URL argument to check against the allow-list.' });
  });

  it('says nothing when there is no tool bag', () => {
    expect(checkDomainAllowlist({ text: 'x' })).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* FR-GRD-006 — destructive_action (Arch §13.1 "destructive always asks")      */
/* -------------------------------------------------------------------------- */

describe('FR-GRD-006 destructive_action', () => {
  it('trips for a destructive tool so the engine asks for approval', () => {
    const tool = makeTool({ name: 'sandbox_delete', permissions: { destructive: true } });
    const result = checkDestructiveAction(toolInput({ definition: tool }));
    expect(result).toEqual({
      passed: false,
      reason: 'Tool sandbox_delete performs a destructive action and needs approval.',
    });
  });

  it('passes a non-destructive tool', () => {
    const tool = makeTool({ name: 'echo', permissions: { destructive: false } });
    expect(checkDestructiveAction(toolInput({ definition: tool }))).toEqual({
      passed: true,
      reason: 'Tool echo is not destructive.',
    });
  });

  it('says nothing when there is no tool bag', () => {
    expect(checkDestructiveAction({ value: 1 })).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* evaluateCheck dispatches every tool check type                              */
/* -------------------------------------------------------------------------- */

describe('evaluateCheck dispatches the tool point', () => {
  it('routes tool_allowed through the check', () => {
    const check = makeCheck('tool_allowed', {}, { action: 'block' });
    const result = evaluateCheck(check, toolInput({ enabledTools: [] }));
    expect(result?.passed).toBe(false);
  });

  it('routes path_confinement through the check', () => {
    const check = makeCheck('path_confinement', {}, { action: 'block' });
    const del = makeTool({ name: 'sandbox_delete', permissions: { destructive: true } });
    const result = evaluateCheck(check, toolInput({ definition: del, args: { path: '../../x' } }));
    expect(result?.passed).toBe(false);
  });

  it('routes domain_allowlist through the check', () => {
    const check = makeCheck('domain_allowlist', {}, { action: 'block' });
    const http = makeTool({ name: 'http_request', permissions: { network: true } });
    const result = evaluateCheck(
      check,
      toolInput({ definition: http, args: { url: 'https://evil.test' }, allowedDomains: [] }),
    );
    expect(result?.passed).toBe(false);
  });

  it('routes destructive_action through the check', () => {
    const check = makeCheck('destructive_action', {}, { action: 'ask_user' });
    const del = makeTool({ name: 'sandbox_delete', permissions: { destructive: true } });
    expect(evaluateCheck(check, toolInput({ definition: del }))?.passed).toBe(false);
  });

  it('stays silent for a tool check with no tool bag', () => {
    const check = makeCheck('tool_allowed', {}, { action: 'block' });
    expect(evaluateCheck(check, { text: 'hi' })).toBeUndefined();
  });

  it('a disabled tool check still says nothing', () => {
    const check = makeCheck('tool_allowed', {}, { action: 'block', enabled: false });
    expect(evaluateCheck(check, toolInput({ enabledTools: [] }))).toBeUndefined();
  });
});
