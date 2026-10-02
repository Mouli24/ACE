import {
  DEFAULT_SEARCH_MODE,
  SEARCH_K_MAX,
  SEARCH_K_MIN,
  SEARCH_MODES,
  type Id,
  type RetrievalConfig,
} from '@ace/contracts';
import { Link } from 'react-router-dom';

import { useKnowledgeBases } from '../nodes/retrieval/hooks';
import { NumberField, SelectField } from './fields';
import type { PatchConfig } from './panels';
import type { NumberRange } from './validation';

/** The contract's own bound on `k` (round 5 §2.4: 1..20). */
export const RETRIEVAL_K_RANGE: NumberRange = {
  min: SEARCH_K_MIN,
  max: SEARCH_K_MAX,
  integer: true,
};

const MODE_LABEL: Record<(typeof SEARCH_MODES)[number], string> = {
  hybrid: 'hybrid (keyword + vector)',
  vector: 'vector (meaning)',
  keyword: 'keyword (exact terms)',
};

/**
 * The Retrieval node's panel (round 5 §5 item 3, FR-RAG-006): which of the project's knowledge
 * bases it searches, how many hits (`k`, 1–20) and how. The query arrives on its `query` port and
 * the hits leave as json on `out`; until a base is chosen pre-flight reports
 * `missing_knowledge_base`, which is why the select starts empty rather than picking one.
 */
export function RetrievalPanel({
  config,
  patch,
  projectId,
}: {
  config: RetrievalConfig;
  patch: PatchConfig<RetrievalConfig>;
  projectId: Id | undefined;
}) {
  const bases = useKnowledgeBases(projectId);
  const options = (bases.data ?? []).map((base) => ({ value: base.id, label: base.name }));
  // a base deleted since it was chosen stays visible, named for what it is
  const chosenMissing =
    config.knowledgeBaseId !== undefined &&
    bases.data !== undefined &&
    !bases.data.some((base) => base.id === config.knowledgeBaseId);

  return (
    <div className="flex flex-col gap-4" data-testid="retrieval-panel">
      <SelectField
        label="Knowledge base"
        value={config.knowledgeBaseId}
        options={
          chosenMissing
            ? [...options, { value: config.knowledgeBaseId!, label: 'deleted knowledge base' }]
            : options
        }
        placeholder={bases.isPending ? 'Loading…' : 'Choose a knowledge base'}
        disabled={options.length === 0 && !chosenMissing}
        onChange={(knowledgeBaseId) => patch({ knowledgeBaseId })}
        hint="The base this node searches."
      />
      {bases.data !== undefined && bases.data.length === 0 && (
        <p className="text-xs text-fg-muted" data-testid="retrieval-no-bases">
          No knowledge bases in this project yet.{' '}
          {projectId !== undefined && (
            <Link className="text-accent underline" to={`/projects/${projectId}/knowledge`}>
              Create one
            </Link>
          )}
        </p>
      )}
      {chosenMissing && (
        <p role="alert" className="text-xs text-danger" data-testid="retrieval-kb-missing">
          The chosen knowledge base no longer exists. Choose another before running.
        </p>
      )}
      <NumberField
        label="Results (k)"
        value={config.k}
        range={RETRIEVAL_K_RANGE}
        onCommit={(k) => patch({ k })}
      />
      <SelectField
        label="Search mode"
        value={config.mode ?? DEFAULT_SEARCH_MODE}
        options={SEARCH_MODES.map((mode) => ({ value: mode, label: MODE_LABEL[mode] }))}
        onChange={(mode) => patch({ mode })}
      />
    </div>
  );
}
