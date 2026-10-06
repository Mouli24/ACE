import { describe, expect, it } from "vitest";

import {
  EDGE_TRANSFER_SUMMARY_MAX,
  ENGINE_EVENT_TYPES,
  EngineEventSchema,
  EventSchema,
  EventsQuerySchema,
  PERSISTED_RUN_EVENT_TYPES,
  PERSISTED_THREAD_EVENT_TYPES,
  RUN_EVENT_TYPES,
  RunEventSchema,
  THREAD_EVENT_TYPES,
  TRANSIENT_EVENT_TYPES,
  ThreadEventSchema,
} from "../events.js";
import { LOOP_STOP_REASONS } from "../graph.js";
import {
  ServerFrameSchema,
  WsServerFrameSchema,
  isPersistedFrame,
} from "../ws.js";
import {
  APPROVAL_ID,
  CHAT_MESSAGE_ID,
  EDGE_ID,
  KB_DOCUMENT_ID,
  KB_ID,
  LOOP_EDGE_ID,
  MCP_SERVER_ID,
  MESSAGE_ID,
  NODE_A,
  NODE_B,
  NODE_RUN_ID,
  NOW,
  PROVIDER_ID,
  RUN_ID,
  THREAD_ID,
  TOOL_CALL_ID,
  VERDICT_ID,
  WORKFLOW_ID,
} from "./fixtures.js";

const usage = {
  tokensIn: 12,
  tokensOut: 40,
  costUsd: 0.000_092,
  priceTableVersion: "mock-v1",
};

const summary = {
  id: RUN_ID,
  workflowId: WORKFLOW_ID,
  status: "RUNNING",
  startedAt: NOW,
  totals: usage,
};

const approvalRequest = {
  id: APPROVAL_ID,
  runId: RUN_ID,
  nodeRunId: NODE_RUN_ID,
  nodeId: NODE_A,
  nodeName: "Writer",
  point: "output",
  checkType: "pii",
  reason: "The output contains an email address.",
  preview: "You can reach the team at the address below.",
  requestedAt: NOW,
};

const approvalDecision = {
  requestId: APPROVAL_ID,
  decision: "reject",
  note: "No customer addresses in drafts.",
  decidedAt: NOW,
};

const verdict = {
  id: VERDICT_ID,
  nodeRunId: NODE_RUN_ID,
  point: "output",
  checkType: "pii",
  action: "redact",
  passed: false,
  reason: "An email address was found in the output.",
  redactedTypes: ["email"],
  at: NOW,
};

/* Round 4 §2.5. */

const toolCall = {
  id: TOOL_CALL_ID,
  nodeRunId: NODE_RUN_ID,
  toolName: "echo",
  args: { text: "hello" },
  resultSummary: "hello",
  durationMs: 2,
  status: "ok",
  verdicts: [],
  at: NOW,
};

const timelineMessage = {
  id: MESSAGE_ID,
  workflowId: WORKFLOW_ID,
  runId: RUN_ID,
  nodeId: NODE_A,
  type: "agent",
  content: [{ type: "text", text: "echo said: hello" }],
  at: NOW,
};

const chatMessage = {
  id: CHAT_MESSAGE_ID,
  threadId: THREAD_ID,
  role: "agent",
  content: [{ type: "text", text: "You said: hello" }],
  verdicts: [],
  at: NOW,
};

/** One valid frame per type of §2.4, in the order §2.4 lists them. */
const frames: Record<string, { type: string; payload: unknown; seq?: number }> =
  {
    "run.started": { type: "run.started", payload: { run: summary }, seq: 1 },
    "run.completed": {
      type: "run.completed",
      payload: { runId: RUN_ID, status: "COMPLETE", totals: usage },
      seq: 2,
    },
    "node.state": {
      type: "node.state",
      payload: {
        runId: RUN_ID,
        nodeRunId: NODE_RUN_ID,
        nodeId: NODE_A,
        iteration: 1,
        attempt: 1,
        status: "RUNNING",
      },
      seq: 3,
    },
    "node.token": {
      type: "node.token",
      payload: { runId: RUN_ID, nodeRunId: NODE_RUN_ID, delta: "Hel" },
    },
    "node.output": {
      type: "node.output",
      payload: {
        runId: RUN_ID,
        nodeRunId: NODE_RUN_ID,
        nodeId: NODE_A,
        output: [{ type: "text", text: "the answer" }],
        usage,
      },
      seq: 4,
    },
    "node.error": {
      type: "node.error",
      payload: {
        runId: RUN_ID,
        nodeRunId: NODE_RUN_ID,
        nodeId: NODE_A,
        error: {
          kind: "provider",
          code: "http_503",
          message: "down",
          retryable: true,
        },
        failureReason: "RUN_FAILED",
      },
      seq: 5,
    },
    "edge.transfer": {
      type: "edge.transfer",
      payload: {
        runId: RUN_ID,
        edgeId: EDGE_ID,
        fromNodeId: NODE_A,
        toNodeId: NODE_B,
        iteration: 1,
        summary: "text (12 words)",
      },
      seq: 6,
    },
    "usage.updated": {
      type: "usage.updated",
      payload: { runId: RUN_ID, totals: usage },
      seq: 7,
    },

    /* Round 3 §2.6 */
    "run.paused": { type: "run.paused", payload: { runId: RUN_ID }, seq: 8 },
    "run.resumed": { type: "run.resumed", payload: { runId: RUN_ID }, seq: 9 },
    "node.approval_required": {
      type: "node.approval_required",
      payload: { runId: RUN_ID, request: approvalRequest },
      seq: 10,
    },
    "node.approval_decided": {
      type: "node.approval_decided",
      payload: {
        runId: RUN_ID,
        nodeRunId: NODE_RUN_ID,
        decision: approvalDecision,
      },
      seq: 11,
    },
    "guardrail.verdict": {
      type: "guardrail.verdict",
      payload: { runId: RUN_ID, nodeRunId: NODE_RUN_ID, verdict },
      seq: 12,
    },
    "loop.iteration": {
      type: "loop.iteration",
      payload: {
        runId: RUN_ID,
        edgeId: LOOP_EDGE_ID,
        targetNodeId: NODE_A,
        iteration: 2,
      },
      seq: 13,
    },

    /* Round 4 §2.5 */
    "tool.call": {
      type: "tool.call",
      payload: { runId: RUN_ID, nodeRunId: NODE_RUN_ID, toolCall },
      seq: 14,
    },
    "message.created": {
      type: "message.created",
      payload: { workflowId: WORKFLOW_ID, message: timelineMessage },
      seq: 15,
    },
  };

/** One valid frame per thread event type (round 4 §2.5). */
const threadFrames: Record<
  string,
  { type: string; payload: unknown; seq?: number }
> = {
  "chat.message": {
    type: "chat.message",
    payload: { threadId: THREAD_ID, message: chatMessage },
    seq: 16,
  },
  "chat.token": {
    type: "chat.token",
    payload: { threadId: THREAD_ID, delta: "You " },
  },
};

/** Indexed access is checked in this workspace, so fixture lookup fails loudly instead. */
const payloadOf = (type: string): Record<string, unknown> => {
  const frame = frames[type];
  if (frame === undefined) throw new Error(`no fixture for ${type}`);
  return frame.payload as Record<string, unknown>;
};

describe("FR-EXE-014 RunEvent covers every type of round 2 §2.4 and round 3 §2.6", () => {
  it("declares exactly the sixteen run event types; round 5 §2.8 adds none (D230)", () => {
    expect([...RUN_EVENT_TYPES]).toEqual([
      "run.started",
      "run.completed",
      "node.state",
      "node.token",
      "node.output",
      "node.error",
      "edge.transfer",
      "usage.updated",
      "run.paused",
      "run.resumed",
      "node.approval_required",
      "node.approval_decided",
      "guardrail.verdict",
      "loop.iteration",
      "tool.call",
      "message.created",
    ]);
  });

  it.each(Object.keys(frames))("parses %s", (type) => {
    expect(RunEventSchema.parse(frames[type])).toEqual(frames[type]);
  });

  it("parses every declared type, so the union can never fall behind the list", () => {
    for (const type of RUN_EVENT_TYPES) {
      expect(Object.keys(frames), `${type} needs a fixture`).toContain(type);
      expect(RunEventSchema.safeParse(frames[type]).success, type).toBe(true);
    }
  });

  it("refuses an event type §2.4 does not define", () => {
    expect(
      RunEventSchema.safeParse({ type: "node.thinking", payload: {}, seq: 1 })
        .success,
    ).toBe(false);
  });
});

describe("§2.4 node.token is transient, and round 4 §2.5 chat.token with it", () => {
  it("names the two types that carry no seq", () => {
    expect([...TRANSIENT_EVENT_TYPES]).toEqual(["node.token", "chat.token"]);
    expect([...PERSISTED_RUN_EVENT_TYPES]).not.toContain("node.token");
    expect(PERSISTED_RUN_EVENT_TYPES).toHaveLength(RUN_EVENT_TYPES.length - 1);
    expect([...PERSISTED_THREAD_EVENT_TYPES]).toEqual(["chat.message"]);
  });

  it("refuses a seq on node.token, because it is never persisted or resumed", () => {
    expect(
      RunEventSchema.safeParse({ ...frames["node.token"], seq: 9 }).success,
    ).toBe(false);
  });

  it("requires a seq on every other type", () => {
    for (const type of PERSISTED_RUN_EVENT_TYPES) {
      const { seq: _seq, ...withoutSeq } = frames[type] as { seq?: number };
      expect(RunEventSchema.safeParse(withoutSeq).success, type).toBe(false);
    }
  });
});

describe("§2.4 run event payloads", () => {
  it("ends a run only in a terminal state", () => {
    for (const status of ["COMPLETE", "HALTED", "BLOCKED"]) {
      expect(
        RunEventSchema.safeParse({
          type: "run.completed",
          payload: { runId: RUN_ID, status, totals: usage },
          seq: 2,
        }).success,
        status,
      ).toBe(true);
    }
    expect(
      RunEventSchema.safeParse({
        type: "run.completed",
        payload: { runId: RUN_ID, status: "RUNNING", totals: usage },
        seq: 2,
      }).success,
    ).toBe(false);
  });

  it("carries the halt reason and the final output when a run ends", () => {
    const parsed = RunEventSchema.parse({
      type: "run.completed",
      payload: {
        runId: RUN_ID,
        status: "HALTED",
        haltReason: "failure",
        totals: usage,
        finalOutput: { [NODE_B]: [{ type: "text", text: "partial" }] },
      },
      seq: 8,
    });

    expect(parsed.type).toBe("run.completed");
  });

  it("carries the failure reason on a state change into FAILED", () => {
    expect(
      RunEventSchema.safeParse({
        type: "node.state",
        payload: {
          ...payloadOf("node.state"),
          status: "FAILED",
          failureReason: "CONTRACT_VIOLATION",
        },
        seq: 3,
      }).success,
    ).toBe(true);
  });

  it("carries the model used with a node output (FR-RTR-006)", () => {
    expect(
      RunEventSchema.safeParse({
        type: "node.output",
        payload: {
          ...payloadOf("node.output"),
          modelUsed: {
            providerId: PROVIDER_ID,
            modelId: "mock-text",
            viaFallback: true,
          },
        },
        seq: 4,
      }).success,
    ).toBe(true);
  });

  it("caps an edge.transfer summary at 120 characters (FR-EXE-015)", () => {
    expect(EDGE_TRANSFER_SUMMARY_MAX).toBe(120);
    const payload = payloadOf("edge.transfer");

    expect(
      RunEventSchema.safeParse({
        type: "edge.transfer",
        payload: { ...payload, summary: "x".repeat(120) },
        seq: 6,
      }).success,
    ).toBe(true);
    expect(
      RunEventSchema.safeParse({
        type: "edge.transfer",
        payload: { ...payload, summary: "x".repeat(121) },
        seq: 6,
      }).success,
    ).toBe(false);
  });

  it("refuses a token delta that is not a string", () => {
    expect(
      RunEventSchema.safeParse({
        type: "node.token",
        payload: { runId: RUN_ID, nodeRunId: NODE_RUN_ID, delta: 42 },
      }).success,
    ).toBe(false);
  });
});

describe("round 3 §2.6 control, approval, verdict and loop events", () => {
  const frame = (type: string, payload: unknown, seq = 20) => ({
    type,
    payload,
    seq,
  });

  it("FR-CTL-001 FR-CTL-002 says only which run paused or resumed", () => {
    for (const type of ["run.paused", "run.resumed"]) {
      expect(
        RunEventSchema.safeParse(frame(type, { runId: RUN_ID })).success,
        type,
      ).toBe(true);
      expect(
        RunEventSchema.safeParse(frame(type, { runId: RUN_ID, pausedAt: NOW }))
          .success,
        type,
      ).toBe(false);
    }
  });

  it("FR-GRD-013 carries the whole approval request, its preview capped at 500", () => {
    const long = { ...approvalRequest, preview: "x".repeat(501) };

    expect(
      RunEventSchema.safeParse(
        frame("node.approval_required", { runId: RUN_ID, request: long }),
      ).success,
    ).toBe(false);
  });

  it("TC-GRD-008 carries the decision with the time it was made", () => {
    const { decidedAt: _decidedAt, ...untimed } = approvalDecision;

    expect(
      RunEventSchema.safeParse(
        frame("node.approval_decided", {
          runId: RUN_ID,
          nodeRunId: NODE_RUN_ID,
          decision: untimed,
        }),
      ).success,
    ).toBe(false);
  });

  it("TC-GRD-018 never carries a redacted value on a verdict (FR-GRD-014, FR-GRD-015)", () => {
    const leaky = { ...verdict, value: "ada@example.com" };

    expect(
      RunEventSchema.safeParse(
        frame("guardrail.verdict", {
          runId: RUN_ID,
          nodeRunId: NODE_RUN_ID,
          verdict: leaky,
        }),
      ).success,
    ).toBe(false);
  });

  it("FR-PAR-005 numbers loop iterations from 1", () => {
    const payload = payloadOf("loop.iteration");

    expect(
      RunEventSchema.safeParse(
        frame("loop.iteration", { ...payload, iteration: 0 }),
      ).success,
    ).toBe(false);
  });

  it.each([...LOOP_STOP_REASONS])(
    "FR-PAR-003 says the loop stopped on %s",
    (stop) => {
      const payload = payloadOf("loop.iteration");

      expect(
        RunEventSchema.safeParse(
          frame("loop.iteration", { ...payload, iteration: 3, stop }),
        ).success,
      ).toBe(true);
    },
  );

  it("refuses a stop reason §2.4 does not name", () => {
    const payload = payloadOf("loop.iteration");

    expect(
      RunEventSchema.safeParse(
        frame("loop.iteration", { ...payload, stop: "timeout" }),
      ).success,
    ).toBe(false);
  });

  it("D80 says which budget halted the run, and by how much", () => {
    const budgetHalt = {
      scope: "daily",
      capUsd: 5,
      costUsd: 5.2,
      projected: true,
    };

    expect(
      RunEventSchema.safeParse(
        frame("run.completed", {
          runId: RUN_ID,
          status: "HALTED",
          haltReason: "budget_exceeded",
          totals: usage,
          budgetHalt,
        }),
      ).success,
    ).toBe(true);
  });

  it.each(["stopped", "budget_exceeded"])(
    "FR-CTL-003 FR-GRD-008 ends a run HALTED %s",
    (haltReason) => {
      expect(
        RunEventSchema.safeParse(
          frame("run.completed", {
            runId: RUN_ID,
            status: "HALTED",
            haltReason,
            totals: usage,
          }),
        ).success,
      ).toBe(true);
    },
  );
});

describe("FR-PRV-004 EngineEvent", () => {
  const frame = {
    type: "provider.status",
    payload: {
      providerId: PROVIDER_ID,
      status: "AUTH_FAILED",
      message: "invalid key",
    },
    seq: 11,
  };

  it("declares provider.status, round 4 §2.5 mcp.status, round 5 §2.8 kb.ingest and memory.updated, and the parity task frames", () => {
    expect([...ENGINE_EVENT_TYPES]).toEqual([
      "provider.status",
      "mcp.status",
      "kb.ingest",
      "memory.updated",
      "task.updated",
      "task.deleted",
    ]);
  });

  it("parses an MCP server coming up with its tool count (FR-TOOL-007, D16)", () => {
    const mcp = {
      type: "mcp.status",
      payload: { serverId: MCP_SERVER_ID, status: "connected", toolCount: 3 },
      seq: 17,
    };

    expect(EngineEventSchema.parse(mcp)).toEqual(mcp);
    expect(
      EngineEventSchema.safeParse({
        ...mcp,
        payload: { serverId: MCP_SERVER_ID, status: "CONNECTED", toolCount: 3 },
      }).success,
      "an MCP status is lowercase, not a ProviderState",
    ).toBe(false);
    expect(
      EngineEventSchema.safeParse({
        ...mcp,
        payload: { serverId: MCP_SERVER_ID, status: "connected" },
      }).success,
      "the tool count says how many tools the registry gained",
    ).toBe(false);
  });

  it("parses a provider status change", () => {
    expect(EngineEventSchema.parse(frame)).toEqual(frame);
  });

  it("refuses a status that is not a ProviderState", () => {
    expect(
      EngineEventSchema.safeParse({
        ...frame,
        payload: { providerId: PROVIDER_ID, status: "down" },
      }).success,
    ).toBe(false);
  });
});

describe("FR-EXE-014 the persisted event log", () => {
  it("stores a global seq, a time, a type and its payload", () => {
    const event = {
      seq: 12,
      at: NOW,
      runId: RUN_ID,
      type: "node.state",
      payload: { status: "COMPLETED" },
    };

    expect(EventSchema.parse(event)).toEqual(event);
  });

  it("scopes an event to a run, a workflow, both or neither", () => {
    expect(
      EventSchema.safeParse({
        seq: 1,
        at: NOW,
        type: "provider.status",
        payload: {},
      }).success,
    ).toBe(true);
    expect(
      EventSchema.safeParse({
        seq: 1,
        at: NOW,
        workflowId: WORKFLOW_ID,
        type: "workflow.updated",
        payload: {},
      }).success,
    ).toBe(true);
  });

  it("reads afterSeq off the query string of GET /runs/:id/events", () => {
    expect(EventsQuerySchema.parse({})).toEqual({});
    expect(EventsQuerySchema.parse({ afterSeq: "41" }).afterSeq).toBe(41);
    expect(EventsQuerySchema.parse({ afterSeq: 0 }).afterSeq).toBe(0);
    expect(EventsQuerySchema.safeParse({ afterSeq: -1 }).success).toBe(false);
    expect(EventsQuerySchema.safeParse({ afterSeq: "soon" }).success).toBe(
      false,
    );
  });

  it("refuses a negative or fractional seq — resume depends on it being monotonic", () => {
    expect(
      EventSchema.safeParse({ seq: -1, at: NOW, type: "x", payload: {} })
        .success,
    ).toBe(false);
    expect(
      EventSchema.safeParse({ seq: 1.5, at: NOW, type: "x", payload: {} })
        .success,
    ).toBe(false);
  });
});

describe("FR-EXE-014 run events travel on the round 1 socket", () => {
  it.each(Object.keys(frames))("the whole-socket union accepts %s", (type) => {
    expect(ServerFrameSchema.parse(frames[type])).toEqual(frames[type]);
  });

  it("still accepts the round 1 frames", () => {
    expect(
      ServerFrameSchema.parse({ type: "hello", payload: { seq: 0 } }).type,
    ).toBe("hello");
    expect(
      ServerFrameSchema.parse({
        type: "workflow.updated",
        payload: { workflowId: WORKFLOW_ID, version: 4 },
        seq: 13,
      }).type,
    ).toBe("workflow.updated");
  });

  it("accepts provider.status on the engine scope", () => {
    expect(
      ServerFrameSchema.parse({
        type: "provider.status",
        payload: { providerId: PROVIDER_ID, status: "CONNECTED" },
        seq: 14,
      }).type,
    ).toBe("provider.status");
  });

  it("leaves the round 1 union alone, so @ace/sdk keeps compiling until M2 (D54)", () => {
    expect(WsServerFrameSchema.safeParse(frames["node.token"]).success).toBe(
      false,
    );
    expect(
      WsServerFrameSchema.parse({ type: "hello", payload: { seq: 0 } }).type,
    ).toBe("hello");
  });

  it("tells a resuming client which frames carry a seq", () => {
    expect(
      isPersistedFrame(ServerFrameSchema.parse(frames["node.state"])),
    ).toBe(true);
    expect(
      isPersistedFrame(ServerFrameSchema.parse(frames["node.token"])),
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Round 4 §2.5                                                              */
/* -------------------------------------------------------------------------- */

describe("round 4 §2.5 the five events this round adds", () => {
  it("parses every new type (round 4 §3)", () => {
    for (const type of ["tool.call", "message.created"]) {
      expect(RunEventSchema.safeParse(frames[type]).success, type).toBe(true);
    }
    for (const type of THREAD_EVENT_TYPES) {
      expect(
        ThreadEventSchema.safeParse(threadFrames[type]).success,
        type,
      ).toBe(true);
    }
    expect([...THREAD_EVENT_TYPES]).toEqual(["chat.message", "chat.token"]);
  });

  it("FR-TOOL-009 logs the whole tool call, verdicts and all", () => {
    const parsed = RunEventSchema.parse(frames["tool.call"]);

    expect(parsed.type).toBe("tool.call");
    expect(
      RunEventSchema.safeParse({
        type: "tool.call",
        payload: {
          runId: RUN_ID,
          nodeRunId: NODE_RUN_ID,
          toolCall: { ...toolCall, toolName: "Echo" },
        },
        seq: 14,
      }).success,
      "a tool name is snake_case",
    ).toBe(false);
  });

  it("FR-CHAT-001 puts a new timeline row on the workflow, not on a run", () => {
    expect(
      RunEventSchema.safeParse({
        type: "message.created",
        payload: { message: timelineMessage },
        seq: 15,
      }).success,
      "the payload names its workflow",
    ).toBe(false);
  });

  it("FR-CHAT-005 keeps a chat turn on its thread, with no run to name", () => {
    expect(
      ThreadEventSchema.safeParse({
        type: "chat.message",
        payload: { threadId: THREAD_ID, runId: RUN_ID, message: chatMessage },
        seq: 16,
      }).success,
    ).toBe(false);
  });

  it("FR-CHAT-006 streams chat.token with no seq, and refuses one (round 4 §3)", () => {
    expect(ThreadEventSchema.parse(threadFrames["chat.token"])).toEqual(
      threadFrames["chat.token"],
    );
    expect(
      ThreadEventSchema.safeParse({ ...threadFrames["chat.token"], seq: 17 })
        .success,
      "a transient frame is never persisted or resumed",
    ).toBe(false);
    expect(
      ThreadEventSchema.safeParse({
        type: "chat.message",
        payload: { threadId: THREAD_ID, message: chatMessage },
      }).success,
      "chat.message is persisted, so it carries a seq",
    ).toBe(false);
  });

  it("rides the one whole-socket union, and isPersistedFrame tells them apart", () => {
    for (const frame of [
      frames["tool.call"],
      frames["message.created"],
      threadFrames["chat.message"],
    ]) {
      expect(
        isPersistedFrame(ServerFrameSchema.parse(frame)),
        JSON.stringify(frame),
      ).toBe(true);
    }
    expect(
      isPersistedFrame(ServerFrameSchema.parse(threadFrames["chat.token"])),
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Round 5 §2.8                                                                */
/* -------------------------------------------------------------------------- */

describe("FR-RAG-003 kb.ingest", () => {
  const ingest = {
    type: "kb.ingest",
    payload: {
      knowledgeBaseId: KB_ID,
      documentId: KB_DOCUMENT_ID,
      status: "embedding",
      progress: 0.6,
    },
    seq: 19,
  };

  it("rides the engine subscription, persisted with a seq", () => {
    expect(EngineEventSchema.parse(ingest)).toEqual(ingest);
    const { seq: _seq, ...withoutSeq } = ingest;
    expect(EngineEventSchema.safeParse(withoutSeq).success).toBe(false);
    expect(ServerFrameSchema.safeParse(ingest).success).toBe(true);
  });

  it("TC-RAG-003 carries the reason on a failed document", () => {
    const failed = {
      ...ingest,
      payload: {
        knowledgeBaseId: KB_ID,
        documentId: KB_DOCUMENT_ID,
        status: "failed",
        error: "The PDF is damaged.",
      },
    };
    expect(EngineEventSchema.parse(failed)).toEqual(failed);
  });

  it("bounds progress to 0..1 and the status to the pipeline", () => {
    const at = (payload: Record<string, unknown>) =>
      EngineEventSchema.safeParse({
        ...ingest,
        payload: { ...ingest.payload, ...payload },
      }).success;

    expect(at({ progress: 0 })).toBe(true);
    expect(at({ progress: 1 })).toBe(true);
    expect(at({ progress: 60 })).toBe(false);
    expect(at({ status: "done" })).toBe(false);
  });

  it("is not a run event", () => {
    expect(RunEventSchema.safeParse(ingest).success).toBe(false);
  });
});

describe("FR-MEM-002 FR-MEM-004 memory.updated", () => {
  const frame = {
    type: "memory.updated",
    payload: {
      nodeId: NODE_A,
      ops: [{ op: "save", key: "user_name", value: "Ada" }],
    },
    seq: 18,
  };

  it("rides the engine subscription, persisted with a seq — a delete belongs to no run (D230)", () => {
    expect(EngineEventSchema.parse(frame)).toEqual(frame);
    expect(isPersistedFrame(ServerFrameSchema.parse(frame))).toBe(true);
    expect(RunEventSchema.safeParse(frame).success).toBe(false);
  });

  it("carries the ops, deletes included, and at least one", () => {
    const clear = {
      ...frame,
      payload: {
        nodeId: NODE_A,
        ops: [
          { op: "delete", key: "user_name" },
          { op: "delete", key: "city" },
        ],
      },
    };
    expect(EngineEventSchema.safeParse(clear).success).toBe(true);
    expect(
      EngineEventSchema.safeParse({
        ...frame,
        payload: { nodeId: NODE_A, ops: [] },
      }).success,
    ).toBe(false);
  });
});

describe("FR-OBS-002 usage.updated with the day totals", () => {
  it("carries the day across every run on the completing frame, and stays valid without it", () => {
    const withDay = {
      type: "usage.updated",
      payload: {
        runId: RUN_ID,
        totals: usage,
        dayTotals: { day: "2026-10-01", totals: usage },
      },
      seq: 20,
    };
    expect(RunEventSchema.parse(withDay)).toEqual(withDay);
    expect(RunEventSchema.safeParse(frames["usage.updated"]).success).toBe(
      true,
    );
    expect(
      RunEventSchema.safeParse({
        ...withDay,
        payload: {
          ...withDay.payload,
          dayTotals: { day: "today", totals: usage },
        },
      }).success,
    ).toBe(false);
  });
});
