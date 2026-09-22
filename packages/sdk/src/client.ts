import {
  API_BASE_PATH,
  CreateProjectRequestSchema,
  CreateWorkflowRequestSchema,
  GraphOpsRequestSchema,
  GraphOpsResponseSchema,
  HealthResponseSchema,
  ProjectSchema,
  SettingsPatchSchema,
  SettingsSchema,
  UpdateProjectRequestSchema,
  UpdateWorkflowRequestSchema,
  ValidateWorkflowResponseSchema,
  WorkflowExportSchema,
  WorkflowGraphResponseSchema,
  WorkflowSchema,
  pageSchema,
  type CreateProjectRequest,
  type CreateWorkflowRequest,
  type CursorQuery,
  type GraphOpsRequest,
  type GraphOpsResponse,
  type HealthResponse,
  type Id,
  type Page,
  type Project,
  type Settings,
  type SettingsPatch,
  type UpdateProjectRequest,
  type UpdateWorkflowRequest,
  type ValidateWorkflowResponse,
  type Workflow,
  type WorkflowExport,
  type WorkflowGraphResponse,
} from '@ace/contracts';
import type { z } from 'zod';

import { AceApiError } from './errors.js';

export interface AceClientOptions {
  /** Engine origin, e.g. `http://127.0.0.1:4747`. `/api/v1` is appended here. */
  baseUrl: string;
  /** Session token (§2.10); sent as `Authorization: Bearer` on every request. */
  token: string;
  /** Injectable for tests and non-browser hosts; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

type ListQuery = Partial<Pick<CursorQuery, 'cursor' | 'limit'>>;

const ProjectPageSchema = pageSchema(ProjectSchema);
const WorkflowPageSchema = pageSchema(WorkflowSchema);
const NoContentSchema = { parse: (): undefined => undefined };

function joinUrl(baseUrl: string, path: string, query?: ListQuery): string {
  const origin = baseUrl.replace(/\/+$/, '');
  const url = new URL(`${origin}${API_BASE_PATH}${path}`);
  if (query?.cursor !== undefined) url.searchParams.set('cursor', query.cursor);
  if (query?.limit !== undefined) url.searchParams.set('limit', String(query.limit));
  return url.toString();
}

/**
 * The typed REST client for round 1 §2.8: one method per endpoint, bodies validated against the
 * contract before they leave, responses validated as they arrive.
 */
export function createAceClient(options: AceClientOptions) {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);

  async function request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    responseSchema: { parse(value: unknown): T },
    body?: { schema: z.ZodType; value: unknown },
    query?: ListQuery,
  ): Promise<T> {
    let payload: string | undefined;
    if (body) {
      const parsed = body.schema.safeParse(body.value);
      if (!parsed.success) throw AceApiError.invalidRequest(path, parsed.error.issues);
      payload = JSON.stringify(parsed.data);
    }

    let response: Response;
    try {
      response = await fetchImpl(joinUrl(options.baseUrl, path, query), {
        method,
        headers: {
          authorization: `Bearer ${options.token}`,
          accept: 'application/json',
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { body: payload }),
      });
    } catch (cause) {
      throw AceApiError.network(cause);
    }

    if (response.status === 204) return responseSchema.parse(undefined);

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }

    if (!response.ok) throw AceApiError.fromResponse(response.status, json);

    try {
      return responseSchema.parse(json);
    } catch (error) {
      throw AceApiError.invalidResponse(path, error instanceof Error ? error.message : error);
    }
  }

  return {
    /* System */
    health: (): Promise<HealthResponse> => request('GET', '/health', HealthResponseSchema),
    getSettings: (): Promise<Settings> => request('GET', '/settings', SettingsSchema),
    patchSettings: (patch: SettingsPatch): Promise<Settings> =>
      request('PATCH', '/settings', SettingsSchema, { schema: SettingsPatchSchema, value: patch }),

    /* Projects */
    listProjects: (query?: ListQuery): Promise<Page<Project>> =>
      request('GET', '/projects', ProjectPageSchema, undefined, query),
    createProject: (body: CreateProjectRequest): Promise<Project> =>
      request('POST', '/projects', ProjectSchema, {
        schema: CreateProjectRequestSchema,
        value: body,
      }),
    getProject: (id: Id): Promise<Project> => request('GET', `/projects/${id}`, ProjectSchema),
    updateProject: (id: Id, body: UpdateProjectRequest): Promise<Project> =>
      request('PATCH', `/projects/${id}`, ProjectSchema, {
        schema: UpdateProjectRequestSchema,
        value: body,
      }),
    deleteProject: (id: Id): Promise<void> => request('DELETE', `/projects/${id}`, NoContentSchema),
    openProject: (id: Id): Promise<Project> =>
      request('POST', `/projects/${id}/open`, ProjectSchema),

    /* Workflows */
    listWorkflows: (projectId: Id, query?: ListQuery): Promise<Page<Workflow>> =>
      request('GET', `/projects/${projectId}/workflows`, WorkflowPageSchema, undefined, query),
    createWorkflow: (projectId: Id, body: CreateWorkflowRequest): Promise<Workflow> =>
      request('POST', `/projects/${projectId}/workflows`, WorkflowSchema, {
        schema: CreateWorkflowRequestSchema,
        value: body,
      }),
    getWorkflow: (id: Id): Promise<WorkflowGraphResponse> =>
      request('GET', `/workflows/${id}`, WorkflowGraphResponseSchema),
    updateWorkflow: (id: Id, body: UpdateWorkflowRequest): Promise<Workflow> =>
      request('PATCH', `/workflows/${id}`, WorkflowSchema, {
        schema: UpdateWorkflowRequestSchema,
        value: body,
      }),
    deleteWorkflow: (id: Id): Promise<void> =>
      request('DELETE', `/workflows/${id}`, NoContentSchema),
    duplicateWorkflow: (id: Id): Promise<WorkflowGraphResponse> =>
      request('POST', `/workflows/${id}/duplicate`, WorkflowGraphResponseSchema),
    applyGraphOps: (id: Id, body: GraphOpsRequest): Promise<GraphOpsResponse> =>
      request('POST', `/workflows/${id}/graph-ops`, GraphOpsResponseSchema, {
        schema: GraphOpsRequestSchema,
        value: body,
      }),
    validateWorkflow: (id: Id): Promise<ValidateWorkflowResponse> =>
      request('POST', `/workflows/${id}/validate`, ValidateWorkflowResponseSchema),
    exportWorkflow: (id: Id): Promise<WorkflowExport> =>
      request('GET', `/workflows/${id}/export`, WorkflowExportSchema),
    importWorkflow: (projectId: Id, file: WorkflowExport): Promise<WorkflowGraphResponse> =>
      request('POST', `/projects/${projectId}/workflows/import`, WorkflowGraphResponseSchema, {
        schema: WorkflowExportSchema,
        value: file,
      }),
  };
}

export type AceClient = ReturnType<typeof createAceClient>;
