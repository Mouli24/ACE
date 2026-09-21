import { describe, expect, it } from 'vitest';

import { derivePorts } from '../graph.js';
import { NODE_A } from './fixtures.js';

describe('FR-NODE-006 derivePorts', () => {
  it('gives an input node one output port per outputTypes entry, and no inputs', () => {
    const { inputs, outputs } = derivePorts({
      id: NODE_A,
      kind: 'input',
      config: { artifactIds: [], outputTypes: ['text', 'image'] },
    });

    expect(inputs).toEqual([]);
    expect(outputs).toEqual([
      { id: NODE_A + ':out:text', name: 'text', dataType: 'text', multi: true },
      { id: NODE_A + ':out:image', name: 'image', dataType: 'image', multi: true },
    ]);
  });

  it('gives an output node one single-edge input port per accepted type, in §2.4 order', () => {
    const { inputs, outputs } = derivePorts({ id: NODE_A, kind: 'output', config: {} });

    expect(outputs).toEqual([]);
    expect(inputs.map((p) => p.dataType)).toEqual([
      'text',
      'json',
      'image',
      'audio',
      'video',
      'code',
      'file',
    ]);
    expect(inputs.every((p) => p.multi === false)).toBe(true);
    expect(inputs[0]).toEqual({
      id: NODE_A + ':in:text',
      name: 'text',
      dataType: 'text',
      multi: false,
    });
  });

  it('gives an agent one single-edge input port per inputTypes and one output per outputTypes', () => {
    const { inputs, outputs } = derivePorts({
      id: NODE_A,
      kind: 'agent',
      config: {
        instructions: '',
        inputTypes: ['text', 'file'],
        outputTypes: ['json'],
        routing: { policy: 'fixed', fallbackModelIds: [] },
        execution: { temperature: 0.7, maxTokens: 4096, timeoutMs: 120_000, retries: 2 },
        contextPolicy: { budgetTokens: 4000 },
        tools: { enabled: [], maxToolCalls: 10, allowedDomains: [] },
        knowledgeBaseIds: [],
        memory: { enabled: false },
        skillIds: [],
      },
    });

    expect(inputs).toEqual([
      { id: NODE_A + ':in:text', name: 'text', dataType: 'text', multi: false },
      { id: NODE_A + ':in:file', name: 'file', dataType: 'file', multi: false },
    ]);
    expect(outputs).toEqual([
      { id: NODE_A + ':out:json', name: 'json', dataType: 'json', multi: true },
    ]);
  });

  it('derives a model node exactly like an agent node', () => {
    const { inputs, outputs } = derivePorts({
      id: NODE_A,
      kind: 'model',
      config: {
        inputTypes: ['image'],
        outputTypes: ['text'],
        execution: { temperature: 0.7, maxTokens: 4096, timeoutMs: 120_000, retries: 2 },
      },
    });

    expect(inputs).toEqual([
      { id: NODE_A + ':in:image', name: 'image', dataType: 'image', multi: false },
    ]);
    expect(outputs).toEqual([
      { id: NODE_A + ':out:text', name: 'text', dataType: 'text', multi: true },
    ]);
  });

  it('gives a merge node in (text, multi), in_json (json, multi) and out (json)', () => {
    const { inputs, outputs } = derivePorts({
      id: NODE_A,
      kind: 'merge',
      config: { mode: 'all' },
    });

    expect(inputs).toEqual([
      { id: NODE_A + ':in:in', name: 'in', dataType: 'text', multi: true },
      { id: NODE_A + ':in:in_json', name: 'in_json', dataType: 'json', multi: true },
    ]);
    expect(outputs).toEqual([
      { id: NODE_A + ':out:out', name: 'out', dataType: 'json', multi: true },
    ]);
  });

  it.each([
    ['template', 'json', false, 'text'],
    ['extract_json_field', 'json', false, 'json'],
    ['join', 'text', true, 'text'],
  ] as const)(
    'gives a %s transform an in port (%s, multi %s) and an out port (%s)',
    (op, inType, inMulti, outType) => {
      const { inputs, outputs } = derivePorts({ id: NODE_A, kind: 'transform', config: { op } });

      expect(inputs).toEqual([
        { id: NODE_A + ':in:in', name: 'in', dataType: inType, multi: inMulti },
      ]);
      expect(outputs).toEqual([
        { id: NODE_A + ':out:out', name: 'out', dataType: outType, multi: true },
      ]);
    },
  );

  it.each([
    ['retrieval', { k: 5 }],
    ['guardrail', {}],
    ['custom', {}],
  ] as const)('gives a %s node no ports until its own round (D19)', (kind, config) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercising a later-round kind
    expect(derivePorts({ id: NODE_A, kind, config } as any)).toEqual({ inputs: [], outputs: [] });
  });

  it('builds every port id as <nodeId>:in|out:<name> (D18)', () => {
    const { inputs, outputs } = derivePorts({
      id: NODE_A,
      kind: 'model',
      config: {
        inputTypes: ['text'],
        outputTypes: ['code'],
        execution: { temperature: 0.7, maxTokens: 4096, timeoutMs: 120_000, retries: 2 },
      },
    });

    for (const port of inputs) {
      expect(port.id).toBe(NODE_A + ':in:' + port.name);
    }
    for (const port of outputs) {
      expect(port.id).toBe(NODE_A + ':out:' + port.name);
    }
  });
});

describe('TC-NODE-005 Ports from types', () => {
  const agentWith = (outputTypes: string[]) => ({
    id: NODE_A,
    kind: 'agent' as const,
    config: {
      instructions: '',
      inputTypes: ['text' as const],
      outputTypes: outputTypes as ('text' | 'image')[],
      routing: { policy: 'fixed' as const, fallbackModelIds: [] },
      execution: { temperature: 0.7, maxTokens: 4096, timeoutMs: 120_000, retries: 2 },
      contextPolicy: { budgetTokens: 4000 },
      tools: { enabled: [], maxToolCalls: 10, allowedDomains: [] },
      knowledgeBaseIds: [],
      memory: { enabled: false },
      skillIds: [],
    },
  });

  it('adds an image port when image is added to the output types', () => {
    const before = derivePorts(agentWith(['text']));
    const after = derivePorts(agentWith(['text', 'image']));

    expect(before.outputs.map((p) => p.name)).toEqual(['text']);
    expect(after.outputs.map((p) => p.name)).toEqual(['text', 'image']);
  });

  it('keeps the existing port id stable when a type is added (D18)', () => {
    const before = derivePorts(agentWith(['text']));
    const after = derivePorts(agentWith(['text', 'image']));

    expect(after.outputs[0]).toEqual(before.outputs[0]);
  });

  it('keeps the remaining port id stable when an earlier type is removed (D18)', () => {
    const both = derivePorts(agentWith(['text', 'image']));
    const onlyImage = derivePorts(agentWith(['image']));

    expect(onlyImage.outputs[0]).toEqual(both.outputs[1]);
  });
});
