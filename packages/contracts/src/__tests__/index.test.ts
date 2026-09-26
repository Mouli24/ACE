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
  ])('re-exports %s -> %s', (_module, symbol) => {
    expect(contracts).toHaveProperty(symbol);
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

  it('keeps an importable, still-empty placeholder for the four later-round modules', () => {
    const placeholders = { knowledge, memory, usage, templates };

    expect(Object.keys(placeholders)).toHaveLength(4);
    for (const [name, module] of Object.entries(placeholders)) {
      expect(Object.keys(module), `${name}.ts should still be empty`).toEqual([]);
    }
  });

  it('exports SeqSchema exactly once, so the star exports never make it ambiguous', () => {
    expect(contracts.SeqSchema).toBeDefined();
    expect(contracts.SeqSchema).toBe(events.SeqSchema);
  });
});
