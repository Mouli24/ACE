import {
  DEFAULT_SEARCH_K,
  MEMORY_OUTPUT_FIELD,
  type EnvelopeMemoryEntry,
  type HiddenInstructionType,
  type MemoryOp,
  type Node,
  type NodeRunSource,
  type Part,
  type RetrievedChunk,
  type SearchHit,
  type SearchMode,
} from '@ace/contracts';

import type { MockDb } from './db';
import { stripHiddenInstructions } from './knowledge';

/**
 * What round 5 changes about a node run in the mock engine (§2.2, §2.4, §2.10): a Retrieval node
 * searches its base and outputs `{ hits }`; an agent with `knowledgeBaseIds` retrieves implicitly
 * into `context.retrieved`; an agent with memory gets its entries in `context.memory`; and the four
 * §2.10 mock models answer the way the engine's mock adapter does. Every path records its chunks on
 * the node run as `sources` (FR-RAG-007), and `mock-memory`'s `__memory` ops are applied and
 * recorded as `memoryOps` (FR-MEM-002) — never left in the output (§2.2).
 *
 * Pure apart from the two lookups the caller resolves against the db, so the scenario builder can
 * stay free of storage.
 */

export interface Round5RunDeps {
  /** Search these bases; `k` per base, best first overall. */
  retrieve(
    knowledgeBaseIds: readonly string[],
    query: string,
    k: number,
    mode: SearchMode,
  ): SearchHit[];
  /** The node's remembered facts, oldest first. */
  memoryFor(nodeId: string): EnvelopeMemoryEntry[];
}

export interface Round5Behaviour {
  /** The node's output parts. */
  output: Part[];
  /** Its text, for edge summaries and the next node's reads. */
  text: string;
  /** What streams as `node.token`; empty for a node that calls no model. */
  streamed: string[];
  /** A Retrieval node calls no model: no `modelUsed`, no usage (D234). */
  calledModel: boolean;
  sources?: NodeRunSource[];
  retrieved?: RetrievedChunk[];
  memory?: EnvelopeMemoryEntry[];
  /** The `__memory` ops this node run applied (only with `memory.enabled`). */
  memoryOps?: MemoryOp[];
  /** Hidden-instruction kinds the context point stripped from retrieved or handed-over hits (§2.3). */
  stripped?: HiddenInstructionType[];
}

interface ModelConfig {
  modelId?: string;
  knowledgeBaseIds?: string[];
  memory?: { enabled: boolean };
}

const textOfParts = (parts: readonly Part[]): string =>
  parts
    .filter((part): part is Extract<Part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();

/** Hits a Retrieval node handed over, whether they arrive as a json part or as its text. */
function hitsIn(reads: readonly Part[]): SearchHit[] {
  for (const part of reads) {
    let value: unknown;
    if (part.type === 'json') value = part.value;
    else if (part.type === 'text') {
      try {
        value = JSON.parse(part.text);
      } catch {
        continue;
      }
    } else continue;
    const hits = (value as { hits?: unknown } | null)?.hits;
    if (Array.isArray(hits)) return hits as SearchHit[];
  }
  return [];
}

const toSource = (hit: SearchHit): NodeRunSource => ({
  chunkId: hit.chunkId,
  documentId: hit.documentId,
  score: hit.score,
  source: hit.source,
});

/** Words as the mock streams them: each with its trailing space, like `streamText`. */
const asTokens = (text: string): string[] => text.split(/(?<=\s)/).filter((token) => token !== '');

const firstWord = (text: string): string =>
  (text.match(/[\p{L}\p{N}'-]+/u)?.[0] ?? 'friend').slice(0, 80);

/** The first sentence of a chunk, for a citation's answer. */
const firstSentence = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  const end = line.search(/[.!?](\s|$)/);
  return (end === -1 ? line : line.slice(0, end + 1)).slice(0, 240);
};

const MOCK_MODELS = new Set(['mock-cite', 'mock-memory', 'mock-summary']);

/**
 * How round 5 shapes this node's run, or `undefined` when nothing of round 5 applies — every graph
 * of rounds 1–4 takes that branch, so their scenarios play exactly as before.
 */
export function round5Behaviour(
  node: Node,
  reads: readonly Part[],
  inputText: string,
  deps: Round5RunDeps,
): Round5Behaviour | undefined {
  if (node.kind === 'retrieval') {
    const config = node.config as { knowledgeBaseId?: string; k?: number; mode?: SearchMode };
    const query = textOfParts(reads) || inputText;
    const hits =
      config.knowledgeBaseId === undefined
        ? []
        : deps.retrieve(
            [config.knowledgeBaseId],
            query,
            config.k ?? DEFAULT_SEARCH_K,
            config.mode ?? 'hybrid',
          );
    return {
      output: [{ type: 'json', value: { hits } }],
      text: JSON.stringify({ hits }),
      streamed: [],
      calledModel: false,
      sources: hits.map(toSource),
    };
  }

  if (node.kind !== 'agent' && node.kind !== 'model') return undefined;
  const config = node.config as ModelConfig;
  const modelId = config.modelId ?? 'mock-text';
  const knowledgeBaseIds = node.kind === 'agent' ? (config.knowledgeBaseIds ?? []) : [];
  const memoryEnabled = node.kind === 'agent' && config.memory?.enabled === true;
  const handedHits = hitsIn(reads);

  if (
    knowledgeBaseIds.length === 0 &&
    !memoryEnabled &&
    handedHits.length === 0 &&
    !MOCK_MODELS.has(modelId)
  ) {
    return undefined;
  }

  // implicit retrieval: the incoming text is the query, k = 5 per base (§2.4)
  const query = textOfParts(reads) || inputText;
  const found =
    knowledgeBaseIds.length === 0
      ? []
      : deps.retrieve(knowledgeBaseIds, query, DEFAULT_SEARCH_K, 'hybrid');
  const stripped = new Set<HiddenInstructionType>();
  const retrieved: RetrievedChunk[] = found.map((hit) => {
    // the context point tags and sanitises before anything reaches a prompt (§2.3, BR-13)
    const clean = stripHiddenInstructions(hit.text);
    clean.stripped.forEach((type) => stripped.add(type));
    return { chunkId: hit.chunkId, text: clean.text, score: hit.score, source: hit.source };
  });
  // hits a Retrieval node handed over pass the same context point on their way into the prompt
  for (const hit of handedHits) {
    stripHiddenInstructions(hit.text).stripped.forEach((type) => stripped.add(type));
  }
  const memory = memoryEnabled ? deps.memoryFor(node.id) : [];
  // one source per chunk, however many paths found it
  const cited = [...found, ...handedHits].filter(
    (hit, index, all) => all.findIndex((other) => other.chunkId === hit.chunkId) === index,
  );

  let text: string | undefined;
  let output: Part[] | undefined;
  let memoryOps: MemoryOp[] | undefined;

  switch (modelId) {
    case 'mock-cite': {
      const top = cited[0];
      text =
        top === undefined
          ? 'I found no sources to answer from.'
          : `${firstSentence(stripHiddenInstructions(top.text).text)} [source: ${top.source}]`;
      break;
    }
    case 'mock-memory': {
      const said = textOfParts(reads) || inputText;
      const name = firstWord(said);
      const remembered = memory.find((entry) => entry.key === 'user_name');
      const answer =
        remembered === undefined
          ? `Nice to meet you, ${name}.`
          : `Welcome back, ${remembered.value}.`;
      const ops: MemoryOp[] = [{ op: 'save', key: 'user_name', value: name }];
      // the model answered `{ answer, __memory }`; §2.2 takes `__memory` out before anything else
      // sees it, so only `answer` is the node's output
      const raw: Record<string, unknown> = { answer, [MEMORY_OUTPUT_FIELD]: ops };
      output = [
        {
          type: 'json',
          value: Object.fromEntries(
            Object.entries(raw).filter(([key]) => key !== MEMORY_OUTPUT_FIELD),
          ),
        },
      ];
      text = answer;
      if (memoryEnabled) memoryOps = ops;
      break;
    }
    case 'mock-summary': {
      const words = (textOfParts(reads) || inputText).split(/\s+/).filter(Boolean);
      text = words.slice(0, 30).join(' ') || '(nothing to summarise)';
      break;
    }
    default:
      break;
  }

  return {
    output: output ?? (text === undefined ? [] : [{ type: 'text', text }]),
    text: text ?? '',
    streamed: text === undefined ? [] : asTokens(text),
    calledModel: true,
    ...(cited.length === 0 ? {} : { sources: cited.map(toSource) }),
    ...(retrieved.length === 0 ? {} : { retrieved }),
    ...(memory.length === 0 ? {} : { memory }),
    ...(memoryOps === undefined ? {} : { memoryOps }),
    ...(stripped.size === 0 ? {} : { stripped: [...stripped] }),
  };
}

/**
 * Apply a node's memory ops and announce them as one `memory.updated` (engine scope, D230). A save
 * replaces a key's value; a delete of an absent key changes nothing but is still reported.
 */
export function applyMemoryOps(db: MockDb, nodeId: string, ops: readonly MemoryOp[]): void {
  if (ops.length === 0) return;
  for (const op of ops) {
    if (op.op === 'save') db.saveMemory(nodeId, op.key, op.value);
    else db.deleteMemory(nodeId, { key: op.key });
  }
  db.emit({ type: 'memory.updated', scope: 'engine', payload: { nodeId, ops: [...ops] } });
}
