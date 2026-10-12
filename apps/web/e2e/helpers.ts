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
  await expect(page.getByRole('heading', { name: 'What would you like to make?' })).toBeVisible();
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
 * The Ace UI workspace (D330–D333): "Add node" on the Canvas adds an Agent and opens its settings
 * modal; a click on a card opens that modal (the old sheet's Configure tab); Inspector, Runs and
 * Memory live in a floating sheet opened from the node menu's "Inspect" or the workspace "…" menu.
 */

/** The node settings modal, when open. */
export const settingsDialog = (page: Page): Locator =>
  page.getByRole('dialog').filter({ has: page.getByTestId('config-panel') });

/** Close the node settings modal if it is open (Done commits what is still waiting). */
export async function closeSettings(page: Page): Promise<void> {
  const dialog = settingsDialog(page);
  if (await dialog.isVisible()) await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toHaveCount(0);
}

/**
 * Add an Agent with the Canvas's "Add node" pill: it lands after the last stage, linked to it, and
 * its settings open; `name` is typed into Persona name, then the modal is closed. Only Agents can be
 * added (FR-CAN-002, `PALETTE_NODE_KINDS`).
 */
export async function addFromDialog(page: Page, kind: Kind, name?: string): Promise<void> {
  if (kind !== 'agent') throw new Error(`only an agent can be added from the Canvas, not ${kind}`);
  await closeSettings(page);
  await page.getByTestId('new-node-button').click();
  const dialog = settingsDialog(page);
  await expect(dialog).toBeVisible();
  if (name) await dialog.getByLabel('Persona name').fill(name);
  await closeSettings(page);
}

/**
 * Show one tab of the workflow sheet for the selected node. "Configure" is the node settings modal
 * now: it opens when the card is clicked, so this only checks it is there.
 */
export async function openSheet(
  page: Page,
  tab: 'Configure' | 'Inspector' | 'Runs' | 'Memory',
): Promise<void> {
  if (tab === 'Configure') {
    await expect(settingsDialog(page)).toBeVisible();
    return;
  }
  await closeSettings(page);
  if (!(await page.getByRole('tab', { name: tab }).isVisible())) {
    await page.getByTestId('workspace-menu').click();
    await page.getByTestId('menu-sheet').click();
  }
  await page.getByRole('tab', { name: tab }).click();
}

/** Close the workflow sheet when it is open (it covers the right of the Canvas). */
export async function closeSheet(page: Page): Promise<void> {
  await closeSettings(page);
  const close = page.getByTestId('workflow-sheet').getByRole('button', { name: 'Close panel' });
  if (await close.isVisible()) await close.click();
  await expect(page.getByTestId('workflow-sheet')).toHaveCount(0);
}

/**
 * Drop a node kind onto the Canvas at client coordinates, as a palette drag would carry it. The
 * New node dialog that was the drag's source is gone (D332); the Canvas still accepts the drop.
 */
export async function dragKindToCanvas(
  page: Page,
  kind: Kind,
  at: { x: number; y: number },
): Promise<void> {
  const dataTransfer = await page.evaluateHandle((k) => {
    const transfer = new DataTransfer();
    transfer.setData('application/x-ace-node-kind', k);
    return transfer;
  }, kind);
  const canvas = page.getByTestId('canvas');
  await canvas.dispatchEvent('dragover', { dataTransfer, clientX: at.x, clientY: at.y });
  await canvas.dispatchEvent('drop', { dataTransfer, clientX: at.x, clientY: at.y });
}

/**
 * Select one node and show it on a tab: "Configure" opens its settings modal (a click on the card),
 * the others open the sheet through the node menu's "Inspect" and pick the tab.
 */
export async function selectInSheet(
  page: Page,
  nodeId: string,
  tab: 'Configure' | 'Inspector' | 'Runs' | 'Memory',
): Promise<void> {
  await closeSheet(page);
  if (tab === 'Configure') {
    await nodeCard(page, nodeId).click();
    await expect(settingsDialog(page)).toBeVisible();
    return;
  }
  await nodeCard(page, nodeId).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Inspect' }).click();
  await page.getByRole('tab', { name: tab }).click();
}

/** Open a node's settings modal and return its configuration region. */
export async function configureNode(page: Page, nodeId: string): Promise<Locator> {
  await selectInSheet(page, nodeId, 'Configure');
  const panel = settingsDialog(page).getByRole('region', { name: 'Node configuration' });
  await expect(panel).toBeVisible();
  return panel;
}

const overlaps = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Zoom out (the toolbar's "Zoom out") until `target` no longer sits under the minimap in the
 * Canvas's bottom-right corner, so a real mouse press lands on it.
 */
export async function clearOfMinimap(page: Page, target: Locator): Promise<void> {
  const minimap = page.getByTestId('canvas-minimap');
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

/** Forge's terminal (D301): the real xterm's rows, as text — only the rows on screen, never the scrollback. */
export const terminalText = (page: Page): Locator =>
  page.locator('[data-testid="terminal-view"] .xterm-rows');

/** Forge with the Terminal open, focused, at its prompt. */
export async function openTerminal(page: Page, seeded: Seeded): Promise<void> {
  await page.goto(forgeUrl(seeded));
  await expect(page.getByTestId('forge')).toBeVisible();
  await page.keyboard.press('Control+Backquote');
  await expect(terminalText(page)).toContainText('~ $');
  // The default panel shows six rows; maximised, a whole run stays on screen (.xterm-rows is the
  // viewport only). Ctrl+J and Ctrl+` leave maximised, so a test that hides the panel starts small.
  await page.getByRole('button', { name: 'Maximize panel' }).click();
  await page.getByTestId('terminal-view').click();
}

/** Types a line into the focused terminal and presses Enter, as a person would. */
export async function runLine(page: Page, line: string): Promise<void> {
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
}
