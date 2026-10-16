import type { GraphOp, Model, Node } from '@ace/contracts';

/**
 * PG-1.3 (D351): "Templates ask once for one provider for every node." The wizard's first step is
 * that question; the template is instantiated on the engine's default and every Agent/Model node is
 * then moved onto the provider the person chose, as one batch of `update_node` ops.
 *
 * Each node takes the first available model of that provider that covers its data types, else the
 * first available one; with none, the model is left empty, so pre-flight names it `missing_model`
 * rather than the run starting on a model the provider does not have.
 */
export function templateProviderOps(
  nodes: readonly Node[],
  providerId: string,
  models: readonly Model[],
): GraphOp[] {
  const offered = models.filter((model) => model.providerId === providerId && model.available);
  return nodes.flatMap((node): GraphOp[] => {
    if (node.kind !== 'agent' && node.kind !== 'model') return [];
    if (node.config.providerId === providerId) return [];
    const fits = offered.find(
      (model) =>
        node.config.inputTypes.every((type) => model.inputTypes.includes(type)) &&
        node.config.outputTypes.every((type) => model.outputTypes.includes(type)),
    );
    const modelId = (fits ?? offered[0])?.modelId ?? '';
    const config = { ...node.config, providerId, modelId } as Node['config'];
    return [{ op: 'update_node', nodeId: node.id, patch: { config } }];
  });
}
