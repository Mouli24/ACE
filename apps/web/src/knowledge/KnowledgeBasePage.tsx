import { Button } from '@ace/ui';
import { Settings, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { ConfirmDialog } from './ConfirmDialog';
import { DocumentsPanel } from './DocumentsPanel';
import { KbSettingsDialog } from './KbSettingsDialog';
import { TestSearchPanel } from './TestSearchPanel';
import { useDeleteKnowledgeBase, useIngestProgress, useKnowledgeBase } from './hooks';

/**
 * `/knowledge/:kbId` — one base: its settings, documents with live ingestion, and a test search
 * (FR-RAG-002/003/008/009). Two columns on a wide screen, stacked below `lg` so it works at 380 px.
 */
export function KnowledgeBasePage() {
  const { kbId = '' } = useParams();
  const [search] = useSearchParams();
  const focusDocumentId = search.get('doc') ?? undefined;
  const focusChunkId = search.get('chunk') ?? undefined;
  const navigate = useNavigate();
  const kb = useKnowledgeBase(kbId);
  const progress = useIngestProgress(kbId);
  const remove = useDeleteKnowledgeBase();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (kb.isError) {
    return (
      <main data-testid="knowledge-base-page" className="p-6">
        <p role="alert" className="text-danger">
          Knowledge base not found.{' '}
          <Link to="/projects" className="underline">
            Back to projects
          </Link>
        </p>
      </main>
    );
  }

  const base = kb.data;

  return (
    <main
      data-testid="knowledge-base-page"
      className="mx-auto flex h-full w-full max-w-6xl flex-col gap-6 overflow-y-auto px-4 py-10"
    >
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {base && (
            <Link
              to={`/projects/${base.projectId}/knowledge`}
              className="font-human text-xs text-fg-muted underline-offset-2 hover:underline"
            >
              ← Knowledge
            </Link>
          )}
          <h1 className="break-words font-human text-2xl font-semibold" data-testid="kb-name">
            {base?.name ?? '…'}
          </h1>
          {base && (
            <p className="font-machine text-xs text-fg-muted" data-testid="kb-meta">
              {base.documentCount} {base.documentCount === 1 ? 'document' : 'documents'} ·{' '}
              {base.chunkCount} {base.chunkCount === 1 ? 'chunk' : 'chunks'} · embedder{' '}
              {base.embeddingModelId} · chunks {base.chunkSize} tokens, overlap {base.chunkOverlap}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant="secondary" size="sm" disabled={!base} onClick={() => setEditing(true)}>
            <Settings className="h-3.5 w-3.5" aria-hidden /> Settings
          </Button>
          <Button variant="secondary" size="sm" disabled={!base} onClick={() => setDeleting(true)}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete knowledge base
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex min-w-0 flex-col gap-2">
          {focusChunkId !== undefined && (
            <p className="font-machine text-xs text-fg-muted" data-testid="kb-opened-chunk">
              Opened from source chunk {focusChunkId}
            </p>
          )}
          <DocumentsPanel kbId={kbId} progress={progress} focusDocumentId={focusDocumentId} />
        </div>
        <TestSearchPanel kbId={kbId} />
      </div>

      {editing && base && <KbSettingsDialog kb={base} onClose={() => setEditing(false)} />}
      {deleting && base && (
        <ConfirmDialog
          title={`Delete ${base.name}?`}
          description="Every document, chunk and vector in it is removed. Agents attached to it stop retrieving from it."
          confirmLabel="Delete knowledge base"
          pending={remove.isPending}
          error={remove.error}
          onClose={() => setDeleting(false)}
          onConfirm={() =>
            remove.mutate(base, {
              onSuccess: () => navigate(`/projects/${base.projectId}/knowledge`),
            })
          }
        />
      )}
    </main>
  );
}
