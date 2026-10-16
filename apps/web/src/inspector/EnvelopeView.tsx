import { envelopeUsedTokens, type Envelope, type Id, type Part } from '@ace/contracts';
import { PartRenderer } from '@ace/ui';

import { api } from '../app/api';
import { useArtifact } from '../artifacts';
import { schemaSummary } from '../config-panel/ReadsSection';
import { VerdictList } from '../guardrails/VerdictList';

/** The theme's inner box: radius 10, soft fill, hairline. */
const INNER_BOX =
  'flex flex-col gap-1 rounded-[10px] border border-[var(--line)] bg-[var(--soft)] px-3 py-[10px] text-[12px]';
const META = 'm-0 font-machine text-[10.5px] text-[var(--muted)]';

/**
 * A node that is not an agent reads with no budget: the engine builds its envelopes to
 * `Number.MAX_SAFE_INTEGER` (BR-02 still holds, nothing is summarised for it).
 */
const UNBOUNDED = Number.MAX_SAFE_INTEGER;

/**
 * BR-02/BR-13, PG-4.1: what a node was handed — from which node, how much of its budget the reads
 * and context took, how trusted it was, the contract it was held to and the input-point verdicts on
 * its reads (PG-4.5) — then the reads themselves. Names come from the run's snapshot, so a node
 * renamed or deleted since still reads as it was when the run started.
 */
export function EnvelopeView({
  envelope,
  names,
  showTo = false,
}: {
  envelope: Envelope;
  /** Every node of the run's snapshot, by id. */
  names: ReadonlyMap<Id, string>;
  /** Also name the receiving node (Domain's dialog, where one envelope fans out to several). */
  showTo?: boolean;
}) {
  const from = names.get(envelope.fromNodeId) ?? 'a node not in this run';
  const to = names.get(envelope.toNodeId) ?? 'a node not in this run';
  const { context, contract } = envelope;
  const used = envelopeUsedTokens(envelope);
  const budget = context.budgetTokens >= UNBOUNDED ? undefined : context.budgetTokens;
  const verdicts = envelope.guardrailVerdicts ?? [];

  return (
    <div className={INNER_BOX} data-testid={`envelope-${envelope.id}`}>
      <p className={META}>
        from{' '}
        <b data-testid="envelope-from" className="font-semibold text-[var(--ink)]">
          {from}
        </b>
        {showTo && (
          <>
            {' '}
            to{' '}
            <b data-testid="envelope-to" className="font-semibold text-[var(--ink)]">
              {to}
            </b>
          </>
        )}{' '}
        · iteration {envelope.iteration} · <span data-testid="envelope-trust">{context.trust}</span>
      </p>
      <p className={META} data-testid="envelope-usage">
        {budget === undefined
          ? `≈ ${used.toLocaleString()} tokens · no budget`
          : `≈ ${used.toLocaleString()} of ${budget.toLocaleString()} tokens used`}
        {context.retrieved !== undefined && context.retrieved.length > 0 && (
          <> · {context.retrieved.length} retrieved</>
        )}
        {context.memory !== undefined && context.memory.length > 0 && (
          <> · {context.memory.length} remembered</>
        )}
      </p>
      <p className={META} data-testid="envelope-contract">
        contract {contract.outputTypes.join(', ')}
        {contract.jsonSchema !== undefined && (
          <span title={JSON.stringify(contract.jsonSchema)}>
            {' '}
            · {schemaSummary(contract.jsonSchema)}
          </span>
        )}
        {' · '}
        <span data-testid="envelope-max-tokens">
          {contract.maxTokens === undefined
            ? 'no max tokens'
            : `max ${contract.maxTokens.toLocaleString()} tokens`}
        </span>
      </p>
      {context.summary && (
        <p className="m-0 text-[var(--muted)]" data-testid="envelope-summary">
          {context.summary}
        </p>
      )}
      {verdicts.length > 0 && (
        <div data-testid="envelope-verdicts">
          <VerdictList verdicts={verdicts} />
        </div>
      )}
      {envelope.reads.map((part, index) => (
        <PartView key={index} part={part} />
      ))}
    </div>
  );
}

/**
 * All seven Part types, through the shared renderers (FR-MM-006): media resolve via the content URL.
 * A Part names its artifact but carries no hash; the row does (D214), so the card is given the
 * artifact's sha256 once it is fetched — "name, size, hash" (R4 §5 item 3, D-076).
 */
export function PartView({ part }: { part: Part }) {
  const artifact = useArtifact('artifactId' in part ? part.artifactId : undefined);
  const hash = artifact.data?.hash;
  return (
    <PartRenderer
      part={part}
      contentUrl={(artifactId) => api().artifactContentUrl(artifactId)}
      {...(hash === undefined ? {} : { hash })}
    />
  );
}
