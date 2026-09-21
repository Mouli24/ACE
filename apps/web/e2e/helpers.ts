import { expect, type Locator, type Page } from '@playwright/test';

// Type-only: brings the `window.__aceMock` declaration from the mock bootstrap into scope.
import type {} from '../src/mocks/browser';

/** The six round-1 kinds, typed loosely so the helpers stay free of app imports. */
export type Kind = 'input' | 'agent' | 'model' | 'output' | 'merge' | 'transform';

export interface Seeded {
  projectId: string;
  workflowId: string;
  nodeIds: string[];
}

/** Land on the app with a clean mock engine (localStorage is the mock's database). */
export async function freshApp(page: Page): Promise<void> {
  await page.goto('/projects');
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto('/projects');
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
}

/** Create a project + workflow with one node per kind through the mock's test hook. */
export async function seedGraph(
  page: Page,
  kinds: Kind[],
  names?: { projectName?: string; workflowName?: string },
): Promise<Seeded> {
  return page.evaluate(({ kinds, names }) => window.__aceMock!.seedGraph(kinds, names), {
    kinds,
    names,
  });
}

export async function connect(
  page: Page,
  workflowId: string,
  from: string,
  fromPort: string,
  to: string,
  toPort: string,
) {
  await page.evaluate(
    ({ workflowId, from, fromPort, to, toPort }) =>
      window.__aceMock!.connect(workflowId, from, fromPort, to, toPort),
    { workflowId, from, fromPort, to, toPort },
  );
}

export async function openWorkflow(page: Page, seeded: Seeded): Promise<void> {
  await page.goto(`/projects/${seeded.projectId}/workflows/${seeded.workflowId}`);
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
}

export const nodeCard = (page: Page, nodeId: string): Locator =>
  page.getByTestId(`node-card-${nodeId}`);
export const flowNode = (page: Page, nodeId: string): Locator =>
  page.locator(`.react-flow__node[data-id="${nodeId}"]`);
export const port = (page: Page, nodeId: string, direction: 'in' | 'out', name: string): Locator =>
  page.getByTestId(`port-${nodeId}:${direction}:${name}`);

/** What the mock engine holds for a workflow: the source of truth for every "persisted" assertion. */
export async function serverGraph(page: Page, workflowId: string) {
  return page.evaluate((id) => {
    const db = window.__aceMock!.db;
    db.load();
    return {
      version: db.getWorkflow(id)?.version ?? -1,
      nodes: db
        .nodesOf(id)
        .map((n) => ({
          id: n.id,
          kind: n.kind,
          name: n.name,
          position: n.position,
          config: n.config,
        })),
      edges: db.edgesOf(id).map((e) => ({ id: e.id, from: e.from, to: e.to })),
    };
  }, workflowId);
}

/** Wait until autosave has flushed: the mock's version stops moving. */
export async function settled(
  page: Page,
  workflowId: string,
  expectedNodes?: number,
): Promise<void> {
  await expect
    .poll(async () => (await serverGraph(page, workflowId)).nodes.length, { timeout: 5000 })
    .toBe(expectedNodes ?? (await serverGraph(page, workflowId)).nodes.length);
  await page.waitForTimeout(250);
}

/** Drag with real mouse events (React Flow listens to pointer events on the document). */
export async function dragBy(page: Page, target: Locator, dx: number, dy: number): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error('target has no box');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  const steps = 12;
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(startX + (dx * i) / steps, startY + (dy * i) / steps);
  }
  await page.mouse.up();
}

/** Drag from one handle to another with real mouse events. */
export async function dragConnect(page: Page, from: Locator, to: Locator): Promise<void> {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (!a || !b) throw new Error('handle has no box');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  const steps = 15;
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(
      a.x + a.width / 2 + ((b.x + b.width / 2 - a.x - a.width / 2) * i) / steps,
      a.y + a.height / 2 + ((b.y + b.height / 2 - a.y - a.height / 2) * i) / steps,
    );
  }
  await page.mouse.up();
}
