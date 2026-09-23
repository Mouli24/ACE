import { z } from 'zod';

import {
  ENGINE_EVENT_FRAME_SCHEMAS,
  RUN_EVENT_FRAME_SCHEMAS,
  SeqSchema,
} from './events.js';
import { IdSchema } from './graph.js';

/**
 * The WebSocket at `ws://127.0.0.1:4747/ws?token=<token>` (round 1 §2.9).
 *
 * Frames are JSON `{ type, payload }`. Server frames about a run or a workflow also carry the
 * global monotonic `seq` they were persisted with, which is what `resume { afterSeq }` replays
 * from; `hello` is neither, so it carries its seq in the payload only, and `node.token` is
 * transient, so it has none at all (round 2 §2.4).
 */

export const WS_PATH = '/ws';

/** Close code for a missing or wrong token (§2.9, FR-SYS-002). */
export const WS_CLOSE_UNAUTHORIZED = 4401;

export const WS_SCOPES = ['workflow', 'engine'] as const;
export const WsScopeSchema = z.enum(WS_SCOPES);
export type WsScope = z.infer<typeof WsScopeSchema>;

/* -------------------------------------------------------------------------- */
/* Client -> server                                                            */
/* -------------------------------------------------------------------------- */

/** A workflow subscription names its workflow; an engine subscription takes no id. */
export const WsSubscribePayloadSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('workflow'), id: IdSchema }),
  z.object({ scope: z.literal('engine') }),
]);
export type WsSubscribePayload = z.infer<typeof WsSubscribePayloadSchema>;

export const WsUnsubscribePayloadSchema = z.object({
  scope: WsScopeSchema,
  id: IdSchema.optional(),
});
export type WsUnsubscribePayload = z.infer<typeof WsUnsubscribePayloadSchema>;

export const WsResumePayloadSchema = z.object({ afterSeq: z.number().int().min(0) });
export type WsResumePayload = z.infer<typeof WsResumePayloadSchema>;

export const WsClientFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), payload: WsSubscribePayloadSchema }),
  z.object({ type: z.literal('unsubscribe'), payload: WsUnsubscribePayloadSchema }),
  z.object({ type: z.literal('resume'), payload: WsResumePayloadSchema }),
]);
export type WsClientFrame = z.infer<typeof WsClientFrameSchema>;

/* -------------------------------------------------------------------------- */
/* Server -> client (round 1)                                                  */
/* -------------------------------------------------------------------------- */

/* `SeqSchema` lives in `events.ts` with the log it numbers, and is re-exported by the barrel. */

export const WsHelloPayloadSchema = z.object({ seq: SeqSchema });
export type WsHelloPayload = z.infer<typeof WsHelloPayloadSchema>;

export const WsWorkflowUpdatedPayloadSchema = z.object({
  workflowId: IdSchema,
  version: z.number().int().min(0),
});
export type WsWorkflowUpdatedPayload = z.infer<typeof WsWorkflowUpdatedPayloadSchema>;

const CORE_SERVER_FRAME_SCHEMAS = [
  z.object({ type: z.literal('hello'), payload: WsHelloPayloadSchema }),
  z.object({
    type: z.literal('workflow.updated'),
    payload: WsWorkflowUpdatedPayloadSchema,
    seq: SeqSchema,
  }),
] as const;

/**
 * The two frames round 1 §2.9 defines. Kept as its own union so the round 2 contract is purely
 * additive: `@ace/sdk` still narrows `frame.seq` on every member of it (D31).
 */
export const WsServerFrameSchema = z.discriminatedUnion('type', CORE_SERVER_FRAME_SCHEMAS);
export type WsServerFrame = z.infer<typeof WsServerFrameSchema>;

/**
 * Every frame the server may send: the round 1 core plus round 2's run and engine events (§2.4),
 * so one `safeParse` covers the whole socket. `node.token` is the one member without a `seq`, so
 * a client that tracks `lastSeq` must check for it before resuming (§5 item 1).
 */
export const ServerFrameSchema = z.discriminatedUnion('type', [
  ...CORE_SERVER_FRAME_SCHEMAS,
  ...RUN_EVENT_FRAME_SCHEMAS,
  ...ENGINE_EVENT_FRAME_SCHEMAS,
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;

/** `true` when this frame was persisted with a `seq` and therefore replays on `resume`. */
export function isPersistedFrame(frame: ServerFrame): frame is Extract<ServerFrame, { seq: number }> {
  return 'seq' in frame;
}
