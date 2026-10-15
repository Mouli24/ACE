import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  FORMAT_VERSION,
  derivePorts,
  type Edge,
  type Node,
  type Provider,
  type Run,
  type RunSummary,
  type WorkflowExport,
} from '@ace/contracts';
import { expect as baseExpect, type Locator, type Page } from '@playwright/test';

/**
 * Shared seeding and page helpers for the product-gaps red tests (`docs/team-prompts/
 * product-gaps-fix-prompt.md`, Phase 0 item 5). The real UI — the production build served by
 * `vite preview` — against the real engine on a temp data dir with the mock provider, as every
 * other acceptance suite (`round-N/arhant-tests-mouli.e2e.ts`, `domain/domain.e2e.ts`).
 *
 * Expectations wait 5 s, not Playwright's default: a red test that looks for a control the UI
 * does not have yet should fail fast, on that control, and the file should run quickly.
 */
export const expect = baseExpect.configure({ timeout: 5_000 });

/**
 * Every test here is red until its PG item lands: `test.fail(NOT_BUILT, '<item>: …')`. Set
 * `PG_PROVE_RED=1` to run them as ordinary tests and read the assertion each one fails on — the
 * user's symptom, never a setup step (Gate 0). When an item's fix lands, delete its `test.fail`.
 */
export const NOT_BUILT = process.env['PG_PROVE_RED'] !== '1';

export interface EngineHandle {
  url: string;
  wsUrl: string;
  token: string;
  dataDir: string;
  controlUrl: string;
  controlToken: string;
}

/** `helpers/start-for-playwright.ts` writes the engine's address and token here. */
export function engine(): EngineHandle {
  const handleFile = fileURLToPath(new URL('../.playwright-engine.json', import.meta.url));
  return JSON.parse(readFileSync(handleFile, 'utf8')) as EngineHandle;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { url, token } = engine();
  const response = await fetch(`${url}/api/v1${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${response.status} ${text}`);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

/** The harness's own lever (`start-for-playwright.ts`): restart the engine on the same data dir. */
export async function restartEngine(): Promise<EngineHandle> {
  const { controlUrl, controlToken } = engine();
  const response = await fetch(`${controlUrl}/engine/restart`, {
    method: 'POST',
    headers: { authorization: `Bearer ${controlToken}` },
  });
  if (!response.ok) throw new Error(`engine restart → ${response.status} ${await response.text()}`);
  return (await response.json()) as EngineHandle;
}

/** A mock provider with its catalogue fetched, one per name (a failing model gets its own). */
export async function mockProvider(name = 'PG mock'): Promise<string> {
  const { items } = await api<{ items: Provider[] }>('/providers?limit=500');
  const known = items.find((provider) => provider.type === 'mock' && provider.name === name);
  if (known !== undefined) return known.id;
  const created = await api<Provider>('/providers', {
    method: 'POST',
    body: JSON.stringify({ type: 'mock', name }),
  });
  await api(`/providers/${created.id}/refresh-models`, { method: 'POST' });
  return created.id;
}

let seq = 0;
export async function newProject(label: string, folderPath?: string): Promise<string> {
  seq += 1;
  const project = await api<{ id: string }>('/projects', {
    method: 'POST',
    body: JSON.stringify({
      name: `pg-${label}-${Date.now().toString(36)}-${seq}`,
      ...(folderPath === undefined ? {} : { folderPath }),
    }),
  });
  return project.id;
}

export interface AgentSpec {
  name: string;
  /** Omit for a node with no provider at all; a string for a given (possibly unknown) id. */
  providerId?: string;
  modelId?: string;
  instructions?: string;
  inputTypes?: string[];
  outputTypes?: string[];
  brain?: boolean;
  config?: Record<string, unknown>;
}

export interface Seeded {
  projectId: string;
  workflowId: string;
  nodes: Node[];
  byName(name: string): Node;
}

/**
 * A workflow of Agents laid out left to right, imported through the engine (fresh ids). `edges`
 * names pairs of nodes joined output → input by a data edge.
 */
export async function seedAgents(
  label: string,
  agents: AgentSpec[],
  options: { edges?: Array<[string, string]>; projectId?: string } = {},
): Promise<Seeded> {
  const projectId = options.projectId ?? (await newProject(label));
  const workflowId = '01PG0000000000000000000WF0';
  const nodes: Node[] = agents.map((spec, index) => {
    const draft = {
      id: `01PG0000000000000000000N${String(index + 1).padStart(2, '0')}`,
      workflowId,
      kind: 'agent' as const,
      name: spec.name,
      position: { x: index * 420, y: 120 },
      config: {
        ...(spec.providerId === undefined ? {} : { providerId: spec.providerId }),
        ...(spec.modelId === undefined ? {} : { modelId: spec.modelId }),
        instructions: spec.instructions ?? `Act as the ${spec.name}.`,
        inputTypes: spec.inputTypes ?? ['text'],
        outputTypes: spec.outputTypes ?? ['text'],
        ...(spec.brain === true ? { brain: true } : {}),
        ...(spec.config ?? {}),
      },
    };
    return {
      ...draft,
      ...derivePorts(draft as unknown as Parameters<typeof derivePorts>[0]),
    } as Node;
  });
  const find = (name: string): Node => {
    const node = nodes.find((each) => each.name === name);
    if (node === undefined) throw new Error(`no node named ${name}`);
    return node;
  };
  const edges: Edge[] = (options.edges ?? []).map(([from, to], index) => ({
    id: `01PG000000000000000000ED${String(index + 1).padStart(2, '0')}`,
    workflowId,
    kind: 'data',
    from: { nodeId: find(from).id, portId: find(from).outputs[0]?.id ?? '' },
    to: { nodeId: find(to).id, portId: find(to).inputs[0]?.id ?? '' },
  }));
  const exported: WorkflowExport = {
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    name: `PG ${label}`,
    nodes,
    edges,
  };
  const imported = await api<{ workflow: { id: string }; nodes: Node[] }>(
    `/projects/${projectId}/workflows/import`,
    { method: 'POST', body: JSON.stringify(exported) },
  );
  return {
    projectId,
    workflowId: imported.workflow.id,
    nodes: imported.nodes,
    byName(name) {
      const found = imported.nodes.find((node) => node.name === name);
      if (found === undefined) throw new Error(`the imported graph has no node named "${name}"`);
      return found;
    },
  };
}

/** An empty workflow in a new project. */
export async function seedEmptyWorkflow(
  label: string,
): Promise<{ projectId: string; workflowId: string }> {
  const projectId = await newProject(label);
  const workflow = await api<{ id: string }>(`/projects/${projectId}/workflows`, {
    method: 'POST',
    body: JSON.stringify({ name: label }),
  });
  return { projectId, workflowId: workflow.id };
}

export interface Graph {
  workflow: { id: string; version: number };
  nodes: Node[];
  edges: Edge[];
}

export const graphOf = (workflowId: string): Promise<Graph> =>
  api<Graph>(`/workflows/${workflowId}`);

/** A config patch through graph-ops, the seam the config panel writes through (BR-01). */
export async function updateNodeConfig(
  workflowId: string,
  nodeId: string,
  config: Record<string, unknown>,
): Promise<void> {
  const graph = await graphOf(workflowId);
  await api(`/workflows/${workflowId}/graph-ops`, {
    method: 'POST',
    body: JSON.stringify({
      baseVersion: graph.workflow.version,
      ops: [{ op: 'update_node', nodeId, patch: { config } }],
    }),
  });
}

/** Start a run through the API and wait until it has settled. */
export async function runToEnd(workflowId: string, timeout = 60_000): Promise<Run> {
  const run = await api<Run>(`/workflows/${workflowId}/runs`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  let last: Run = run;
  await baseExpect
    .poll(
      async () => {
        last = await api<Run>(`/runs/${run.id}`);
        return ['COMPLETE', 'HALTED', 'BLOCKED'].includes(last.status);
      },
      { timeout, message: 'the run settles' },
    )
    .toBe(true);
  return last;
}

/** The newest run of a workflow once it has settled (one started from the UI). */
export async function settledRun(workflowId: string, timeout = 60_000): Promise<RunSummary> {
  let last: RunSummary | undefined;
  await baseExpect
    .poll(
      async () => {
        const { items } = await api<{ items: RunSummary[] }>(`/workflows/${workflowId}/runs`);
        last = items[0];
        return last !== undefined && ['COMPLETE', 'HALTED', 'BLOCKED'].includes(last.status);
      },
      { timeout, message: 'the run started from the UI settles' },
    )
    .toBe(true);
  return last as RunSummary;
}

/* -------------------------------------------------------------------------- */
/* Page helpers                                                                */
/* -------------------------------------------------------------------------- */

export type Theme = 'light' | 'dark';

/** FR-SYS-005, D329: the theme is the `ace-theme` choice in localStorage. Set before any load. */
export async function useTheme(page: Page, theme: Theme): Promise<void> {
  await page.addInitScript((value) => {
    try {
      window.localStorage.setItem('ace-theme', value);
    } catch {
      // a page with no storage keeps the default
    }
  }, theme);
}

/** Any route, with the session token the web app takes from `?token=` on first load (§2.10). */
export async function open(page: Page, path: string): Promise<void> {
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}token=${engine().token}`);
}

export async function openCanvas(page: Page, projectId: string, workflowId: string): Promise<void> {
  await open(page, `/projects/${projectId}/workflows/${workflowId}`);
  await baseExpect(page.getByTestId('canvas')).toBeVisible({ timeout: 30_000 });
}

export const card = (page: Page, nodeId: string): Locator =>
  page.getByTestId(`node-card-${nodeId}`);

/** A port's handle by its id (`<nodeId>:in|out:<name>`, from the engine's graph). */
export const port = (page: Page, portId: string): Locator => page.getByTestId(`port-${portId}`);

/** The node settings modal (D333), when open. */
export const settingsDialog = (page: Page): Locator =>
  page.getByRole('dialog').filter({ has: page.getByTestId('config-panel') });

export async function closeSettings(page: Page): Promise<void> {
  const dialog = settingsDialog(page);
  if (await dialog.isVisible()) await dialog.getByRole('button', { name: 'Done' }).click();
  await baseExpect(dialog).toHaveCount(0);
}

export async function fitView(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Fit to view' }).click();
  await page.waitForTimeout(400);
}

/** The React Flow viewport's scale, read from its transform. */
export async function canvasZoom(page: Page): Promise<number> {
  return page.locator('.react-flow__viewport').evaluate((viewport) => {
    const match = /scale\(([\d.]+)\)/u.exec((viewport as HTMLElement).style.transform);
    return match === null ? 1 : Number(match[1]);
  });
}

/**
 * Put the Canvas at a zoom: 1 is the toolbar's "Zoom to 100%" (or Fit then in/out), 0.5 zooms out
 * from 100% with the toolbar until the scale is at or under one half.
 */
export async function setCanvasZoom(page: Page, target: number): Promise<number> {
  await fitView(page);
  for (let step = 0; step < 12; step += 1) {
    const zoom = await canvasZoom(page);
    if (Math.abs(zoom - target) < 0.08 || (target < 1 && zoom <= target)) return zoom;
    await page.getByRole('button', { name: zoom > target ? 'Zoom out' : 'Zoom in' }).click();
    await page.waitForTimeout(250);
  }
  return canvasZoom(page);
}

/** Computed opacity of an element and every ancestor multiplied: what the eye actually gets. */
export async function seenOpacity(target: Locator): Promise<number> {
  return target.evaluate((element) => {
    let opacity = 1;
    for (let at: Element | null = element; at !== null; at = at.parentElement) {
      opacity *= Number(getComputedStyle(at).opacity);
    }
    return opacity;
  });
}

/** A mouse drag in small steps, from one point to another, optionally holding before the drop. */
export async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  options: { steps?: number; beforeDrop?: () => Promise<void> } = {},
): Promise<void> {
  const steps = options.steps ?? 15;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps,
    );
  }
  if (options.beforeDrop !== undefined) await options.beforeDrop();
  await page.mouse.up();
}

export async function centre(target: Locator): Promise<{ x: number; y: number }> {
  const box = await target.boundingBox();
  if (box === null) throw new Error('the element has no box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** The workspace "…" menu (D331) and its Start run. */
export async function startRunFromMenu(page: Page): Promise<void> {
  await closeSettings(page);
  await page.getByTestId('workspace-menu').click();
  const menu = page.getByRole('menu').filter({ has: page.getByTestId('menu-sheet') });
  await baseExpect(menu).toBeVisible();
  await menu.getByTestId('menu-start-run').click();
  await baseExpect(menu).toHaveCount(0);
}

/** Chat is the Team chat column (D335); an agent's mention tab points it at the node. */
export async function openChat(page: Page, nodeId: string): Promise<Locator> {
  await closeSettings(page);
  const mention = page.getByTestId(`chat-mention-${nodeId}`);
  await mention.click();
  await baseExpect(mention).toHaveAttribute('aria-pressed', 'true');
  const panel = page.getByTestId('chat-aside');
  await baseExpect(panel.getByLabel('Message this agent')).toBeVisible();
  return panel;
}

export async function sendChat(panel: Locator, text: string): Promise<void> {
  const input = panel.getByLabel('Message this agent');
  await input.fill(text);
  await input.press('Enter');
}

export interface ChatMessageRow {
  id: string;
  role: string;
  content: Array<{ type: string; text?: string }>;
  error?: { kind: string; code: string; message: string };
}

/** The newest chat thread on a node, once a predicate on it holds. */
export async function newestThread(
  nodeId: string,
  until: (messages: ChatMessageRow[]) => boolean,
  timeout = 30_000,
): Promise<{ thread: { id: string }; messages: ChatMessageRow[] }> {
  let last: { thread: { id: string }; messages: ChatMessageRow[] } | undefined;
  await baseExpect
    .poll(
      async () => {
        const threads = await api<Array<{ id: string }>>(`/nodes/${nodeId}/chat/threads`);
        const newest = threads[0];
        if (newest === undefined) return false;
        last = await api(`/chat/threads/${newest.id}`);
        return until(last?.messages ?? []);
      },
      { timeout, message: 'the chat thread reaches the expected state' },
    )
    .toBe(true);
  return last as { thread: { id: string }; messages: ChatMessageRow[] };
}

/** Domain's conversation column. */
export const domain = (page: Page): Locator =>
  page.getByRole('region', { name: 'Domain', exact: true });
export const domainMessages = (page: Page): Locator => domain(page).getByTestId('domain-message');
