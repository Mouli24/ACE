import { isKbDocumentSettled, type Id, type KbDocument } from '@ace/contracts';
import type { IngestProgressView } from '@ace/sdk';
import { Badge, Button, DIALOG_CLOSE_CLASS, Icons, ProgressBar, cn, formatBytes } from '@ace/ui';
import { useEffect, useRef, useState } from 'react';

import { AttachmentPicker } from '../artifacts';
import { ConfirmDialog } from './ConfirmDialog';
import { documentTypeLabel, stageProgress } from './format';
import {
  useAddKbDocument,
  useDeleteKbDocument,
  useKbDocuments,
  useReindexKnowledgeBase,
} from './hooks';

const STATUS_VARIANT = {
  ready: 'accent',
  failed: 'danger',
} as const;

/**
 * A base's documents (FR-RAG-002/003/009): upload (the round 4 uploader, many files at once), one
 * row per document with its type, size, a status chip and a progress bar driven live by `kb.ingest`,
 * a failure's reason inline, its chunk count, delete (confirmed) and a reindex of the whole base.
 * A theme card; each document an inner box (D328).
 */
export function DocumentsPanel({
  kbId,
  progress,
  focusDocumentId,
}: {
  kbId: Id;
  progress: IngestProgressView;
  /** A document opened from an inspector source link (`?doc=`, FR-RAG-007): scrolled to and marked. */
  focusDocumentId?: Id | undefined;
}) {
  const documents = useKbDocuments(kbId);
  const focusedRow = useRef<HTMLLIElement | null>(null);
  const focusedLoaded = documents.data?.some((doc) => doc.id === focusDocumentId) ?? false;
  useEffect(() => {
    if (focusedLoaded) focusedRow.current?.scrollIntoView?.({ block: 'center' });
  }, [focusedLoaded]);
  const add = useAddKbDocument(kbId);
  const remove = useDeleteKbDocument(kbId);
  const reindex = useReindexKnowledgeBase(kbId);
  const [deleting, setDeleting] = useState<KbDocument | undefined>();

  const docs = documents.data ?? [];

  return (
    <section
      aria-labelledby="kb-documents-heading"
      className="flex min-w-0 flex-col gap-3 rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="kb-documents-heading" className="text-[14px] font-bold">
          Documents
        </h2>
        <Button
          variant="secondary"
          size="sm"
          disabled={docs.length === 0 || reindex.isPending}
          onClick={() => reindex.mutate()}
          data-testid="kb-reindex"
        >
          <Icons.RotateCw aria-hidden size={12} /> Reindex
        </Button>
      </div>

      <AttachmentPicker
        label="Add documents (PDF, DOCX, Markdown, HTML, text, code)"
        data-testid="kb-upload"
        onUploaded={(artifact) => add.mutate(artifact.id)}
      />
      {add.error && (
        <p role="alert" className="text-[12px] text-[#c94c27]">
          Could not add the document: {add.error.message}
        </p>
      )}
      {reindex.error && (
        <p role="alert" className="text-[12px] text-[#c94c27]">
          Could not reindex: {reindex.error.message}
        </p>
      )}

      {documents.isPending && <p className="text-[13px] text-[var(--muted)]">Loading documents…</p>}
      {documents.isError && (
        <p role="alert" className="text-[12px] text-[#c94c27]">
          Could not load documents: {documents.error.message}
        </p>
      )}
      {documents.isSuccess && docs.length === 0 && (
        <p className="py-6 text-center text-[13px] text-[var(--muted)]">
          No documents yet. Upload some to start ingestion.
        </p>
      )}

      {docs.length > 0 && (
        <ul aria-label="Documents" className="flex flex-col gap-2">
          {docs.map((doc) => {
            const live = progress.byDocument[doc.id];
            const settled = isKbDocumentSettled(doc.status);
            const value = live?.progress ?? stageProgress(doc.status);
            return (
              <li
                key={doc.id}
                ref={doc.id === focusDocumentId ? focusedRow : undefined}
                data-testid={`kb-doc-${doc.id}`}
                data-focused={doc.id === focusDocumentId ? 'true' : undefined}
                aria-current={doc.id === focusDocumentId ? 'true' : undefined}
                className={cn(
                  'flex min-w-0 flex-col gap-2 rounded-[10px] border bg-[var(--soft)] px-[10px] py-2',
                  doc.id === focusDocumentId
                    ? 'border-[#ef6b3f] shadow-[0_0_0_1px_#ef6b3f]'
                    : 'border-[var(--line)]',
                )}
              >
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                  <span
                    className="min-w-0 flex-1 truncate text-[12.5px] font-semibold"
                    title={doc.name}
                  >
                    {doc.name}
                  </span>
                  <span className="font-machine text-[10px] text-[var(--muted)]">
                    {documentTypeLabel(doc.name, doc.mime)} · {formatBytes(doc.size)}
                  </span>
                  <Badge
                    variant={
                      doc.status === 'ready' || doc.status === 'failed'
                        ? STATUS_VARIANT[doc.status]
                        : 'default'
                    }
                    data-testid={`kb-doc-status-${doc.id}`}
                    data-status={doc.status}
                    aria-label={`Status: ${doc.status}`}
                  >
                    {doc.status}
                  </Badge>
                  <span
                    className="font-machine text-[10px] text-[var(--muted)]"
                    data-testid={`kb-doc-chunks-${doc.id}`}
                  >
                    {doc.chunkCount} {doc.chunkCount === 1 ? 'chunk' : 'chunks'}
                  </span>
                  <button
                    type="button"
                    className={DIALOG_CLOSE_CLASS}
                    aria-label={`Delete ${doc.name}`}
                    onClick={() => setDeleting(doc)}
                  >
                    <Icons.X aria-hidden size={12} />
                  </button>
                </div>
                {!settled && (
                  <ProgressBar
                    value={value}
                    max={1}
                    label={`Ingesting ${doc.name}: ${doc.status}`}
                    showValue
                  />
                )}
                {doc.status === 'failed' && (
                  <p
                    role="alert"
                    className="text-[11px] leading-[1.45] text-[#c94c27]"
                    data-testid={`kb-doc-error-${doc.id}`}
                  >
                    {doc.error ?? live?.error ?? 'Ingestion failed.'}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          description="Its chunks are removed from the knowledge base and searches stop returning them."
          confirmLabel="Delete document"
          pending={remove.isPending}
          error={remove.error}
          onClose={() => setDeleting(undefined)}
          onConfirm={() => remove.mutate(deleting.id, { onSuccess: () => setDeleting(undefined) })}
        />
      )}
    </section>
  );
}
