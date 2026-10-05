import {
  CONTEXT_BUDGET_SHARES,
  type DataType,
  type Envelope,
  type EnvelopeContract,
  type Id,
  type Node,
  type NodeKind,
  type Part,
  type Timestamp,
  type TrustLevel,
  type Usage,
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

/**
 * The budget an agent's envelopes are built to (Task 9 review ruling, round 5 §2.2, §2.4): its
 * `budgetTokens` less the share its retrieved chunks may take when it has a knowledge base and the
 * share its memory may take when memory is on — so the reads and their summary leave room for both,
 * and the context builder, given the whole budget, fits them in what is left. An agent with neither
 * keeps the whole budget, exactly as before round 5.
 */
export function readsBudgetFor(agent: Extract<Node, { kind: 'agent' }>): number {
  const { budgetTokens } = agent.config.contextPolicy;
  const retrieved =
    (agent.config.knowledgeBaseIds?.length ?? 0) > 0 ? CONTEXT_BUDGET_SHARES.retrieved : 0;
  const memory = agent.config.memory?.enabled === true ? CONTEXT_BUDGET_SHARES.memory : 0;
  return Math.floor(budgetTokens * (1 - retrieved - memory));
}

/**
 * The envelopes a node run was delivered, from the ones its row stores (13b fix I1, FR-ERR-003,
 * BR-13). A row stores what the node read: its first envelope carries the chunks and memory the
 * context step placed, is `untrusted` and states the whole budget. A retry, or a drive seeded from
 * a recorded row, starts from what was *delivered* instead — the placed context taken off, the trust
 * the source node's kind gives (so a person's Input text is never judged as model output), and an
 * agent's reads budget — so its context step builds the context afresh, exactly as the first
 * attempt's did. An envelope as delivered comes back unchanged; `nodes` is the run's snapshot.
 */
export function asDelivered(envelopes: readonly Envelope[], nodes: readonly Node[]): Envelope[] {
  const byId = new Map(nodes.map((node): [Id, Node] => [node.id, node]));
  return envelopes.map((envelope) => {
    const { retrieved: _retrieved, memory: _memory, ...context } = envelope.context;
    const from = byId.get(envelope.fromNodeId);
    const to = byId.get(envelope.toNodeId);
    return {
      ...envelope,
      context: {
        ...context,
        ...(to?.kind === 'agent' ? { budgetTokens: readsBudgetFor(to) } : {}),
        ...(from === undefined ? {} : { trust: trustForSource(from.kind) }),
      },
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Summariser port                                                             */
/* -------------------------------------------------------------------------- */

export interface SummariseInput {
  parts: readonly Part[];
  budgetTokens: number;
  /** Cancels a model summarisation call when the run is stopped. */
  signal?: AbortSignal;
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
  summarise(
    input: SummariseInput & { target?: { providerId: Id; modelId: string } },
  ): Promise<SummariseResult & { usage?: Usage }>;
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
    async summarise({ parts, budgetTokens }) {
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
        parts: [
          ...(truncated === '' ? [] : [{ type: 'text' as const, text: truncated }]),
          ...references,
        ],
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
  /** The receiving node's model, for a summariser that calls one (F3). */
  target?: { providerId: Id; modelId: string };
  signal?: AbortSignal;
}

/** One envelope for one edge group, built to fit (FR-EXE-005, FR-EXE-007). */
export async function buildEnvelope(
  input: BuildEnvelopeInput,
  summariser: Summariser,
): Promise<{ envelope: Envelope; usage?: Usage }> {
  const { parts, summary, usage } = await summariser.summarise({
    parts: input.parts,
    budgetTokens: input.budgetTokens,
    ...(input.target === undefined ? {} : { target: input.target }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  const combinedSummary = summary ?? input.inheritedSummary;

  const envelope: Envelope = {
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

  return usage === undefined ? { envelope } : { envelope, usage };
}

/** A node's required output types, as the contract its upstream envelope carries. */
export function contractFor(
  outputTypes: DataType[],
  jsonSchema?: Record<string, unknown>,
  maxTokens?: number,
): EnvelopeContract {
  return {
    outputTypes,
    ...(jsonSchema === undefined ? {} : { jsonSchema }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  };
}
