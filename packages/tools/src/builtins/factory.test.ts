import { BUILTIN_TOOL_NAMES } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { ToolRegistry } from '../registry.js';
import { createBuiltinTools, isDockerAvailable, registerBuiltinTools } from './factory.js';

/** Agentic nodes' background-command tools, registered after the contract's list until it names them. */
const AGENTIC = ['command_output', 'kill_command'];
const contractOrder = (names: string[]) => names.filter((name) => !AGENTIC.includes(name));

describe('TC-TOOL-001 the six built-ins', () => {
  it('builds them in the contract order with no wiring', () => {
    const names = createBuiltinTools().map((tool) => tool.definition.name);
    expect(contractOrder(names)).toEqual([...BUILTIN_TOOL_NAMES]);
    expect(names).toEqual(expect.arrayContaining(AGENTIC));
  });

  it('registers all six on a registry, so GET /tools lists them in order', () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    expect(contractOrder(registry.list().map((definition) => definition.name))).toEqual([
      ...BUILTIN_TOOL_NAMES,
    ]);
    for (const definition of registry.list()) expect(definition.source).toBe('builtin');
  });

  it('probes Docker without requiring it (D13)', () => {
    expect(typeof isDockerAvailable()).toBe('boolean');
  });
});
