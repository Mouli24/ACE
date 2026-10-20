import { describe, expect, it } from 'vitest';

import * as artifacts from '../artifacts.js';
import * as chat from '../chat.js';
import * as envelope from '../envelope.js';
import * as events from '../events.js';
import * as guardrails from '../guardrails.js';
import * as contracts from '../index.js';
import * as knowledge from '../knowledge.js';
import * as memory from '../memory.js';
import * as models from '../models.js';
import * as providers from '../providers.js';
import * as runs from '../runs.js';
import * as templates from '../templates.js';
import * as tools from '../tools.js';
import * as usage from '../usage.js';
import * as workspace from '../workspace.js';

/**
 * Round 1 §3 item 3 requires the barrel to export every module of §2 plus an empty placeholder per
 * later round, so that `src/index.ts` never changes again. This test is what makes that promise
 * checkable: if a module stops being re-exported, or a placeholder is deleted, it fails.
 */
describe('FR-SYS-006 contracts barrel', () => {
  it.each([
    ['enums', 'DATA_TYPES'],
    ['errors', 'aceError'],
    ['errors', 'ERROR_CODE_HTTP_STATUS'],
    ['graph', 'derivePorts'],
    ['graph', 'NodeSchema'],
    ['graph', 'FORMAT_VERSION'],
    ['validation', 'isConnectionAllowed'],
    ['validation', 'VALIDATION_ISSUE_CODES'],
    ['graph-ops', 'GraphOpsRequestSchema'],
    ['graph-ops', 'nodeConfigPatchSchema'],
    ['settings', 'SettingsSchema'],
    ['export', 'WorkflowExportSchema'],
    ['ws', 'WsClientFrameSchema'],
    ['ws', 'WS_CLOSE_UNAUTHORIZED'],
    ['ws', 'ServerFrameSchema'],
    ['ws', 'isPersistedFrame'],
    ['api', 'HealthResponseSchema'],
    ['api', 'pageSchema'],
    ['api', 'API_BASE_PATH'],
    ['providers', 'ProviderSchema'],
    ['providers', 'CreateProviderRequestSchema'],
    ['providers', 'ProviderCheckResultSchema'],
    ['providers', 'ProviderDetectResponseSchema'],
    ['models', 'ModelSchema'],
    ['models', 'ModelQuerySchema'],
    ['models', 'modelMatchesQuery'],
    ['envelope', 'PartSchema'],
    ['envelope', 'EnvelopeSchema'],
    ['envelope', 'validateAgainstContract'],
    ['runs', 'RunSchema'],
    ['runs', 'RunSummarySchema'],
    ['runs', 'NodeRunSchema'],
    ['runs', 'UsageSchema'],
    ['runs', 'StartRunRequestSchema'],
    ['events', 'EventSchema'],
    ['events', 'RunEventSchema'],
    ['events', 'EngineEventSchema'],
    ['events', 'SeqSchema'],
    ['events', 'RUN_EVENT_TYPES'],
    ['errors', 'PolicyInUseDetailsSchema'],
    ['guardrails', 'GUARDRAIL_CHECK_TYPES'],
    ['guardrails', 'GuardrailCheckSchema'],
    ['guardrails', 'GuardrailPolicySchema'],
    ['guardrails', 'VerdictSchema'],
    ['guardrails', 'ApprovalRequestSchema'],
    ['guardrails', 'ApprovalDecisionSchema'],
    ['guardrails', 'PolicyTestResponseSchema'],
    ['guardrails', 'defaultGuardrailChecks'],
    ['graph', 'validateLoopConfig'],
    ['graph', 'LOOP_REFUSAL_CODES'],
    ['graph', 'DottedPathSchema'],
    ['graph', 'LoopStopReasonSchema'],
    ['graph', 'ReviewContractSchema'],
    ['graph', 'REVIEW_CONTRACT_SCHEMA'],
    ['envelope', 'MergeOutputSchema'],
    ['validation', 'ROUND_3_VALIDATION_ISSUE_CODES'],
    ['runs', 'RunActionSchema'],
    ['runs', 'allowedRunActions'],
    ['runs', 'RetryRequestSchema'],
    ['runs', 'RerunRequestSchema'],
    ['runs', 'AUTO_RETRY_POLICY'],
    ['runs', 'BudgetHaltSchema'],
    ['events', 'RunPausedPayloadSchema'],
    ['events', 'RunResumedPayloadSchema'],
    ['events', 'NodeApprovalRequiredPayloadSchema'],
    ['events', 'NodeApprovalDecidedPayloadSchema'],
    ['events', 'GuardrailVerdictPayloadSchema'],
    ['events', 'LoopIterationPayloadSchema'],
    ['artifacts', 'ArtifactSchema'],
    ['artifacts', 'isAllowedUpload'],
    ['artifacts', 'ALLOWED_UPLOAD_MIME_TYPES'],
    ['artifacts', 'DEFAULT_MAX_UPLOAD_MB'],
    ['tools', 'ToolDefinitionSchema'],
    ['tools', 'ToolCallSchema'],
    ['tools', 'McpServerSchema'],
    ['tools', 'CreateMcpServerRequestSchema'],
    ['tools', 'BUILTIN_TOOL_NAMES'],
    ['chat', 'MessageSchema'],
    ['chat', 'MessageQuerySchema'],
    ['chat', 'PostMessageRequestSchema'],
    ['chat', 'ChatThreadSchema'],
    ['chat', 'ChatMessageSchema'],
    ['chat', 'ChatRequestSchema'],
    ['chat', 'MESSAGE_TYPES'],
    ['guardrails', 'ChatVerdictSchema'],
    ['errors', 'ROUND_4_ERROR_CODES'],
    ['errors', 'UploadTooLargeDetailsSchema'],
    ['errors', 'GuardrailBlockedDetailsSchema'],
    ['validation', 'ROUND_4_VALIDATION_ISSUE_CODES'],
    ['settings', 'DOCKER_SANDBOX_MODES'],
    ['events', 'ToolCallPayloadSchema'],
    ['events', 'MessageCreatedPayloadSchema'],
    ['events', 'ChatMessagePayloadSchema'],
    ['events', 'ChatTokenPayloadSchema'],
    ['events', 'McpStatusPayloadSchema'],
    ['events', 'ThreadEventSchema'],
    ['events', 'THREAD_EVENT_TYPES'],
    ['knowledge', 'KnowledgeBaseSchema'],
    ['knowledge', 'KbDocumentSchema'],
    ['knowledge', 'KbChunkSchema'],
    ['knowledge', 'SearchRequestSchema'],
    ['knowledge', 'SearchHitSchema'],
    ['knowledge', 'SearchResponseSchema'],
    ['knowledge', 'fuseRankings'],
    ['knowledge', 'NodeRunSourceSchema'],
    ['memory', 'MemoryEntrySchema'],
    ['memory', 'MemoryOpSchema'],
    ['memory', 'MEMORY_OUTPUT_FIELD'],
    ['usage', 'UsageQuerySchema'],
    ['usage', 'UsageResponseSchema'],
    ['usage', 'TraceEntrySchema'],
    ['usage', 'TRACE_ENTRY_KIND_BY_EVENT_TYPE'],
    ['usage', 'HealthMetricsSchema'],
    ['workspace', 'FileEntrySchema'],
    ['workspace', 'FileContentSchema'],
    ['workspace', 'SaveFileRequestSchema'],
    ['workspace', 'RepoStatusSchema'],
    ['workspace', 'FilesChangedPayloadSchema'],
    ['errors', 'IDE_ERROR_CODES'],
    ['events', 'PROJECT_EVENT_TYPES'],
    ['workspace', 'ProcessStartRequestSchema'],
    ['workspace', 'ProcessSummarySchema'],
    ['workspace', 'ProcessDetailSchema'],
    ['workspace', 'ProjectScriptsSchema'],
    ['workspace', 'ProcessOutputPayloadSchema'],
    ['workspace', 'ProcessExitedPayloadSchema'],
    ['workspace', 'PROCESS_OUTPUT_MAX_CHARS'],
    ['workspace', 'PROCESS_FRAME_MAX_CHARS'],
    ['graph', 'TerminalTrustSchema'],
    ['ws', 'WS_CLOSE_FORBIDDEN_ORIGIN'],
    ['templates', 'TemplateSchema'],
    ['templates', 'TEMPLATE_IDS'],
    ['templates', 'InstantiateTemplateRequestSchema'],
    ['templates', 'InstantiateTemplateResponseSchema'],
    ['settings', 'BackupImportResponseSchema'],
    ['graph', 'SEARCH_MODES'],
    ['envelope', 'EnvelopeMemoryEntrySchema'],
    ['envelope', 'CONTEXT_BUDGET_SHARES'],
    ['guardrails', 'HIDDEN_INSTRUCTION_TYPES'],
    ['validation', 'ROUND_5_VALIDATION_ISSUE_CODES'],
    ['validation', 'AGENTIC_VALIDATION_ISSUE_CODES'],
    ['events', 'KbIngestPayloadSchema'],
    ['events', 'MemoryUpdatedPayloadSchema'],
  ])('re-exports %s -> %s', (_module, symbol) => {
    expect(contracts).toHaveProperty(symbol);
  });

  it('re-exports the workspace module itself (D299)', () => {
    expect(contracts.FileEntrySchema).toBe(workspace.FileEntrySchema);
  });

  it('re-exports every enum of §2.2 through the barrel', () => {
    for (const name of [
      'DataTypeSchema',
      'NodeKindSchema',
      'EdgeKindSchema',
      'NodeStateSchema',
      'RunStateSchema',
      'FailureReasonSchema',
      'HaltReasonSchema',
      'ProviderStateSchema',
      'ProviderTypeSchema',
      'ErrorKindSchema',
      'GuardrailActionSchema',
      'GuardrailPointSchema',
      'RoutingPolicySchema',
    ]) {
      expect(contracts).toHaveProperty(name);
    }
  });

  it('fills the five modules round 2 §2 defines', () => {
    const filled = { providers, models, runs, envelope, events };

    expect(Object.keys(filled)).toHaveLength(5);
    for (const [name, module] of Object.entries(filled)) {
      expect(Object.keys(module).length, `${name}.ts should export its contract`).toBeGreaterThan(
        0,
      );
    }
  });

  it('fills the module round 3 §2 adds', () => {
    expect(
      Object.keys(guardrails).length,
      'guardrails.ts should export its contract',
    ).toBeGreaterThan(0);
  });

  it('fills the three modules round 4 §2 adds', () => {
    const filled = { tools, artifacts, chat };

    expect(Object.keys(filled)).toHaveLength(3);
    for (const [name, module] of Object.entries(filled)) {
      expect(Object.keys(module).length, `${name}.ts should export its contract`).toBeGreaterThan(
        0,
      );
    }
  });

  it('fills the four placeholder modules round 5 §2 defines', () => {
    const filled = { knowledge, memory, usage, templates };

    expect(Object.keys(filled)).toHaveLength(4);
    for (const [name, module] of Object.entries(filled)) {
      expect(Object.keys(module).length, `${name}.ts should export its contract`).toBeGreaterThan(
        0,
      );
    }
  });

  it('exports MemoryEntrySchema once — the stored row — and the envelope its own entry (D229)', () => {
    expect(contracts.MemoryEntrySchema).toBe(memory.MemoryEntrySchema);
    expect(contracts.EnvelopeMemoryEntrySchema).toBe(envelope.EnvelopeMemoryEntrySchema);
  });

  it('exports SeqSchema exactly once, so the star exports never make it ambiguous', () => {
    expect(contracts.SeqSchema).toBeDefined();
    expect(contracts.SeqSchema).toBe(events.SeqSchema);
  });
});
