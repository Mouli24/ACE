import { describe, expect, it } from 'vitest';

import { ToolRegistry } from '../registry.js';
import { registerBuiltinTools } from './factory.js';

describe('D301 agents never get the terminal', () => {
  it('registers no built-in tool for processes or the terminal', () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    const names = registry.list().map((definition) => definition.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => /process|terminal/i.test(name))).toEqual([]);
  });
});
