import {
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  REVIEW_CONTRACT_SCHEMA,
  RetrievalConfigSchema,
  derivePorts,
  portId,
  validateLoopConfig,
  type Edge,
  type InstantiateTemplateResponse,
  type KnowledgeBase,
  type Node,
  type NodePortSource,
  type Position,
  type Project,
  type Provider,
  type Template,
  type TemplateId,
} from '@ace/contracts';

import { newId } from '../lib/ulid';
import { createNode } from '../nodes/factory';
import { MOCK_EMBED_MODEL_ID } from './catalog';
import type { MockDb } from './db';
import { addDocument, ingestNow } from './knowledge';
import { SAMPLE_DOCUMENT_FIXTURE } from './knowledge-fixtures';

/**
 * The four starting points (round 5 §2.7, FR-ONB-002), as the mock engine builds them. Each is wired
 * to the mock provider — created on the spot if there is none, since a mock needs no key — so every
 * one runs to COMPLETE with no key and no network (TC-ONB-002).
 */

export const TEMPLATES: readonly Template[] = [
  {
    id: 'linear-chain',
    name: 'Linear chain',
    description: 'One agent answers one request: Input → Agent → Output.',
    requires: { knowledgeBase: false },
  },
  {
    id: 'review-fix',
    name: 'Review and fix',
    description:
      'A writer drafts, a reviewer scores the draft, and a loop sends it back until it passes.',
    requires: { knowledgeBase: false },
  },
  {
    id: 'parallel-research',
    name: 'Parallel research',
    description: 'Two researchers work at once and a merge node combines what they found.',
    requires: { knowledgeBase: false },
  },
  {
    id: 'rag-qa',
    name: 'RAG Q&A',
    description: 'Answer questions from your own documents, with every source cited.',
    requires: { knowledgeBase: true },
  },
  {
    id: 'single-builder',
    name: 'Single builder',
    description: 'One coding agent takes a task and changes the code in its own workspace.',
    requires: { knowledgeBase: false },
  },
  {
    id: 'plan-build-review',
    name: 'Plan, build and review',
    description:
      'A planner breaks the task down, a builder changes the code, a reviewer sends it back until it is right.',
    requires: { knowledgeBase: false },
  },
];

export const templateById = (id: string): Template | undefined =>
  TEMPLATES.find((template) => template.id === id);

/** The mock provider every template runs on, created when the engine has none yet. */
export function mockProviderOf(db: MockDb): Provider {
  return (
    db.listProviders().find((provider) => provider.type === 'mock') ??
    db.createProvider({ type: 'mock', name: 'Mock' })
  );
}

/** Columns 400 px apart: a card grows with its content, and at 320 px neighbours overlapped. */
const at = (x: number, y = 160): Position => ({ x, y });

function agent(
  workflowId: string,
  name: string,
  position: Position,
  config: Record<string, unknown>,
): Node {
  const node = createNode('agent', workflowId, position);
  const built = { ...node, name, config: { ...node.config, ...config } } as Node;
  return { ...built, ...derivePorts(built as NodePortSource) } as Node;
}

function retrievalNode(workflowId: string, knowledgeBaseId: string, position: Position): Node {
  const base = {
    id: newId(),
    kind: 'retrieval' as const,
    config: RetrievalConfigSchema.parse({ knowledgeBaseId }),
  };
  return { ...base, workflowId, name: 'Retrieval', position, ...derivePorts(base) } as Node;
}

function input(workflowId: string, text: string): Node {
  const node = createNode('input', workflowId, at(80));
  return { ...node, config: { ...node.config, text } } as Node;
}

const dataEdge = (
  workflowId: string,
  from: Node,
  fromPort: string,
  to: Node,
  toPort: string,
): Edge => ({
  id: newId(),
  workflowId,
  kind: 'data',
  from: { nodeId: from.id, portId: portId(from.id, 'out', fromPort) },
  to: { nodeId: to.id, portId: portId(to.id, 'in', toPort) },
});

/** A base on the mock embedder with the sample document already ready (§2.7). */
function seedSampleKnowledgeBase(db: MockDb, project: Project, provider: Provider): KnowledgeBase {
  const ts = new Date().toISOString();
  const kb = db.addKnowledgeBase({
    id: newId(),
    projectId: project.id,
    name: 'Sample knowledge',
    embeddingProviderId: provider.id,
    embeddingModelId: MOCK_EMBED_MODEL_ID,
    chunkSize: DEFAULT_CHUNK_SIZE,
    chunkOverlap: DEFAULT_CHUNK_OVERLAP,
    documentCount: 0,
    chunkCount: 0,
    createdAt: ts,
    updatedAt: ts,
  });
  const artifact = db.putArtifact({
    mime: SAMPLE_DOCUMENT_FIXTURE.mime,
    name: SAMPLE_DOCUMENT_FIXTURE.name,
    bytes: SAMPLE_DOCUMENT_FIXTURE.bytes(),
  });
  ingestNow(db, addDocument(db, kb.id, artifact));
  return db.getKnowledgeBase(kb.id) ?? kb;
}

function graphOf(
  id: TemplateId,
  workflowId: string,
  provider: Provider,
  knowledgeBaseId: string | undefined,
): { nodes: Node[]; edges: Edge[] } {
  const mock = { providerId: provider.id, modelId: 'mock-text' };
  const output = (x: number) => createNode('output', workflowId, at(x));

  switch (id) {
    case 'linear-chain': {
      const i = input(workflowId, 'Summarise why envelopes beat raw chat history.');
      const a = agent(workflowId, 'Agent', at(480), {
        ...mock,
        instructions: 'Answer the request in three sentences.',
      });
      const o = output(880);
      return {
        nodes: [i, a, o],
        edges: [
          dataEdge(workflowId, i, 'text', a, 'text'),
          dataEdge(workflowId, a, 'text', o, 'text'),
        ],
      };
    }

    case 'review-fix': {
      const i = input(workflowId, 'Write a short product announcement for offline mode.');
      const writer = agent(workflowId, 'Writer', at(480), {
        ...mock,
        instructions: 'Write the draft; when a review is attached, fix what it asks for.',
      });
      const reviewer = agent(workflowId, 'Reviewer', at(880), {
        ...mock,
        modelId: 'mock-json',
        instructions: 'Score the draft from 0 to 10 and say whether it is approved.',
        outputTypes: ['json'],
        outputContract: { jsonSchema: REVIEW_CONTRACT_SCHEMA },
      });
      const o = output(1280);
      const loop: Edge = {
        id: newId(),
        workflowId,
        kind: 'loop',
        from: { nodeId: reviewer.id, portId: portId(reviewer.id, 'out', 'json') },
        to: { nodeId: writer.id, portId: portId(writer.id, 'in', 'text') },
        loop: {
          maxIterations: 3,
          exitCondition: { path: 'verdict', equals: 'approved' },
          onMax: 'continue',
        },
      };
      const edges = [
        dataEdge(workflowId, i, 'text', writer, 'text'),
        dataEdge(workflowId, writer, 'text', reviewer, 'text'),
        dataEdge(workflowId, reviewer, 'json', o, 'json'),
      ];
      const nodes = [i, writer, reviewer, o];
      const check = validateLoopConfig(loop, { nodes, edges });
      if (!check.ok) throw new Error(`review-fix template: ${check.reason}`);
      return { nodes, edges: [...edges, loop] };
    }

    case 'parallel-research': {
      const i = input(workflowId, 'What should a small team know before adopting local models?');
      const alpha = agent(workflowId, 'Researcher A', at(480, 20), {
        ...mock,
        instructions: 'Research the costs.',
      });
      const beta = agent(workflowId, 'Researcher B', at(480, 300), {
        ...mock,
        instructions: 'Research the risks.',
      });
      const merge = createNode('merge', workflowId, at(880));
      const o = output(1280);
      return {
        nodes: [i, alpha, beta, merge, o],
        edges: [
          dataEdge(workflowId, i, 'text', alpha, 'text'),
          dataEdge(workflowId, i, 'text', beta, 'text'),
          dataEdge(workflowId, alpha, 'text', merge, 'in'),
          dataEdge(workflowId, beta, 'text', merge, 'in'),
          dataEdge(workflowId, merge, 'out', o, 'json'),
        ],
      };
    }

    case 'single-builder': {
      const i = input(workflowId, 'Add a README section that explains how to run the tests.');
      const builder = agent(workflowId, 'Builder', at(480), {
        ...mock,
        modelId: 'mock-coder',
        instructions: 'Make the change the task asks for, then summarise what you changed.',
      });
      const o = output(880);
      return {
        nodes: [i, builder, o],
        edges: [
          dataEdge(workflowId, i, 'text', builder, 'text'),
          dataEdge(workflowId, builder, 'text', o, 'text'),
        ],
      };
    }

    case 'plan-build-review': {
      const i = input(workflowId, 'Add a README section that explains how to run the tests.');
      const planner = agent(workflowId, 'Planner', at(480), {
        ...mock,
        instructions: 'Restate the task, then write a short numbered plan.',
      });
      const builder = agent(workflowId, 'Builder', at(880), {
        ...mock,
        modelId: 'mock-coder',
        instructions: 'Follow the plan and make the change.',
      });
      const reviewer = agent(workflowId, 'Reviewer', at(1280), {
        ...mock,
        modelId: 'mock-json',
        instructions: 'Score the change from 0 to 10 and say whether it is approved.',
        outputTypes: ['json'],
        outputContract: { jsonSchema: REVIEW_CONTRACT_SCHEMA },
      });
      const o = output(1680);
      const loop: Edge = {
        id: newId(),
        workflowId,
        kind: 'loop',
        from: { nodeId: reviewer.id, portId: portId(reviewer.id, 'out', 'json') },
        to: { nodeId: builder.id, portId: portId(builder.id, 'in', 'text') },
        loop: {
          maxIterations: 2,
          exitCondition: { path: 'verdict', equals: 'approved' },
          onMax: 'continue',
        },
      };
      const edges = [
        dataEdge(workflowId, i, 'text', planner, 'text'),
        dataEdge(workflowId, planner, 'text', builder, 'text'),
        dataEdge(workflowId, builder, 'text', reviewer, 'text'),
        dataEdge(workflowId, reviewer, 'json', o, 'json'),
      ];
      return { nodes: [i, planner, builder, reviewer, o], edges: [...edges, loop] };
    }

    case 'rag-qa': {
      const i = input(workflowId, 'What does ACE pass between nodes?');
      const retrieval = retrievalNode(workflowId, knowledgeBaseId!, at(480, 20));
      const answerer = agent(workflowId, 'Answerer', at(880), {
        ...mock,
        modelId: 'mock-cite',
        instructions: 'Answer only from the retrieved sources, and cite them.',
        inputTypes: ['text', 'json'],
        knowledgeBaseIds: knowledgeBaseId === undefined ? [] : [knowledgeBaseId],
      });
      const o = output(1280);
      return {
        nodes: [i, retrieval, answerer, o],
        edges: [
          dataEdge(workflowId, i, 'text', retrieval, 'query'),
          dataEdge(workflowId, i, 'text', answerer, 'text'),
          dataEdge(workflowId, retrieval, 'out', answerer, 'json'),
          dataEdge(workflowId, answerer, 'text', o, 'text'),
        ],
      };
    }
  }
}

export type InstantiateOutcome =
  | { ok: true; response: InstantiateTemplateResponse }
  | { ok: false; status: 404; what: 'Template' | 'Project' };

/** `POST /templates/:id/instantiate` (§2.7, D235). */
export function instantiateTemplate(
  db: MockDb,
  id: string,
  body: { projectName?: string; projectId?: string },
): InstantiateOutcome {
  const template = templateById(id);
  if (template === undefined) return { ok: false, status: 404, what: 'Template' };

  let project: Project | undefined;
  if (body.projectId !== undefined) {
    project = db.getProject(body.projectId);
    if (project === undefined) return { ok: false, status: 404, what: 'Project' };
  } else {
    project = db.createProject({ name: body.projectName ?? template.name });
  }

  const provider = mockProviderOf(db);
  const kb = template.requires.knowledgeBase
    ? seedSampleKnowledgeBase(db, project, provider)
    : undefined;
  const workflow = db.createWorkflow(project.id, template.name);
  const { nodes, edges } = graphOf(template.id, workflow.id, provider, kb?.id);
  const committed = db.commitGraph(workflow.id, nodes, edges, { silent: true });

  return {
    ok: true,
    response: {
      project,
      workflow: committed,
      nodes,
      edges,
      ...(kb === undefined ? {} : { knowledgeBaseId: kb.id }),
    },
  };
}
