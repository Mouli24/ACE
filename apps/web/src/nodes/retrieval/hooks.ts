import type { Id, KnowledgeBase } from '@ace/contracts';
import { useQueries, useQuery } from '@tanstack/react-query';

import { api } from '../../app/api';
import { kbQueryKeys } from '../../knowledge/hooks';
import { useWorkflowGraph } from '../../workflows/hooks';

/**
 * Knowledge-base reads the Retrieval node, the Agent's "Knowledge bases" field and the inspector's
 * Sources section share (round 5 §5 item 3). They are the knowledge screens' own keys, so a base
 * created or a document added there shows here at once.
 */
export const retrievalQueryKeys = {
  knowledgeBases: kbQueryKeys.list,
  kbDocuments: kbQueryKeys.documents,
};

/** `GET /projects/:id/knowledge-bases` → `{ items }`; idle until a project is known. */
export function useKnowledgeBases(projectId: Id | undefined) {
  return useQuery({
    queryKey: retrievalQueryKeys.knowledgeBases(projectId ?? ''),
    queryFn: async (): Promise<KnowledgeBase[]> =>
      (await api().listKnowledgeBases(projectId!)).items,
    enabled: projectId !== undefined && projectId !== '',
  });
}

/** The project a workflow belongs to, from the graph the Canvas already loaded. */
export function useWorkflowProjectId(workflowId: Id | undefined): Id | undefined {
  return useWorkflowGraph(workflowId).data?.workflow.projectId;
}

/**
 * The name of the base a Retrieval node searches, for its card (FR-RAG-006). No request is made for
 * any other kind of node, or for a Retrieval node with no base chosen yet.
 */
export function useKnowledgeBaseName(
  projectId: Id | undefined,
  knowledgeBaseId: Id | undefined,
): string | undefined {
  const bases = useKnowledgeBases(knowledgeBaseId === undefined ? undefined : projectId);
  if (knowledgeBaseId === undefined) return undefined;
  return bases.data?.find((base) => base.id === knowledgeBaseId)?.name;
}

/**
 * Which base each document belongs to, across every base of the project (FR-RAG-007): a node run's
 * sources name a document, and the link to the chunk needs its base. Idle unless asked.
 */
export function useDocumentBaseIndex(
  projectId: Id | undefined,
  enabled: boolean,
): ReadonlyMap<Id, Id> {
  const bases = useKnowledgeBases(enabled ? projectId : undefined);
  const documents = useQueries({
    queries: (bases.data ?? []).map((base) => ({
      queryKey: retrievalQueryKeys.kbDocuments(base.id),
      queryFn: async () => (await api().listKbDocuments(base.id)).items,
      enabled,
    })),
  });
  const index = new Map<Id, Id>();
  for (const result of documents) {
    for (const document of result.data ?? []) index.set(document.id, document.knowledgeBaseId);
  }
  return index;
}
