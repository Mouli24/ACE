import { BUILTIN_TOOL_NAMES } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { ToolRegistry } from '../registry.js';
import { createBuiltinTools, isDockerAvailable, registerBuiltinTools } from './factory.js';

describe('TC-TOOL-001 the six built-ins', () => {
  it('builds them in the contract order with no wiring', () => {
    const names = createBuiltinTools().map((tool) => tool.definition.name);
    expect(names).toEqual([...BUILTIN_TOOL_NAMES]);
  });

  it('registers all six on a registry, so GET /tools lists them in order', () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    expect(registry.list().map((definition) => definition.name)).toEqual([...BUILTIN_TOOL_NAMES]);
    for (const definition of registry.list()) expect(definition.source).toBe('builtin');
  });

  it('probes Docker without requiring it (D13)', () => {
    expect(typeof isDockerAvailable()).toBe('boolean');
  });
});
