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
  CliDetectResponseSchema,
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
  type CliDetectResponse,
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
  // Round 5 §2.9 (knowledge, memory, usage and trace, templates, backup)
  AddKbDocumentRequestSchema,
  BACKUP_CONTENT_TYPE,
  BACKUP_UPLOAD_FIELD,
  BackupImportResponseSchema,
  CreateKnowledgeBaseRequestSchema,
  HealthMetricsSchema,
  InstantiateTemplateRequestSchema,
  InstantiateTemplateResponseSchema,
  KbDocumentSchema,
  KnowledgeBaseSchema,
  MemoryEntrySchema,
  SearchRequestSchema,
  SearchResponseSchema,
  TemplateSchema,
  TraceResponseSchema,
  UpdateKnowledgeBaseRequestSchema,
  UsageQuerySchema,
  UsageResponseSchema,
  type AddKbDocumentRequest,
  type BackupImportResponse,
  type HealthMetrics,
  type InstantiateTemplateRequest,
  type InstantiateTemplateResponse,
  type KbDocument,
  type KnowledgeBase,
  type MemoryEntry,
  type SearchResponse,
  type Template,
  type TemplateId,
  type TraceEntry,
  type UpdateKnowledgeBaseRequest,
  type UsageResponse,
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

/*
 * Round 5 §2.9. Bases and documents answer `{ items }` (D64); memory, trace and templates answer a
 * bare array, the way §2.9/§2.6/§2.7 write them (D235).
 */
const KnowledgeBaseListSchema = z.object({ items: z.array(KnowledgeBaseSchema) });
const KbDocumentListSchema = z.object({ items: z.array(KbDocumentSchema) });
const MemoryEntryListSchema = z.array(MemoryEntrySchema);
const TemplateListSchema = z.array(TemplateSchema);
/** `POST /knowledge-bases/:id/reindex` answers 202; whatever body comes with it is not read. */
const AcceptedSchema = { parse: (): undefined => undefined };

/** `chunkSize`/`chunkOverlap` default in the contract, so a caller may leave them out (§2.1). */
export type CreateKnowledgeBaseBody = z.input<typeof CreateKnowledgeBaseRequestSchema>;
/** `k` and `mode` default to 5 and `hybrid` (D235). */
export type SearchRequestBody = z.input<typeof SearchRequestSchema>;
/** `groupBy` may be one grouping or several; it travels as a repeated query parameter (D234). */
export type UsageQueryInput = z.input<typeof UsageQuerySchema>;

export interface ImportBackupOptions {
  /** The filename sent with the zip; taken from a `File` when omitted. */
  filename?: string;
  /** Aborts the upload; the promise rejects with a `network` `AceApiError`. */
  signal?: AbortSignal;
}

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

  /** One authenticated round trip; a fetch that throws becomes a `network` `AceApiError`. */
  async function send(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    init: { accept: string; contentType?: string; body?: BodyInit; signal?: AbortSignal },
    query?: Query,
  ): Promise<Response> {
    try {
      return await fetchImpl(joinUrl(options.baseUrl, path, query), {
        method,
        headers: {
          authorization: `Bearer ${options.token}`,
          accept: init.accept,
          ...(init.contentType === undefined ? {} : { 'content-type': init.contentType }),
        },
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(init.signal === undefined ? {} : { signal: init.signal }),
      });
    } catch (cause) {
      throw AceApiError.network(cause);
    }
  }

  async function readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }

  /** Validate a JSON reply against the contract; a mismatch is an `invalid_response`. */
  async function parseJson<T>(
    response: Response,
    path: string,
    responseSchema: { parse(value: unknown): T },
  ): Promise<T> {
    if (response.status === 204) return responseSchema.parse(undefined);
    const json = await readJson(response);
    if (!response.ok) throw AceApiError.fromResponse(response.status, json);
    try {
      return responseSchema.parse(json);
    } catch (error) {
      throw AceApiError.invalidResponse(path, error instanceof Error ? error.message : error);
    }
  }

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

    const response = await send(
      method,
      path,
      payload === undefined
        ? { accept: 'application/json' }
        : { accept: 'application/json', contentType: 'application/json', body: payload },
      query,
    );
    return parseJson(response, path, responseSchema);
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
    /** X1 (FR-PRV-008): which coding-agent CLIs the engine's machine has, and their sign-in. */
    detectClis: (): Promise<CliDetectResponse> =>
      request('GET', '/providers/detect/clis', CliDetectResponseSchema),

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

    /* Knowledge bases (round 5 §2.1/§2.9, FR-RAG-001/002/003/004/008/009) */

    listKnowledgeBases: (projectId: Id): Promise<{ items: KnowledgeBase[] }> =>
      request('GET', `/projects/${projectId}/knowledge-bases`, KnowledgeBaseListSchema),
    createKnowledgeBase: (projectId: Id, body: CreateKnowledgeBaseBody): Promise<KnowledgeBase> =>
      request('POST', `/projects/${projectId}/knowledge-bases`, KnowledgeBaseSchema, {
        schema: CreateKnowledgeBaseRequestSchema,
        value: body,
      }),
    getKnowledgeBase: (id: Id): Promise<KnowledgeBase> =>
      request('GET', `/knowledge-bases/${id}`, KnowledgeBaseSchema),
    /** Name and chunk settings only: the embedder is fixed at creation (D235). */
    updateKnowledgeBase: (id: Id, body: UpdateKnowledgeBaseRequest): Promise<KnowledgeBase> =>
      request('PATCH', `/knowledge-bases/${id}`, KnowledgeBaseSchema, {
        schema: UpdateKnowledgeBaseRequestSchema,
        value: body,
      }),
    /** Removes the base with its chunks and vectors. */
    deleteKnowledgeBase: (id: Id): Promise<void> =>
      request('DELETE', `/knowledge-bases/${id}`, NoContentSchema),
    /**
     * Answers 202 with the document `pending`; ingestion runs in the background and reports each
     * stage as a `kb.ingest` frame on the engine subscription (FR-RAG-003, D230).
     */
    addKbDocument: (knowledgeBaseId: Id, body: AddKbDocumentRequest): Promise<KbDocument> =>
      request('POST', `/knowledge-bases/${knowledgeBaseId}/documents`, KbDocumentSchema, {
        schema: AddKbDocumentRequestSchema,
        value: body,
      }),
    listKbDocuments: (knowledgeBaseId: Id): Promise<{ items: KbDocument[] }> =>
      request('GET', `/knowledge-bases/${knowledgeBaseId}/documents`, KbDocumentListSchema),
    /** Removes the document's chunks too (FR-RAG-009). */
    deleteKbDocument: (documentId: Id): Promise<void> =>
      request('DELETE', `/kb-documents/${documentId}`, NoContentSchema),
    /** 202: every document goes through the pipeline again, reported by `kb.ingest` (FR-RAG-009). */
    reindexKnowledgeBase: (knowledgeBaseId: Id): Promise<void> =>
      request('POST', `/knowledge-bases/${knowledgeBaseId}/reindex`, AcceptedSchema),
    /** The test-search panel: hybrid by default, best hit first, scores 0..1 (FR-RAG-004/008). */
    queryKnowledgeBase: (knowledgeBaseId: Id, body: SearchRequestBody): Promise<SearchResponse> =>
      request('POST', `/knowledge-bases/${knowledgeBaseId}/query`, SearchResponseSchema, {
        schema: SearchRequestSchema,
        value: body,
      }),

    /* Agent memory (round 5 §2.2/§2.9, FR-MEM-004) */

    /** Oldest first — the order entries are injected in. */
    listNodeMemory: (nodeId: Id): Promise<MemoryEntry[]> =>
      request('GET', `/nodes/${nodeId}/memory`, MemoryEntryListSchema),
    deleteNodeMemoryEntry: (nodeId: Id, entryId: Id): Promise<void> =>
      request('DELETE', `/nodes/${nodeId}/memory/${entryId}`, NoContentSchema),
    clearNodeMemory: (nodeId: Id): Promise<void> =>
      request('DELETE', `/nodes/${nodeId}/memory`, NoContentSchema),

    /* Trace, usage and health (round 5 §2.6, FR-OBS-001/002/004/007) */

    /** Ascending `seq`, the event log's own order (FR-OBS-001). */
    getRunTrace: (runId: Id): Promise<TraceEntry[]> =>
      request('GET', `/runs/${runId}/trace`, TraceResponseSchema),
    /**
     * `from` inclusive, `to` exclusive; `groupBy` as a repeated query parameter (D234). The query is
     * checked against the contract before it leaves, as a body would be.
     */
    getUsage: async (query: UsageQueryInput): Promise<UsageResponse> => {
      const parsed = UsageQuerySchema.safeParse(query);
      if (!parsed.success) throw AceApiError.invalidRequest('/usage', parsed.error.issues);
      return request('GET', '/usage', UsageResponseSchema, undefined, {
        from: parsed.data.from,
        to: parsed.data.to,
        groupBy: parsed.data.groupBy,
      });
    },
    getHealthMetrics: (): Promise<HealthMetrics> =>
      request('GET', '/metrics/health', HealthMetricsSchema),

    /* Templates (round 5 §2.7, FR-ONB-002) */

    listTemplates: (): Promise<Template[]> => request('GET', '/templates', TemplateListSchema),
    /** `projectName` makes a new project, `projectId` uses one; never both (D235). */
    instantiateTemplate: (
      id: TemplateId,
      body: InstantiateTemplateRequest = {},
    ): Promise<InstantiateTemplateResponse> =>
      request('POST', `/templates/${id}/instantiate`, InstantiateTemplateResponseSchema, {
        schema: InstantiateTemplateRequestSchema,
        value: body,
      }),

    /* Backup and restore (round 5 §2.7, FR-SYS-012) */

    /**
     * `POST /backup/export` answers an `application/zip` stream, read whole as a `Blob` for the
     * browser to save. A failure still arrives as the JSON error envelope and is raised as an
     * `AceApiError`.
     */
    exportBackup: async (): Promise<Blob> => {
      const response = await send('POST', '/backup/export', {
        accept: `${BACKUP_CONTENT_TYPE}, application/json`,
      });
      if (!response.ok) {
        throw AceApiError.fromResponse(response.status, await readJson(response));
      }
      return response.blob();
    },
    /**
     * `POST /backup/import` with the zip as multipart field `file` (D235). The engine backs up the
     * current data first, then answers what it restored. No upload progress is needed, so it goes
     * through `fetch`; the multipart boundary is fetch's to set, so no `content-type` is named.
     */
    importBackup: async (
      file: Blob,
      importOptions: ImportBackupOptions = {},
    ): Promise<BackupImportResponse> => {
      const form = new FormData();
      const filename =
        importOptions.filename ??
        (typeof File !== 'undefined' && file instanceof File ? file.name : undefined);
      if (filename === undefined) form.append(BACKUP_UPLOAD_FIELD, file);
      else form.append(BACKUP_UPLOAD_FIELD, file, filename);

      const response = await send('POST', '/backup/import', {
        accept: 'application/json',
        body: form,
        ...(importOptions.signal === undefined ? {} : { signal: importOptions.signal }),
      });
      return parseJson(response, '/backup/import', BackupImportResponseSchema);
    },
  };
}

export type AceClient = ReturnType<typeof createAceClient>;
