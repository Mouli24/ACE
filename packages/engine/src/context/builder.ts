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

import { estimatePartsTokens, estimateTokens } from '../envelopes/index.js';
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
 * For an **agent** it assembles what the agent reads beyond its upstream outputs — the chunks its
 * attached knowledge bases return and its own long-term memory — inside the agent's `budgetTokens`;
 * for agents and **model** nodes alike it puts every untrusted piece through the context guardrails
 * before it reaches the prompt. A model node has no knowledge bases and no memory, so for it only the
 * upstream-read pass runs.
 *
 * - **Retrieval.** The query is the text of every incoming read, in `fromNodeId` order (the order
 *   the prompt manager reads them in). Each attached base is searched once, `k = 5`, the default
 *   mode; the hits are merged and sorted best first. They take at most
 *   `floor(budgetTokens × CONTEXT_BUDGET_SHARES.retrieved)` tokens: the best are placed while they
 *   fit, and from the first that does not, the rest are dropped — the lowest scores first.
 * - **Memory.** Oldest first, inside `floor(budgetTokens × CONTEXT_BUDGET_SHARES.memory)`; entries
 *   that do not fit are left out from the newest end (§2.2). The ids placed come back as
 *   `usedMemoryIds`, for `lastUsedAt`.
 * - **The whole budget.** The reads and every envelope summary are measured first, after guarding;
 *   memory then fits inside `min(its share, budgetTokens − reads)` and the chunks inside
 *   `min(their share, budgetTokens − reads − memory placed)` — memory first, because it has priority
 *   over chunks. So reads, summaries, chunks and memory together never exceed `budgetTokens`, and
 *   what the whole budget could not hold is never judged at all. Every chunk left out is in
 *   `droppedSources`, lowest score first. (The run service builds an agent's envelopes at a reduced
 *   budget, so the reads and their summary leave room for retrieval and memory.)
 * - **Guardrails.** Each untrusted upstream read — text, code, and every key and string of its JSON —
 *   and an untrusted summary, each chunk, and each memory key and value goes through the guard; a
 *   `failed` answer fails the node `GUARDRAIL_VIOLATION`. Only what is finally placed leaves a
 *   verdict: a chunk or entry dropped for the budget — even one that grew past it when a redaction
 *   lengthened it — never reaches a prompt, so its verdicts are never recorded. What a person typed
 *   into an Input node is trusted (BR-13).
 * - **Placement (F4).** Retrieved chunks and memory ride the node's **first** envelope sorted by
 *   `fromNodeId`, which becomes `untrusted` and states the whole `budgetTokens`; the other
 *   envelopes keep only their own reads and summary, so nothing is duplicated in the prompt.
 *   Envelopes come back in the order given. Context an envelope already carries — a stored one,
 *   reused by a retry or a re-run — is dropped first and rebuilt, never stacked.
 *
 * Token costs are the engine's estimate (`CHARS_PER_TOKEN`, Arch §24): a read as the envelope
 * measures it, a chunk its text, a memory entry its key plus its value — all after guarding.
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
  /** An agent gets retrieval, memory and the guard; a model node gets the guard over its reads. */
  node: Extract<Node, { kind: 'agent' | 'model' }>;
  envelopes: readonly Envelope[];
  /** The agent's long-term memory, as stored; empty when memory is off or cleared. */
  memory: readonly MemoryEntry[];
  /** Absent when no knowledge store is wired: an attached base is then not searched. */
  search: SearchService | undefined;
  /** Absent when no guardrail engine is wired: content is placed unchecked (the round 4 posture). */
  guard: ContextGuard | undefined;
  target: EvaluationTarget;
}

/**
 * A `failed` answer from the guard, carried out of a nested walk to the one place that reports it,
 * with the verdicts of the content that failed (they are recorded: that content is why the node
 * failed).
 */
class ContextRefused extends Error {
  override readonly name = 'ContextRefused';

  constructor(
    readonly nodeError: NodeError,
    readonly pending: readonly Verdict[],
  ) {
    super(nodeError.message);
  }
}

/** Something judged and kept for now; its verdicts are recorded only if it is finally placed. */
interface Judged {
  text: string;
  pending: Verdict[];
}

interface PlacedChunk {
  chunk: RetrievedChunk;
  source: NodeRunSource;
  cost: number;
  pending: Verdict[];
}

interface PlacedMemory {
  entry: EnvelopeMemoryEntry;
  id: Id;
  cost: number;
  pending: Verdict[];
}

/**
 * An envelope as it was delivered, without the context an earlier context step placed on it. A node
 * run stores the envelopes it read (13a review I2), and a retry, a re-run or a planned run starts
 * from those: their chunks and memory are rebuilt here, never stacked on the fresh ones — the reads
 * cost counts neither, so stacking would overrun the budget unseen.
 */
function withoutPlacedContext(envelope: Envelope): Envelope {
  const { retrieved, memory, ...context } = envelope.context;
  if (retrieved === undefined && memory === undefined) return envelope;
  return { ...envelope, context };
}

/** Arrival order is a race; source node id is not (the prompt manager's order, TC-PRM-001). */
const byFromNodeId = (a: Envelope, b: Envelope): number => a.fromNodeId.localeCompare(b.fromNodeId);

/** Oldest first; `id` (a ULID) breaks a tie in creation order. */
const oldestFirst = (a: MemoryEntry, b: MemoryEntry): number =>
  Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id);

const memoryCost = (key: string, value: string): number =>
  estimateTokens(key) + estimateTokens(value);

const sum = (costs: readonly { cost: number }[]): number =>
  costs.reduce((total, each) => total + each.cost, 0);

export async function buildNodeContext(
  input: BuildNodeContextInput,
): Promise<GuardrailStep<NodeContext>> {
  const { node, guard, target } = input;
  /** Recorded verdicts, in the order their content was placed. */
  const verdicts: Verdict[] = [];

  async function record(pending: readonly Verdict[]): Promise<void> {
    if (guard === undefined || pending.length === 0) return;
    verdicts.push(...(await guard.record(target, pending)));
  }

  async function failed(error: NodeError, pending: readonly Verdict[] = []) {
    await record(pending);
    const step: GuardrailStep<NodeContext> = {
      kind: 'failed',
      failureReason: failureReasonFor(error),
      error,
      verdicts,
    };
    return step;
  }

  /** Judge without recording; a refusal leaves through `ContextRefused`. */
  async function judge(label: ContextLabel, text: string): Promise<Judged> {
    if (guard === undefined) return { text, pending: [] };
    const result = await guard.inspect({ target, label, text });
    if (result.kind === 'failed') throw new ContextRefused(result.error, result.verdicts);
    return { text: result.text, pending: result.verdicts };
  }

  /** Judge something that is placed whatever its size — an upstream read — and record at once. */
  async function sanitise(label: ContextLabel, text: string): Promise<string> {
    const judged = await judge(label, text);
    await record(judged.pending);
    return judged.text;
  }

  /** Keys too: a JSON key reaches the prompt as surely as its value does (BR-13). */
  async function sanitiseJson(value: unknown): Promise<unknown> {
    if (typeof value === 'string') return sanitise('upstream', value);
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      for (const item of value) items.push(await sanitiseJson(item));
      return items;
    }
    if (value !== null && typeof value === 'object') {
      const entries: [string, unknown][] = [];
      for (const [key, item] of Object.entries(value)) {
        entries.push([await sanitise('upstream', key), await sanitiseJson(item)]);
      }
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

  async function search(knowledgeBaseIds: readonly Id[], query: string): Promise<SearchHit[]> {
    if (input.search === undefined || query.trim() === '') return [];
    const service = input.search;

    const responses = await Promise.all(
      [...new Set(knowledgeBaseIds)].map((kbId) =>
        service.search(kbId, { query, k: DEFAULT_SEARCH_K, mode: DEFAULT_SEARCH_MODE }),
      ),
    );
    // Best first across every base; the sort is stable, so equal scores keep base order.
    return responses.flatMap((response) => response.hits).sort((a, b) => b.score - a.score);
  }

  /** The best chunks that fit `share` (the room left for them), judged; the rest dropped, best first. */
  async function fitRetrieved(
    hits: readonly SearchHit[],
    share: number,
  ): Promise<{ placed: PlacedChunk[]; dropped: NodeRunSource[] }> {
    const placed: PlacedChunk[] = [];
    const dropped: NodeRunSource[] = [];
    const seen = new Set<Id>();
    let used = 0;
    let full = false;

    for (const hit of hits) {
      if (seen.has(hit.chunkId)) continue;
      seen.add(hit.chunkId);

      // Measured before the guard sees it, so a chunk that cannot fit is never judged; measured
      // again after, because a redaction can lengthen it — and then it is dropped unrecorded.
      if (!full && used + estimateTokens(hit.text) <= share) {
        const judged = await judge('retrieved', hit.text);
        const cost = estimateTokens(judged.text);
        if (used + cost <= share) {
          placed.push({
            chunk: {
              chunkId: hit.chunkId,
              text: judged.text,
              score: hit.score,
              source: hit.source,
            },
            source: sourceOf(hit),
            cost,
            pending: judged.pending,
          });
          used += cost;
          continue;
        }
      }

      full = true;
      dropped.push(sourceOf(hit));
    }

    return { placed, dropped };
  }

  /** The oldest entries that fit `share` (the room left for memory), key and value judged; the newest left out. */
  async function fitMemory(share: number): Promise<PlacedMemory[]> {
    const placed: PlacedMemory[] = [];
    let used = 0;

    for (const entry of [...input.memory].sort(oldestFirst)) {
      if (used + memoryCost(entry.key, entry.value) > share) break;
      const key = await judge('memory_key', entry.key);
      const value = await judge('memory', entry.value);
      const cost = memoryCost(key.text, value.text);
      if (used + cost > share) break;

      placed.push({
        entry: { key: key.text, value: value.text },
        id: entry.id,
        cost,
        pending: [...key.pending, ...value.pending],
      });
      used += cost;
    }

    return placed;
  }

  try {
    const envelopes: Envelope[] = [];
    for (const envelope of input.envelopes) {
      envelopes.push(await sanitiseEnvelope(withoutPlacedContext(envelope)));
    }

    const ordered = [...envelopes].sort(byFromNodeId);
    const first = ordered[0];
    if (node.kind === 'model' || first === undefined) {
      // A model node has no bases and no memory; an agent with no incoming envelope has nothing to
      // carry them. Either way the reads are all there is.
      return {
        kind: 'continue',
        envelopes,
        sources: [],
        droppedSources: [],
        usedMemoryIds: [],
        verdicts,
      };
    }

    const budgetTokens = node.config.contextPolicy.budgetTokens;
    /* What the reads already take: every envelope's reads and its summary (FR-EXE-007). */
    const readsCost = envelopes.reduce(
      (total, each) =>
        total + estimatePartsTokens(each.reads) + estimateTokens(each.context.summary ?? ''),
      0,
    );

    let hits: SearchHit[];
    try {
      hits = await search(
        node.config.knowledgeBaseIds,
        queryOf(ordered.flatMap((each) => each.reads)),
      );
    } catch (error) {
      // A base deleted mid-run is BLOCKED (`missing_knowledge_base`), as pre-flight would have said;
      // anything else — an embedder that cannot be reached — is classified like any node failure.
      return failed(classifyError(error));
    }

    /*
     * The whole budget (FR-EXE-007): each kind fits inside its share *and* inside what is left of
     * `budgetTokens` once the reads are paid for — memory first, because memory has priority over
     * chunks — so whatever the whole budget could not hold is never judged, never recorded and
     * never able to fail the node.
     */
    const memory = await fitMemory(
      Math.min(Math.floor(budgetTokens * CONTEXT_BUDGET_SHARES.memory), budgetTokens - readsCost),
    );
    const retrieved = await fitRetrieved(
      hits,
      Math.min(
        Math.floor(budgetTokens * CONTEXT_BUDGET_SHARES.retrieved),
        budgetTokens - readsCost - sum(memory),
      ),
    );

    // Only now is it known what is placed, so only now are its verdicts recorded.
    await record([
      ...retrieved.placed.flatMap((each) => each.pending),
      ...memory.flatMap((each) => each.pending),
    ]);

    const chunks = retrieved.placed.map((each) => each.chunk);
    const entries = memory.map((each) => each.entry);
    if (chunks.length > 0 || entries.length > 0) {
      envelopes[envelopes.indexOf(first)] = {
        ...first,
        context: {
          ...first.context,
          ...(chunks.length === 0 ? {} : { retrieved: chunks }),
          ...(entries.length === 0 ? {} : { memory: entries }),
          // The reads were delivered at the reduced reads budget; with the chunks and memory on it,
          // this envelope holds what the whole budget was fitted to, and says so (FR-EXE-007).
          budgetTokens,
          // Anything retrieved or remembered is untrusted, whoever sent the envelope (BR-13).
          trust: 'untrusted',
        },
      };
    }

    return {
      kind: 'continue',
      envelopes,
      sources: retrieved.placed.map((each) => each.source),
      // Every dropped chunk scored below every placed one; lowest first.
      droppedSources: [...retrieved.dropped].reverse(),
      usedMemoryIds: memory.map((each) => each.id),
      verdicts,
    };
  } catch (error) {
    if (error instanceof ContextRefused) return failed(error.nodeError, error.pending);
    throw error;
  }
}
