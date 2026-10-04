import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TEMPLATE_IDS,
  derivePorts,
  validateLoopConfig,
  type Artifact,
  type CreateProviderRequest,
  type KbDocument,
  type KnowledgeBase,
  type Model,
  type Provider,
  type Run,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { createBackupService } from '../backup/index.js';
import { HttpError } from '../gateway/errors.js';
import { createGraphService, validateGraph, type GraphService } from '../graph/index.js';
import { newId } from '../ids.js';
import { createLogger } from '../logging/index.js';
import { LOCAL_SCOPE, type BackupStore } from '../ports/index.js';
import {
  TEMPLATE_DEFINITIONS,
  TEMPLATE_MODELS,
  createTemplateService,
  templateGraph,
} from '../templates/service.js';
import { FakeRepository } from './fake-repository.js';

const NOW = '2026-10-01T10:00:00.000Z';

/** The mock provider's catalogue rows the templates use (packages/providers mock.ts, §2.6). */
function catalogue(providerId: string): Model[] {
  const row = (
    modelId: string,
    inputTypes: Model['inputTypes'],
    outputTypes: Model['outputTypes'],
  ): Model => ({
    id: newId(),
    providerId,
    modelId,
    displayName: modelId,
    inputTypes,
    outputTypes,
    contextWindow: 8192,
    supportsTools: false,
    supportsJson: outputTypes.includes('json'),
    available: true,
    source: 'manifest',
    lastCheckedAt: NOW,
  });
  return [
    row('mock-text', ['text'], ['text']),
    row('mock-json', ['text', 'json'], ['json']),
    row('mock-reject-twice', ['text', 'json'], ['json']),
    row('mock-cite', ['text'], ['text']),
  ];
}

function errorIssues(issues: { severity: string }[]) {
  return issues.filter((i) => i.severity === 'error');
}

describe('TC-ONB-002 every template validates with no error issues', () => {
  for (const id of TEMPLATE_IDS) {
    it(`${id}: passes validateGraph, with and without a model catalogue`, () => {
      const providerId = newId();
      const { nodes, edges } = templateGraph(
        id,
        { workflowId: newId(), newId },
        providerId,
        id === 'rag-qa' ? newId() : undefined,
      );

      expect(errorIssues(validateGraph(nodes, edges))).toEqual([]);

      const provider = { id: providerId } as unknown as Provider;
      const withCatalogue = validateGraph(nodes, edges, {
        providers: [provider],
        models: catalogue(providerId),
      });
      expect(errorIssues(withCatalogue)).toEqual([]);
    });

    it(`${id}: derivePorts round-trips every node's ports`, () => {
      const { nodes } = templateGraph(id, { workflowId: newId(), newId }, newId(), newId());
      for (const node of nodes) {
        const ports = derivePorts({
          id: node.id,
          kind: node.kind,
          config: node.config,
        } as Parameters<typeof derivePorts>[0]);
        expect({ inputs: node.inputs, outputs: node.outputs }).toEqual(ports);
      }
    });
  }

  it('lists the four templates in the wizard order, a knowledge base only for rag-qa', () => {
    expect(TEMPLATE_DEFINITIONS.map((t) => t.id)).toEqual([...TEMPLATE_IDS]);
    expect(TEMPLATE_DEFINITIONS.filter((t) => t.requires.knowledgeBase).map((t) => t.id)).toEqual([
      'rag-qa',
    ]);
  });

  it('review-fix: the loop edge is valid, bounded at 3 and exits on verdict == approved', () => {
    const { nodes, edges } = templateGraph('review-fix', { workflowId: newId(), newId }, newId());
    const loop = edges.filter((e) => e.kind === 'loop');
    expect(loop).toHaveLength(1);
    const edge = loop[0]!;
    expect(edge.loop).toEqual({
      maxIterations: 3,
      exitCondition: { path: 'verdict', equals: 'approved' },
      onMax: 'continue',
    });
    expect(nodes.find((n) => n.id === edge.from.nodeId)?.name).toBe('Reviewer');
    expect(nodes.find((n) => n.id === edge.to.nodeId)?.name).toBe('Writer');
    expect(validateLoopConfig(edge, { nodes, edges })).toEqual({ ok: true });

    const models = nodes.flatMap((n) => (n.kind === 'agent' ? [n.config.modelId] : []));
    expect(models).toEqual([TEMPLATE_MODELS.text, TEMPLATE_MODELS.reviewer]);
  });

  it('rag-qa: the answerer names the knowledge base and runs on mock-cite', () => {
    const kb = newId();
    const { nodes } = templateGraph('rag-qa', { workflowId: newId(), newId }, newId(), kb);
    const answerer = nodes.find((n) => n.kind === 'agent');
    expect(answerer?.kind === 'agent' && answerer.config.knowledgeBaseIds).toEqual([kb]);
    expect(answerer?.kind === 'agent' && answerer.config.modelId).toBe('mock-cite');
  });
});

/* -------------------------------------------------------------------------- */

interface Harness {
  repository: FakeRepository;
  graph: GraphService;
  providers: Provider[];
  created: CreateProviderRequest[];
  kbs: { projectId: string; name: string; embeddingModelId: string; embeddingProviderId: string }[];
  documents: { kbId: string; artifactId: string }[];
  stored: { mime: string; name: string; text: string }[];
  service: ReturnType<typeof createTemplateService>;
}

function harness(initialProviders: Provider[] = []): Harness {
  const repository = new FakeRepository();
  const logger = createLogger({ level: 'silent', destination: { write: () => undefined } });
  const real = createGraphService({ repository, scope: LOCAL_SCOPE, logger, now: () => NOW });
  const folder = mkdtempSync(join(tmpdir(), 'ace-template-'));
  // A local double: the real service, but projects land in a temp folder rather than the cwd.
  const graph: GraphService = {
    ...real,
    createProject: (input) => real.createProject({ ...input, folderPath: join(folder, newId()) }),
    getProject: (id) => real.getProject(id),
    importWorkflow: (projectId, raw) => real.importWorkflow(projectId, raw),
  };

  const state = {
    providers: [...initialProviders],
    created: [] as CreateProviderRequest[],
    kbs: [] as Harness['kbs'],
    documents: [] as Harness['documents'],
    stored: [] as Harness['stored'],
  };

  const service = createTemplateService({
    graph,
    providers: {
      list: async () => state.providers,
      create: async (input) => {
        state.created.push(input);
        const provider: Provider = {
          id: newId(),
          type: input.type,
          name: input.name,
          keySet: false,
          status: 'CONNECTED',
          concurrency: input.concurrency,
          createdAt: NOW,
          updatedAt: NOW,
        };
        state.providers.push(provider);
        return provider;
      },
    },
    createKnowledgeBase: async (projectId, body) => {
      state.kbs.push({
        projectId,
        name: body.name,
        embeddingModelId: body.embeddingModelId,
        embeddingProviderId: body.embeddingProviderId,
      });
      const kb: KnowledgeBase = {
        id: newId(),
        projectId,
        name: body.name,
        embeddingProviderId: body.embeddingProviderId,
        embeddingModelId: body.embeddingModelId,
        chunkSize: body.chunkSize,
        chunkOverlap: body.chunkOverlap,
        documentCount: 0,
        chunkCount: 0,
        createdAt: NOW,
        updatedAt: NOW,
      };
      return kb;
    },
    addDocument: async (kbId, body) => {
      state.documents.push({ kbId, artifactId: body.artifactId });
      const doc: KbDocument = {
        id: newId(),
        knowledgeBaseId: kbId,
        artifactId: body.artifactId,
        name: 'ace-sample.md',
        mime: 'text/markdown',
        size: 1,
        status: 'pending',
        chunkCount: 0,
        createdAt: NOW,
      };
      return doc;
    },
    storeArtifact: async (bytes, mime, name) => {
      state.stored.push({ mime, name, text: new TextDecoder().decode(bytes) });
      const artifact: Artifact = {
        id: newId(),
        hash: 'a'.repeat(64),
        mime,
        name,
        size: bytes.byteLength,
        createdAt: NOW,
      };
      return artifact;
    },
    now: () => NOW,
  });

  return {
    repository,
    graph,
    get providers() {
      return state.providers;
    },
    created: state.created,
    kbs: state.kbs,
    documents: state.documents,
    stored: state.stored,
    service,
  };
}

describe('FR-ONB-002 instantiate', () => {
  it('creates a new project from projectName, and a workflow that validates', async () => {
    const h = harness();
    const result = await h.service.instantiate('linear-chain', { projectName: 'My first project' });

    expect(result.project.name).toBe('My first project');
    expect(result.workflow.projectId).toBe(result.project.id);
    expect(result.nodes).toHaveLength(4);
    expect(result.edges).toHaveLength(3);
    expect(result.knowledgeBaseId).toBeUndefined();

    const stored = await h.graph.getWorkflowGraph(result.workflow.id);
    expect(stored.nodes).toHaveLength(4);
    expect(errorIssues(await h.graph.validateWorkflow(result.workflow.id))).toEqual([]);
  });

  it('reuses an existing project with projectId, and names a new one after the template otherwise', async () => {
    const h = harness();
    const existing = await h.graph.createProject({ name: 'Existing' });

    const reused = await h.service.instantiate('review-fix', { projectId: existing.id });
    expect(reused.project.id).toBe(existing.id);

    const named = await h.service.instantiate('parallel-research', {});
    expect(named.project.id).not.toBe(existing.id);
    expect(named.project.name).toBe('Parallel research');
  });

  it('answers 404 for an unknown template id and for an unknown projectId', async () => {
    const h = harness();
    await expect(
      h.service.instantiate('nope' as never, { projectName: 'x' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      h.service.instantiate('linear-chain', { projectId: newId() }),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it('the review-fix workflow keeps its loop edge through the import path', async () => {
    const h = harness();
    const result = await h.service.instantiate('review-fix', { projectName: 'Loop' });
    const loop = result.edges.filter((e) => e.kind === 'loop');
    expect(loop).toHaveLength(1);
    expect(loop[0]?.loop?.maxIterations).toBe(3);
    expect(errorIssues(await h.graph.validateWorkflow(result.workflow.id))).toEqual([]);
  });

  it('rag-qa creates a mock-embed base with one seeded document', async () => {
    const h = harness();
    const result = await h.service.instantiate('rag-qa', { projectName: 'Docs' });

    const mock = h.providers.find((p) => p.type === 'mock');
    expect(h.kbs).toEqual([
      {
        projectId: result.project.id,
        name: expect.any(String),
        embeddingModelId: 'mock-embed',
        embeddingProviderId: mock?.id,
      },
    ]);
    expect(h.stored).toHaveLength(1);
    expect(h.stored[0]).toMatchObject({ mime: 'text/markdown', name: 'ace-sample.md' });
    expect(h.stored[0]?.text.length).toBeGreaterThan(50);
    expect(h.documents).toHaveLength(1);
    expect(result.knowledgeBaseId).toBeDefined();
    expect(h.documents[0]?.kbId).toBe(result.knowledgeBaseId);

    const answerer = result.nodes.find((n) => n.kind === 'agent');
    expect(answerer?.kind === 'agent' && answerer.config.knowledgeBaseIds).toEqual([
      result.knowledgeBaseId,
    ]);
    expect(answerer?.kind === 'agent' && answerer.config.providerId).toBe(mock?.id);
  });

  it('the other templates create no knowledge base', async () => {
    const h = harness();
    await h.service.instantiate('linear-chain', { projectName: 'a' });
    expect(h.kbs).toEqual([]);
    expect(h.stored).toEqual([]);
  });

  it('creates a Mock provider when none exists, reuses the first otherwise', async () => {
    const empty = harness();
    await empty.service.instantiate('linear-chain', { projectName: 'a' });
    expect(empty.created).toEqual([expect.objectContaining({ type: 'mock', name: 'Mock' })]);
    await empty.service.instantiate('linear-chain', { projectName: 'b' });
    expect(empty.created).toHaveLength(1);

    const ollama = {
      id: newId(),
      type: 'ollama',
      name: 'Local',
      status: 'CONNECTED',
    } as unknown as Provider;
    const mockA = {
      id: newId(),
      type: 'mock',
      name: 'First mock',
      status: 'CONNECTED',
    } as unknown as Provider;
    const mockB = {
      id: newId(),
      type: 'mock',
      name: 'Second mock',
      status: 'CONNECTED',
    } as unknown as Provider;
    const existing = harness([ollama, mockA, mockB]);
    const result = await existing.service.instantiate('review-fix', { projectName: 'c' });
    expect(existing.created).toEqual([]);
    const agents = result.nodes.flatMap((n) => (n.kind === 'agent' ? [n.config.providerId] : []));
    expect(agents).toEqual([mockA.id, mockA.id]);
  });

  it('list returns the definitions', () => {
    expect(
      harness()
        .service.list()
        .map((t) => t.id),
    ).toEqual([...TEMPLATE_IDS]);
  });
});

/* -------------------------------------------------------------------------- */

describe('FR-SYS-012 backup service', () => {
  function backup(active: Run[]) {
    const calls: string[] = [];
    const store: BackupStore = {
      exportZip: async () => {
        calls.push('export');
        return new Uint8Array([1, 2, 3]);
      },
      importZip: async () => {
        calls.push('import');
        return { projects: 2, runs: 3, artifacts: 4 };
      },
      writePreImportBackup: async () => {
        calls.push('preImport');
        return '/backups/x.zip';
      },
    };
    const service = createBackupService({
      store,
      repository: { runs: { listActive: async () => active } } as never,
      scope: LOCAL_SCOPE,
    });
    return { service, calls };
  }

  it('export delegates to the BackupStore', async () => {
    const { service, calls } = backup([]);
    expect(await service.exportZip()).toEqual(new Uint8Array([1, 2, 3]));
    expect(calls).toEqual(['export']);
  });

  it('import answers { restored } from the store and does not write the pre-import backup itself', async () => {
    const { service, calls } = backup([]);
    expect(await service.importZip(new Uint8Array([9]))).toEqual({
      restored: { projects: 2, runs: 3, artifacts: 4 },
    });
    expect(calls).toEqual(['import']);
  });

  it('refuses to import while a run is active, before touching the store', async () => {
    const run = { id: newId(), status: 'RUNNING' } as Run;
    const { service, calls } = backup([run]);
    const error = await service.importZip(new Uint8Array([9])).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ code: 'invalid_run_state', status: 409 });
    expect(calls).toEqual([]);
  });
});
