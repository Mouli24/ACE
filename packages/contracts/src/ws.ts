import { z } from 'zod';

import { IdSchema } from './graph.js';

/**
 * The WebSocket at `ws://127.0.0.1:4747/ws?token=<token>` (round 1 §2.9).
 *
 * Frames are JSON `{ type, payload }`. Server frames about a run or a workflow also carry the
 * global monotonic `seq` they were persisted with, which is what `resume { afterSeq }` replays
 * from; `hello` is neither, so it carries its seq in the payload only.
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

/** The global event sequence: monotonic, append-only, the anchor for `resume`. */
export const SeqSchema = z.number().int().min(0);

export const WsHelloPayloadSchema = z.object({ seq: SeqSchema });
export type WsHelloPayload = z.infer<typeof WsHelloPayloadSchema>;

export const WsWorkflowUpdatedPayloadSchema = z.object({
  workflowId: IdSchema,
  version: z.number().int().min(0),
});
export type WsWorkflowUpdatedPayload = z.infer<typeof WsWorkflowUpdatedPayloadSchema>;

export const WsServerFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), payload: WsHelloPayloadSchema }),
  z.object({
    type: z.literal('workflow.updated'),
    payload: WsWorkflowUpdatedPayloadSchema,
    seq: SeqSchema,
  }),
]);
export type WsServerFrame = z.infer<typeof WsServerFrameSchema>;
