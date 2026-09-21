import type { Edge } from '@ace/contracts';

import { wouldCloseCycle } from './cycle';

const WF = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const [A, B, C] = [
  '01ARZ3NDEKTSV4RRFFQ69G5FA0',
  '01ARZ3NDEKTSV4RRFFQ69G5FA1',
  '01ARZ3NDEKTSV4RRFFQ69G5FA2',
];
let n = 0;
const e = (from: string, to: string, kind: Edge['kind'] = 'data'): Edge => ({
  id: `01ARZ3NDEKTSV4RRFFQ69G5FE${String(n++).padStart(1, '0')}`,
  workflowId: WF,
  kind,
  from: { nodeId: from, portId: `${from}:out:text` },
  to: { nodeId: to, portId: `${to}:in:text` },
});

describe('wouldCloseCycle (FR-CON-003, DFS over data edges)', () => {
  it('A→B then B→A closes a cycle', () => {
    expect(wouldCloseCycle([e(A, B)], B, A)).toBe(true);
  });

  it('A→B→C then C→A closes a cycle', () => {
    expect(wouldCloseCycle([e(A, B), e(B, C)], C, A)).toBe(true);
  });

  it('a self edge is a cycle', () => {
    expect(wouldCloseCycle([], A, A)).toBe(true);
  });

  it('fan-out and diamonds are not cycles', () => {
    expect(wouldCloseCycle([e(A, B), e(A, C)], B, C)).toBe(false);
    expect(wouldCloseCycle([e(A, B), e(A, C), e(B, C)], A, C)).toBe(false);
  });

  it('loop edges are ignored: only plain data edges count (D3)', () => {
    expect(wouldCloseCycle([e(A, B, 'loop')], B, A)).toBe(false);
  });
});
