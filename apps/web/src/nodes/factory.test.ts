import { applyNewNodeInit, createNode } from './factory';

describe('applyNewNodeInit', () => {
  it('names the node and sets provider and model on an Agent', () => {
    const node = applyNewNodeInit(createNode('agent', 'wf', { x: 0, y: 0 }), {
      name: '  Draft  ',
      providerId: 'p1',
      modelId: 'm1',
    });
    expect(node.name).toBe('Draft');
    expect(node.kind === 'agent' && node.config.providerId).toBe('p1');
    expect(node.kind === 'agent' && node.config.modelId).toBe('m1');
  });

  it('ignores a blank name and never puts a model on a non-model kind', () => {
    const base = createNode('merge', 'wf', { x: 0, y: 0 });
    const node = applyNewNodeInit(base, { name: '   ', providerId: 'p1' });
    expect(node).toEqual(base);
  });
});
