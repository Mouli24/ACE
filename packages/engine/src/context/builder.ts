import {
  CONTEXT_BUDGET_SHARES,
  DEFAULT_SEARCH_K,
  DEFAULT_SEARCH_MODE,
  type Envelope,
  type EnvelopeMemoryEntry,
  type Id,
  type MemoryEntry,
  type Node,
  type NodeError,
  type NodeRunSource,
  type Part,
  type RetrievedChunk,
  type SearchHit,
  type Verdict,
} from '@ace/contracts';

import { estimateTokens } from '../envelopes/index.js';
import { classifyError, failureReasonFor } from '../errors/index.js';
import type { EvaluationTarget } from '../guardrails/evaluator.js';
import { queryOf, sourceOf } from '../knowledge/retrieval-node.js';
import type { SearchService } from '../knowledge/search.js';
import type { GuardrailStep } from '../runs/executor.js';
import type { ContextGuard, ContextLabel } from './guard.js';

/**
 * The context builder (round 5 §2.2–§2.4, §4 item 7, Arch §12.6, F4, D232, FR-RAG-005..007,
 * FR-MEM-003, FR-GRD-004).
 *
 * It assembles what an agent reads beyond its upstream outputs — the chunks its attached knowledge
 * bases return and its own long-term memory — inside the agent's `budgetTokens`, and puts every
 * untrusted piece through the context guardrails before it is placed:
 *
 * - **Retrieval.** The query is the text of every incoming read, in `fromNodeId` order (the order
 *   the prompt manager reads them in). Each attached base is searched once, `k = 5`, the default
 *   mode; the hits are merged and sorted best first. They take at most
 *   `floor(budgetTokens × CONTEXT_BUDGET_SHARES.retrieved)` tokens: the best are placed while they
 *   fit, and from the first that does not, the rest are dropped — the lowest scores first — and
 *   recorded as `droppedSources`, lowest score first.
 * - **Memory.** Oldest first, inside `floor(budgetTokens × CONTEXT_BUDGET_SHARES.memory)`; entries
 *   that do not fit are left out from the newest end (§2.2). The ids placed come back as
 *   `usedMemoryIds`, for `lastUsedAt`.
 * - **Guardrails.** Each untrusted upstream read (and an untrusted summary), each chunk and each
 *   memory value goes through `guard.sanitise` before it is placed; a `failed` answer fails the node
 *   `GUARDRAIL_VIOLATION`. Only what is placed is judged: a chunk dropped for the budget never reaches
 *   a prompt, so it gets no verdict. What a person typed into an Input node is trusted (BR-13).
 * - **Placement (F4).** Retrieved chunks and memory ride the node's **first** envelope sorted by
 *   `fromNodeId`, which becomes `untrusted`; the other envelopes keep only their own reads and
 *   summary, so nothing is duplicated in the prompt. Envelopes come back in the order given.
 *
 * Token costs are the engine's estimate (`CHARS_PER_TOKEN`, Arch §24): a chunk costs its text, a
 * memory entry its key plus its value, both measured after sanitising. The summary keeps the rest of
 * the budget; it is built with the envelope, not here.
 */

export interface NodeContext {
  envelopes: Envelope[];
  /** The chunks placed, best first (FR-RAG-007). */
  sources: NodeRunSource[];
  /** The chunks left out to fit the budget, lowest score first (D233). */
  droppedSources: NodeRunSource[];
  /** The memory entries placed, oldest first. */
  usedMemoryIds: Id[];
}

export interface BuildNodeContextInput {
  node: Extract<Node, { kind: 'agent' }>;
  envelopes: readonly Envelope[];
  /** The agent's long-term memory, as stored; empty when memory is off or cleared. */
  memory: readonly MemoryEntry[];
  /** Absent when no knowledge store is wired: an attached base is then not searched. */
  search: SearchService | undefined;
  /** Absent when no guardrail engine is wired: content is placed unchecked (the round 4 posture). */
  guard: ContextGuard | undefined;
  target: EvaluationTarget;
}

/** A `failed` answer from the guard, carried out of a nested walk to the one place that reports it. */
class ContextRefused extends Error {
  override readonly name = 'ContextRefused';

  constructor(readonly nodeError: NodeError) {
    super(nodeError.message);
  }
}

/** Arrival order is a race; source node id is not (the prompt manager's order, TC-PRM-001). */
const byFromNodeId = (a: Envelope, b: Envelope): number => a.fromNodeId.localeCompare(b.fromNodeId);

/** Oldest first; `id` (a ULID) breaks a tie in creation order. */
const oldestFirst = (a: MemoryEntry, b: MemoryEntry): number =>
  Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id);

const memoryCost = (key: string, value: string): number =>
  estimateTokens(key) + estimateTokens(value);

export async function buildNodeContext(
  input: BuildNodeContextInput,
): Promise<GuardrailStep<NodeContext>> {
  const { node, guard, target } = input;
  const verdicts: Verdict[] = [];
  const budgetTokens = node.config.contextPolicy.budgetTokens;

  const failed = (error: NodeError): GuardrailStep<NodeContext> => ({
    kind: 'failed',
    failureReason: failureReasonFor(error),
    error,
    verdicts,
  });

  async function sanitise(label: ContextLabel, text: string): Promise<string> {
    if (guard === undefined) return text;
    const result = await guard.sanitise({ target, label, text });
    verdicts.push(...result.verdicts);
    if (result.kind === 'failed') throw new ContextRefused(result.error);
    return result.text;
  }

  async function sanitiseJson(value: unknown): Promise<unknown> {
    if (typeof value === 'string') return sanitise('upstream', value);
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      for (const item of value) items.push(await sanitiseJson(item));
      return items;
    }
    if (value !== null && typeof value === 'object') {
      const entries: [string, unknown][] = [];
      for (const [key, item] of Object.entries(value))
        entries.push([key, await sanitiseJson(item)]);
      return Object.fromEntries(entries);
    }
    return value;
  }

  async function sanitisePart(part: Part): Promise<Part> {
    switch (part.type) {
      case 'text':
        return { type: 'text', text: await sanitise('upstream', part.text) };
      case 'code':
        return { ...part, text: await sanitise('upstream', part.text) };
      case 'json':
        return { type: 'json', value: await sanitiseJson(part.value) };
      default:
        // A file-like part is a reference; there is no text in it to judge (D6).
        return part;
    }
  }

  /** BR-13: only an untrusted envelope is judged; what a person typed reaches the prompt as typed. */
  async function sanitiseEnvelope(envelope: Envelope): Promise<Envelope> {
    if (guard === undefined || envelope.context.trust !== 'untrusted') return envelope;

    const reads: Part[] = [];
    for (const part of envelope.reads) reads.push(await sanitisePart(part));
    const { summary } = envelope.context;

    return {
      ...envelope,
      reads,
      context: {
        ...envelope.context,
        ...(summary === undefined ? {} : { summary: await sanitise('upstream', summary) }),
      },
    };
  }

  async function search(query: string): Promise<SearchHit[]> {
    if (input.search === undefined || query.trim() === '') return [];
    const service = input.search;
    const knowledgeBaseIds = [...new Set(node.config.knowledgeBaseIds)];

    const responses = await Promise.all(
      knowledgeBaseIds.map((kbId) =>
        service.search(kbId, { query, k: DEFAULT_SEARCH_K, mode: DEFAULT_SEARCH_MODE }),
      ),
    );
    // Best first across every base; the sort is stable, so equal scores keep base order.
    return responses.flatMap((response) => response.hits).sort((a, b) => b.score - a.score);
  }

  /** The best chunks that fit the retrieved share, guarded; the rest dropped lowest score first. */
  async function fitRetrieved(hits: readonly SearchHit[]): Promise<{
    retrieved: RetrievedChunk[];
    sources: NodeRunSource[];
    droppedSources: NodeRunSource[];
  }> {
    const share = Math.floor(budgetTokens * CONTEXT_BUDGET_SHARES.retrieved);
    const retrieved: RetrievedChunk[] = [];
    const sources: NodeRunSource[] = [];
    const dropped: NodeRunSource[] = [];
    const seen = new Set<Id>();
    let used = 0;
    let full = false;

    for (const hit of hits) {
      if (seen.has(hit.chunkId)) continue;
      seen.add(hit.chunkId);

      // Measured before the guard sees it, so a chunk that cannot fit is never judged; measured
      // again after, because a redaction can lengthen the text.
      if (!full && used + estimateTokens(hit.text) <= share) {
        const text = await sanitise('retrieved', hit.text);
        const cost = estimateTokens(text);
        if (used + cost <= share) {
          retrieved.push({ chunkId: hit.chunkId, text, score: hit.score, source: hit.source });
          sources.push(sourceOf(hit));
          used += cost;
          continue;
        }
      }

      full = true;
      dropped.push(sourceOf(hit));
    }

    return { retrieved, sources, droppedSources: dropped.reverse() };
  }

  /** The oldest entries that fit the memory share, guarded; the newest left out. */
  async function fitMemory(): Promise<{ memory: EnvelopeMemoryEntry[]; usedMemoryIds: Id[] }> {
    const share = Math.floor(budgetTokens * CONTEXT_BUDGET_SHARES.memory);
    const memory: EnvelopeMemoryEntry[] = [];
    const usedMemoryIds: Id[] = [];
    let used = 0;

    for (const entry of [...input.memory].sort(oldestFirst)) {
      if (used + memoryCost(entry.key, entry.value) > share) break;
      const value = await sanitise('memory', entry.value);
      const cost = memoryCost(entry.key, value);
      if (used + cost > share) break;

      memory.push({ key: entry.key, value });
      usedMemoryIds.push(entry.id);
      used += cost;
    }

    return { memory, usedMemoryIds };
  }

  try {
    const envelopes: Envelope[] = [];
    for (const envelope of input.envelopes) envelopes.push(await sanitiseEnvelope(envelope));

    const ordered = [...envelopes].sort(byFromNodeId);
    const first = ordered[0];
    if (first === undefined) {
      // Nothing to carry the context: an agent with no incoming envelope reads nothing extra.
      return {
        kind: 'continue',
        envelopes,
        sources: [],
        droppedSources: [],
        usedMemoryIds: [],
        verdicts,
      };
    }

    let hits: SearchHit[];
    try {
      hits = await search(queryOf(ordered.flatMap((each) => each.reads)));
    } catch (error) {
      // A base deleted mid-run is BLOCKED (`missing_knowledge_base`), as pre-flight would have said;
      // anything else — an embedder that cannot be reached — is classified like any node failure.
      return failed(classifyError(error));
    }

    const { retrieved, sources, droppedSources } = await fitRetrieved(hits);
    const { memory, usedMemoryIds } = await fitMemory();

    if (retrieved.length > 0 || memory.length > 0) {
      envelopes[envelopes.indexOf(first)] = {
        ...first,
        context: {
          ...first.context,
          ...(retrieved.length === 0 ? {} : { retrieved }),
          ...(memory.length === 0 ? {} : { memory }),
          // Anything retrieved or remembered is untrusted, whoever sent the envelope (BR-13).
          trust: 'untrusted',
        },
      };
    }

    return { kind: 'continue', envelopes, sources, droppedSources, usedMemoryIds, verdicts };
  } catch (error) {
    if (error instanceof ContextRefused) return failed(error.nodeError);
    throw error;
  }
}
