import { describe, expect, it } from 'vitest';

import { isToolError, ToolError, ToolRegistrationError } from './errors.js';
import { RecordingToolLogger, SANDBOX_DENIED_MESSAGE, SILENT_TOOL_LOGGER } from './logging.js';

describe('NFR-SEC-04 tool logging', () => {
  it('records every level with its payload, in order', () => {
    const logger = new RecordingToolLogger();

    logger.info({ tool: 'echo' }, 'tool started');
    logger.warn({ tool: 'code_sandbox', requested: '../x' }, SANDBOX_DENIED_MESSAGE);
    logger.error({ tool: 'http_request' }, 'tool failed');

    expect(logger.lines).toEqual([
      { level: 'info', payload: { tool: 'echo' }, message: 'tool started' },
      {
        level: 'warn',
        payload: { tool: 'code_sandbox', requested: '../x' },
        message: SANDBOX_DENIED_MESSAGE,
      },
      { level: 'error', payload: { tool: 'http_request' }, message: 'tool failed' },
    ]);
  });

  it('finds the lines whose message contains a fragment', () => {
    const logger = new RecordingToolLogger();
    logger.info({}, 'tool started');
    logger.warn({ n: 1 }, SANDBOX_DENIED_MESSAGE);
    logger.warn({ n: 2 }, SANDBOX_DENIED_MESSAGE);

    expect(logger.matching('escape attempt').map((line) => line.payload)).toEqual([
      { n: 1 },
      { n: 2 },
    ]);
    expect(logger.matching('nothing like this')).toEqual([]);
  });

  it('has a silent logger that accepts every level and keeps nothing', () => {
    expect(SILENT_TOOL_LOGGER.info({}, 'a')).toBeUndefined();
    expect(SILENT_TOOL_LOGGER.warn({}, 'b')).toBeUndefined();
    expect(SILENT_TOOL_LOGGER.error({}, 'c')).toBeUndefined();
  });
});

describe('FR-TOOL-009 tool errors', () => {
  it('carries its kind, tool and details, defaulting details to empty', () => {
    const withDetails = new ToolError('denied', 'sandbox_delete', 'no', { reason: 'escapes_sandbox' });
    const bare = new ToolError('timeout', 'code_sandbox', 'too slow');

    expect(withDetails).toBeInstanceOf(Error);
    expect(withDetails.name).toBe('ToolError');
    expect(withDetails.kind).toBe('denied');
    expect(withDetails.toolName).toBe('sandbox_delete');
    expect(withDetails.details).toEqual({ reason: 'escapes_sandbox' });
    expect(bare.details).toEqual({});
  });

  it('tells its own errors apart from anything else thrown', () => {
    expect(isToolError(new ToolError('failed', 'echo', 'x'))).toBe(true);
    expect(isToolError(new Error('x'))).toBe(false);
    expect(isToolError(new ToolRegistrationError('Bad Name', 'x'))).toBe(false);
    expect(isToolError('denied')).toBe(false);
    expect(isToolError(undefined)).toBe(false);
  });
});
