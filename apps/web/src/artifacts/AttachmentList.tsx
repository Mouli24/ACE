import type { Id } from '@ace/contracts';
import { Icons, formatBytes } from '@ace/ui';

import { api } from '../app/api';
import { useArtifact } from './useArtifact';

export interface AttachmentListProps {
  artifactIds: Id[];
  /** Detach one artifact; when omitted the list is read-only (e.g. a sent chat message). */
  onRemove?: (artifactId: Id) => void;
  'data-testid'?: string;
}

/** The theme's quiet square glyph button (28px, radius 7). */
const ROW_BUTTON_CLASS =
  'grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-[7px] border-none bg-transparent text-[12px] text-[var(--muted)] outline-none hover:bg-[var(--hover)] focus-visible:shadow-[0_0_0_2px_#ef6b3f]';

/** One attached artifact: name, size, type, a download link (FR-MM-009) and a remove control. */
function AttachmentRow({ id, onRemove }: { id: Id; onRemove?: (id: Id) => void }) {
  const artifact = useArtifact(id);

  return (
    <li
      data-testid={`attachment-${id}`}
      className="flex items-center gap-2 rounded-[9px] border border-[var(--line)] bg-[var(--canvas)] py-1.5 pl-3 pr-1"
    >
      <span className="min-w-0 flex-1">
        <span
          className="block truncate text-[12.5px] text-[var(--ink)]"
          title={artifact.data?.name}
        >
          {artifact.data?.name ?? (artifact.isError ? 'unavailable' : 'loading…')}
        </span>
        {artifact.data && (
          <span className="block font-machine text-[10px] text-[var(--muted)]">
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
          className={`${ROW_BUTTON_CLASS} no-underline hover:text-[var(--ink)]`}
        >
          <Icons.Download aria-hidden size={12} />
        </a>
      )}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${artifact.data?.name ?? 'attachment'}`}
          data-testid={`attachment-remove-${id}`}
          className={`${ROW_BUTTON_CLASS} hover:text-[#c94c27]`}
          onClick={() => onRemove(id)}
        >
          <Icons.X aria-hidden size={12} />
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
