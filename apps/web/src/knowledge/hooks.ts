import {
  isKbDocumentSettled,
  type Id,
  type KbDocument,
  type KnowledgeBase,
  type UpdateKnowledgeBaseRequest,
} from '@ace/contracts';
import {
  IngestProgressBuffer,
  applyKbIngest,
  type CreateKnowledgeBaseBody,
  type IngestProgressView,
  type SearchRequestBody,
} from '@ace/sdk';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { api } from '../app/api';
import { getSocket } from '../app/socket';

/**
 * Engine data for the knowledge screens (round 5 §5 item 2, FR-RAG-001/002/003/008/009). Everything
 * about one base hangs under `kbQueryKeys.base(id)`, so a write to it — a document added, deleted,
 * settled, or a reindex — invalidates the base, its documents and any open test search at once: a
 * search re-runs after a delete and no longer returns the deleted document's chunks (TC-RAG-008).
 */
export const kbQueryKeys = {
  list: (projectId: Id) => ['knowledge-bases', projectId] as const,
  base: (id: Id) => ['knowledge-base', id] as const,
  documents: (id: Id) => ['knowledge-base', id, 'documents'] as const,
  search: (id: Id, request: SearchRequestBody) =>
    ['knowledge-base', id, 'search', request] as const,
};

/** `GET /projects/:id/knowledge-bases` → `{ items }` (FR-RAG-001, D235). */
export function useKnowledgeBases(projectId: Id) {
  return useQuery({
    queryKey: kbQueryKeys.list(projectId),
    queryFn: async () => (await api().listKnowledgeBases(projectId)).items,
    enabled: projectId !== '',
  });
}

/** `GET /knowledge-bases/:id`. */
export function useKnowledgeBase(id: Id) {
  return useQuery({
    queryKey: kbQueryKeys.base(id),
    queryFn: () => api().getKnowledgeBase(id),
    enabled: id !== '',
  });
}

/**
 * `GET /knowledge-bases/:id/documents` → `{ items }` (FR-RAG-002). `kb.ingest` patches it live; while
 * any document is still in the pipeline it also refetches every few seconds, so a screen opened with
 * no socket (or one that missed a frame) still reaches the engine's answer (BR-01).
 */
export function useKbDocuments(id: Id) {
  return useQuery({
    queryKey: kbQueryKeys.documents(id),
    queryFn: async () => (await api().listKbDocuments(id)).items,
    enabled: id !== '',
    refetchInterval: (query) =>
      (query.state.data ?? []).some((doc) => !isKbDocumentSettled(doc.status)) ? 3000 : false,
  });
}

/** A base changed: its row, documents and searches refetch, and so does the project's list. */
function invalidateBase(queryClient: QueryClient, kb: { id: Id; projectId?: Id }): void {
  void queryClient.invalidateQueries({ queryKey: kbQueryKeys.base(kb.id) });
  if (kb.projectId !== undefined) {
    void queryClient.invalidateQueries({ queryKey: kbQueryKeys.list(kb.projectId) });
  }
}

/** `POST /projects/:id/knowledge-bases` (FR-RAG-001). */
export function useCreateKnowledgeBase(projectId: Id) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateKnowledgeBaseBody): Promise<KnowledgeBase> =>
      api().createKnowledgeBase(projectId, body),
    onSuccess: (kb) => {
      queryClient.setQueryData(kbQueryKeys.base(kb.id), kb);
      void queryClient.invalidateQueries({ queryKey: kbQueryKeys.list(projectId) });
    },
  });
}

/** `PATCH /knowledge-bases/:id` — name and chunk settings only; the embedder is fixed (D235). */
export function useUpdateKnowledgeBase(id: Id) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateKnowledgeBaseRequest): Promise<KnowledgeBase> =>
      api().updateKnowledgeBase(id, body),
    onSuccess: (kb) => {
      queryClient.setQueryData(kbQueryKeys.base(kb.id), kb);
      void queryClient.invalidateQueries({ queryKey: kbQueryKeys.list(kb.projectId) });
    },
  });
}

/** `DELETE /knowledge-bases/:id` — its chunks and vectors go with it. */
export function useDeleteKnowledgeBase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (kb: KnowledgeBase): Promise<void> => api().deleteKnowledgeBase(kb.id),
    // The base's own queries are left to be collected once its page unmounts: removing them here
    // would refetch a 404 under the still-open page before it navigates away.
    onSuccess: (_void, kb) =>
      queryClient.invalidateQueries({ queryKey: kbQueryKeys.list(kb.projectId) }),
  });
}

/** `POST /knowledge-bases/:id/documents` → 202 `pending` document (FR-RAG-002). */
export function useAddKbDocument(id: Id) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (artifactId: Id): Promise<KbDocument> => api().addKbDocument(id, { artifactId }),
    onSuccess: (doc) => {
      queryClient.setQueryData<KbDocument[]>(kbQueryKeys.documents(id), (docs) =>
        docs === undefined || docs.some((d) => d.id === doc.id) ? docs : [...docs, doc],
      );
      invalidateBase(queryClient, { id });
    },
  });
}

/** `DELETE /kb-documents/:id` — removes its chunks too (FR-RAG-009, TC-RAG-008). */
export function useDeleteKbDocument(id: Id) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (documentId: Id): Promise<void> => api().deleteKbDocument(documentId),
    onSuccess: (_void, documentId) => {
      queryClient.setQueryData<KbDocument[]>(kbQueryKeys.documents(id), (docs) =>
        docs?.filter((d) => d.id !== documentId),
      );
      invalidateBase(queryClient, { id });
    },
  });
}

/** `POST /knowledge-bases/:id/reindex` → 202; every document goes round again (FR-RAG-009). */
export function useReindexKnowledgeBase(id: Id) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (): Promise<void> => api().reindexKnowledgeBase(id),
    onSuccess: () => invalidateBase(queryClient, { id }),
  });
}

/**
 * `POST /knowledge-bases/:id/query` for the test-search panel (FR-RAG-008). A query rather than a
 * mutation so that it lives under the base's key and re-runs whenever the base changes.
 */
export function useKbSearch(id: Id, request: SearchRequestBody | undefined) {
  return useQuery({
    queryKey: kbQueryKeys.search(id, request ?? { query: '' }),
    queryFn: () => api().queryKnowledgeBase(id, request ?? { query: '' }),
    enabled: id !== '' && request !== undefined,
  });
}

/**
 * Live ingestion progress for one base (round 5 §5 item 1–2, FR-RAG-003). `kb.ingest` rides the
 * engine subscription (D230), which the app socket already holds, so this only attaches a handler:
 * each frame is folded into an `IngestProgressBuffer` (replays and stale frames ignored) for the
 * progress bars, and patched into the cached document list with `applyKbIngest` for the status
 * chips. A document that settles — or one the cache has never seen — refetches the base, so its
 * chunk counts and the open search follow the engine.
 */
export function useIngestProgress(kbId: Id): IngestProgressView {
  const queryClient = useQueryClient();
  const buffer = useMemo(() => new IngestProgressBuffer(kbId), [kbId]);
  const [view, setView] = useState<IngestProgressView>(() => buffer.view);

  useEffect(() => {
    setView(buffer.view);
    const socket = getSocket();
    if (!socket || kbId === '') return;
    return socket.on('kb.ingest', (payload, frame) => {
      if (payload.knowledgeBaseId !== kbId) return;
      buffer.apply(frame);
      setView(buffer.view);
      let known = false;
      queryClient.setQueryData<KbDocument[]>(kbQueryKeys.documents(kbId), (docs) =>
        docs?.map((doc) => {
          if (doc.id !== payload.documentId) return doc;
          known = true;
          return applyKbIngest(doc, payload);
        }),
      );
      if (!known || isKbDocumentSettled(payload.status)) {
        invalidateBase(queryClient, { id: kbId });
        const kb = queryClient.getQueryData<KnowledgeBase>(kbQueryKeys.base(kbId));
        if (kb) void queryClient.invalidateQueries({ queryKey: kbQueryKeys.list(kb.projectId) });
      }
    });
  }, [buffer, kbId, queryClient]);

  return view;
}
