import { describe, expect, it } from 'vitest';

import { EnvelopeContextSchema, EnvelopeMemoryEntrySchema } from '../envelope.js';
import {
  MEMORY_KEY_MAX,
  MEMORY_OUTPUT_FIELD,
  MEMORY_PROMPT_HEADING,
  MEMORY_VALUE_MAX,
  MemoryEntrySchema,
  MemoryOpSchema,
  MemoryOpsSchema,
} from '../memory.js';
import { MEMORY_ENTRY_ID, NODE_A, NOW } from './fixtures.js';

const entry = {
  id: MEMORY_ENTRY_ID,
  nodeId: NODE_A,
  key: 'user_name',
  value: 'Ada',
  createdAt: NOW,
  updatedAt: NOW,
};

describe('FR-MEM-002 FR-MEM-004 MemoryEntry', () => {
  it('parses a stored entry, with and without a last use', () => {
    expect(MemoryEntrySchema.parse(entry)).toEqual(entry);
    expect(MemoryEntrySchema.parse({ ...entry, lastUsedAt: NOW })).toEqual({
      ...entry,
      lastUsedAt: NOW,
    });
  });

  it('bounds the value to 1..2000 characters (§3)', () => {
    expect(MEMORY_VALUE_MAX).toBe(2000);
    expect(MemoryEntrySchema.safeParse({ ...entry, value: 'x'.repeat(2000) }).success).toBe(true);
    expect(MemoryEntrySchema.safeParse({ ...entry, value: 'x'.repeat(2001) }).success).toBe(false);
    expect(MemoryEntrySchema.safeParse({ ...entry, value: '' }).success).toBe(false);
  });

  it('bounds the key to 1..80 characters', () => {
    expect(MEMORY_KEY_MAX).toBe(80);
    expect(MemoryEntrySchema.safeParse({ ...entry, key: 'k'.repeat(80) }).success).toBe(true);
    expect(MemoryEntrySchema.safeParse({ ...entry, key: 'k'.repeat(81) }).success).toBe(false);
    expect(MemoryEntrySchema.safeParse({ ...entry, key: '' }).success).toBe(false);
  });

  it('belongs to one agent node and is strict', () => {
    const { nodeId: _node, ...orphan } = entry;
    expect(MemoryEntrySchema.safeParse(orphan).success).toBe(false);
    expect(MemoryEntrySchema.safeParse({ ...entry, trust: 'trusted' }).success).toBe(false);
  });
});

describe('FR-MEM-002 MemoryOp', () => {
  it('saves a key with a value, or deletes a key', () => {
    const save = { op: 'save', key: 'user_name', value: 'Ada' };
    const remove = { op: 'delete', key: 'user_name' };

    expect(MemoryOpSchema.parse(save)).toEqual(save);
    expect(MemoryOpSchema.parse(remove)).toEqual(remove);
  });

  it('refuses a save with no value, a delete with one, and any other op', () => {
    expect(MemoryOpSchema.safeParse({ op: 'save', key: 'k' }).success).toBe(false);
    expect(MemoryOpSchema.safeParse({ op: 'delete', key: 'k', value: 'v' }).success).toBe(false);
    expect(MemoryOpSchema.safeParse({ op: 'clear' }).success).toBe(false);
  });

  it('holds an op to the same bounds as the entry it writes', () => {
    expect(
      MemoryOpSchema.safeParse({ op: 'save', key: 'k', value: 'x'.repeat(2001) }).success,
    ).toBe(false);
    expect(MemoryOpSchema.safeParse({ op: 'delete', key: 'k'.repeat(81) }).success).toBe(false);
  });

  it('reads the ops from an agent output field named __memory (§2.2)', () => {
    expect(MEMORY_OUTPUT_FIELD).toBe('__memory');
    const output = {
      answer: 'Hello, Ada.',
      [MEMORY_OUTPUT_FIELD]: [{ op: 'save', key: 'user_name', value: 'Ada' }],
    };

    expect(MemoryOpsSchema.parse(output[MEMORY_OUTPUT_FIELD])).toHaveLength(1);
  });

  it('names the prompt block the memory instruction lives under (§2.2)', () => {
    expect(MEMORY_PROMPT_HEADING).toBe('## Memory operations');
  });
});

describe('FR-MEM-003 memory in the envelope', () => {
  it('carries only key and value in the envelope — not the stored row (D229)', () => {
    expect(EnvelopeMemoryEntrySchema.parse({ key: 'user_name', value: 'Ada' })).toEqual({
      key: 'user_name',
      value: 'Ada',
    });
    expect(EnvelopeMemoryEntrySchema.safeParse(entry).success).toBe(false);
  });

  it('TC-MEM-002 allows an envelope with no memory section at all', () => {
    const context = EnvelopeContextSchema.parse({ budgetTokens: 4000, trust: 'untrusted' });
    expect(context).not.toHaveProperty('memory');
  });
});
