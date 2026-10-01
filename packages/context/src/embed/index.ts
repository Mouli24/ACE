import type { Embedder, ProviderAdapter } from '@ace/engine';

export const DEFAULT_EMBED_BATCH_SIZE = 32;

/**
 * Embeds texts through a provider adapter, `batchSize` at a time and in order, with the knowledge
 * base's embedding model (§2.1). An adapter without `embed()` rejects with a clear reason.
 */
export function createEmbedder(
  adapter: Pick<ProviderAdapter, 'embed'>,
  modelId: string,
  batchSize: number = DEFAULT_EMBED_BATCH_SIZE,
): Embedder {
  const size = Math.max(1, Math.floor(batchSize));
  return {
    async embed(texts) {
      const embed = adapter.embed;
      if (embed === undefined) {
        throw new Error(
          `The provider cannot create embeddings (embed() is not supported), so the embedding model "${modelId}" cannot be used.`,
        );
      }
      const vectors: number[][] = [];
      for (let i = 0; i < texts.length; i += size) {
        const batch = texts.slice(i, i + size);
        const result = await embed.call(adapter, batch, { modelId });
        if (result.length !== batch.length) {
          throw new Error(
            `The embedding model "${modelId}" returned ${result.length} vectors for ${batch.length} texts.`,
          );
        }
        vectors.push(...result);
      }
      return vectors;
    },
  };
}
