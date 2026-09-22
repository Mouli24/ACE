import type {
  DataType,
  Envelope,
  EnvelopeContract,
  Id,
  NodeKind,
  Part,
  Timestamp,
  TrustLevel,
} from '@ace/contracts';

/**
 * The envelope engine (FR-EXE-005, FR-EXE-007, Arch §12.4, BR-02, BR-13).
 *
 * Every handoff is an envelope, and every envelope fits its budget. Fitting is not "trim
 * afterwards": what does not fit is summarised out *before* the envelope exists, so there is no
 * moment at which an over-budget envelope has been built.
 */

/** Arch §24: the engine estimates tokens as characters over four rather than tokenising. */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** What a part costs, measured the way it will be rendered into the prompt (Arch §12.5). */
export function renderForMeasurement(part: Part): string {
  switch (part.type) {
    case 'text':
      return part.text;
    case 'json':
      return JSON.stringify(part.value);
    case 'code':
      return part.text;
    default:
      // D6: a file travels as a reference, so it costs the reference, not the file.
      return `[artifact ${part.name}]`;
  }
}

export function estimatePartsTokens(parts: readonly Part[]): number {
  return parts.reduce((total, part) => total + estimateTokens(renderForMeasurement(part)), 0);
}

/**
 * BR-13: only what a person typed into an Input node is trusted. Everything a model, a tool or a
 * retrieval produced is untrusted, however many hops ago it was produced.
 */
export function trustForSource(kind: NodeKind): TrustLevel {
  return kind === 'input' ? 'trusted' : 'untrusted';
}

/* -------------------------------------------------------------------------- */
/* Summariser port                                                             */
/* -------------------------------------------------------------------------- */

export interface SummariseInput {
  parts: readonly Part[];
  budgetTokens: number;
}

export interface SummariseResult {
  parts: Part[];
  /** Set when something had to be left out, so the agent knows it is not seeing everything. */
  summary?: string;
}

/**
 * How the engine makes content fit (FR-EXE-007). A real summarising model is a later round; the
 * port exists now so the scheduler and executor never have to know which one is in use.
 */
export interface Summariser {
  summarise(input: SummariseInput): SummariseResult;
}

export const TRUNCATED_SUMMARY = 'truncated to budget';

/** How much of the text budget the head keeps; the tail gets the rest. */
export const HEAD_SHARE = 0.7;

/**
 * Keep the beginning and the end (FR-EXE-007, TC-EXE-006).
 *
 * Head and tail rather than head alone: a document's opening says what it is and its closing says
 * what it concluded, and dropping the tail loses the answer while keeping the preamble. Seventy
 * to thirty because the opening usually carries more of the framing.
 *
 * Artifact references are kept whole and paid for first — they are a few characters each, and
 * dropping one would silently lose a file the downstream node is meant to read.
 */
export function createTruncatingSummariser(): Summariser {
  return {
    summarise({ parts, budgetTokens }) {
      if (estimatePartsTokens(parts) <= budgetTokens) return { parts: [...parts] };

      const references = parts.filter(
        (part) => part.type !== 'text' && part.type !== 'json' && part.type !== 'code',
      );
      const textual = parts.filter(
        (part) => part.type === 'text' || part.type === 'json' || part.type === 'code',
      );

      const summaryCost = estimateTokens(TRUNCATED_SUMMARY);
      const referenceCost = estimatePartsTokens(references);
      const textBudget = Math.max(0, budgetTokens - referenceCost - summaryCost);
      const budgetChars = textBudget * CHARS_PER_TOKEN;

      const joined = textual.map(renderForMeasurement).join('\n\n');
      const headChars = Math.floor(budgetChars * HEAD_SHARE);
      const tailChars = budgetChars - headChars;

      const truncated =
        budgetChars <= 0
          ? ''
          : joined.slice(0, headChars) + joined.slice(joined.length - tailChars);

      return {
        parts: [...(truncated === '' ? [] : [{ type: 'text' as const, text: truncated }]), ...references],
        summary: TRUNCATED_SUMMARY,
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Building an envelope                                                        */
/* -------------------------------------------------------------------------- */

export interface BuildEnvelopeInput {
  id: Id;
  runId: Id;
  fromNodeId: Id;
  toNodeId: Id;
  iteration: number;
  parts: readonly Part[];
  budgetTokens: number;
  trust: TrustLevel;
  contract: EnvelopeContract;
  createdAt: Timestamp;
  /** Carried through from an upstream summary, when there was one. */
  inheritedSummary?: string;
}

/** One envelope for one edge group, built to fit (FR-EXE-005, FR-EXE-007). */
export function buildEnvelope(input: BuildEnvelopeInput, summariser: Summariser): Envelope {
  const { parts, summary } = summariser.summarise({
    parts: input.parts,
    budgetTokens: input.budgetTokens,
  });

  const combinedSummary = summary ?? input.inheritedSummary;

  return {
    id: input.id,
    runId: input.runId,
    fromNodeId: input.fromNodeId,
    toNodeId: input.toNodeId,
    iteration: input.iteration,
    reads: parts,
    context: {
      ...(combinedSummary === undefined ? {} : { summary: combinedSummary }),
      budgetTokens: input.budgetTokens,
      trust: input.trust,
    },
    contract: input.contract,
    createdAt: input.createdAt,
  };
}

/** A node's required output types, as the contract its upstream envelope carries. */
export function contractFor(outputTypes: DataType[], jsonSchema?: Record<string, unknown>, maxTokens?: number): EnvelopeContract {
  return {
    outputTypes,
    ...(jsonSchema === undefined ? {} : { jsonSchema }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  };
}
