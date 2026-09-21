import {
  DEFAULT_ALLOWED_ORIGINS,
  DEFAULT_CONCURRENCY,
  DEFAULT_THEME,
  type Edge,
  type Node,
  type Project,
  type Settings,
  type Workflow,
  type WsWorkflowUpdatedPayload,
} from '@ace/contracts';

import { newId } from '../lib/ulid';

/** A persisted event, as the engine keeps it in `events` (§2.9): global monotonic seq. */
export interface MockEvent {
  seq: number;
  type: 'workflow.updated';
  payload: WsWorkflowUpdatedPayload;
}

interface Snapshot {
  settings: Settings;
  projects: Project[];
  workflows: Workflow[];
  nodes: Record<string, Node[]>;
  edges: Record<string, Edge[]>;
  events: MockEvent[];
  seq: number;
}

export interface MockDbOptions {
  /** Persist to localStorage so every tab of the same origin shares one engine. */
  persist?: boolean;
  storageKey?: string;
}

export const MOCK_STORAGE_KEY = 'ace.mock.db';

/** Paths the mock engine treats as unwritable (FR-PRJ-003, TC-PRJ-002). */
export function isUnwritablePath(path: string): boolean {
  return /readonly|unwritable/i.test(path);
}

const now = (): string => new Date().toISOString();

function defaultSettings(): Settings {
  return {
    dataDir: '/mock/.ace',
    concurrency: DEFAULT_CONCURRENCY,
    theme: DEFAULT_THEME,
    onboardingCompleted: false,
    allowedOrigins: [...DEFAULT_ALLOWED_ORIGINS],
  };
}

function emptySnapshot(): Snapshot {
  return {
    settings: defaultSettings(),
    projects: [],
    workflows: [],
    nodes: {},
    edges: {},
    events: [],
    seq: 0,
  };
}

/**
 * The in-memory engine behind the MSW handlers (round 1 §5 step 10). It is deliberately dumb
 * storage; every rule (versions, validation, cycles) lives in `handlers.ts` so the handlers read
 * like the endpoint table in §2.8.
 */
export class MockDb {
  private state: Snapshot = emptySnapshot();
  private readonly persist: boolean;
  private readonly storageKey: string;

  constructor(options: MockDbOptions = {}) {
    this.persist = options.persist ?? true;
    this.storageKey = options.storageKey ?? MOCK_STORAGE_KEY;
    this.load();
  }

  /* ---------------------------------------------------------------- persistence */

  /** Re-read the shared snapshot: another tab may have written since. */
  load(): void {
    if (!this.persist) return;
    try {
      const raw = globalThis.localStorage?.getItem(this.storageKey);
      if (raw) this.state = { ...emptySnapshot(), ...(JSON.parse(raw) as Snapshot) };
    } catch {
      this.state = emptySnapshot();
    }
  }

  save(): void {
    if (!this.persist) return;
    try {
      globalThis.localStorage?.setItem(this.storageKey, JSON.stringify(this.state));
    } catch {
      /* storage full or unavailable: the in-memory copy still serves this tab */
    }
  }

  reset(): void {
    this.state = emptySnapshot();
    this.save();
  }

  /* ---------------------------------------------------------------- settings */

  get settings(): Settings {
    return this.state.settings;
  }

  patchSettings(patch: Partial<Settings>): Settings {
    this.state.settings = { ...this.state.settings, ...patch };
    this.save();
    return this.state.settings;
  }

  /* ---------------------------------------------------------------- projects */

  listProjects(): Project[] {
    return [...this.state.projects];
  }

  getProject(id: string): Project | undefined {
    return this.state.projects.find((p) => p.id === id);
  }

  createProject(input: { name: string; folderPath?: string }): Project {
    const ts = now();
    const project: Project = {
      id: newId(),
      name: input.name,
      folderPath: input.folderPath ?? `/mock/projects/${input.name.replace(/[^\w-]+/g, '-')}`,
      createdAt: ts,
      updatedAt: ts,
    };
    this.state.projects.push(project);
    this.save();
    return project;
  }

  updateProject(id: string, patch: { name?: string; lastOpenedAt?: string }): Project | undefined {
    const project = this.getProject(id);
    if (!project) return undefined;
    Object.assign(project, patch, { updatedAt: now() });
    this.save();
    return project;
  }

  deleteProject(id: string): boolean {
    const before = this.state.projects.length;
    this.state.projects = this.state.projects.filter((p) => p.id !== id);
    for (const wf of this.state.workflows.filter((w) => w.projectId === id))
      this.deleteWorkflow(wf.id);
    if (this.state.settings.lastProjectId === id) delete this.state.settings.lastProjectId;
    this.save();
    return this.state.projects.length < before;
  }

  /* ---------------------------------------------------------------- workflows */

  listWorkflows(projectId: string): Workflow[] {
    return this.state.workflows.filter((w) => w.projectId === projectId);
  }

  getWorkflow(id: string): Workflow | undefined {
    return this.state.workflows.find((w) => w.id === id);
  }

  createWorkflow(projectId: string, name: string): Workflow {
    const ts = now();
    const workflow: Workflow = {
      id: newId(),
      projectId,
      name,
      version: 0,
      formatVersion: 1,
      createdAt: ts,
      updatedAt: ts,
    };
    this.state.workflows.push(workflow);
    this.state.nodes[workflow.id] = [];
    this.state.edges[workflow.id] = [];
    this.save();
    return workflow;
  }

  updateWorkflow(id: string, patch: { name?: string }): Workflow | undefined {
    const workflow = this.getWorkflow(id);
    if (!workflow) return undefined;
    Object.assign(workflow, patch, { updatedAt: now() });
    this.save();
    return workflow;
  }

  deleteWorkflow(id: string): boolean {
    const before = this.state.workflows.length;
    this.state.workflows = this.state.workflows.filter((w) => w.id !== id);
    delete this.state.nodes[id];
    delete this.state.edges[id];
    this.save();
    return this.state.workflows.length < before;
  }

  nodesOf(workflowId: string): Node[] {
    return this.state.nodes[workflowId] ?? [];
  }

  edgesOf(workflowId: string): Edge[] {
    return this.state.edges[workflowId] ?? [];
  }

  /** Commit a new graph: version + 1, and one `workflow.updated` event with the next seq. */
  commitGraph(workflowId: string, nodes: Node[], edges: Edge[]): Workflow {
    const workflow = this.getWorkflow(workflowId);
    if (!workflow) throw new Error(`unknown workflow ${workflowId}`);
    workflow.version += 1;
    workflow.updatedAt = now();
    this.state.nodes[workflowId] = nodes;
    this.state.edges[workflowId] = edges;
    this.state.seq += 1;
    this.state.events.push({
      seq: this.state.seq,
      type: 'workflow.updated',
      payload: { workflowId, version: workflow.version },
    });
    this.save();
    return workflow;
  }

  /* ---------------------------------------------------------------- events */

  get seq(): number {
    return this.state.seq;
  }

  get events(): readonly MockEvent[] {
    return this.state.events;
  }

  eventsAfter(afterSeq: number): MockEvent[] {
    return this.state.events.filter((e) => e.seq > afterSeq);
  }
}
