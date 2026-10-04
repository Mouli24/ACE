import {
  FORMAT_VERSION,
  type AddKbDocumentRequest,
  type Artifact,
  type CreateKnowledgeBaseRequest,
  type Id,
  type InstantiateTemplateRequest,
  type InstantiateTemplateResponse,
  type KbDocument,
  type KnowledgeBase,
  type Project,
  type Template,
  type TemplateId,
} from '@ace/contracts';

import { notFound } from '../gateway/errors.js';
import type { GraphService } from '../graph/index.js';
import { newId } from '../ids.js';
import type { ProviderService } from '../providers/index.js';
import {
  SAMPLE_DOCUMENT,
  SAMPLE_DOCUMENT_MIME,
  SAMPLE_DOCUMENT_NAME,
  TEMPLATE_DEFINITIONS,
  TEMPLATE_MODELS,
  templateGraph,
} from './definitions.js';

export * from './definitions.js';

export interface TemplateService {
  list(): Template[];
  instantiate(
    id: TemplateId,
    body: InstantiateTemplateRequest,
  ): Promise<InstantiateTemplateResponse>;
}

export interface TemplateServiceDeps {
  graph: Pick<GraphService, 'createProject' | 'getProject' | 'importWorkflow'>;
  providers: Pick<ProviderService, 'list' | 'create'>;
  /** Injected: the knowledge service is built beside this one (round 5 Task 8). */
  createKnowledgeBase(projectId: Id, body: CreateKnowledgeBaseRequest): Promise<KnowledgeBase>;
  addDocument(kbId: Id, body: AddKbDocumentRequest): Promise<KbDocument>;
  storeArtifact(bytes: Uint8Array, mime: string, name: string): Promise<Artifact>;
  now?: () => string;
}

const MOCK_PROVIDER_NAME = 'Mock';
const KB_CHUNK_SIZE = 700;
const KB_CHUNK_OVERLAP = 90;

export function createTemplateService(deps: TemplateServiceDeps): TemplateService {
  const now = deps.now ?? (() => new Date().toISOString());

  /** F11: the first mock provider, created as `Mock` when the workspace has none. */
  async function mockProviderId(): Promise<Id> {
    const existing = (await deps.providers.list()).find((p) => p.type === 'mock');
    if (existing !== undefined) return existing.id;
    const created = await deps.providers.create({
      type: 'mock',
      name: MOCK_PROVIDER_NAME,
      concurrency: 4,
    });
    return created.id;
  }

  async function projectFor(
    template: Template,
    body: InstantiateTemplateRequest,
  ): Promise<Project> {
    if (body.projectId !== undefined) return deps.graph.getProject(body.projectId);
    return deps.graph.createProject({ name: body.projectName ?? template.name });
  }

  return {
    list: () => TEMPLATE_DEFINITIONS.map((t) => ({ ...t, requires: { ...t.requires } })),

    async instantiate(id, body) {
      const template = TEMPLATE_DEFINITIONS.find((t) => t.id === id);
      if (template === undefined) throw notFound(`Template ${id}`);

      const providerId = await mockProviderId();
      const project = await projectFor(template, body);

      let knowledgeBaseId: Id | undefined;
      if (template.requires.knowledgeBase) {
        const kb = await deps.createKnowledgeBase(project.id, {
          name: `${template.name} sample`,
          embeddingProviderId: providerId,
          embeddingModelId: TEMPLATE_MODELS.embed,
          chunkSize: KB_CHUNK_SIZE,
          chunkOverlap: KB_CHUNK_OVERLAP,
        });
        const artifact = await deps.storeArtifact(
          new TextEncoder().encode(SAMPLE_DOCUMENT),
          SAMPLE_DOCUMENT_MIME,
          SAMPLE_DOCUMENT_NAME,
        );
        await deps.addDocument(kb.id, { artifactId: artifact.id });
        knowledgeBaseId = kb.id;
      }

      // The graph goes in through the workflow-import path: one transaction, fresh ids, ports
      // re-derived, so a template is exactly as valid as a graph a user imported (D100, FR-WF-008).
      const graph = templateGraph(id, { workflowId: newId(), newId }, providerId, knowledgeBaseId);
      const imported = await deps.graph.importWorkflow(project.id, {
        formatVersion: FORMAT_VERSION,
        exportedAt: now(),
        name: template.name,
        nodes: graph.nodes,
        edges: graph.edges,
      });

      return {
        project,
        workflow: imported.workflow,
        nodes: imported.nodes,
        edges: imported.edges,
        ...(knowledgeBaseId === undefined ? {} : { knowledgeBaseId }),
      };
    },
  };
}
