import { describe, expect, it } from 'vitest';

import { FORMAT_VERSION } from '../graph.js';
import { WorkflowExportSchema } from '../export.js';
import { EDGE_ID, NODE_A, NODE_B, NOW, WORKFLOW_ID } from './fixtures.js';

const inputNode = {
  id: NODE_A,
  workflowId: WORKFLOW_ID,
  kind: 'input' as const,
  name: 'Input',
  position: { x: 0, y: 0 },
  inputs: [],
  outputs: [{ id: NODE_A + ':out:text', name: 'text', dataType: 'text' as const, multi: true }],
  config: { artifactIds: [], outputTypes: ['text' as const] },
};

const outputNode = {
  id: NODE_B,
  workflowId: WORKFLOW_ID,
  kind: 'output' as const,
  name: 'Output',
  position: { x: 400, y: 0 },
  inputs: [{ id: NODE_B + ':in:text', name: 'text', dataType: 'text' as const, multi: false }],
  outputs: [],
  config: {},
};

const edge = {
  id: EDGE_ID,
  workflowId: WORKFLOW_ID,
  kind: 'data' as const,
  from: { nodeId: NODE_A, portId: NODE_A + ':out:text' },
  to: { nodeId: NODE_B, portId: NODE_B + ':in:text' },
};

const exported = {
  formatVersion: FORMAT_VERSION,
  exportedAt: NOW,
  name: 'Linear',
  nodes: [inputNode, outputNode],
  edges: [edge],
};

describe('FR-WF-007 WorkflowExport round-trip', () => {
  it('parses back to exactly what was exported', () => {
    expect(WorkflowExportSchema.parse(exported)).toEqual(exported);
  });

  it('survives a JSON round-trip unchanged', () => {
    const reparsed = WorkflowExportSchema.parse(JSON.parse(JSON.stringify(exported)));

    expect(reparsed).toEqual(exported);
  });

  it('exports at formatVersion 1', () => {
    expect(FORMAT_VERSION).toBe(1);
  });

  it('accepts an export with no nodes and no edges', () => {
    expect(
      WorkflowExportSchema.safeParse({ ...exported, nodes: [], edges: [] }).success,
    ).toBe(true);
  });
});

describe('TC-WF-007 Export has no secrets', () => {
  /** Assembled at runtime: a key-shaped literal in the repo is itself banned (CLAUDE.md §2). */
  const fakeKey = ['sk', 'ant', 'x'.repeat(24)].join('-');

  it('keeps a providerId but drops any key-shaped field smuggled into the file', () => {
    const withProvider = {
      ...exported,
      nodes: [
        {
          ...inputNode,
          kind: 'model' as const,
          config: {
            providerId: NODE_A,
            modelId: 'mock-small',
            inputTypes: ['text' as const],
            outputTypes: ['text' as const],
            apiKey: fakeKey,
          },
        },
        outputNode,
      ],
    };

    const parsed = WorkflowExportSchema.parse(withProvider);
    const serialised = JSON.stringify(parsed);

    expect(serialised).not.toContain('apiKey');
    expect(serialised).not.toContain(fakeKey);
    expect(serialised).toContain(NODE_A);
  });

  it('drops an apiKey placed at the top level of the export', () => {
    const parsed = WorkflowExportSchema.parse({ ...exported, apiKey: fakeKey });

    expect('apiKey' in parsed).toBe(false);
  });
});

describe('TC-WF-008 Bad import version', () => {
  it.each([0, 2, 99])('rejects an import at formatVersion %i', (formatVersion) => {
    expect(WorkflowExportSchema.safeParse({ ...exported, formatVersion }).success).toBe(false);
  });

  it('rejects an import with no formatVersion at all', () => {
    const rest = { ...exported };
    delete (rest as { formatVersion?: unknown }).formatVersion;

    expect(WorkflowExportSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects an import whose exportedAt is not a timestamp', () => {
    expect(WorkflowExportSchema.safeParse({ ...exported, exportedAt: 'today' }).success).toBe(false);
  });
});
