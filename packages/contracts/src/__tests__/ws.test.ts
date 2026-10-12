import { describe, expect, it } from 'vitest';

import {
  WS_CLOSE_FORBIDDEN_ORIGIN,
  WS_CLOSE_UNAUTHORIZED,
  WS_PATH,
  ServerFrameSchema,
  WS_SCOPES,
  WsClientFrameSchema,
  WsServerFrameSchema,
} from '../ws.js';
import { WORKFLOW_ID } from './fixtures.js';

describe('FR-EXE-014 WebSocket client frames', () => {
  it('subscribes to one workflow by id', () => {
    const frame = { type: 'subscribe', payload: { scope: 'workflow', id: WORKFLOW_ID } };

    expect(WsClientFrameSchema.parse(frame)).toEqual(frame);
  });

  it('subscribes to the engine scope without an id', () => {
    const frame = { type: 'subscribe', payload: { scope: 'engine' } };

    expect(WsClientFrameSchema.parse(frame)).toEqual(frame);
  });

  it('refuses a workflow subscription with no id', () => {
    expect(
      WsClientFrameSchema.safeParse({ type: 'subscribe', payload: { scope: 'workflow' } }).success,
    ).toBe(false);
  });

  it('unsubscribes with or without an id', () => {
    expect(
      WsClientFrameSchema.parse({
        type: 'unsubscribe',
        payload: { scope: 'workflow', id: WORKFLOW_ID },
      }),
    ).toEqual({ type: 'unsubscribe', payload: { scope: 'workflow', id: WORKFLOW_ID } });
    expect(
      WsClientFrameSchema.safeParse({ type: 'unsubscribe', payload: { scope: 'engine' } }).success,
    ).toBe(true);
  });

  it('resumes from a sequence number', () => {
    const frame = { type: 'resume', payload: { afterSeq: 41 } };

    expect(WsClientFrameSchema.parse(frame)).toEqual(frame);
    expect(WsClientFrameSchema.safeParse({ type: 'resume', payload: { afterSeq: 0 } }).success).toBe(
      true,
    );
  });

  it.each([
    ['a negative afterSeq', -1],
    ['a fractional afterSeq', 1.5],
  ])('refuses resume with %s', (_label, afterSeq) => {
    expect(WsClientFrameSchema.safeParse({ type: 'resume', payload: { afterSeq } }).success).toBe(
      false,
    );
  });

  it('refuses a frame type round 1 §2.9 does not define', () => {
    expect(WsClientFrameSchema.safeParse({ type: 'ping', payload: {} }).success).toBe(false);
  });

  it('declares §2.9’s two scopes, round 4 §2.5’s thread and Forge’s project (D299)', () => {
    expect([...WS_SCOPES]).toEqual(['workflow', 'engine', 'thread', 'project']);
  });

  it('subscribes to a project by id and carries files.changed without a seq (D299)', () => {
    const frame = { type: 'subscribe', payload: { scope: 'project', id: WORKFLOW_ID } };
    expect(WsClientFrameSchema.parse(frame)).toEqual(frame);
    expect(
      WsClientFrameSchema.safeParse({ type: 'subscribe', payload: { scope: 'project' } }).success,
    ).toBe(false);
    const changed = {
      type: 'files.changed',
      payload: { projectId: WORKFLOW_ID, changes: [{ path: 'a.ts', kind: 'changed' }], resync: false },
    };
    expect(ServerFrameSchema.parse(changed)).toEqual(changed);
    expect(ServerFrameSchema.safeParse({ ...changed, seq: 3 }).success, 'transient: no seq').toBe(
      false,
    );
  });

  it('subscribes to a thread by id (round 4 §2.5, FR-CHAT-006)', () => {
    const frame = { type: 'subscribe', payload: { scope: 'thread', id: WORKFLOW_ID } };

    expect(WsClientFrameSchema.parse(frame)).toEqual(frame);
    expect(
      WsClientFrameSchema.safeParse({ type: 'subscribe', payload: { scope: 'thread' } }).success,
      'a thread subscription names its thread',
    ).toBe(false);
  });
});

describe('FR-EXE-014 WebSocket server frames', () => {
  it('carries process.output and process.exited on the project scope without a seq (D301)', () => {
    const output = {
      type: 'process.output',
      payload: { projectId: WORKFLOW_ID, processId: WORKFLOW_ID, stream: 'stdout', data: 'hi\n' },
    };
    const exited = {
      type: 'process.exited',
      payload: {
        projectId: WORKFLOW_ID,
        processId: WORKFLOW_ID,
        exitCode: 0,
        signal: null,
        status: 'exited',
      },
    };
    expect(ServerFrameSchema.parse(output)).toEqual(output);
    expect(ServerFrameSchema.parse(exited)).toEqual(exited);
    expect(ServerFrameSchema.safeParse({ ...output, seq: 4 }).success, 'transient: no seq').toBe(
      false,
    );
  });

  it('sends hello with the current global seq and no frame-level seq', () => {
    const frame = { type: 'hello', payload: { seq: 12 } };

    expect(WsServerFrameSchema.parse(frame)).toEqual(frame);
  });

  it('sends workflow.updated with a frame-level seq', () => {
    const frame = {
      type: 'workflow.updated',
      payload: { workflowId: WORKFLOW_ID, version: 4 },
      seq: 13,
    };

    expect(WsServerFrameSchema.parse(frame)).toEqual(frame);
  });

  it('refuses workflow.updated without a seq, since every workflow frame carries one', () => {
    expect(
      WsServerFrameSchema.safeParse({
        type: 'workflow.updated',
        payload: { workflowId: WORKFLOW_ID, version: 4 },
      }).success,
    ).toBe(false);
  });

  it('refuses workflow.updated whose workflowId is not a ULID', () => {
    expect(
      WsServerFrameSchema.safeParse({
        type: 'workflow.updated',
        payload: { workflowId: 'wf-1', version: 4 },
        seq: 13,
      }).success,
    ).toBe(false);
  });
});

describe('FR-SYS-002 WebSocket auth', () => {
  it('closes a socket from an origin not on the allow-list with 4403 (FR-SYS-003, D301)', () => {
    expect(WS_CLOSE_FORBIDDEN_ORIGIN).toBe(4403);
  });

  it('closes a wrong or missing token with 4401', () => {
    expect(WS_CLOSE_UNAUTHORIZED).toBe(4401);
  });

  it('is served at /ws', () => {
    expect(WS_PATH).toBe('/ws');
  });
});
