import {
  DEFAULT_SEARCH_K,
  DEFAULT_SEARCH_MODE,
  SEARCH_K_MAX,
  SEARCH_K_MIN,
  SEARCH_MODES,
  SearchRequestSchema,
  type Id,
  type SearchMode,
} from '@ace/contracts';
import type { SearchRequestBody } from '@ace/sdk';
import { Button, Input, Label, SourceChip, formatScore } from '@ace/ui';
import { Search } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';

import { FieldError, fieldErrors, selectClass, toNumber, type FieldErrors } from './fields';
import { highlightSegments, queryTerms } from './format';
import { useKbSearch } from './hooks';

const MODE_LABEL: Record<SearchMode, string> = {
  hybrid: 'Hybrid (vector + keyword)',
  vector: 'Vector only',
  keyword: 'Keyword only',
};

/** A hit's text with the query's terms wrapped in `<mark>` (FR-RAG-008). */
function HighlightedText({ text, terms }: { text: string; terms: readonly string[] }) {
  return (
    <p className="whitespace-pre-wrap break-words font-human text-sm">
      {highlightSegments(text, terms).map((segment, index) =>
        segment.match ? (
          <mark key={index} className="rounded-sm bg-accent/30 px-0.5 text-fg">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </p>
  );
}

/**
 * Test search (FR-RAG-008): try a query against the base before attaching it — query, k (1–20),
 * mode — and see each hit's score, source, which index found it (`via`) and where it matched. The
 * search lives under the base's query key, so deleting a document or a reindex re-runs it.
 */
export function TestSearchPanel({ kbId }: { kbId: Id }) {
  const [query, setQuery] = useState('');
  const [k, setK] = useState(String(DEFAULT_SEARCH_K));
  const [mode, setMode] = useState<SearchMode>(DEFAULT_SEARCH_MODE);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [request, setRequest] = useState<SearchRequestBody | undefined>();

  const search = useKbSearch(kbId, request);
  const terms = useMemo(() => queryTerms(request?.query ?? ''), [request]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = SearchRequestSchema.safeParse({ query: query.trim(), k: toNumber(k), mode });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setRequest(parsed.data);
  };

  const hits = search.data?.hits ?? [];

  return (
    <section aria-labelledby="kb-search-heading" className="flex min-w-0 flex-col gap-3">
      <h2 id="kb-search-heading" className="font-human text-lg font-semibold">
        Test search
      </h2>
      <form onSubmit={submit} noValidate className="flex flex-col gap-3" role="search">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="kb-search-query">Query</Label>
          <Input
            id="kb-search-query"
            value={query}
            placeholder="Ask something the documents answer"
            aria-invalid={errors['query'] ? true : undefined}
            onChange={(event) => setQuery(event.target.value)}
          />
          <FieldError
            id="kb-search-query-error"
            message={errors['query'] && 'Type something to search for.'}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor="kb-search-k">Results (k)</Label>
            <Input
              id="kb-search-k"
              type="number"
              inputMode="numeric"
              min={SEARCH_K_MIN}
              max={SEARCH_K_MAX}
              value={k}
              aria-invalid={errors['k'] ? true : undefined}
              onChange={(event) => setK(event.target.value)}
            />
            <FieldError
              id="kb-search-k-error"
              message={errors['k'] && `k must be between ${SEARCH_K_MIN} and ${SEARCH_K_MAX}.`}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor="kb-search-mode">Mode</Label>
            <select
              id="kb-search-mode"
              className={selectClass}
              value={mode}
              onChange={(event) => setMode(event.target.value as SearchMode)}
            >
              {SEARCH_MODES.map((option) => (
                <option key={option} value={option}>
                  {MODE_LABEL[option]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <Button type="submit" className="self-start" disabled={search.isFetching}>
          <Search className="h-4 w-4" aria-hidden /> Search
        </Button>
      </form>

      {search.isError && (
        <p role="alert" className="text-sm text-danger">
          Search failed: {search.error.message}
        </p>
      )}
      {search.data && (
        <p className="font-machine text-[11px] text-fg-muted" data-testid="kb-search-summary">
          {hits.length} {hits.length === 1 ? 'result' : 'results'} in{' '}
          {Math.round(search.data.tookMs)} ms
        </p>
      )}
      {search.data && hits.length === 0 && (
        <p className="text-sm text-fg-muted">Nothing matched. Try other words or another mode.</p>
      )}
      {hits.length > 0 && (
        <ol aria-label="Search results" className="flex flex-col gap-2">
          {hits.map((hit, index) => (
            <li
              key={hit.chunkId}
              data-testid={`kb-search-hit-${hit.chunkId}`}
              data-document-id={hit.documentId}
              className="flex min-w-0 flex-col gap-2 rounded-card border border-border bg-panel px-3 py-2"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="font-machine text-[11px] text-fg-muted">#{index + 1}</span>
                <span
                  className="font-machine text-xs"
                  data-testid="kb-hit-score"
                  aria-label={`Score ${formatScore(hit.score)}`}
                >
                  {formatScore(hit.score)}
                </span>
                <SourceChip source={hit.source} via={hit.via} className="min-w-0" />
              </div>
              <HighlightedText text={hit.text} terms={terms} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
