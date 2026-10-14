import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { foldDebate, type DebateHubConfig, type DebateRecord, type Model } from '@ace/contracts';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { InProcessPubSubStub } from '../../__tests__/pubsub-stub.js';
import { createEventBus } from '../../events/index.js';
import { LOCAL_SCOPE, type EngineEvent, type ModelRouter } from '../../ports/index.js';
import { createDebateCaller } from '../caller.js';
import { createDebateControl, type AttachableDebateControl } from '../control.js';
import type { DebateBudget, DebateGuardrails, DebateHooks, DebateWorkspace } from '../ports.js';
import { runDebate, type DebateOutcome, type DebaterSpec, type DebateSpec } from '../runner.js';
import { createFakeDebateProvider, type FakeDebateProvider } from './fake-debate-provider.js';

export const RUN_ID = '01JF0000000000000000000001';
export const WORKFLOW_ID = '01JF0000000000000000000002';
export const DEBATE_ID = '01JF0000000000000000000003';
export const HUB_ID = '01JF00000000000000000000H0';
export const PROJECT = 'D:/projects/debate-demo';

/** Every name, provider and model a prompt must never carry (D345). */
export const DEBATERS = [
  {
    id: '01JF00000000000000000000DA',
    name: 'Claude Debater',
    providerId: '01JF00000000000000000000PA',
    modelId: 'claude-sonnet-debate',
  },
  {
    id: '01JF00000000000000000000DB',
    name: 'Codex Debater',
    providerId: '01JF00000000000000000000PB',
    modelId: 'gpt-codex-debate',
  },
  {
    id: '01JF00000000000000000000DC',
    name: 'Gemini Debater',
    providerId: '01JF00000000000000000000PC',
    modelId: 'gemini-pro-debate',
  },
  {
    id: '01JF00000000000000000000DD',
    name: 'Fable Debater',
    providerId: '01JF00000000000000000000PD',
    modelId: 'fable-debate',
  },
  {
    id: '01JF00000000000000000000DE',
    name: 'Haiku Debater',
    providerId: '01JF00000000000000000000PE',
    modelId: 'haiku-debate',
  },
] as const;
export const HUB = {
  name: 'Debate Hub',
  providerId: '01JF00000000000000000000PH',
  modelId: 'claude-judge-model',
};

export const LABELS = ['A', 'B', 'C', 'D', 'E'] as const;
export const nodeOf = (label: (typeof LABELS)[number]): string =>
  DEBATERS[LABELS.indexOf(label)]?.id ?? '';

export interface FakeWorkspace extends DebateWorkspace {
  files: Map<string, string>;
  scratches: { dir: string; disposed: boolean }[];
}

export function fakeWorkspace(files: Record<string, string> = {}): FakeWorkspace {
  const map = new Map(Object.entries(files));
  const scratches: { dir: string; disposed: boolean }[] = [];
  return {
    files: map,
    scratches,
    async snapshot(_folder, paths) {
      return {
        sha: 'abc1234',
        dirty: false,
        files: paths.map((path) => {
          const content = map.get(path);
          if (content === undefined) throw new Error(`${path} does not exist in the project.`);
          return { path, content };
        }),
      };
    },
    async scratch() {
      const dir = mkdtempSync(join(tmpdir(), 'ace-debate-test-'));
      const entry = { dir, disposed: false };
      scratches.push(entry);
      return {
        dir,
        dispose: async () => {
          rmSync(dir, { recursive: true, force: true });
          entry.disposed = true;
        },
      };
    },
  };
}

export interface HarnessOptions {
  debaters?: number;
  config?: Partial<DebateHubConfig> & { topic?: string };
  material?: string;
  stances?: Partial<Record<(typeof LABELS)[number], string>>;
  reads?: Partial<Record<(typeof LABELS)[number], string[]>>;
  files?: Record<string, string>;
  projectFolder?: string;
  provider?: FakeDebateProvider;
  workspace?: FakeWorkspace;
  guardrails?: DebateGuardrails;
  budget?: DebateBudget;
  hooks?: DebateHooks;
  models?: Model[];
  maxTokens?: number;
}

export interface HarnessRun {
  outcome: DebateOutcome;
  /** The persisted log, as the repository holds it. */
  events: EngineEvent[];
  /** Everything published, transient deltas included. */
  published: EngineEvent[];
  /** `foldDebate` over the persisted log (D352). */
  record: DebateRecord | undefined;
}

export function debateHarness(options: HarnessOptions = {}) {
  const repository = new FakeRepository();
  const bus = createEventBus({
    repository,
    scope: LOCAL_SCOPE,
    pubsub: new InProcessPubSubStub<EngineEvent>(),
  });
  const published: EngineEvent[] = [];
  const subscribed = bus.subscribe((event) => {
    published.push(event);
  });
  const provider = options.provider ?? createFakeDebateProvider();
  const workspace = options.workspace ?? fakeWorkspace(options.files);
  const control: AttachableDebateControl = createDebateControl();
  const abort = new AbortController();

  const router: ModelRouter = {
    resolve: (node) =>
      node.providerId === undefined || node.modelId === undefined
        ? { ok: false, code: 'missing_model', reason: 'no model chosen' }
        : {
            ok: true,
            route: { providerId: node.providerId, modelId: node.modelId, viaFallback: false },
          },
    resolveForBench: () => ({ ok: false, code: 'policy_not_allowed', reason: 'not benched' }),
  };
  const caller = createDebateCaller({
    adapterFor: async () => provider.adapter,
    modelsFor: async () => options.models ?? [],
    runGated: async (_providerId, fn) => fn(),
    router,
  });

  const count = options.debaters ?? 3;
  const maxTokens = options.maxTokens ?? 4096;
  const debaters: DebaterSpec[] = DEBATERS.slice(0, count).map((d, index) => {
    const label = LABELS[index] ?? 'A';
    const stance = options.stances?.[label];
    const reads = options.reads?.[label];
    return {
      nodeId: d.id,
      name: d.name,
      route: {
        providerId: d.providerId,
        modelId: d.modelId,
        routing: { policy: 'fixed', fallbackModelIds: [] },
      },
      timeoutMs: 120_000,
      maxTokens,
      ...(stance === undefined ? {} : { stance }),
      reads: reads ?? [],
    };
  });

  const spec: DebateSpec = {
    runId: RUN_ID,
    workflowId: WORKFLOW_ID,
    debateId: DEBATE_ID,
    hub: {
      nodeId: HUB_ID,
      name: HUB.name,
      route: {
        providerId: HUB.providerId,
        modelId: HUB.modelId,
        routing: { policy: 'fixed', fallbackModelIds: [] },
      },
      timeoutMs: 120_000,
      maxTokens,
    },
    config: { topic: 'Should the cache be Redis?', ...options.config },
    material: options.material ?? 'The service runs on three instances.',
    debaters,
    ...(options.projectFolder === undefined
      ? { projectFolder: PROJECT }
      : { projectFolder: options.projectFolder }),
    signal: abort.signal,
    control,
  };

  async function run(): Promise<HarnessRun> {
    const outcome = await runDebate(spec, {
      bus,
      caller,
      workspace,
      tokenBatchMs: 0,
      ...(options.guardrails === undefined ? {} : { guardrails: options.guardrails }),
      ...(options.budget === undefined ? {} : { budget: options.budget }),
      ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    });
    await subscribed;
    const events = await repository.events.listAfter(LOCAL_SCOPE, 0, { runIds: [RUN_ID] });
    return { outcome, events, published, record: foldDebate(events) };
  }

  return { run, provider, workspace, control, spec, abort, repository };
}

/** Every prompt a provider received, the judge's included. */
export const allPrompts = (provider: FakeDebateProvider): string[] =>
  provider.calls.map((c) => c.prompt);

export const scratchGone = (dir: string): boolean => !existsSync(dir);
