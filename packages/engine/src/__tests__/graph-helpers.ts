import type { DataType, Edge, GraphOp, Node, Project, Workflow } from '@ace/contracts';

import { createEngineApp, type EngineApp } from '../gateway/index.js';
import { createGraphService } from '../graph/index.js';
import { newId } from '../ids.js';
import { createLogger } from '../logging/index.js';
import { LOCAL_SCOPE, type Auth, type Repository, type Scope } from '../ports/index.js';
import { FakeRepository } from './fake-repository.js';

export const TOKEN = 'a'.repeat(64);
export const AUTH = { Authorization: `Bearer ${TOKEN}` };
export const JSON_HEADERS = { ...AUTH, 'content-type': 'application/json' };

const auth: Auth = {
  verifyToken: async (_scope: Scope, token: string | undefined) => token === TOKEN,
};

export interface Harness {
  app: EngineApp;
  repository: Repository;
}

export function createHarness(repository: Repository = new FakeRepository()): Harness {
  const logger = createLogger({ level: 'silent', destination: { write: () => undefined } });
  const graph = createGraphService({ repository, scope: LOCAL_SCOPE, logger });

  const app = createEngineApp({
    repository,
    auth,
    logger,
    scope: LOCAL_SCOPE,
    version: '0.1.0',
    graph,
    selfOrigins: ['http://127.0.0.1:4747'],
  });

  return { app, repository };
}

export async function post(app: EngineApp, path: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: JSON_HEADERS,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function patch(app: EngineApp, path: string, body: unknown): Promise<Response> {
  return app.request(path, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) });
}

export async function get(app: EngineApp, path: string): Promise<Response> {
  return app.request(path, { headers: AUTH });
}

export async function del(app: EngineApp, path: string): Promise<Response> {
  return app.request(path, { method: 'DELETE', headers: AUTH });
}

export async function createProject(app: EngineApp, folderPath: string): Promise<Project> {
  const response = await post(app, '/api/v1/projects', { name: 'Demo', folderPath });
  if (response.status !== 201 && response.status !== 200) {
    throw new Error(`createProject failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as Project;
}

export async function createWorkflow(app: EngineApp, projectId: string): Promise<Workflow> {
  const response = await post(app, `/api/v1/projects/${projectId}/workflows`, { name: 'Flow 1' });
  return (await response.json()) as Workflow;
}

export async function graphOps(
  app: EngineApp,
  workflowId: string,
  baseVersion: number,
  ops: GraphOp[],
): Promise<Response> {
  return post(app, `/api/v1/workflows/${workflowId}/graph-ops`, { baseVersion, ops });
}

/* -------------------------------------------------------------------------- */
/* Node builders — ports are re-derived server-side, so these send empty ones.  */
/* -------------------------------------------------------------------------- */

function base(workflowId: string, id: string, name: string) {
  return { id, workflowId, name, position: { x: 0, y: 0 }, inputs: [], outputs: [] };
}

export function inputNode(
  workflowId: string,
  outputTypes: DataType[] = ['text'],
  id = newId(),
): Node {
  return {
    ...base(workflowId, id, 'Input'),
    kind: 'input',
    config: { artifactIds: [], outputTypes },
  };
}

export function outputNode(workflowId: string, id = newId()): Node {
  return { ...base(workflowId, id, 'Output'), kind: 'output', config: {} };
}

export function agentNode(
  workflowId: string,
  inputTypes: DataType[] = ['text'],
  outputTypes: DataType[] = ['text'],
  id = newId(),
): Node {
  return {
    ...base(workflowId, id, 'Agent'),
    kind: 'agent',
    config: {
      instructions: 'Summarise',
      inputTypes,
      outputTypes,
      routing: { policy: 'fixed', fallbackModelIds: [] },
      execution: { temperature: 0.7, maxTokens: 4096, timeoutMs: 120_000, retries: 2 },
      contextPolicy: { budgetTokens: 4000 },
      tools: { enabled: [], maxToolCalls: 10, allowedDomains: [] },
      knowledgeBaseIds: [],
      memory: { enabled: false },
      skillIds: [],
    },
  };
}

export function mergeNode(workflowId: string, id = newId()): Node {
  return { ...base(workflowId, id, 'Merge'), kind: 'merge', config: { mode: 'all' } };
}

export function edgeBetween(
  workflowId: string,
  fromNodeId: string,
  fromPort: string,
  toNodeId: string,
  toPort: string,
  id = newId(),
): Edge {
  return {
    id,
    workflowId,
    kind: 'data',
    from: { nodeId: fromNodeId, portId: `${fromNodeId}:out:${fromPort}` },
    to: { nodeId: toNodeId, portId: `${toNodeId}:in:${toPort}` },
  };
}

export const addNode = (node: Node): GraphOp => ({ op: 'add_node', node });
export const addEdge = (edge: Edge): GraphOp => ({ op: 'add_edge', edge });
