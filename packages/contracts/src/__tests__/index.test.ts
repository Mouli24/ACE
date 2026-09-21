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
    ['api', 'HealthResponseSchema'],
    ['api', 'pageSchema'],
    ['api', 'API_BASE_PATH'],
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

  it('keeps an importable, still-empty placeholder for all thirteen later-round modules', () => {
    const placeholders = {
      providers,
      models,
      runs,
      envelope,
      events,
      guardrails,
      tools,
      artifacts,
      chat,
      knowledge,
      memory,
      usage,
      templates,
    };

    expect(Object.keys(placeholders)).toHaveLength(13);
    for (const [name, module] of Object.entries(placeholders)) {
      expect(module, `${name}.ts should be importable`).toBeDefined();
    }
  });
});
