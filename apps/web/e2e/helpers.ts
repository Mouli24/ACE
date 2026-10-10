import { expect, type Locator, type Page } from '@playwright/test';

// Type-only: brings the `window.__aceMock` declaration from the mock bootstrap into scope.
import type {} from '../src/mocks/browser';

/** The six round-1 kinds, typed loosely so the helpers stay free of app imports. */
export type Kind = 'input' | 'agent' | 'model' | 'output' | 'merge' | 'transform' | 'retrieval';

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
  names?: { projectName?: string; workflowName?: string; withModel?: boolean },
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
      nodes: db.nodesOf(id).map((n) => ({
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

/*
 * POC Theme V2 layout (D259): the palette is the New node dialog, Configure/Inspector/Runs/Memory
 * live in a floating sheet that starts closed, and Chat is a permanent column.
 */

/** Add a node from the New node dialog: open it, choose the kind, optionally name it, add it. */
export async function addFromDialog(page: Page, kind: Kind, name?: string): Promise<void> {
  await page.getByTestId('new-node-button').click();
  await page.getByTestId(`palette-${kind}`).click();
  if (name) await page.getByLabel('Name').fill(name);
  await page.getByTestId('new-node-add').click();
}

/** Show one tab of the workflow sheet, opening the sheet first when it is closed. */
export async function openSheet(
  page: Page,
  tab: 'Configure' | 'Inspector' | 'Runs' | 'Memory',
): Promise<void> {
  if (!(await page.getByRole('tab', { name: tab }).isVisible()))
    await page.getByTestId('sheet-toggle').click();
  await page.getByRole('tab', { name: tab }).click();
}

/** Close the workflow sheet when it is open (it covers the right of the Canvas and bottom panel). */
export async function closeSheet(page: Page): Promise<void> {
  const close = page.getByRole('button', { name: 'Close panel' });
  if (await close.isVisible()) await close.click();
  await expect(page.getByTestId('workflow-sheet')).toHaveCount(0);
}

/**
 * Drag a kind out of the New node dialog onto the Canvas at client coordinates. Dispatched events:
 * the overlay goes `pointer-events: none` once the drag starts, which a mouse-driven `dragTo`
 * cannot get past, and the drop must land on the Canvas underneath.
 */
export async function dragKindToCanvas(
  page: Page,
  kind: Kind,
  at: { x: number; y: number },
): Promise<void> {
  await page.getByTestId('new-node-button').click();
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await page.getByTestId(`palette-${kind}`).dispatchEvent('dragstart', { dataTransfer });
  const canvas = page.getByTestId('canvas');
  await canvas.dispatchEvent('dragover', { dataTransfer, clientX: at.x, clientY: at.y });
  await canvas.dispatchEvent('drop', { dataTransfer, clientX: at.x, clientY: at.y });
  await page.getByTestId(`palette-${kind}`).dispatchEvent('dragend', { dataTransfer });
}

/**
 * Select one node and show it on a tab of the sheet. The sheet is closed first: open, it covers the
 * right of the Canvas, and the card may sit under it.
 */
export async function selectInSheet(
  page: Page,
  nodeId: string,
  tab: 'Configure' | 'Inspector' | 'Runs' | 'Memory',
): Promise<void> {
  await closeSheet(page);
  await nodeCard(page, nodeId).click();
  await openSheet(page, tab);
}

/** Select one node and open the sheet on its Configure tab. */
export async function configureNode(page: Page, nodeId: string): Promise<Locator> {
  await selectInSheet(page, nodeId, 'Configure');
  const panel = page.getByRole('complementary', { name: 'Node configuration' });
  await expect(panel).toBeVisible();
  return panel;
}

const overlaps = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Zoom out (the zoom pill's "Zoom out") until `target` no longer sits under the minimap in the
 * Canvas's bottom-right corner, so a real mouse press lands on it. At 1280×720 a fitted two-card
 * graph can put the second card's output port there.
 */
export async function clearOfMinimap(page: Page, target: Locator): Promise<void> {
  const minimap = page.locator('.react-flow__minimap');
  for (let step = 0; step < 6; step += 1) {
    const [box, map] = await Promise.all([target.boundingBox(), minimap.boundingBox()]);
    if (!box || !map || !overlaps(box, map)) return;
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await page.waitForTimeout(300);
  }
  throw new Error('target is still under the minimap after zooming out');
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

/** Forge (D299): a project with a workflow and files on its (mock) disk. */
export async function seedForge(page: Page, files: Record<string, string>): Promise<Seeded> {
  const seeded = await seedGraph(page, ['agent'], {
    projectName: 'Shop',
    workflowName: 'Main',
    withModel: true,
  });
  await page.evaluate(({ projectId, files }) => window.__aceMock!.seedFiles(projectId, files), {
    projectId: seeded.projectId,
    files,
  });
  return seeded;
}

export const forgeUrl = (seeded: Seeded): string =>
  `/projects/${seeded.projectId}/workflows/${seeded.workflowId}/forge`;

/** What the mock engine's disk holds - the truth for every "saved" assertion. */
export async function diskFile(
  page: Page,
  projectId: string,
  path: string,
): Promise<string | undefined> {
  return page.evaluate(
    ({ projectId, path }) => {
      const db = window.__aceMock!.db;
      db.load();
      return db.filesOf(projectId)[path]?.content;
    },
    { projectId, path },
  );
}

/** The real Monaco editor in the workbench. */
export const monacoEditor = (page: Page): Locator =>
  page.locator('[data-testid="monaco-host"] .monaco-editor').first();

/** Type at the end of the active file, as a person would. */
export async function typeAtEnd(page: Page, text: string): Promise<void> {
  await monacoEditor(page).locator('.view-lines').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
}
