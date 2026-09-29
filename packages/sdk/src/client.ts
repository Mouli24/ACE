import {
  API_BASE_PATH,
  ApprovalDecisionRequestSchema,
  ApprovalRequestSchema,
  CreateGuardrailPolicyRequestSchema,
  CreateProviderRequestSchema,
  EventSchema,
  GuardrailPolicySchema,
  PolicyTestRequestSchema,
  PolicyTestResponseSchema,
  RerunRequestSchema,
  RetryRequestSchema,
  UpdateGuardrailPolicyRequestSchema,
  ModelListResponseSchema,
  NodeRunSchema,
  ProviderCheckResultSchema,
  ProviderDetectResponseSchema,
  ProviderSchema,
  RefreshModelsResponseSchema,
  RunSchema,
  RunSummarySchema,
  StartRunRequestSchema,
  UpdateProviderRequestSchema,
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
  type ApprovalDecisionRequest,
  type ApprovalRequest,
  type CreateGuardrailPolicyRequest,
  type CreateProjectRequest,
  type Event,
  type GuardrailPolicy,
  type GuardrailPolicyQuery,
  type PolicyTestRequest,
  type PolicyTestResponse,
  type RetryRequest,
  type UpdateGuardrailPolicyRequest,
  type ModelListResponse,
  type ModelQuery,
  type NodeRun,
  type Provider,
  type ProviderCheckResult,
  type ProviderDetectResponse,
  type RefreshModelsResponse,
  type Run,
  type RunSummary,
  type StartRunRequest,
  type UpdateProviderRequest,
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
  // Round 4 §2.4 (artifacts, tools, MCP servers, timeline messages, direct chat)
  ArtifactSchema,
  ToolListResponseSchema,
  McpServerSchema,
  McpServerListResponseSchema,
  CreateMcpServerRequestSchema,
  MessageListResponseSchema,
  PostMessageRequestSchema,
  PostMessageResponseSchema,
  ChatRequestSchema,
  ChatResponseSchema,
  ChatThreadSchema,
  ChatThreadDetailSchema,
  type Artifact,
  type ChatRequest,
  type ChatResponse,
  type ChatThread,
  type ChatThreadDetail,
  type CreateMcpServerRequest,
  type McpServer,
  type McpServerListResponse,
  type MessageListResponse,
  type MessageQuery,
  type PostMessageRequest,
  type PostMessageResponse,
  type ToolListResponse,
} from '@ace/contracts';
import { z } from 'zod';

import { AceApiError } from './errors.js';
import { uploadArtifact, type UploadArtifactOptions } from './upload.js';

export interface AceClientOptions {
  /** Engine origin, e.g. `http://127.0.0.1:4747`. `/api/v1` is appended here. */
  baseUrl: string;
  /** Session token (§2.10); sent as `Authorization: Bearer` on every request. */
  token: string;
  /** Injectable for tests and non-browser hosts; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /**
   * Injectable for tests and non-browser hosts; defaults to the global `XMLHttpRequest`. Used only
   * by `uploadArtifact`, which needs XHR because `fetch` cannot report upload progress (round 4 §2.1).
   */
  XMLHttpRequest?: typeof XMLHttpRequest;
}

type ListQuery = Partial<Pick<CursorQuery, 'cursor' | 'limit'>>;

/**
 * Anything that goes into a query string; `undefined` members are left out. An array is sent as a
 * repeated parameter (`?type=user&type=error`), which is how `MessageQuery.type` travels (§2.4).
 */
type Query = Record<string, string | number | boolean | string[] | undefined>;

const ProjectPageSchema = pageSchema(ProjectSchema);
const ProviderPageSchema = pageSchema(ProviderSchema);
const RunSummaryPageSchema = pageSchema(RunSummarySchema);
const NodeRunListSchema = z.array(NodeRunSchema);
const EventListSchema = z.array(EventSchema);
/** `GET /runs/:id/approvals` answers a bare array, the way §2.5 writes it (D78). */
const ApprovalRequestListSchema = z.array(ApprovalRequestSchema);
const GuardrailPolicyPageSchema = pageSchema(GuardrailPolicySchema);

/**
 * §2.1 marks `concurrency` optional on the request while the schema gives it a default, so the
 * *output* type demands it. Callers get the input type, which is what §2.1 describes.
 */
export type CreateProviderBody = z.input<typeof CreateProviderRequestSchema>;
const WorkflowPageSchema = pageSchema(WorkflowSchema);
const NoContentSchema = { parse: (): undefined => undefined };
/** `GET /nodes/:id/chat/threads` answers a bare array, the way §2.4 writes it (D78). */
const ChatThreadListSchema = z.array(ChatThreadSchema);

function joinUrl(baseUrl: string, path: string, query?: Query): string {
  const origin = baseUrl.replace(/\/+$/, '');
  const url = new URL(`${origin}${API_BASE_PATH}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const member of value) url.searchParams.append(key, String(member));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
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
    query?: Query,
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

    /* Providers (round 2 §2.5) */
    listProviders: (query?: ListQuery): Promise<Page<Provider>> =>
      request('GET', '/providers', ProviderPageSchema, undefined, query),
    createProvider: (body: CreateProviderBody): Promise<Provider> =>
      request('POST', '/providers', ProviderSchema, {
        schema: CreateProviderRequestSchema,
        value: body,
      }),
    getProvider: (id: Id): Promise<Provider> => request('GET', `/providers/${id}`, ProviderSchema),
    updateProvider: (id: Id, body: UpdateProviderRequest): Promise<Provider> =>
      request('PATCH', `/providers/${id}`, ProviderSchema, {
        schema: UpdateProviderRequestSchema,
        value: body,
      }),
    /**
     * Without `confirm` the engine answers 409 `provider_in_use` and names the nodes that still
     * reference it (§2.5); the UI shows those before asking again with `confirm: true`.
     */
    deleteProvider: (id: Id, options: { confirm?: boolean } = {}): Promise<void> =>
      request('DELETE', `/providers/${id}`, NoContentSchema, undefined, {
        ...(options.confirm ? { confirm: true } : {}),
      }),
    checkProvider: (id: Id): Promise<ProviderCheckResult> =>
      request('POST', `/providers/${id}/check`, ProviderCheckResultSchema),
    refreshModels: (id: Id): Promise<RefreshModelsResponse> =>
      request('POST', `/providers/${id}/refresh-models`, RefreshModelsResponseSchema),
    detectProviders: (): Promise<ProviderDetectResponse> =>
      request('GET', '/providers/detect', ProviderDetectResponseSchema),

    /* Models */
    listModels: (query: ModelQuery = {}): Promise<ModelListResponse> =>
      request('GET', '/models', ModelListResponseSchema, undefined, {
        providerId: query.providerId,
        inputType: query.inputType,
        outputType: query.outputType,
        available: query.available,
      }),

    /* Runs */
    startRun: (workflowId: Id, body: StartRunRequest = {}): Promise<Run> =>
      request('POST', `/workflows/${workflowId}/runs`, RunSchema, {
        schema: StartRunRequestSchema,
        value: body,
      }),
    listRuns: (workflowId: Id, query?: ListQuery): Promise<Page<RunSummary>> =>
      request('GET', `/workflows/${workflowId}/runs`, RunSummaryPageSchema, undefined, query),
    getRun: (runId: Id): Promise<Run> => request('GET', `/runs/${runId}`, RunSchema),
    listNodeRuns: (runId: Id): Promise<NodeRun[]> =>
      request('GET', `/runs/${runId}/node-runs`, NodeRunListSchema),
    getNodeRun: (nodeRunId: Id): Promise<NodeRun> =>
      request('GET', `/node-runs/${nodeRunId}`, NodeRunSchema),
    /** `afterSeq` is how a reconnecting client catches up outside the socket (Arch §21.4). */
    listRunEvents: (runId: Id, query: { afterSeq?: number } = {}): Promise<Event[]> =>
      request('GET', `/runs/${runId}/events`, EventListSchema, undefined, query),

    /* Run controls (round 3 §2.5, FR-CTL-001..006) */

    /**
     * The four controls. Each answers the `Run`, so the UI takes `status`, `pausedAt` and
     * `allowedActions` from the reply instead of guessing; a control the current state does not
     * allow answers 409 `invalid_run_state` (FR-CTL-006, D76).
     */
    pauseRun: (runId: Id): Promise<Run> => request('POST', `/runs/${runId}/pause`, RunSchema),
    resumeRun: (runId: Id): Promise<Run> => request('POST', `/runs/${runId}/resume`, RunSchema),
    stopRun: (runId: Id): Promise<Run> => request('POST', `/runs/${runId}/stop`, RunSchema),
    /** Answers the **new** run, which carries `restartedFromRunId` (FR-CTL-004). */
    restartRun: (runId: Id): Promise<Run> => request('POST', `/runs/${runId}/restart`, RunSchema),

    /* Retries and re-runs (round 3 §2.1, FR-ERR-003/004, FR-CTL-005) */

    /** `withDownstream` re-runs everything reachable after the node too (FR-ERR-004). */
    retryNodeRun: (nodeRunId: Id, body: RetryRequest): Promise<NodeRun> =>
      request('POST', `/node-runs/${nodeRunId}/retry`, NodeRunSchema, {
        schema: RetryRequestSchema,
        value: body,
      }),
    /** That node alone, on the latest upstream outputs (FR-CTL-005). */
    rerunNode: (runId: Id, nodeId: Id): Promise<NodeRun> =>
      request('POST', `/runs/${runId}/nodes/${nodeId}/rerun`, NodeRunSchema, {
        schema: RerunRequestSchema,
        value: {},
      }),

    /* Approvals (round 3 §2.5, FR-GRD-013) */

    /** The route is the decision; the note is optional and is logged with it. */
    approveNodeRun: (nodeRunId: Id, body: ApprovalDecisionRequest = {}): Promise<NodeRun> =>
      request('POST', `/node-runs/${nodeRunId}/approve`, NodeRunSchema, {
        schema: ApprovalDecisionRequestSchema,
        value: body,
      }),
    /** A reject fails the node GUARDRAIL_VIOLATION (BR-03, Arch §19.1). */
    rejectNodeRun: (nodeRunId: Id, body: ApprovalDecisionRequest = {}): Promise<NodeRun> =>
      request('POST', `/node-runs/${nodeRunId}/reject`, NodeRunSchema, {
        schema: ApprovalDecisionRequestSchema,
        value: body,
      }),
    /** The pending requests, for a card the UI can show after a reload (Arch §21.2). */
    listApprovals: (runId: Id): Promise<ApprovalRequest[]> =>
      request('GET', `/runs/${runId}/approvals`, ApprovalRequestListSchema),

    /* Guardrail policies (round 3 §2.5, FR-GRD-001, 002, 011, 018) */

    listGuardrailPolicies: (query: GuardrailPolicyQuery = {}): Promise<Page<GuardrailPolicy>> =>
      request('GET', '/guardrail-policies', GuardrailPolicyPageSchema, undefined, {
        projectId: query.projectId,
      }),
    createGuardrailPolicy: (body: CreateGuardrailPolicyRequest): Promise<GuardrailPolicy> =>
      request('POST', '/guardrail-policies', GuardrailPolicySchema, {
        schema: CreateGuardrailPolicyRequestSchema,
        value: body,
      }),
    getGuardrailPolicy: (id: Id): Promise<GuardrailPolicy> =>
      request('GET', `/guardrail-policies/${id}`, GuardrailPolicySchema),
    /** A PATCH never edits in place: the reply is version + 1 (FR-GRD-001, Arch §13.4). */
    updateGuardrailPolicy: (id: Id, body: UpdateGuardrailPolicyRequest): Promise<GuardrailPolicy> =>
      request('PATCH', `/guardrail-policies/${id}`, GuardrailPolicySchema, {
        schema: UpdateGuardrailPolicyRequestSchema,
        value: body,
      }),
    /**
     * Without `confirm` a policy a node still references answers 409 `policy_in_use` with
     * `{ nodeIds }` (§2.5, D78); the UI names those nodes before asking again.
     */
    deleteGuardrailPolicy: (id: Id, options: { confirm?: boolean } = {}): Promise<void> =>
      request('DELETE', `/guardrail-policies/${id}`, NoContentSchema, undefined, {
        ...(options.confirm ? { confirm: true } : {}),
      }),
    /** Try text against the policy without a run: verdicts with neither id (FR-GRD-001). */
    testGuardrailPolicy: (id: Id, body: PolicyTestRequest): Promise<PolicyTestResponse> =>
      request('POST', `/guardrail-policies/${id}/test`, PolicyTestResponseSchema, {
        schema: PolicyTestRequestSchema,
        value: body,
      }),
    setDefaultGuardrailPolicy: (id: Id): Promise<GuardrailPolicy> =>
      request('POST', `/guardrail-policies/${id}/set-default`, GuardrailPolicySchema),

    /* Artifacts (round 4 §2.1/§2.4, FR-MM-001/002/009) */

    /**
     * Multipart `POST /artifacts` with upload progress. It goes through `XMLHttpRequest`, not the
     * shared `request`, because `fetch` cannot report how far the bytes have gone (M4 §2). A file
     * over the limit answers 413 `upload_too_large`, a disallowed type 415 `unsupported_type`.
     */
    uploadArtifact: (file: Blob, uploadOptions: UploadArtifactOptions = {}): Promise<Artifact> =>
      uploadArtifact({
        url: joinUrl(options.baseUrl, '/artifacts'),
        token: options.token,
        XHR: options.XMLHttpRequest ?? globalThis.XMLHttpRequest,
        file,
        ...uploadOptions,
      }),
    getArtifact: (id: Id): Promise<Artifact> => request('GET', `/artifacts/${id}`, ArtifactSchema),
    /**
     * The `GET /artifacts/:id/content` URL with the session token as a `?token=` parameter, so an
     * `<img>`/`<audio>`/`<video>` element can load it — those cannot send an `Authorization`
     * header, and the engine accepts the token on the query string for exactly this (M4 §2).
     */
    artifactContentUrl: (id: Id): string =>
      joinUrl(options.baseUrl, `/artifacts/${id}/content`, { token: options.token }),

    /* Tools and MCP servers (round 4 §2.2/§2.4, FR-TOOL-001/007) */

    listTools: (): Promise<ToolListResponse> => request('GET', '/tools', ToolListResponseSchema),
    listMcpServers: (): Promise<McpServerListResponse> =>
      request('GET', '/mcp-servers', McpServerListResponseSchema),
    createMcpServer: (body: CreateMcpServerRequest): Promise<McpServer> =>
      request('POST', '/mcp-servers', McpServerSchema, {
        schema: CreateMcpServerRequestSchema,
        value: body,
      }),
    deleteMcpServer: (id: Id): Promise<void> =>
      request('DELETE', `/mcp-servers/${id}`, NoContentSchema),
    /** Re-checks liveness and tool count; answers the refreshed `McpServer` (FR-TOOL-007). */
    checkMcpServer: (id: Id): Promise<McpServer> =>
      request('POST', `/mcp-servers/${id}/check`, McpServerSchema),

    /* Timeline messages (round 4 §2.3/§2.4, FR-CHAT-001/002/003) */

    listMessages: (workflowId: Id, query: MessageQuery = {}): Promise<MessageListResponse> =>
      request('GET', `/workflows/${workflowId}/messages`, MessageListResponseSchema, undefined, {
        runId: query.runId,
        nodeId: query.nodeId,
        type: query.type,
        cursor: query.cursor,
        limit: query.limit,
      }),
    /** Stores a `user` message and, with `run: true`, starts a run with it (FR-CHAT-003). */
    postMessage: (workflowId: Id, body: PostMessageRequest): Promise<PostMessageResponse> =>
      request('POST', `/workflows/${workflowId}/messages`, PostMessageResponseSchema, {
        schema: PostMessageRequestSchema,
        value: body,
      }),

    /* Direct agent chat (round 4 §2.3/§2.4, FR-CHAT-004..008) */

    /**
     * `POST /nodes/:id/chat` answers 202 `{ threadId, messageId }`; the reply streams over the
     * socket as `chat.token` on the thread's subscription and settles with `chat.message` (§2.3).
     */
    postNodeChat: (nodeId: Id, body: ChatRequest): Promise<ChatResponse> =>
      request('POST', `/nodes/${nodeId}/chat`, ChatResponseSchema, {
        schema: ChatRequestSchema,
        value: body,
      }),
    listNodeChatThreads: (nodeId: Id): Promise<ChatThread[]> =>
      request('GET', `/nodes/${nodeId}/chat/threads`, ChatThreadListSchema),
    getChatThread: (id: Id): Promise<ChatThreadDetail> =>
      request('GET', `/chat/threads/${id}`, ChatThreadDetailSchema),
    deleteChatThread: (id: Id): Promise<void> =>
      request('DELETE', `/chat/threads/${id}`, NoContentSchema),
  };
}

export type AceClient = ReturnType<typeof createAceClient>;
