import type { Id } from '@ace/contracts';
import { formatBytes } from '@ace/ui';
import { Download, File as FileIcon, X } from 'lucide-react';

import { api } from '../app/api';
import { useArtifact } from './useArtifact';

export interface AttachmentListProps {
  artifactIds: Id[];
  /** Detach one artifact; when omitted the list is read-only (e.g. a sent chat message). */
  onRemove?: (artifactId: Id) => void;
  'data-testid'?: string;
}

/** One attached artifact: name, size, type, a download link (FR-MM-009) and a remove control. */
function AttachmentRow({ id, onRemove }: { id: Id; onRemove?: (id: Id) => void }) {
  const artifact = useArtifact(id);

  return (
    <li
      data-testid={`attachment-${id}`}
      className="flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5"
    >
      <FileIcon className="h-3.5 w-3.5 shrink-0 text-fg-muted" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-human text-xs text-fg" title={artifact.data?.name}>
          {artifact.data?.name ?? (artifact.isError ? 'unavailable' : 'loading…')}
        </span>
        {artifact.data && (
          <span className="block font-machine text-[10px] text-fg-muted">
            {formatBytes(artifact.data.size)} · {artifact.data.mime}
          </span>
        )}
      </span>
      {artifact.data && (
        <a
          href={api().artifactContentUrl(id)}
          download={artifact.data.name}
          aria-label={`Download ${artifact.data.name}`}
          data-testid={`attachment-download-${id}`}
          className="shrink-0 rounded p-1 text-fg-muted hover:text-fg"
        >
          <Download className="h-3.5 w-3.5" aria-hidden />
        </a>
      )}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${artifact.data?.name ?? 'attachment'}`}
          data-testid={`attachment-remove-${id}`}
          className="shrink-0 rounded p-1 text-fg-muted hover:text-danger"
          onClick={() => onRemove(id)}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
    </li>
  );
}

/** The list of a node or message's attachments; each row loads its own metadata by id. */
export function AttachmentList({
  artifactIds,
  onRemove,
  'data-testid': testId = 'attachment-list',
}: AttachmentListProps) {
  if (artifactIds.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1" data-testid={testId}>
      {artifactIds.map((id) => (
        <AttachmentRow key={id} id={id} {...(onRemove ? { onRemove } : {})} />
      ))}
    </ul>
  );
}
