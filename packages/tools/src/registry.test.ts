import { BUILTIN_TOOL_NAMES, ToolDefinitionSchema, type ToolDefinition } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { ToolRegistrationError } from './errors.js';
import { ToolRegistry } from './registry.js';

function definition(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return ToolDefinitionSchema.parse({
    name: 'my_tool',
    description: 'A tool.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object', properties: {} },
    permissions: { network: false, fsPaths: [], destructive: false },
    timeoutMs: 1_000,
    source: 'builtin',
    ...overrides,
  });
}

const noop = async (): Promise<unknown> => ({});

const SERVER_ONE = '01J9ZS0ABCDEFGHJKMNPQRSTVW';
const SERVER_TWO = '01J9ZS0ABCDEFGHJKMNPQRSTVX';

describe('TC-TOOL-001 Registry', () => {
  it('lists a registered tool with its permissions', () => {
    const registry = new ToolRegistry();
    registry.register(definition({ name: 'alpha' }), noop);

    expect(registry.list()).toEqual([definition({ name: 'alpha' })]);
    expect(registry.list()[0]?.permissions).toEqual({
      network: false,
      fsPaths: [],
      destructive: false,
    });
  });

  it('hands back the implementation with the definition', async () => {
    const registry = new ToolRegistry();
    registry.register(definition({ name: 'alpha' }), async () => ({ ran: true }));

    const found = registry.get('alpha');
    expect(found?.definition.name).toBe('alpha');
    await expect(
      found?.implementation(
        {},
        {
          scope: { workspaceId: 'local' },
          runId: 'r1',
          sandboxDir: '/tmp/s',
          logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        },
      ),
    ).resolves.toEqual({ ran: true });
  });

  it('returns undefined for a name nobody registered', () => {
    expect(new ToolRegistry().get('nope')).toBeUndefined();
  });

  it('refuses a name that is not snake_case', () => {
    const registry = new ToolRegistry();

    // `ToolDefinitionSchema` would refuse these itself, so the registry is handed a raw shape to
    // prove it does not rely on someone else having parsed first.
    for (const name of ['WebSearch', 'web-search', '_leading', '9lives', 'web search', '']) {
      expect(() => registry.register({ ...definition(), name } as ToolDefinition, noop)).toThrow(
        ToolRegistrationError,
      );
    }

    expect(registry.list()).toEqual([]);
  });

  it('refuses a name that is already taken, keeping the first implementation', async () => {
    const registry = new ToolRegistry();
    registry.register(definition({ name: 'alpha' }), async () => ({ first: true }));

    expect(() => registry.register(definition({ name: 'alpha' }), async () => ({ second: true })))
      .toThrow(ToolRegistrationError);

    const found = registry.get('alpha');
    await expect(
      found?.implementation(
        {},
        {
          scope: { workspaceId: 'local' },
          runId: 'r1',
          sandboxDir: '/tmp/s',
          logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        },
      ),
    ).resolves.toEqual({ first: true });
    expect(registry.list()).toHaveLength(1);
  });

  it('refuses a definition whose shape the contract would not accept', () => {
    const registry = new ToolRegistry();

    expect(() =>
      registry.register(
        { ...definition(), timeoutMs: 0 } as ToolDefinition,
        noop,
      ),
    ).toThrow(ToolRegistrationError);
    expect(() =>
      registry.register(
        { ...definition(), source: 'mcp' } as ToolDefinition,
        noop,
      ),
    ).toThrow(ToolRegistrationError);
  });

  it('lists in registration order, so the built-ins keep §2.2 order', () => {
    const registry = new ToolRegistry();
    for (const name of ['gamma', 'alpha', 'beta']) {
      registry.register(definition({ name }), noop);
    }
    expect(registry.list().map((tool) => tool.name)).toEqual(['gamma', 'alpha', 'beta']);
  });

  it('drops a tool by name, and every tool of one MCP server at once', () => {
    const registry = new ToolRegistry();
    registry.register(definition({ name: 'alpha' }), noop);
    registry.register(
      definition({ name: 'mcp_files_read', source: 'mcp', mcpServerId: SERVER_ONE }),
      noop,
    );
    registry.register(
      definition({ name: 'mcp_files_write', source: 'mcp', mcpServerId: SERVER_ONE }),
      noop,
    );
    registry.register(
      definition({ name: 'mcp_other_ping', source: 'mcp', mcpServerId: SERVER_TWO }),
      noop,
    );

    expect(registry.unregister('alpha')).toBe(true);
    expect(registry.unregister('alpha')).toBe(false);
    expect(registry.unregisterServer(SERVER_ONE)).toEqual(['mcp_files_read', 'mcp_files_write']);
    expect(registry.list().map((tool) => tool.name)).toEqual(['mcp_other_ping']);
  });

  it('a name freed by unregister can be taken again', () => {
    const registry = new ToolRegistry();
    registry.register(definition({ name: 'alpha' }), noop);
    registry.unregister('alpha');
    expect(() => registry.register(definition({ name: 'alpha' }), noop)).not.toThrow();
  });

  it('answers whether a name is registered, for the pre-flight `tool_not_registered` check', () => {
    const registry = new ToolRegistry();
    registry.register(definition({ name: 'alpha' }), noop);
    expect(registry.has('alpha')).toBe(true);
    expect(registry.has('beta')).toBe(false);
  });

  it('every built-in name in the contract is a legal registry name', () => {
    const registry = new ToolRegistry();
    for (const name of BUILTIN_TOOL_NAMES) {
      expect(() => registry.register(definition({ name }), noop)).not.toThrow();
    }
    expect(registry.list()).toHaveLength(BUILTIN_TOOL_NAMES.length);
  });
});
