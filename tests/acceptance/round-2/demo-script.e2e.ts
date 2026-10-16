import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The round 2 §1 demo script, walked through the **UI** in one pass against the real engine.
 *
 * The gate asks for this script to be walked by both of us. Round 1 settled (D41) that a pass
 * performed once and written up is a claim the next person cannot re-check, so it is automated
 * instead: this file walks every step in order, in one test, the way a person would — Providers →
 * add Mock → Test → models listed → open a workflow → pick a model → Start → watch the states and
 * the streaming text → inspect the run → fallback → contract violation → reload mid-run.
 *
 * It does not replace two people looking at the screen together; it replaces *narrating* that they
 * did. What is still human is the judgement — whether the thing looks right — and that is recorded
 * as such in REPORT.md rather than ticked here.
 */

interface EngineHandle {
  url: string;
  token: string;
}

function engine(): EngineHandle {
  const handleFile = fileURLToPath(new URL('../.playwright-engine.json', import.meta.url));
  return JSON.parse(readFileSync(handleFile, 'utf8')) as EngineHandle;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { url, token } = engine();
  const response = await fetch(`${url}/api/v1${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`${path} → ${response.status} ${await response.text()}`);
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

const FIXTURES = fileURLToPath(new URL('../fixtures/round-2/', import.meta.url));
const PLACEHOLDER = '01M3R2PV0000000000000000PV';

interface Node {
  id: string;
  kind: string;
  name: string;
  config: Record<string, unknown>;
}
interface Graph {
  workflow: { id: string };
  nodes: Node[];
  edges: Array<{ id: string; from: { nodeId: string } }>;
}

const card = (page: Page, nodeId: string) => page.getByTestId(`node-card-${nodeId}`);

/*
 * Ace UI layout (D330–D333): a click on a card opens its settings modal (the old sheet's Configure
 * tab), which covers the Canvas until it is closed; the run starts from the workspace "…" menu,
 * whose footer carries the run's state; Inspector is a tab of the floating sheet, opened from the
 * "…" menu or a card's menu ("Inspect").
 */
const settingsDialog = (page: Page): Locator =>
  page.getByRole('dialog').filter({ has: page.getByTestId('config-panel') });

/** Close the node settings modal if it is open (Done commits whatever is still waiting). */
async function closeSettings(page: Page): Promise<void> {
  const dialog = settingsDialog(page);
  if (await dialog.isVisible()) await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toHaveCount(0);
}

/** Start a run from the workspace "…" menu (D331), once "Start run" is offered and enabled. */
async function start(page: Page): Promise<void> {
  await closeSettings(page);
  const item = page.getByTestId('menu-start-run');
  await expect(async () => {
    if (await page.getByRole('menu').isVisible()) await page.keyboard.press('Escape');
    await page.getByTestId('workspace-menu').click();
    await expect(item).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await item.click();
}

/** The workspace footer: it carries the run's state as `data-run-status` (D330). */
const footer = (page: Page) =>
  page.locator('footer').filter({ has: page.getByTestId('footer-mode') });

/**
 * Where to click a card so the card itself receives the click: near the top of its header, a
 * quarter of the way in (D-089), unless something sits over that point. In the V2 layout the halt
 * note is a pill centred at the top of the Canvas (D259), and after Fit to view it can cover the
 * top row of card headers; then the first point of the header, or failing that of the card's body,
 * that the card receives — never a control inside it.
 */
async function clickPoint(target: Locator): Promise<{ x: number; y: number }> {
  // read once the card has stopped moving: Fit to view animates the viewport
  let last = '';
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(await target.boundingBox());
        const still = now === last;
        last = now;
        return still;
      },
      { message: 'the card is still', timeout: 10_000, intervals: [50, 100, 100, 200] },
    )
    .toBe(true);
  const point = await target.evaluate((card) => {
    const box = card.getBoundingClientRect();
    const header = card.querySelector('header')?.getBoundingClientRect() ?? box;
    const candidates = [{ x: Math.max(4, Math.min(60, box.width * 0.25)), y: 6 }];
    for (const y of [
      6,
      header.bottom - box.top - header.height / 2,
      box.height / 2,
      box.height - 10,
    ]) {
      for (let x = 8; x < box.width - 8; x += 8) candidates.push({ x, y });
    }
    const control =
      'button, input, textarea, select, a, [role="button"], .react-flow__handle, .nodrag';
    for (const candidate of candidates) {
      const hit = document.elementFromPoint(box.left + candidate.x, box.top + candidate.y);
      if (hit === null || !card.contains(hit)) continue;
      const inside = hit.closest(control);
      if (inside === null || !card.contains(inside)) return candidate;
    }
    return null;
  });
  expect(point, 'some part of the card receives a click').not.toBeNull();
  return point as { x: number; y: number };
}

/** The workflow sheet (D331), from the workspace "…" menu; it shows the selected node. */
async function openSheet(page: Page, tab: 'Inspector' | 'Runs' | 'Memory'): Promise<void> {
  await closeSettings(page);
  if (!(await page.getByRole('tab', { name: tab }).isVisible())) {
    await page.getByTestId('workspace-menu').click();
    await page.getByTestId('menu-sheet').click();
  }
  await page.getByRole('tab', { name: tab }).click();
}
const nodeOf = (graph: Graph, kind: string) => graph.nodes.find((n) => n.kind === kind) as Node;

/** Import a fixture for a step of the script, pointed at the provider the UI just created. */
async function workflowFor(
  file: string,
  providerId: string,
  projectId: string,
  patch: (nodes: Node[]) => void = () => undefined,
): Promise<Graph> {
  const exported = JSON.parse(readFileSync(`${FIXTURES}${file}`, 'utf8')) as { nodes: Node[] };
  for (const node of exported.nodes) {
    const config = node.config as { providerId?: string };
    if (config.providerId === PLACEHOLDER) config.providerId = providerId;
  }
  patch(exported.nodes);
  return api<Graph>(`/projects/${projectId}/workflows/import`, {
    method: 'POST',
    body: JSON.stringify(exported),
  });
}

test.describe('Round 2 §1 demo script, through the UI', () => {
  test('the whole script, in order, against the real engine', async ({ page }) => {
    const { token } = engine();

    /* ---- Providers → add "Mock" → Test → CONNECTED, models listed ---- */
    const before = new Set(
      (await api<{ items: Array<{ id: string }> }>('/providers?limit=500')).items.map((p) => p.id),
    );
    await page.goto(`/providers?token=${token}`);
    await page.getByRole('button', { name: /add provider/i }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Type').click();
    await page.getByRole('option', { name: 'Mock' }).click();
    await dialog.getByLabel('Name').fill('Mock');
    await dialog.getByRole('button', { name: 'Add provider' }).click();

    // PG-1.4 (D359): the Providers page groups rows into sections, so the first row is no longer
    // the one just added — the row is the provider this dialog created, found by its id
    let providerId = '';
    await expect
      .poll(
        async () => {
          const { items } = await api<{ items: Array<{ id: string; name: string }> }>(
            '/providers?limit=500',
          );
          providerId = items.find((p) => !before.has(p.id) && p.name === 'Mock')?.id ?? '';
          return providerId;
        },
        { message: 'the new Mock provider reaches the engine' },
      )
      .not.toBe('');
    const row = page.getByTestId(`provider-row-${providerId}`);
    await expect(row).toContainText('Mock');
    await row.getByRole('button', { name: 'Test' }).click();
    await expect(row.locator('[data-testid^="provider-status-"]')).toHaveAttribute(
      'data-status',
      'CONNECTED',
    );

    // …models listed. The catalogue needs the refresh until D-024 is fixed, so the script presses
    // the button the UI offers rather than pretending the list is there on its own.
    await page.getByRole('tab', { name: 'Models' }).click();
    await page.getByRole('button', { name: /refresh models/i }).click();
    await expect(page.getByTestId('models-table')).toBeVisible();
    // `.first()`: earlier specs on the same engine add Mock providers of their own, each with a
    // mock-text row in this unfiltered table
    await expect(page.getByTestId('model-row-mock-text').first()).toBeVisible();

    const project = await api<{ id: string }>('/projects', {
      method: 'POST',
      body: JSON.stringify({ name: `demo-${Date.now().toString(36)}` }),
    });

    /* ---- open the workflow → set the Agent model → Start → input dialog ---- */
    const linear = await workflowFor('linear-mock.json', providerId, project.id, (nodes) => {
      for (const node of nodes) {
        if (node.kind === 'agent') delete (node.config as { modelId?: string }).modelId;
        if (node.kind === 'input') delete (node.config as { text?: string }).text;
      }
    });
    const agent = nodeOf(linear, 'agent');
    const input = nodeOf(linear, 'input');
    const output = nodeOf(linear, 'output');

    await page.goto(`/projects/${project.id}/workflows/${linear.workflow.id}?token=${token}`);
    await expect(page.getByTestId('canvas')).toBeVisible();
    await expect(card(page, agent.id)).toBeVisible();

    // Pick `mock-text` in the config panel — the settings modal a click on the card opens (D333) —
    // as the script says.
    await page.getByRole('button', { name: 'Fit to view' }).click();
    await card(page, agent.id).click({ position: await clickPoint(card(page, agent.id)) });
    const panel = settingsDialog(page).getByRole('region', { name: 'Node configuration' });
    // `exact`: "Model provider" is the provider field's label
    await panel.getByLabel('Model', { exact: true }).click();
    await page.getByRole('option', { name: /^Mock text$/ }).click();
    await expect(card(page, agent.id)).toContainText('mock-text');

    // Start → the input dialog, because the Input node has nothing to send.
    await start(page);
    const inputDialog = page.getByTestId('run-input-dialog');
    await expect(inputDialog).toBeVisible();
    await inputDialog.getByLabel(input.name).fill('Summarise the quarterly brief for the board.');
    await inputDialog.getByRole('button', { name: 'Start run' }).click();

    /* ---- Input COMPLETED → Agent RUNNING with streaming text → Output COMPLETED ---- */
    await expect(card(page, input.id)).toHaveAttribute('data-state', 'COMPLETED', {
      timeout: 30_000,
    });
    await expect(card(page, agent.id)).toHaveAttribute('data-state', 'COMPLETED', {
      timeout: 40_000,
    });
    await expect(card(page, output.id)).toHaveAttribute('data-state', 'COMPLETED', {
      timeout: 40_000,
    });
    await expect(footer(page)).toHaveAttribute('data-run-status', 'COMPLETE');
    // D285: the answer is read in the agent's chat, tagged with the run — not on the Output card
    await expect(page.getByTestId(`final-output-${output.id}`)).toHaveCount(0);
    await page.getByTestId(`chat-mention-${agent.id}`).click();
    await expect(page.getByTestId('chat-run-badge').first()).toBeVisible({ timeout: 20_000 });

    /* ---- inspector shows tokens / cost / model / prompt ---- */
    await openSheet(page, 'Inspector');
    const inspector = page.getByTestId('inspector');
    await expect(inspector.getByTestId('inspector-facts')).toContainText('mock-text');
    await expect(inspector.getByTestId('prompt-version')).toContainText('version');
    await inspector.getByRole('button', { name: 'View prompt' }).click();
    await expect(page.getByTestId('prompt-text')).toContainText('## Instructions');
    await page.keyboard.press('Escape');

    /* ---- mock-503 with fallback mock-text → "used: mock-text (fallback)" ---- */
    const fallback = await workflowFor('fallback.json', providerId, project.id);
    const fallbackAgent = nodeOf(fallback, 'agent');
    await page.goto(`/projects/${project.id}/workflows/${fallback.workflow.id}?token=${token}`);
    await expect(card(page, fallbackAgent.id)).toBeVisible();
    await start(page);
    await expect(page.getByTestId(`used-model-${fallbackAgent.id}`)).toContainText('(fallback)', {
      timeout: 40_000,
    });

    /* ---- mock-bad-json with a JSON contract → FAILED CONTRACT_VIOLATION ---- */
    const bad = await workflowFor('contract-violation.json', providerId, project.id);
    const badAgent = nodeOf(bad, 'agent');
    await page.goto(`/projects/${project.id}/workflows/${bad.workflow.id}?token=${token}`);
    await expect(card(page, badAgent.id)).toBeVisible();
    await start(page);
    await expect(card(page, badAgent.id)).toHaveAttribute('data-state', 'FAILED', {
      timeout: 40_000,
    });
    await page.getByRole('button', { name: 'Fit to view' }).click();
    // inspect the failed card from its menu (D333): right-click where the card itself is
    await card(page, badAgent.id).click({
      button: 'right',
      position: await clickPoint(card(page, badAgent.id)),
    });
    await page.getByRole('menuitem', { name: 'Inspect' }).click();
    await openSheet(page, 'Inspector');
    await expect(page.getByTestId('inspector-failure-reason')).toHaveText('CONTRACT_VIOLATION');

    /* ---- reload during a slow run → states and text still correct ---- */
    const slow = await workflowFor('slow.json', providerId, project.id);
    const slowAgent = nodeOf(slow, 'agent');
    await page.goto(`/projects/${project.id}/workflows/${slow.workflow.id}?token=${token}`);
    await expect(card(page, slowAgent.id)).toBeVisible();
    await start(page);
    await expect(card(page, slowAgent.id)).toHaveAttribute('data-state', 'RUNNING', {
      timeout: 20_000,
    });

    await page.reload();
    await expect(page.getByTestId('canvas')).toBeVisible();

    /*
     * What a reload can and cannot recover, stated rather than glossed: the persisted frames come
     * back through `resume`, so the node's final state is right, but `node.token` is transient by
     * contract (§2.4) and the text streamed before the reload is gone for good. The engine's record
     * is the thing to check against, and it agrees.
     */
    const runs = await api<{ items: Array<{ id: string; status: string }> }>(
      `/workflows/${slow.workflow.id}/runs`,
    );
    const runId = runs.items[0]?.id as string;
    await expect
      .poll(async () => (await api<{ status: string }>(`/runs/${runId}`)).status, {
        timeout: 60_000,
      })
      .toBe('COMPLETE');

    const nodeRuns = await api<Array<{ nodeId: string; status: string }>>(
      `/runs/${runId}/node-runs`,
    );
    for (const nodeRun of nodeRuns) {
      await expect(card(page, nodeRun.nodeId)).toHaveAttribute('data-state', nodeRun.status, {
        timeout: 30_000,
      });
    }
  });
});
