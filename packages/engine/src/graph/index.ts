import { mkdirSync, statSync, accessSync, constants, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EdgeSchema,
  FORMAT_VERSION,
  GraphOpsRequestSchema,
  NodeSchema,
  WorkflowExportSchema,
  derivePorts,
  isConnectionAllowed,
  domainGraphIssues,
  nodeConfigPatchSchema,
  validateLoopConfig,
  validateOrderEdge,
  type CursorQuery,
  type Edge,
  type GraphOp,
  type GraphOpsResponse,
  type Id,
  type ImportNotice,
  type ImportWorkflowResponse,
  type Node,
  type Page,
  type Port,
  type Project,
  type TerminalTrust,
  type ValidationIssue,
  type Workflow,
  type WorkflowExport,
  type WorkflowGraphResponse,
} from '@ace/contracts';

import {
  invalidPath,
  notFound,
  staleVersion,
  unsupportedFormatVersion,
  validationFailed,
} from '../gateway/errors.js';
import { newId } from '../ids.js';
import type { Logger } from '../logging/index.js';
import type { Repository, Scope } from '../ports/index.js';
import { findCycle } from './cycles.js';
import { remapGraph } from './ids.js';
import { validateGraph, type ToolLookup } from './validate.js';

export * from './cycles.js';
export * from './validate.js';
export * from './ids.js';

export interface GraphServiceDeps {
  repository: Repository;
  scope: Scope;
  logger: Logger;
  /** Injected so tests get deterministic timestamps. */
  now?: () => string;
  /** Called after a graph-ops batch commits — the event log and WS hub hook in here. */
  onWorkflowUpdated?: (workflowId: Id, version: number) => Promise<void>;
  /**
   * The tool registry `POST /workflows/:id/validate` checks every agent's enabled tools against
   * (round 4 §2.4, D-069: `tool_not_registered`, and `mcp_server_unreachable` from the stored MCP
   * servers). Absent, validation raises neither — a round 1–3 harness builds the service without it.
   */
  tools?: ToolLookup;
  /**
   * Where a project created without a folder gets one: `<projectsRoot>/<projectId>` [audit E-8].
   * The server passes `<dataDir>/projects`. Absent (a test harness), it is a folder under the OS
   * temp directory — never the process's working directory, which used to scatter project folders
   * across whichever checkout or package the engine happened to start from.
   */
  projectsRoot?: string;
}

export interface GraphService {
  createProject(input: { name: string; folderPath?: string }): Promise<Project>;
  listProjects(page: CursorQuery): Promise<Page<Project>>;
  getProject(id: Id): Promise<Project>;
  renameProject(id: Id, name: string): Promise<Project>;
  /**
   * `PATCH /projects/:id` — the whole patch, not only the name. `maxCostPerRunUsd: null` removes the
   * per-run cap and `undefined` leaves it alone, the way D72 reads a removed budget (FR-GRD-008).
   * `terminal` is the trust level (D301). `checkCommand` and `formatOnSave` are Forge's Run checks
   * and format-on-save (D299 Phase 4); `checkCommand: null` removes the command.
   */
  updateProject(
    id: Id,
    patch: {
      name?: string;
      maxCostPerRunUsd?: number | null;
      terminal?: TerminalTrust;
      checkCommand?: string | null;
      formatOnSave?: boolean;
    },
  ): Promise<Project>;
  deleteProject(id: Id): Promise<void>;
  openProject(id: Id): Promise<Project>;

  createWorkflow(projectId: Id, name: string): Promise<Workflow>;
  listWorkflows(projectId: Id, page: CursorQuery): Promise<Page<Workflow>>;
  getWorkflowGraph(id: Id): Promise<WorkflowGraphResponse>;
  renameWorkflow(id: Id, name: string): Promise<Workflow>;
  deleteWorkflow(id: Id): Promise<void>;
  duplicateWorkflow(id: Id): Promise<WorkflowGraphResponse>;

  applyGraphOps(workflowId: Id, request: unknown): Promise<GraphOpsResponse>;
  validateWorkflow(id: Id): Promise<ValidationIssue[]>;
  exportWorkflow(id: Id): Promise<WorkflowExport>;
  /** [audit S-1] With a `notice` when the import cleared commands or lowered workspace access. */
  importWorkflow(projectId: Id, raw: unknown): Promise<ImportWorkflowResponse>;
}

/**
 * FR-PRJ-003 / TC-PRJ-002: the folder must exist and be writable, and a refusal names the path so
 * the user can fix it (NFR-USE-03). The probe is a real write, because a directory can be listable
 * and still refuse new files.
 */
function ensureWritableFolder(folderPath: string): void {
  try {
    mkdirSync(folderPath, { recursive: true });
  } catch (error) {
    throw invalidPath(folderPath, `the folder could not be created (${(error as Error).message})`);
  }

  let stats;
  try {
    stats = statSync(folderPath);
  } catch (error) {
    throw invalidPath(folderPath, `the folder could not be read (${(error as Error).message})`);
  }

  if (!stats.isDirectory()) {
    throw invalidPath(folderPath, 'it is a file, not a folder');
  }

  try {
    accessSync(folderPath, constants.W_OK);
    const probe = join(folderPath, `.ace-write-probe-${newId()}`);
    writeFileSync(probe, '');
    unlinkSync(probe);
  } catch (error) {
    throw invalidPath(folderPath, `it is not writable (${(error as Error).message})`);
  }
}

export function createGraphService(deps: GraphServiceDeps): GraphService {
  const { repository, scope } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const projectsRoot = deps.projectsRoot ?? join(tmpdir(), 'ace-projects');

  async function requireWorkflow(id: Id): Promise<Workflow> {
    const workflow = await repository.workflows.get(scope, id);
    if (workflow === null) throw notFound(`Workflow ${id}`);
    return workflow;
  }

  async function loadGraph(workflowId: Id): Promise<{ nodes: Node[]; edges: Edge[] }> {
    return {
      nodes: await repository.nodes.listByWorkflow(scope, workflowId),
      edges: await repository.edges.listByWorkflow(scope, workflowId),
    };
  }

  return {
    /* ---------------------------------------------------------------- projects */

    async createProject({ name, folderPath }) {
      const id = newId();
      // [audit E-8] A project that already exists keeps the folder it stored; only a new one without
      // a folder of its own lands under `projectsRoot`.
      const resolved = folderPath ?? join(projectsRoot, id);
      ensureWritableFolder(resolved);

      const timestamp = now();
      return repository.projects.create(scope, {
        id,
        name,
        folderPath: resolved,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    },

    listProjects: (page) => repository.projects.list(scope, page),

    async getProject(id) {
      const project = await repository.projects.get(scope, id);
      if (project === null) throw notFound(`Project ${id}`);
      return project;
    },

    async updateProject(id, patch) {
      const updated = await repository.projects.update(scope, id, {
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.maxCostPerRunUsd === undefined ? {} : { maxCostPerRunUsd: patch.maxCostPerRunUsd }),
        ...(patch.terminal === undefined ? {} : { terminal: patch.terminal }),
        ...(patch.checkCommand === undefined ? {} : { checkCommand: patch.checkCommand }),
        ...(patch.formatOnSave === undefined ? {} : { formatOnSave: patch.formatOnSave }),
        updatedAt: now(),
      });
      if (updated === null) throw notFound(`Project ${id}`);
      return updated;
    },

    async renameProject(id, name) {
      const project = await repository.projects.update(scope, id, {
        name,
        updatedAt: now(),
      });
      if (project === null) throw notFound(`Project ${id}`);
      return project;
    },

    async deleteProject(id) {
      if (!(await repository.projects.delete(scope, id))) throw notFound(`Project ${id}`);
      // [audit U-4] FR-PRJ-004 reopens the last project at launch; a deleted one is forgotten, or
      // "/" keeps sending the person to a project that is gone. `undefined` overwrites the stored
      // id in the settings patch, which is how both stores clear an optional setting.
      if ((await repository.settings.get(scope)).lastProjectId === id) {
        await repository.settings.update(scope, { lastProjectId: undefined });
      }
    },

    /** FR-PRJ-004: opening a project is what makes it the one reopened next launch. */
    async openProject(id) {
      const timestamp = now();
      const project = await repository.projects.update(scope, id, {
        lastOpenedAt: timestamp,
        updatedAt: timestamp,
      });
      if (project === null) throw notFound(`Project ${id}`);

      await repository.settings.update(scope, { lastProjectId: id });
      return project;
    },

    /* --------------------------------------------------------------- workflows */

    async createWorkflow(projectId, name) {
      await this.getProject(projectId);

      const timestamp = now();
      return repository.workflows.create(scope, {
        id: newId(),
        projectId,
        name,
        version: 0,
        formatVersion: FORMAT_VERSION,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    },

    async listWorkflows(projectId, page) {
      await this.getProject(projectId);
      return repository.workflows.listByProject(scope, projectId, page);
    },

    async getWorkflowGraph(id) {
      const workflow = await requireWorkflow(id);
      return { workflow, ...(await loadGraph(id)) };
    },

    /** A rename is not a graph edit, so it leaves `version` alone (§2.6 owns that counter). */
    async renameWorkflow(id, name) {
      const workflow = await repository.workflows.update(scope, id, {
        name,
        updatedAt: now(),
      });
      if (workflow === null) throw notFound(`Workflow ${id}`);
      return workflow;
    },

    async deleteWorkflow(id) {
      await requireWorkflow(id);
      await repository.transaction(async (tx) => {
        await tx.edges.deleteByWorkflow(scope, id);
        await tx.nodes.deleteByWorkflow(scope, id);
        await tx.workflows.delete(scope, id);
      });
    },

    async duplicateWorkflow(id) {
      const source = await requireWorkflow(id);
      const { nodes, edges } = await loadGraph(id);

      const timestamp = now();
      const copy: Workflow = {
        id: newId(),
        projectId: source.projectId,
        name: `${source.name} copy`,
        version: 0,
        formatVersion: FORMAT_VERSION,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const remapped = remapGraph(nodes, edges, copy.id);

      return repository.transaction(async (tx) => {
        await tx.workflows.create(scope, copy);
        for (const node of remapped.nodes) await tx.nodes.insert(scope, node);
        for (const edge of remapped.edges) await tx.edges.insert(scope, edge);
        return { workflow: copy, nodes: remapped.nodes, edges: remapped.edges };
      });
    },

    /* -------------------------------------------------------------- graph-ops */

    async applyGraphOps(workflowId, raw) {
      const request = GraphOpsRequestSchema.parse(raw);
      const workflow = await requireWorkflow(workflowId);

      // BR-01: the engine owns the truth, so a client writing against an older version is told to
      // refetch rather than having its edits silently reordered on top (§2.6, TC-WF-005).
      if (request.baseVersion !== workflow.version) throw staleVersion(workflow.version);

      const { nodes, edges } = await loadGraph(workflowId);
      const nodeById = new Map(nodes.map((node) => [node.id, node]));
      const edgeById = new Map(edges.map((edge) => [edge.id, edge]));

      const result = await repository.transaction(async (tx) => {
        for (const op of request.ops) {
          await applyOp(op, { tx, scope, workflowId, nodeById, edgeById });
        }

        // The cycle check runs once, on the finished graph: a batch is allowed to pass through an
        // intermediate shape, only its result has to be acyclic (FR-CON-003).
        const cycle = findCycle([...edgeById.values()]);
        if (cycle !== null) {
          throw validationFailed('That edge would close a cycle.', [
            {
              severity: 'error',
              code: 'cycle',
              message: `These nodes form a cycle: ${cycle.join(' -> ')}. Only a loop edge may close one.`,
            },
          ]);
        }

        // D304, D308: handles stay unique and unreserved, and at most one Agent is the Brain.
        const domainIssues = domainGraphIssues([...nodeById.values()]);
        const [firstIssue] = domainIssues;
        if (firstIssue !== undefined) throw validationFailed(firstIssue.message, domainIssues);

        const version = workflow.version + 1;
        await tx.workflows.update(scope, workflowId, {
          version,
          updatedAt: now(),
        });

        return {
          version,
          nodes: [...nodeById.values()].sort((a, b) => a.id.localeCompare(b.id)),
          edges: [...edgeById.values()].sort((a, b) => a.id.localeCompare(b.id)),
        };
      });

      await deps.onWorkflowUpdated?.(workflowId, result.version);
      return result;
    },

    async validateWorkflow(id) {
      await requireWorkflow(id);
      const { nodes, edges } = await loadGraph(id);
      if (deps.tools === undefined) return validateGraph(nodes, edges);
      const mcpServers = (await repository.mcpServers?.list(scope)) ?? [];
      return validateGraph(nodes, edges, { tools: deps.tools, mcpServers });
    },

    /* ---------------------------------------------------------- export/import */

    async exportWorkflow(id) {
      const workflow = await requireWorkflow(id);
      const { nodes, edges } = await loadGraph(id);

      // FR-WF-007: provider ids are kept, keys cannot be here — no field of the export holds one,
      // and storage refuses to persist one in the first place (BR-07).
      return WorkflowExportSchema.parse({
        formatVersion: FORMAT_VERSION,
        exportedAt: now(),
        name: workflow.name,
        nodes,
        edges,
      });
    },

    async importWorkflow(projectId, raw) {
      await this.getProject(projectId);

      // The version is checked before the body is parsed, so an old file gets the specific
      // "unsupported format version" answer rather than a generic schema error (TC-WF-008).
      const found = (raw as { formatVersion?: unknown } | null)?.formatVersion;
      if (found !== FORMAT_VERSION) throw unsupportedFormatVersion(found, FORMAT_VERSION);

      const parsed = WorkflowExportSchema.parse(raw);

      const timestamp = now();
      const workflow: Workflow = {
        id: newId(),
        projectId,
        name: parsed.name,
        version: 0,
        formatVersion: FORMAT_VERSION,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const remapped = remapGraph(parsed.nodes, parsed.edges, workflow.id);
      const { nodes, notice } = withoutImportedTrust(remapped.nodes);

      return repository.transaction(async (tx) => {
        await tx.workflows.create(scope, workflow);
        for (const node of nodes) await tx.nodes.insert(scope, node);
        for (const edge of remapped.edges) await tx.edges.insert(scope, edge);
        return {
          workflow,
          nodes,
          edges: remapped.edges,
          ...(notice === undefined ? {} : { notice }),
        };
      });
    },
  };
}

/**
 * [audit S-1] A workflow file is someone else's until the person says otherwise. Its nodes came in
 * with their workspace access and allow-listed commands, and a run seeds its allowlist from them
 * (D376), so importing a file and pressing Run executed its commands with no approval card. On
 * import, every node's allow-listed commands are cleared and access above `edit_files` is lowered
 * to it: each command asks again, and running commands at all is the person's choice to make back.
 * The web domains a node may fetch from are kept — they only widen what a tool may read — and
 * listed in the notice for the person to look over.
 */
function withoutImportedTrust(nodes: readonly Node[]): { nodes: Node[]; notice?: ImportNotice } {
  const commandsCleared: Id[] = [];
  const accessLowered: Id[] = [];
  const domains = new Set<string>();

  const kept = nodes.map((node): Node => {
    if (node.kind !== 'agent') return node;
    for (const domain of node.config.tools.allowedDomains) domains.add(domain);
    const workspace = node.config.workspace;
    if (workspace === undefined) return node;
    const lower = workspace.access === 'edit_commands';
    const clear = workspace.allowedCommands.length > 0;
    if (!lower && !clear) return node;
    if (clear) commandsCleared.push(node.id);
    if (lower) accessLowered.push(node.id);
    return {
      ...node,
      config: {
        ...node.config,
        workspace: {
          ...workspace,
          access: lower ? 'edit_files' : workspace.access,
          allowedCommands: [],
        },
      },
    };
  });

  if (commandsCleared.length === 0 && accessLowered.length === 0 && domains.size === 0) {
    return { nodes: kept };
  }
  const nodesWord = (count: number): string => (count === 1 ? '1 node' : `${count} nodes`);
  const said: string[] = [];
  if (commandsCleared.length > 0) {
    said.push(`Cleared the allowed commands of ${nodesWord(commandsCleared.length)}.`);
  }
  if (accessLowered.length > 0) {
    said.push(
      `${nodesWord(accessLowered.length)} can edit files but no longer run commands — turn that back on in the node if you trust this workflow.`,
    );
  }
  if (domains.size > 0) {
    said.push(
      `Its nodes may fetch from ${[...domains].join(', ')} — check these before you run it.`,
    );
  }
  return {
    nodes: kept,
    notice: {
      message: said.join(' '),
      commandsCleared,
      accessLowered,
      allowedDomains: [...domains],
    },
  };
}

/* -------------------------------------------------------------------------- */
/* One operation                                                               */
/* -------------------------------------------------------------------------- */

interface OpContext {
  tx: Repository;
  scope: Scope;
  workflowId: Id;
  nodeById: Map<Id, Node>;
  edgeById: Map<Id, Edge>;
}

/** Re-derive a node's ports from its config — the client never gets to choose them (FR-NODE-006). */
function withDerivedPorts(node: Node): Node {
  const ports = derivePorts({
    id: node.id,
    kind: node.kind,
    config: node.config,
  } as Parameters<typeof derivePorts>[0]);
  return { ...node, inputs: ports.inputs, outputs: ports.outputs } as Node;
}

function findPort(nodeById: Map<Id, Node>, portIdValue: string): Port | undefined {
  for (const node of nodeById.values()) {
    const port = [...node.inputs, ...node.outputs].find((p) => p.id === portIdValue);
    if (port !== undefined) return port;
  }
  return undefined;
}

/**
 * §2.6: *any* invalid op is a 400 `validation_failed` and the whole batch is discarded. An op that
 * names a node, edge or port this workflow does not have is such an op — a 404 would say "the
 * workflow is gone", which is a different thing and would tell a client to stop retrying.
 */
function unknownRef(what: string, id: string) {
  return validationFailed(`${what} ${id} is not part of this workflow.`, [
    {
      severity: 'error',
      code: 'validation_failed',
      message: `${what} ${id} is not part of this workflow.`,
    },
  ]);
}

/**
 * A loop edge as it would stand in the finished graph, or a 400 `validation_failed` naming the rule
 * it broke (§2.4, FR-CON-007, TC-CON-007).
 *
 * The check runs against the batch's graph so far *including this edge*, so `loop_bodies_overlap`
 * and `loop_target_not_upstream` are judged on the shape the client is actually asking for. A
 * `maxIterations` of 0 or 51 comes back through `invalid_loop_config`, as a 400 and not a 500 —
 * `LoopConfigSchema` accepts it inside `Edge` on the way in so an edge stored by an older engine
 * still loads (D73), which makes this the only place the range is enforced.
 */
function requireValidLoop(
  edge: Edge,
  nodeById: Map<Id, Node>,
  edgeById: Map<Id, Edge>,
): void {
  const check = validateLoopConfig(edge, {
    nodes: [...nodeById.values()],
    edges: [...edgeById.values()].map((other) => (other.id === edge.id ? edge : other)).concat(
      edgeById.has(edge.id) ? [] : [edge],
    ),
  });
  if (check.ok) return;

  throw validationFailed(check.reason, [
    {
      severity: 'error',
      code: check.code,
      message: check.reason,
      edgeId: edge.id,
    } satisfies ValidationIssue,
  ]);
}

async function applyOp(op: GraphOp, ctx: OpContext): Promise<void> {
  const { tx, scope, workflowId, nodeById, edgeById } = ctx;

  switch (op.op) {
    case 'add_node': {
      const node = withDerivedPorts(NodeSchema.parse({ ...op.node, workflowId }));
      nodeById.set(node.id, node);
      await tx.nodes.insert(scope, node);
      return;
    }

    case 'update_node': {
      const current = nodeById.get(op.nodeId);
      if (current === undefined) throw unknownRef('Node', op.nodeId);

      // The patch is validated against the schema of *this* node's kind — the request-level union
      // cannot do that, because §2.6's patch carries no discriminator.
      const configPatch =
        op.patch.config === undefined
          ? {}
          : nodeConfigPatchSchema(current.kind).parse(op.patch.config);

      // D308: a handle is set, or `null` takes the node back to its default (a slug of its name).
      const { handle: _previousHandle, ...withoutHandle } = current;
      const handle = op.patch.handle === undefined ? current.handle : (op.patch.handle ?? undefined);
      const merged = NodeSchema.parse({
        ...withoutHandle,
        ...(handle === undefined ? {} : { handle }),
        ...(op.patch.name === undefined ? {} : { name: op.patch.name }),
        config: { ...current.config, ...configPatch },
      });
      const node = withDerivedPorts(merged);

      nodeById.set(node.id, node);
      await tx.nodes.update(scope, node);
      return;
    }

    case 'move_node': {
      const current = nodeById.get(op.nodeId);
      if (current === undefined) throw unknownRef('Node', op.nodeId);

      const node = { ...current, position: op.position } as Node;
      nodeById.set(node.id, node);
      await tx.nodes.update(scope, node);
      return;
    }

    case 'delete_node': {
      if (!nodeById.has(op.nodeId)) throw unknownRef('Node', op.nodeId);

      // §2.6: the engine deletes the node's edges with it, so no edge is left dangling.
      for (const [id, edge] of edgeById) {
        if (edge.from.nodeId === op.nodeId || edge.to.nodeId === op.nodeId) edgeById.delete(id);
      }
      nodeById.delete(op.nodeId);

      await tx.edges.deleteByNode(scope, op.nodeId);
      await tx.nodes.delete(scope, op.nodeId);
      return;
    }

    case 'add_edge': {
      const edge = EdgeSchema.parse({ ...op.edge, workflowId });

      // D373: an order edge ("run after") names two nodes on pseudo ports and carries no data, so
      // it has no ports to find and no types to check — only its own rules. The batch-end cycle
      // check walks it like a data edge.
      if (edge.kind === 'order') {
        requireValidLoop(edge, nodeById, edgeById);
        const check = validateOrderEdge(edge, {
          nodes: [...nodeById.values()],
          edges: [...edgeById.values()],
        });
        if (!check.ok) {
          throw validationFailed(check.reason, [
            {
              severity: 'error',
              code: check.code,
              message: check.reason,
              edgeId: edge.id,
            } satisfies ValidationIssue,
          ]);
        }
        edgeById.set(edge.id, edge);
        await tx.edges.insert(scope, edge);
        return;
      }

      const source = findPort(nodeById, edge.from.portId);
      const target = findPort(nodeById, edge.to.portId);
      if (source === undefined) throw unknownRef('Port', edge.from.portId);
      if (target === undefined) throw unknownRef('Port', edge.to.portId);

      // Every edge goes past the loop rules, not only the loop ones: a *data* edge carrying a loop
      // config is refused by name (`loop_config_on_data_edge`) rather than by whatever its types
      // happen to say, so the client is told what it actually got wrong (§2.4, NFR-USE-03).
      requireValidLoop(edge, nodeById, edgeById);

      // A loop edge is not a data connection (D73): its target's inputs are already fed and it
      // re-queues that target instead, so `isConnectionAllowed` does not apply to it.
      if (edge.kind === 'loop') {
        edgeById.set(edge.id, edge);
        await tx.edges.insert(scope, edge);
        return;
      }

      // Loop edges do not occupy an input port, so they are not counted against it (D73).
      const existingIntoTarget = [...edgeById.values()].filter(
        (e) => e.kind === 'data' && e.to.portId === edge.to.portId,
      ).length;

      const check = isConnectionAllowed(source, target, existingIntoTarget);
      if (!check.ok) {
        throw validationFailed(check.reason, [
          {
            severity: 'error',
            code: check.code,
            message: check.reason,
            edgeId: edge.id,
          } satisfies ValidationIssue,
        ]);
      }

      edgeById.set(edge.id, edge);
      await tx.edges.insert(scope, edge);
      return;
    }

    case 'update_edge': {
      const current = edgeById.get(op.edgeId);
      if (current === undefined) throw unknownRef('Edge', op.edgeId);
      // `EdgePatch` carries nothing but `loop`, so a patch without one has nothing to apply.
      if (op.patch.loop === undefined) return;

      const updated: Edge = { ...current, loop: op.patch.loop };
      requireValidLoop(updated, nodeById, edgeById);

      edgeById.set(updated.id, updated);
      await tx.edges.update(scope, updated);
      return;
    }

    case 'delete_edge': {
      if (!edgeById.has(op.edgeId)) throw unknownRef('Edge', op.edgeId);
      edgeById.delete(op.edgeId);
      await tx.edges.delete(scope, op.edgeId);
      return;
    }
  }
}
