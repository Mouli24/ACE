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
  graph: Pick<GraphService, 'createProject' | 'getProject' | 'importWorkflow' | 'deleteProject'>;
  providers: Pick<ProviderService, 'list' | 'create'>;
  /** Injected: the knowledge service is built beside this one (round 5 Task 8). */
  createKnowledgeBase(projectId: Id, body: CreateKnowledgeBaseRequest): Promise<KnowledgeBase>;
  /** Compensation: removes a base this service created when a later step failed. */
  removeKnowledgeBase(kbId: Id): Promise<void>;
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

      // Resolve the project first: an unknown projectId is a 404 with no side effect.
      const existing =
        body.projectId === undefined ? undefined : await deps.graph.getProject(body.projectId);
      const providerId = await mockProviderId();
      const project = existing ?? (await projectFor(template, body));
      const createdProject = existing === undefined;

      let knowledgeBaseId: Id | undefined;
      let workflow: Awaited<ReturnType<typeof deps.graph.importWorkflow>>;
      try {
        if (template.requires.knowledgeBase) {
          const kb = await deps.createKnowledgeBase(project.id, {
            name: `${template.name} sample`,
            embeddingProviderId: providerId,
            embeddingModelId: TEMPLATE_MODELS.embed,
            chunkSize: KB_CHUNK_SIZE,
            chunkOverlap: KB_CHUNK_OVERLAP,
          });
          knowledgeBaseId = kb.id;
          const artifact = await deps.storeArtifact(
            new TextEncoder().encode(SAMPLE_DOCUMENT),
            SAMPLE_DOCUMENT_MIME,
            SAMPLE_DOCUMENT_NAME,
          );
          await deps.addDocument(kb.id, { artifactId: artifact.id });
        }

        // The graph goes in through the workflow-import path: one transaction, fresh ids, ports
        // re-derived, so a template is exactly as valid as a graph a user imported (D100).
        const graph = templateGraph(
          id,
          { workflowId: newId(), newId },
          providerId,
          knowledgeBaseId,
        );
        const imported = await deps.graph.importWorkflow(project.id, {
          formatVersion: FORMAT_VERSION,
          exportedAt: now(),
          name: template.name,
          nodes: graph.nodes,
          edges: graph.edges,
        });
        workflow = imported;
      } catch (error) {
        // Undo what this call created so a retry starts clean; the original error wins. A project
        // the caller passed in is never touched, and the artifact is left to the retention sweep.
        if (knowledgeBaseId !== undefined) {
          await deps.removeKnowledgeBase(knowledgeBaseId).catch(() => undefined);
        }
        if (createdProject) await deps.graph.deleteProject(project.id).catch(() => undefined);
        throw error;
      }

      return {
        project,
        workflow: workflow.workflow,
        nodes: workflow.nodes,
        edges: workflow.edges,
        ...(knowledgeBaseId === undefined ? {} : { knowledgeBaseId }),
      };
    },
  };
}
