import { AceApiError } from '@ace/sdk';
import { describe, expect, it } from 'vitest';

import { uploadErrorMessage } from './upload-error';

describe('TC-MM-001 uploadErrorMessage (FR-MM-001, NFR-USE-03)', () => {
  it('a 413 quotes the limit from details.maxBytes and says what to do', () => {
    const error = new AceApiError(413, {
      kind: 'invalid_config',
      code: 'upload_too_large',
      message: 'The file is larger than the upload limit.',
      details: { maxBytes: 100 * 1024 * 1024 },
      retryable: false,
    });
    const message = uploadErrorMessage(error);
    expect(message).toMatch(/100 MB/);
    expect(message).toMatch(/smaller/i);
  });

  it('a 413 without details still names the limit as the problem', () => {
    const error = new AceApiError(413, {
      kind: 'invalid_config',
      code: 'upload_too_large',
      message: 'too big',
      retryable: false,
    });
    expect(uploadErrorMessage(error)).toMatch(/upload limit/i);
  });

  it('a 415 says the type is unsupported and what to do', () => {
    const error = new AceApiError(415, {
      kind: 'invalid_config',
      code: 'unsupported_type',
      message: 'That file type cannot be uploaded.',
      retryable: false,
    });
    const message = uploadErrorMessage(error);
    expect(message).toMatch(/type/i);
    expect(message).toMatch(/supported/i);
  });

  it('a network failure explains the engine could not be reached', () => {
    const error = AceApiError.network(new Error('offline'));
    expect(uploadErrorMessage(error)).toMatch(/could not reach the engine/i);
  });

  it('anything else falls back to the engine message', () => {
    const error = new AceApiError(400, {
      kind: 'workflow',
      code: 'weird',
      message: 'Something specific went wrong.',
      retryable: false,
    });
    expect(uploadErrorMessage(error)).toBe('Something specific went wrong.');
  });
});
