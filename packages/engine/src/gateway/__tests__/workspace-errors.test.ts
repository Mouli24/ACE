import { describe, expect, it } from 'vitest';

import { WorkspaceFsError, isWorkspaceFsError } from '../../ports/workspace.js';
import { toApiError } from '../errors.js';

describe('D299 FR-GIT-008 the file API’s refusals', () => {
  it('answers a stale save 409 file_changed with the disk’s version', () => {
    const { status, body } = toApiError(
      new WorkspaceFsError('file_changed', 'a.ts changed on disk.', { currentVersion: 'v2' }),
    );
    expect(status).toBe(409);
    expect(body.error).toMatchObject({
      kind: 'workflow',
      code: 'file_changed',
      message: 'a.ts changed on disk.',
      details: { currentVersion: 'v2' },
      retryable: false,
    });
  });

  it.each([
    ['exists', 409, 'workflow'],
    ['not_found', 404, 'workflow'],
    ['file_too_large', 413, 'invalid_config'],
    ['outside_project', 403, 'invalid_config'],
    ['protected_path', 403, 'invalid_config'],
    ['invalid_path', 400, 'invalid_config'],
  ] as const)('answers %s with %i, kind %s', (code, status, kind) => {
    const answer = toApiError(new WorkspaceFsError(code, 'no'));
    expect(answer.status).toBe(status);
    expect(answer.body.error.kind).toBe(kind);
  });

  it('recognises a refusal thrown by another copy of the engine (branded, not instanceof)', () => {
    const foreign = Object.assign(new Error('elsewhere'), {
      name: 'WorkspaceFsError',
      code: 'exists',
      [Symbol.for('@ace/engine/WorkspaceFsError')]: true,
    });
    expect(isWorkspaceFsError(foreign)).toBe(true);
    expect(toApiError(foreign).status).toBe(409);
    expect(isWorkspaceFsError(Object.assign(new Error('x'), { code: 'exists' }))).toBe(false);
  });
});
