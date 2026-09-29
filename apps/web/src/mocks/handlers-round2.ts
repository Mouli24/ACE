import {
  CreateProviderRequestSchema,
  EventsQuerySchema,
  ModelQuerySchema,
  StartRunRequestSchema,
  UpdateProviderRequestSchema,
  aceError,
  allowedRunActions,
  modelMatchesQuery,
  zeroUsage,
  type ApiError,
  type BudgetHalt,
  type ErrorKind,
  type GuardrailPolicyRef,
  type Model,
  type Node,
  type Part,
  type Run,
  type ValidationIssue,
} from '@ace/contracts';
import { HttpResponse, http, type HttpHandler, type PathParams } from 'msw';

import { newId } from '../lib/ulid';
import { DETECTED_OLLAMA } from './catalog';
import { validateGraph } from './graph-rules';
import { type MockDb } from './db';
import { dropMockSockets } from './fake-socket';
import { pausePlayback, startPlayback, stopAllPlayback } from './playback';
import { buildScenario, type ScenarioName, type ScriptedFrame, type StreamPace } from './scenarios';

/**
 * MSW handlers for the round 2 endpoints (§2.5), plus the pre-flight of §2.7 and the scripted run
 * scenarios of §5 item 11. The engine (A2) is being built at the same time; this is what the UI is
 * developed and tested against until it lands.
 */

const API = '*/api/v1';

type Ctx = { request: Request; params: PathParams };
const param = (ctx: Ctx, name: string): string => String(ctx.params[name] ?? '');

function error(status: number, kind: ErrorKind, code: string, message: string, details?: unknown) {
  const body: ApiError = aceError(kind, code, message, { details, retryable: false });
  return HttpResponse.json(body, { status });
}

const notFound = (what: string) => error(404, 'workflow', 'not_found', `${what} not found.`);
const unauthorized = () => error(401, 'auth', 'unauthorized', 'Missing or invalid session token.');

function hasToken(request: Request): boolean {
  return /^Bearer\s+\S+$/.test(request.headers.get('authorization') ?? '');
}

/** Which scenario a run plays. Tests set it; the default is the happy path. */
let scenario: ScenarioName = 'linear-complete';
export function setScenario(next: ScenarioName): void {
  scenario = next;
}
export function currentScenario(): ScenarioName {
  return scenario;
}

/**
 * How fast a run streams (D200). Independent of the scenario, because the pace is a property of the
 * harness's needs rather than of the story: a test that clicks a control needs the run it is clicking
 * to still be live, whichever story it is telling.
 */
let pace: StreamPace = 'normal';
export function setStreamPace(next: StreamPace): void {
  pace = next;
}
export function currentStreamPace(): StreamPace {
  return pace;
}

/** Cancels every scenario still playing, so tests never leak into one another. */
export function stopScenario(): void {
  stopAllPlayback();
}

/**
 * Play one scripted frame: the node run as it stands, what it changes about the run, any approval it
 * raises, then the frame itself. Node runs are *merged* rather than replaced, so a decision the
 * approve handler wrote onto a node run survives the frames that come after it.
 */
function applyFrame(db: MockDb, run: Run, frame: ScriptedFrame): void {
  if (frame.dropSocket === true) {
    // cut every open mock socket, the way an engine restart would (TC-EXE-013)
    dropMockSockets();
    return;
  }
  // Round 4: a frame may store artifacts or timeline rows before its event is emitted, so the
  // content and message endpoints answer for what the frame announces.
  frame.effect?.(db);
  if (frame.nodeRun !== undefined) {
    const existing = db.getNodeRun(frame.nodeRun.id);
    db.upsertNodeRun(existing === undefined ? frame.nodeRun : { ...existing, ...frame.nodeRun });
  }
  if (frame.run !== undefined) db.updateRun(run.id, frame.run);
  if (frame.approval !== undefined) db.addApproval(frame.approval);

  const emitted = db.emit(frame.event);
  if (frame.event.type === 'run.completed') {
    const payload = emitted.payload as {
      status: Run['status'];
      totals: Run['totals'];
      haltReason?: Run['haltReason'];
      finalOutput?: Run['finalOutput'];
      budgetHalt?: BudgetHalt;
    };
    const endedAt = new Date().toISOString();
    db.updateRun(run.id, {
      status: payload.status,
      totals: payload.totals,
      ...(payload.haltReason === undefined ? {} : { haltReason: payload.haltReason }),
      ...(payload.finalOutput === undefined ? {} : { finalOutput: payload.finalOutput }),
      ...(payload.budgetHalt === undefined ? {} : { budgetHalt: payload.budgetHalt }),
      allowedActions: allowedRunActions(payload.status),
      endedAt,
      durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(run.startedAt)),
    });
  }

  // a `paused` or `waiting-approval` script stops here until a control or a decision arrives
  if (frame.hold === true) pausePlayback(run.id);
}

/** Queue these frames as this run's story, replacing whatever it was playing. */
export function playFrames(db: MockDb, run: Run, frames: readonly ScriptedFrame[]): void {
  startPlayback(
    run.id,
    frames.map((frame) => ({ after: frame.after, play: () => applyFrame(db, run, frame) })),
  );
}

/**
 * Queue this run's scenario (round 2 §5 item 11). The frames come from the run's own snapshot, so a
 * restart replays the graph the run froze rather than whatever the workflow looks like now (BR-04).
 */
export function playScenario(db: MockDb, run: Run): void {
  const cap = db.getProject(run.projectId)?.maxCostPerRunUsd;
  playFrames(
    db,
    run,
    buildScenario(scenario, {
      run,
      workflowId: run.workflowId,
      nodes: run.snapshot.nodes,
      edges: run.snapshot.edges,
      pace,
      ...(cap === undefined || cap === null ? {} : { maxCostPerRunUsd: cap }),
      policyFor: (node) => policyRefFor(db, run.projectId, node),
      artifactPartFor: (artifactId) => artifactPartFor(db, artifactId),
    }),
  );
}

/**
 * Round 4: resolve an Input node's `artifactId` to the `Part` a run reads (§2.6 `mock-vision`). The
 * part kind follows the artifact's mime, and its name/size/mime come from the stored row — a
 * reference, never bytes (BR-02).
 */
export function artifactPartFor(db: MockDb, artifactId: string): Part | undefined {
  const artifact = db.getArtifact(artifactId);
  if (artifact === undefined) return undefined;
  const type: Extract<Part, { artifactId: string }>['type'] = artifact.mime.startsWith('image/')
    ? 'image'
    : artifact.mime.startsWith('audio/')
      ? 'audio'
      : artifact.mime.startsWith('video/')
        ? 'video'
        : 'file';
  return {
    type,
    artifactId: artifact.id,
    mime: artifact.mime,
    name: artifact.name,
    size: artifact.size,
  };
}

/**
 * The policy a node run is checked against (FR-GRD-002): the node's `guardrailPolicyId` override, or
 * the project default. The version is read now, so a later PATCH does not change what the record
 * says — a verdict belongs to the rules that produced it.
 */
export function policyRefFor(
  db: MockDb,
  projectId: string,
  node: Node,
): GuardrailPolicyRef | undefined {
  const override = (node.config as { guardrailPolicyId?: string }).guardrailPolicyId;
  const policy =
    override === undefined ? db.projectDefaultPolicy(projectId) : db.getPolicy(override);
  return policy === undefined ? undefined : { id: policy.id, version: policy.version };
}

/**
 * §2.7 pre-flight, in order, as far as round 2 needs it: an agent or model node must name a
 * provider and a model, the model must exist, be available, and cover the node's data types; an
 * Input node must have text; merge and the later kinds are `not_supported_yet`. Any issue → the
 * run is recorded as BLOCKED and no frame is ever emitted.
 */
export function preflight(
  nodes: Node[],
  models: Model[],
  inputs: Record<string, unknown>,
  providerIds: Set<string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [...modelIssues(nodes, models, providerIds)];

  for (const node of nodes) {
    if (node.kind === 'input') {
      const config = node.config as { text?: string; artifactIds: string[] };
      const supplied = inputs[node.id];
      if (!config.text && config.artifactIds.length === 0 && supplied === undefined) {
        issues.push({
          severity: 'error',
          code: 'missing_input',
          message: `"${node.name}" has nothing to send.`,
          nodeId: node.id,
        });
      }
    }

    // merge runs from round 3 (§2.4, FR-PAR-002); the rest still arrive later
    if (node.kind === 'retrieval' || node.kind === 'guardrail' || node.kind === 'custom') {
      issues.push({
        severity: 'error',
        code: 'not_supported_yet',
        message: `${node.kind} nodes run from a later round.`,
        nodeId: node.id,
      });
    }
  }

  if (!nodes.some((node) => node.kind === 'output')) {
    issues.push({
      severity: 'error',
      code: 'no_output_node',
      message: 'The workflow has no Output node.',
    });
  }

  return issues;
}

/**
 * The model half of pre-flight, on its own because `GET /validate` shows the same three issues
 * before a run is ever started (FR-MOD-005): `provider_missing`, `unavailable_model` and
 * `incompatible_model`. One implementation, so the validation panel and the pre-flight that
 * refuses the run can never disagree about the same graph.
 */
export function modelIssues(
  nodes: Node[],
  models: Model[],
  providerIds: Set<string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const node of nodes) {
    if (node.kind === 'agent' || node.kind === 'model') {
      const config = node.config as {
        providerId?: string;
        modelId?: string;
        inputTypes: string[];
        outputTypes: string[];
      };
      if (!config.providerId || !config.modelId) {
        issues.push({
          severity: 'error',
          code: 'missing_model',
          message: `"${node.name}" has no model chosen.`,
          nodeId: node.id,
        });
        continue;
      }
      if (!providerIds.has(config.providerId)) {
        issues.push({
          severity: 'error',
          code: 'provider_missing',
          message: `"${node.name}" points at a provider that no longer exists.`,
          nodeId: node.id,
        });
        continue;
      }
      const model = models.find(
        (m) => m.providerId === config.providerId && m.modelId === config.modelId,
      );
      if (!model) {
        issues.push({
          severity: 'error',
          code: 'unavailable_model',
          message: `"${config.modelId}" is not in the catalogue.`,
          nodeId: node.id,
        });
        continue;
      }
      if (!model.available) {
        issues.push({
          severity: 'error',
          code: 'unavailable_model',
          message: `"${model.displayName}" is not available.`,
          nodeId: node.id,
        });
        continue;
      }
      const coversInputs = config.inputTypes.every((type) =>
        model.inputTypes.includes(type as never),
      );
      const coversOutputs = config.outputTypes.every((type) =>
        model.outputTypes.includes(type as never),
      );
      if (!coversInputs || !coversOutputs) {
        issues.push({
          severity: 'error',
          code: 'incompatible_model',
          message: `"${model.displayName}" does not handle the data types "${node.name}" is configured for.`,
          nodeId: node.id,
        });
      }
    }
  }

  return issues;
}

export function createRound2Handlers(db: MockDb): HttpHandler[] {
  const guard =
    (handler: (ctx: Ctx) => Response | Promise<Response>) =>
    async (ctx: Ctx): Promise<Response> => {
      if (!hasToken(ctx.request)) return unauthorized();
      db.load();
      if (db.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, db.latencyMs));
      return handler(ctx);
    };

  return [
    /* ---------------------------------------------------------------- providers */
    http.get(
      `${API}/providers/detect`,
      guard(() => HttpResponse.json({ ollama: { ...DETECTED_OLLAMA } })),
    ),

    http.get(
      `${API}/providers`,
      guard(() => HttpResponse.json({ items: db.listProviders() })),
    ),

    http.post(
      `${API}/providers`,
      guard(async ({ request }) => {
        const parsed = CreateProviderRequestSchema.safeParse(await request.json());
        if (!parsed.success) {
          return error(
            400,
            'invalid_config',
            'validation_failed',
            'Request body is invalid.',
            parsed.error.issues,
          );
        }
        return HttpResponse.json(db.createProvider(parsed.data), { status: 201 });
      }),
    ),

    http.get(
      `${API}/providers/:id`,
      guard((ctx) => {
        const provider = db.getProvider(param(ctx, 'id'));
        return provider ? HttpResponse.json(provider) : notFound('Provider');
      }),
    ),

    http.patch(
      `${API}/providers/:id`,
      guard(async (ctx) => {
        const parsed = UpdateProviderRequestSchema.safeParse(await ctx.request.json());
        if (!parsed.success) {
          return error(
            400,
            'invalid_config',
            'validation_failed',
            'Request body is invalid.',
            parsed.error.issues,
          );
        }
        const provider = db.updateProvider(param(ctx, 'id'), parsed.data);
        return provider ? HttpResponse.json(provider) : notFound('Provider');
      }),
    ),

    http.delete(
      `${API}/providers/:id`,
      guard((ctx) => {
        const id = param(ctx, 'id');
        if (!db.getProvider(id)) return notFound('Provider');
        const confirm = new URL(ctx.request.url).searchParams.get('confirm') === 'true';
        const nodeIds = db.nodesUsingProvider(id);
        if (nodeIds.length > 0 && !confirm) {
          return error(
            409,
            'workflow',
            'provider_in_use',
            `${nodeIds.length} node${nodeIds.length === 1 ? ' still uses' : 's still use'} this provider.`,
            { nodeIds },
          );
        }
        db.deleteProvider(id);
        return new HttpResponse(null, { status: 204 });
      }),
    ),

    http.post(
      `${API}/providers/:id/check`,
      guard((ctx) => {
        const result = db.checkProvider(param(ctx, 'id'));
        return result ? HttpResponse.json(result) : notFound('Provider');
      }),
    ),

    http.post(
      `${API}/providers/:id/refresh-models`,
      guard((ctx) => {
        const result = db.refreshModels(param(ctx, 'id'));
        return result ? HttpResponse.json(result) : notFound('Provider');
      }),
    ),

    /* ------------------------------------------------------- validate (FR-MOD-005) */
    /**
     * The round 1 graph checks plus the model-catalogue ones, so `unavailable_model`,
     * `provider_missing` and `incompatible_model` are visible in the validation panel before a run
     * is ever started. This handler is registered ahead of the round 1 one, which it replaces.
     */
    http.post(
      `${API}/workflows/:id/validate`,
      guard((ctx) => {
        const workflowId = param(ctx, 'id');
        if (!db.getWorkflow(workflowId)) return notFound('Workflow');
        const nodes = db.nodesOf(workflowId);
        const providerIds = new Set(db.listProviders().map((provider) => provider.id));
        return HttpResponse.json({
          issues: [
            // The round 1 placeholder warning for "no model yet" is dropped: modelIssues says it
            // properly now, as the error that pre-flight will also refuse the run for (D50).
            ...validateGraph(nodes, db.edgesOf(workflowId)).filter(
              (issue) => issue.code !== 'missing_model',
            ),
            ...modelIssues(nodes, db.listModels(), providerIds),
          ],
        });
      }),
    ),

    /* ---------------------------------------------------------------- models */
    http.get(
      `${API}/models`,
      guard(({ request }) => {
        const query = ModelQuerySchema.safeParse(
          Object.fromEntries(new URL(request.url).searchParams),
        );
        const filter = query.success ? query.data : {};
        return HttpResponse.json({
          items: db.listModels().filter((model) => modelMatchesQuery(model, filter)),
          // The catalogue's own timestamp, not this request's: a "refreshed" line that always says
          // "now" could never show that a refresh had happened (FR-MOD-006).
          refreshedAt: db.catalogRefreshedAt(),
        });
      }),
    ),

    /* ---------------------------------------------------------------- runs */
    http.post(
      `${API}/workflows/:id/runs`,
      guard(async (ctx) => {
        const workflowId = param(ctx, 'id');
        const workflow = db.getWorkflow(workflowId);
        if (!workflow) return notFound('Workflow');
        const parsed = StartRunRequestSchema.safeParse(await ctx.request.json().catch(() => ({})));
        if (!parsed.success) {
          return error(
            400,
            'invalid_config',
            'validation_failed',
            'Request body is invalid.',
            parsed.error.issues,
          );
        }

        const nodes = db.nodesOf(workflowId);
        const issues = preflight(
          nodes,
          db.listModels(),
          parsed.data.inputs ?? {},
          new Set(db.listProviders().map((p) => p.id)),
        );
        if (scenario === 'preflight-blocked' && issues.length === 0) {
          // the scenario is the pre-flight failure itself, so a valid graph still blocks (§2.7)
          const target = nodes.find((node) => node.kind === 'agent' || node.kind === 'model');
          issues.push({
            severity: 'error',
            code: 'provider_unreachable',
            message: `"${target?.name ?? 'An agent'}" cannot reach its provider.`,
            ...(target === undefined ? {} : { nodeId: target.id }),
          });
        }

        const run: Run = {
          id: newId(),
          workflowId,
          projectId: workflow.projectId,
          // §2.5: a blocked run is still a recorded run, answered 201
          status: issues.length > 0 ? 'BLOCKED' : 'RUNNING',
          snapshot: { version: workflow.version, nodes, edges: db.edgesOf(workflowId) },
          inputs: (parsed.data.inputs ?? {}) as Run['inputs'],
          preflightIssues: issues,
          totals: zeroUsage(),
          startedAt: new Date().toISOString(),
          // the engine writes the controls this state allows, so the UI never guesses (FR-CTL-006)
          allowedActions: allowedRunActions(issues.length > 0 ? 'BLOCKED' : 'RUNNING'),
        };
        db.addRun(run);
        if (issues.length === 0) playScenario(db, run);
        return HttpResponse.json(run, { status: 201 });
      }),
    ),

    http.get(
      `${API}/workflows/:id/runs`,
      guard((ctx) => {
        const workflowId = param(ctx, 'id');
        if (!db.getWorkflow(workflowId)) return notFound('Workflow');
        return HttpResponse.json({
          items: db.listRuns(workflowId).map((run) => ({
            id: run.id,
            workflowId: run.workflowId,
            status: run.status,
            ...(run.haltReason === undefined ? {} : { haltReason: run.haltReason }),
            startedAt: run.startedAt,
            ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
            ...(run.durationMs === undefined ? {} : { durationMs: run.durationMs }),
            totals: run.totals,
          })),
        });
      }),
    ),

    http.get(
      `${API}/runs/:id/node-runs`,
      guard((ctx) => HttpResponse.json(db.listNodeRuns(param(ctx, 'id')))),
    ),

    http.get(
      `${API}/runs/:id/events`,
      guard((ctx) => {
        const runId = param(ctx, 'id');
        if (!db.getRun(runId)) return notFound('Run');
        const query = EventsQuerySchema.safeParse(
          Object.fromEntries(new URL(ctx.request.url).searchParams),
        );
        const afterSeq = query.success ? (query.data.afterSeq ?? 0) : 0;
        return HttpResponse.json(
          db
            .eventsAfter(afterSeq)
            // This run's events only: the endpoint is scoped by `:id`, and replaying another run's
            // frames into a resume would put states on nodes that never ran here.
            .filter((event) => (event.payload as { runId?: string }).runId === runId)
            .map((event) => ({
              seq: event.seq,
              at: new Date().toISOString(),
              type: event.type,
              payload: event.payload,
              ...(event.workflowId === undefined ? {} : { workflowId: event.workflowId }),
            })),
        );
      }),
    ),

    http.get(
      `${API}/runs/:id`,
      guard((ctx) => {
        const run = db.getRun(param(ctx, 'id'));
        return run ? HttpResponse.json(run) : notFound('Run');
      }),
    ),

    http.get(
      `${API}/node-runs/:id`,
      guard((ctx) => {
        const nodeRun = db.getNodeRun(param(ctx, 'id'));
        return nodeRun ? HttpResponse.json(nodeRun) : notFound('Node run');
      }),
    ),
  ];
}
