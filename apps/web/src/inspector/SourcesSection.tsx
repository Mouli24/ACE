import type { Id, NodeRun, NodeRunSource, Part } from '@ace/contracts';
import { SourceChip } from '@ace/ui';
import { Link, useParams } from 'react-router-dom';

import { useDocumentBaseIndex, useWorkflowProjectId } from '../nodes/retrieval/hooks';

/** What a source can be shown with beyond its id: the chunk's text and, when known, its base. */
interface ChunkDetail {
  text?: string;
}

/** `{ hits }` json, the Retrieval node's output (round 5 §2.4), wherever it turns up. */
function hitsOf(part: Part): { chunkId: string; text?: string }[] {
  let value: unknown;
  if (part.type === 'json') value = part.value;
  else if (part.type === 'text') {
    try {
      value = JSON.parse(part.text);
    } catch {
      return [];
    }
  } else return [];
  const hits = (value as { hits?: unknown } | null)?.hits;
  if (!Array.isArray(hits)) return [];
  return hits.filter(
    (hit): hit is { chunkId: string; text?: string } =>
      typeof hit === 'object' &&
      hit !== null &&
      typeof (hit as { chunkId?: unknown }).chunkId === 'string',
  );
}

/**
 * Chunk text by id, from everything the node run recorded: a Retrieval node's own `{ hits }`
 * output, the hits a Retrieval node handed an agent in its reads, and the chunks an agent's context
 * builder retrieved (`context.retrieved`). A chunk with none of these shows its source only.
 */
export function chunkDetails(nodeRun: NodeRun): Map<string, ChunkDetail> {
  const details = new Map<string, ChunkDetail>();
  const add = (chunkId: string, text: string | undefined) => {
    if (text !== undefined && !details.get(chunkId)?.text) details.set(chunkId, { text });
  };
  for (const part of nodeRun.output ?? [])
    hitsOf(part).forEach((hit) => add(hit.chunkId, hit.text));
  for (const envelope of nodeRun.inputEnvelopes) {
    for (const chunk of envelope.context.retrieved ?? []) add(chunk.chunkId, chunk.text);
    for (const part of envelope.reads) hitsOf(part).forEach((hit) => add(hit.chunkId, hit.text));
  }
  return details;
}

/** Where a chunk opens: its document in the knowledge screen, scrolled to the chunk (FR-RAG-007). */
export function chunkHref(knowledgeBaseId: Id, source: NodeRunSource): string {
  const query = new URLSearchParams({ doc: source.documentId, chunk: source.chunkId });
  return `/knowledge/${knowledgeBaseId}?${query.toString()}`;
}

function SourceItem({
  source,
  detail,
  knowledgeBaseId,
  testId,
}: {
  source: NodeRunSource;
  detail: ChunkDetail | undefined;
  knowledgeBaseId: Id | undefined;
  testId: string;
}) {
  const chip = <SourceChip source={source.source} score={source.score} />;
  return (
    <li
      data-testid={testId}
      data-chunk-id={source.chunkId}
      data-score={source.score}
      className="flex flex-col gap-[6px] rounded-[10px] border border-[var(--line)] bg-[var(--soft)] px-3 py-[10px] text-[12px]"
    >
      <div className="flex flex-wrap items-center gap-2">
        {knowledgeBaseId === undefined ? (
          chip
        ) : (
          <Link
            to={chunkHref(knowledgeBaseId, source)}
            data-testid="source-link"
            title="Open the document at this chunk"
            className="rounded-full outline-none focus-visible:shadow-[0_0_0_2px_var(--focus)]"
          >
            {chip}
          </Link>
        )}
        <span
          className="font-machine text-[10px] text-[var(--muted)]"
          data-testid="source-chunk-id"
        >
          {source.chunkId}
        </span>
      </div>
      {detail?.text !== undefined && (
        <p
          className="m-0 line-clamp-4 whitespace-pre-wrap text-[12.5px] leading-[1.5] text-[var(--ink)]"
          data-testid="source-text"
        >
          {detail.text}
        </p>
      )}
    </li>
  );
}

/**
 * The chunks a node run's context used (round 5 §5 item 3, FR-RAG-007, TC-RAG-006/007): chunk id,
 * score, source and text, best first, each linking to its document at that chunk; then, collapsed,
 * the chunks the search found but the context budget had no room for (`droppedSources`). Nothing is
 * rendered for a node run that retrieved nothing.
 *
 * In the theme (D328): a mono small-caps label, each chunk an inner box on `--soft`, radius 10.
 */
export function SourcesSection({ nodeRun }: { nodeRun: NodeRun }) {
  const sources = nodeRun.sources ?? [];
  const dropped = nodeRun.droppedSources ?? [];
  const any = sources.length > 0 || dropped.length > 0;
  const params = useParams<{ projectId?: string; workflowId?: string }>();
  const workflowProjectId = useWorkflowProjectId(params.workflowId);
  const baseOf = useDocumentBaseIndex(params.projectId ?? workflowProjectId, any);
  if (!any) return null;
  const details = chunkDetails(nodeRun);

  return (
    <section className="flex flex-col gap-[7px]" data-testid="inspector-sources">
      <h3 className="m-0 font-machine text-[9.5px] font-medium uppercase tracking-[0.1em] text-[var(--muted)]">
        Sources
      </h3>
      {sources.length === 0 ? (
        <p className="m-0 text-[12px] text-[var(--muted)]">No chunk fitted the context budget.</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-[6px] p-0" data-testid="sources-list">
          {sources.map((source) => (
            <SourceItem
              key={source.chunkId}
              source={source}
              detail={details.get(source.chunkId)}
              knowledgeBaseId={baseOf.get(source.documentId)}
              testId={`source-${source.chunkId}`}
            />
          ))}
        </ol>
      )}
      {dropped.length > 0 && (
        <details data-testid="dropped-sources" className="text-[12px]">
          <summary className="cursor-pointer rounded-[4px] text-[var(--muted)] outline-none hover:text-[var(--ink)] focus-visible:shadow-[0_0_0_2px_var(--focus)]">
            Dropped to fit budget ({dropped.length})
          </summary>
          <ol className="m-0 mt-[6px] flex list-none flex-col gap-[6px] p-0">
            {dropped.map((source) => (
              <SourceItem
                key={source.chunkId}
                source={source}
                detail={details.get(source.chunkId)}
                knowledgeBaseId={baseOf.get(source.documentId)}
                testId={`dropped-source-${source.chunkId}`}
              />
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
