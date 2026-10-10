import {
  EnvelopeBlockSchema,
  closestHandles,
  type EnvelopeKind,
  type Id,
  type Part,
  type RosterEntry,
} from '@ace/contracts';

/**
 * Envelope blocks (D310): the only way an agent addresses a teammate. An agent writes zero or more
 * fenced ```ace-envelope JSON blocks; they are taken out of its answer, judged against the team and
 * the graph, and whatever is wrong with one is a CONTRACT_VIOLATION, so the single contract repair
 * retry tells the agent why. A handle in prose, or a name, addresses nobody (D324).
 */

const FENCE = /^[ \t]*```ace-envelope[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*$/gmu;

/** The answer with every block taken out, and the blocks' bodies, in order. */
export function extractEnvelopeBlocks(text: string): { text: string; blocks: string[] } {
  const blocks: string[] = [];
  const rest = text.replace(FENCE, (_fence, body: string) => {
    blocks.push(body.trim());
    return '';
  });
  if (blocks.length === 0) return { text, blocks };
  return { text: rest.replace(/\n{3,}/gu, '\n\n').trim(), blocks };
}

/** A QUERY still waiting for its ANSWER. */
export interface OpenQuery {
  from: Id;
  to: readonly Id[];
}

/** What a turn's blocks are judged against. */
export interface JudgeContext {
  roster: readonly RosterEntry[];
  /** The node whose turn wrote them. */
  fromNodeId: Id;
  /** The nodes its data edges feed: the only ones a HANDOFF may name. */
  successors: ReadonlySet<Id>;
  /** Every QUERY in the run still waiting for its ANSWER, by envelope id. */
  openQueries: ReadonlyMap<Id, OpenQuery>;
  /** The QUERYs this turn was handed: it must ANSWER each one. */
  mustAnswer: readonly Id[];
}

/** One block that passed, with its handles resolved to nodes. */
export interface JudgedEnvelope {
  kind: EnvelopeKind;
  toNodeIds: Id[];
  summary: string;
  inReplyTo?: Id;
}

export type EnvelopeJudgement =
  { ok: true; envelopes: JudgedEnvelope[] } | { ok: false; reason: string };

const handleOf = (roster: readonly RosterEntry[], nodeId: Id): string =>
  `@${roster.find((entry) => entry.nodeId === nodeId)?.handle ?? nodeId}`;

export function judgeEnvelopeBlocks(
  blocks: readonly string[],
  context: JudgeContext,
): EnvelopeJudgement {
  const { roster, fromNodeId } = context;
  const envelopes: JudgedEnvelope[] = [];
  const refuse = (reason: string): EnvelopeJudgement => ({ ok: false, reason });

  for (const [index, body] of blocks.entries()) {
    const which = `Envelope block ${index + 1}`;
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch (error) {
      return refuse(
        `${which} is not valid JSON (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
    const parsed = EnvelopeBlockSchema.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'block'}: ${issue.message}`)
        .join('; ');
      return refuse(`${which} is not a valid envelope (${issues}).`);
    }
    const block = parsed.data;

    const toNodeIds: Id[] = [];
    for (const raw of block.to) {
      const handle = raw.trim().replace(/^@/u, '').toLowerCase();
      if (handle === 'all') {
        return refuse(`${which}: @all is the human's to use; name each teammate instead.`);
      }
      const entry = roster.find((each) => each.handle === handle);
      if (entry === undefined) {
        const near = closestHandles(handle, roster).filter((each) => each !== '@all');
        return refuse(
          `${which}: @${handle} is not on the team.${near.length === 0 ? '' : ` Did you mean ${near.join(' or ')}?`}`,
        );
      }
      if (entry.nodeId === fromNodeId) {
        return refuse(`${which}: an envelope cannot be sent to its own sender (@${handle}).`);
      }
      if (!toNodeIds.includes(entry.nodeId)) toNodeIds.push(entry.nodeId);
    }

    if (block.kind === 'HANDOFF') {
      const stray = toNodeIds.find((nodeId) => !context.successors.has(nodeId));
      if (stray !== undefined) {
        const fed = [...context.successors]
          .filter((nodeId) => roster.some((entry) => entry.nodeId === nodeId))
          .map((nodeId) => handleOf(roster, nodeId));
        return refuse(
          `${which}: a HANDOFF goes along the graph, and this node does not feed ${handleOf(roster, stray)}.${
            fed.length === 0 ? ' It feeds no teammate.' : ` It can hand off to ${fed.join(', ')}.`
          }`,
        );
      }
    }

    if (block.kind === 'ANSWER') {
      if (block.inReplyTo === undefined) {
        return refuse(`${which}: an ANSWER needs inReplyTo, the id of the QUERY it answers.`);
      }
      const query = context.openQueries.get(block.inReplyTo);
      if (query === undefined || !query.to.includes(fromNodeId)) {
        return refuse(`${which}: there is no QUERY ${block.inReplyTo} open to this node.`);
      }
      if (toNodeIds.length !== 1 || toNodeIds[0] !== query.from) {
        return refuse(
          `${which}: an ANSWER goes back to whoever asked, ${handleOf(roster, query.from)}.`,
        );
      }
    }

    envelopes.push({
      kind: block.kind,
      toNodeIds,
      summary: block.summary,
      ...(block.inReplyTo === undefined ? {} : { inReplyTo: block.inReplyTo }),
    });
  }

  const kinds = new Set(envelopes.map((envelope) => envelope.kind));
  if (kinds.has('HANDOFF') && (kinds.has('QUERY') || kinds.has('FLAG'))) {
    return refuse(
      'A turn that sends a QUERY waits for its answer, and one that sends a FLAG hands nothing on, so neither can also HANDOFF.',
    );
  }

  for (const queryId of context.mustAnswer) {
    const answered = envelopes.some(
      (envelope) => envelope.kind === 'ANSWER' && envelope.inReplyTo === queryId,
    );
    if (answered) continue;
    const query = context.openQueries.get(queryId);
    const asker = query === undefined ? 'the asker' : handleOf(roster, query.from);
    return refuse(
      `This turn was handed QUERY ${queryId} from ${asker}: answer it with an ANSWER envelope whose inReplyTo is ${queryId}.`,
    );
  }

  return { ok: true, envelopes };
}

/** The text a teammate reads as an envelope's body: the answer, its blocks already taken out. */
export function envelopeBody(parts: readonly Part[]): string {
  return parts
    .map((part) => {
      if (part.type === 'text' || part.type === 'code') return part.text;
      if (part.type === 'json') return JSON.stringify(part.value);
      return '';
    })
    .filter((text) => text.trim() !== '')
    .join('\n\n');
}
