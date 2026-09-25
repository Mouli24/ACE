import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

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
const start = (page: Page) => page.getByTestId('run-bar').getByRole('button', { name: 'Start' });
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
    await page.goto(`/providers?token=${token}`);
    await page.getByRole('button', { name: /add provider/i }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Type').click();
    await page.getByRole('option', { name: 'Mock' }).click();
    await dialog.getByLabel('Name').fill('Mock');
    await dialog.getByRole('button', { name: 'Add provider' }).click();

    const row = page.locator('[data-testid^="provider-row-"]').first();
    await expect(row).toContainText('Mock');
    await row.getByRole('button', { name: 'Test' }).click();
    await expect(row.locator('[data-testid^="provider-status-"]')).toHaveAttribute(
      'data-status',
      'CONNECTED',
    );

    const providerId = (
      await api<{ items: Array<{ id: string; name: string }> }>('/providers')
    ).items.find((provider) => provider.name === 'Mock')?.id as string;

    // …models listed. The catalogue needs the refresh until D-024 is fixed, so the script presses
    // the button the UI offers rather than pretending the list is there on its own.
    await page.getByRole('tab', { name: 'Models' }).click();
    await page.getByRole('button', { name: /refresh models/i }).click();
    await expect(page.getByTestId('models-table')).toBeVisible();
    await expect(page.getByTestId('model-row-mock-text')).toBeVisible();

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

    // Pick `mock-text` in the config panel, as the script says.
    await page.getByRole('button', { name: 'Fit to view' }).click();
    await card(page, agent.id).locator('header').click();
    const panel = page.getByRole('complementary', { name: 'Node configuration' });
    await panel.getByLabel('Model').click();
    await page.getByRole('option', { name: /^Mock text$/ }).click();
    await expect(card(page, agent.id)).toContainText('mock-text');

    // Start → the input dialog, because the Input node has nothing to send.
    await start(page).click();
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
    await expect(page.getByTestId('run-status')).toHaveAttribute('data-status', 'COMPLETE');
    await expect(page.getByTestId(`final-output-${output.id}`)).toBeVisible();

    /* ---- inspector shows tokens / cost / model / prompt ---- */
    await page.getByRole('tab', { name: 'Inspector' }).click();
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
    await start(page).click();
    await expect(page.getByTestId(`used-model-${fallbackAgent.id}`)).toContainText('(fallback)', {
      timeout: 40_000,
    });

    /* ---- mock-bad-json with a JSON contract → FAILED CONTRACT_VIOLATION ---- */
    const bad = await workflowFor('contract-violation.json', providerId, project.id);
    const badAgent = nodeOf(bad, 'agent');
    await page.goto(`/projects/${project.id}/workflows/${bad.workflow.id}?token=${token}`);
    await expect(card(page, badAgent.id)).toBeVisible();
    await start(page).click();
    await expect(card(page, badAgent.id)).toHaveAttribute('data-state', 'FAILED', {
      timeout: 40_000,
    });
    await page.getByRole('button', { name: 'Fit to view' }).click();
    await card(page, badAgent.id).locator('header').click();
    await page.getByRole('tab', { name: 'Inspector' }).click();
    await expect(page.getByTestId('inspector-failure-reason')).toHaveText('CONTRACT_VIOLATION');

    /* ---- reload during a slow run → states and text still correct ---- */
    const slow = await workflowFor('slow.json', providerId, project.id);
    const slowAgent = nodeOf(slow, 'agent');
    await page.goto(`/projects/${project.id}/workflows/${slow.workflow.id}?token=${token}`);
    await expect(card(page, slowAgent.id)).toBeVisible();
    await start(page).click();
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
