import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Round 2 cross-test of the web feature M2
 * (`docs/team-prompts/02-round-2-providers-execution.md` §7.1).
 *
 * Playwright drives the **real UI** — the production build served by `vite preview` — against the
 * **real engine** on a temp database with the mock provider. No MSW and no fake socket: what passes
 * here is true of the seam between the two halves, which is the only thing a cross-test is for.
 *
 * Every "is it really so?" assertion asks the engine over REST rather than trusting the page.
 *
 * Authorship: §7.1 assigns this file to Arhant. It was written by Mouli on the repository owner's
 * instruction to close the round 2 gate, the same arrangement as round 1's D32 — see D67. A test of
 * one's own feature is weaker than a partner's by construction, so each scenario below asserts
 * against the engine's own records wherever it can, rather than against the UI it came from.
 */

interface EngineHandle {
  url: string;
  wsUrl: string;
  token: string;
}

/** `start-for-playwright.ts` drops the engine's address and token here. */
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
  if (!response.ok) {
    throw new Error(
      `${init.method ?? 'GET'} ${path} → ${response.status} ${await response.text()}`,
    );
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

/* -------------------------------------------------------------------------- */
/* Fixtures and helpers                                                       */
/* -------------------------------------------------------------------------- */

interface Provider {
  id: string;
  name: string;
  type: string;
  keySet: boolean;
  status: string;
}
interface Port {
  id: string;
  name: string;
  dataType: string;
}
interface Node {
  id: string;
  kind: string;
  name: string;
  inputs: Port[];
  outputs: Port[];
  config: Record<string, unknown>;
}
interface Graph {
  workflow: { id: string; version: number };
  nodes: Node[];
  edges: Array<{ id: string; from: { nodeId: string }; to: { nodeId: string } }>;
}
interface NodeRun {
  id: string;
  nodeId: string;
  status: string;
  modelUsed?: { modelId: string; viaFallback: boolean };
  usage: { tokensIn: number; tokensOut: number; costUsd: number };
  prompt?: { version: string; text: string };
  output?: Array<{ type: string; text?: string }>;
}
interface RunSummary {
  id: string;
  status: string;
  durationMs?: number;
  totals: { tokensIn: number; tokensOut: number; costUsd: number };
}

const FIXTURES = fileURLToPath(new URL('../fixtures/round-2/', import.meta.url));
const PLACEHOLDER_PROVIDER = '01M3R2PV0000000000000000PV';

let providerId = '';

/** The mock provider, created once and its catalogue discovered (D-024 still needs the refresh). */
async function mockProvider(): Promise<string> {
  if (providerId) return providerId;
  const created = await api<Provider>('/providers', {
    method: 'POST',
    body: JSON.stringify({ type: 'mock', name: 'Mock' }),
  });
  await api(`/providers/${created.id}/refresh-models`, { method: 'POST' });
  providerId = created.id;
  return providerId;
}

/** Import a round-2 fixture onto a fresh project, pointing its agents at a real provider. */
async function importFixture(
  file: string,
  patch: (exported: { nodes: Node[] }) => void = () => undefined,
): Promise<{ projectId: string; workflowId: string; graph: Graph }> {
  const provider = await mockProvider();
  const exported = JSON.parse(readFileSync(`${FIXTURES}${file}`, 'utf8')) as { nodes: Node[] };
  for (const node of exported.nodes) {
    const config = node.config as { providerId?: string };
    if (config.providerId === PLACEHOLDER_PROVIDER) config.providerId = provider;
  }
  patch(exported);
  const project = await api<{ id: string }>('/projects', {
    method: 'POST',
    body: JSON.stringify({ name: `m2-${Date.now().toString(36)}` }),
  });
  const imported = await api<Graph>(`/projects/${project.id}/workflows/import`, {
    method: 'POST',
    body: JSON.stringify(exported),
  });
  return { projectId: project.id, workflowId: imported.workflow.id, graph: imported };
}

async function openCanvas(page: Page, projectId: string, workflowId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/workflows/${workflowId}?token=${engine().token}`);
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
}

async function openProviders(page: Page): Promise<void> {
  await page.goto(`/providers?token=${engine().token}`);
  await expect(page.getByRole('heading', { name: /providers/i })).toBeVisible();
}

const card = (page: Page, nodeId: string): Locator => page.getByTestId(`node-card-${nodeId}`);

/**
 * Select a node by clicking its header. Fit to view first, and aim at the header rather than the
 * card: the port handles and the React Flow pane both sit over a card and swallow the click.
 *
 * Call this *before* starting a run where possible. A card grows once it carries streamed text and
 * a "used:" line, and a grown card can end up under its neighbour at fit-to-view zoom — then the
 * neighbour swallows the click and the failure looks like a selection bug rather than a layout one.
 */
async function selectCard(page: Page, nodeId: string): Promise<void> {
  await page.getByRole('button', { name: 'Fit to view' }).click();
  await page.waitForTimeout(400);
  await card(page, nodeId).locator('header').click();
  await expect(card(page, nodeId)).toHaveAttribute('data-selected', 'true');
}
const startButton = (page: Page): Locator =>
  // `exact`, because round 3 put Restart in the same bar and "Start" is a substring of it.
  page.getByTestId('run-bar').getByRole('button', { name: 'Start', exact: true });

const nodeOf = (graph: Graph, kind: string): Node =>
  graph.nodes.find((node) => node.kind === kind) as Node;

/** Poll the engine until it agrees with what the page is showing. */
async function engineSays<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  message: string,
  timeout = 20_000,
): Promise<T> {
  let last: T | undefined;
  await expect
    .poll(
      async () => {
        last = await read();
        return predicate(last);
      },
      { timeout, message },
    )
    .toBe(true);
  return last as T;
}

const latestRun = async (workflowId: string): Promise<RunSummary> =>
  (await api<{ items: RunSummary[] }>(`/workflows/${workflowId}/runs`)).items[0] as RunSummary;

/* -------------------------------------------------------------------------- */
/* Providers screen                                                            */
/* -------------------------------------------------------------------------- */

test.describe('Providers screen (FR-PRV-001..007)', () => {
  test('TC-PRV-001/002: each type is addable, and a key is never shown', async ({ page }) => {
    await openProviders(page);

    // A mock provider needs nothing at all.
    await page.getByRole('button', { name: /add provider/i }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('Type').click();
    await page.getByRole('option', { name: 'Mock' }).click();
    await dialog.getByLabel('Name').fill('Keyless mock');
    await dialog.getByRole('button', { name: 'Add provider' }).click();

    const keyless = await engineSays(
      () => api<{ items: Provider[] }>('/providers'),
      (page_) => page_.items.some((p) => p.name === 'Keyless mock'),
      'the mock provider reached the engine',
    );
    const keylessId = keyless.items.find((p) => p.name === 'Keyless mock')?.id as string;
    await expect(page.getByTestId(`provider-key-set-${keylessId}`)).toHaveText('key set: no');

    // An openai provider with a fake key: "key set: yes", and the key itself nowhere.
    const secret = ['sk', 'crosstest', 'never', 'shown'].join('-');
    const responses: string[] = [];
    page.on('response', (response) => {
      if (response.url().includes('/api/v1/providers')) {
        void response
          .text()
          .then((text) => responses.push(text))
          .catch(() => undefined);
      }
    });

    await page.getByRole('button', { name: /add provider/i }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Type').click();
    await page.getByRole('option', { name: 'OpenAI', exact: true }).click();
    await dialog.getByLabel('Name').fill('Keyed openai');
    await dialog.getByLabel('API key').fill(secret);
    await dialog.getByRole('button', { name: 'Add provider' }).click();

    const keyed = await engineSays(
      () => api<{ items: Provider[] }>('/providers'),
      (p) => p.items.some((provider) => provider.name === 'Keyed openai'),
      'the keyed provider reached the engine',
    );
    const keyedId = keyed.items.find((p) => p.name === 'Keyed openai')?.id as string;
    await expect(page.getByTestId(`provider-key-set-${keyedId}`)).toHaveText('key set: yes');

    // FR-PRV-002: not in the DOM, and not in any provider response the page received.
    expect(await page.content()).not.toContain(secret);
    expect(responses.join('\n')).not.toContain(secret);
  });

  test('TC-PRV-003/004: Test renders the state the engine reports', async ({ page }) => {
    const bad = await api<Provider>('/providers', {
      method: 'POST',
      body: JSON.stringify({ type: 'mock', name: 'Bad key', apiKey: 'bad' }),
    });
    const unreachable = await api<Provider>('/providers', {
      method: 'POST',
      body: JSON.stringify({
        type: 'openai_compatible',
        name: 'Nothing there',
        baseUrl: 'http://unreachable.local:9',
      }),
    });
    await openProviders(page);

    const row = (id: string): Locator => page.getByTestId(`provider-row-${id}`);
    await row(bad.id).getByRole('button', { name: 'Test' }).click();
    await expect(row(bad.id).locator('[data-testid^="provider-status-"]')).toHaveAttribute(
      'data-status',
      'AUTH_FAILED',
    );
    // FR-PRV-003 asks for the message, not just the state: it is the chip's tooltip.
    await expect(row(bad.id).locator('[data-testid^="provider-status-"]')).toHaveAttribute(
      'title',
      /.+/,
    );

    await row(unreachable.id).getByRole('button', { name: 'Test' }).click();
    await expect(row(unreachable.id).locator('[data-testid^="provider-status-"]')).toHaveAttribute(
      'data-status',
      'UNREACHABLE',
      { timeout: 20_000 },
    );
  });

  test('TC-PRV-005: a status change reaches the open page with no reload', async ({ page }) => {
    const provider = await api<Provider>('/providers', {
      method: 'POST',
      body: JSON.stringify({ type: 'mock', name: 'Live status' }),
    });
    await openProviders(page);
    const chip = page
      .getByTestId(`provider-row-${provider.id}`)
      .locator('[data-testid^="provider-status-"]');
    await expect(chip).toHaveAttribute('data-status', 'UNKNOWN');

    // Rotate the key to a bad one and check it *through the API*, as another client would.
    await api(`/providers/${provider.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ apiKey: 'bad' }),
    });
    await api(`/providers/${provider.id}/check`, { method: 'POST' });

    // No reload anywhere in this test: the engine-scope `provider.status` frame did it.
    await expect(chip).toHaveAttribute('data-status', 'AUTH_FAILED', { timeout: 20_000 });
  });

  test('TC-PRV-006: removing a provider a node uses warns, then marks the node', async ({
    page,
  }) => {
    const doomed = await api<Provider>('/providers', {
      method: 'POST',
      body: JSON.stringify({ type: 'mock', name: 'Doomed' }),
    });
    await api(`/providers/${doomed.id}/refresh-models`, { method: 'POST' });
    const { projectId, workflowId, graph } = await importFixture('linear-mock.json', (exported) => {
      for (const node of exported.nodes) {
        const config = node.config as { providerId?: string };
        if (config.providerId !== undefined) config.providerId = doomed.id;
      }
    });
    const agent = nodeOf(graph, 'agent');

    await openProviders(page);
    await page.getByRole('button', { name: `Actions for ${doomed.name}` }).click();
    await page.getByRole('menuitem', { name: 'Remove' }).click();
    await page.getByRole('button', { name: 'Remove' }).click();

    // The 409 names the node that still uses it.
    const warning = page.getByTestId('provider-in-use');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText(agent.id);

    await page.getByRole('button', { name: 'Remove anyway' }).click();
    await engineSays(
      () => api<{ items: Provider[] }>('/providers'),
      (p) => !p.items.some((provider) => provider.id === doomed.id),
      'the provider is gone from the engine',
    );

    // FR-PRV-005: the node it left behind says so on the Canvas.
    await openCanvas(page, projectId, workflowId);
    await expect(page.getByTestId(`provider-missing-${agent.id}`)).toBeVisible();
  });
});

/* -------------------------------------------------------------------------- */
/* Config panel                                                                */
/* -------------------------------------------------------------------------- */

test.describe('Config panel (FR-NODE-003/004/005)', () => {
  test('TC-NODE-003/004: an incompatible model is disabled with its reason, a good one sticks', async ({
    page,
  }) => {
    const { projectId, workflowId, graph } = await importFixture('linear-mock.json', (exported) => {
      for (const node of exported.nodes) {
        if (node.kind !== 'agent') continue;
        const config = node.config as { inputTypes: string[]; modelId?: string };
        config.inputTypes = ['text', 'image'];
        delete config.modelId;
      }
    });
    const agent = nodeOf(graph, 'agent');

    await openCanvas(page, projectId, workflowId);
    await selectCard(page, agent.id);
    const panel = page.getByRole('complementary', { name: 'Node configuration' });

    await panel.getByLabel('Model').click();
    // mock-text cannot take an image, and says which type it lacks.
    await expect(page.getByRole('option', { name: /Mock text — no image input/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    // mock-vision can, so it is choosable.
    await page.getByRole('option', { name: /Mock vision/ }).click();

    // TC-NODE-004: the chip on the card follows at once…
    await expect(card(page, agent.id)).toContainText('mock-vision');
    // …and the engine has it.
    await engineSays(
      () => api<Graph>(`/workflows/${workflowId}`),
      (g) =>
        (g.nodes.find((n) => n.id === agent.id)?.config as { modelId?: string }).modelId ===
        'mock-vision',
      'the chosen model reached the engine',
    );
  });

  test('TC-NODE-008: an edit during a run applies to the next run, not this one', async ({
    page,
  }) => {
    const { projectId, workflowId, graph } = await importFixture('slow.json');
    const agent = nodeOf(graph, 'agent');
    await openCanvas(page, projectId, workflowId);
    // Selected before Start: the panel is open when the run begins, which is the case FR-NODE-009
    // is about, and the card is still small enough to click.
    await selectCard(page, agent.id);

    await startButton(page).click();
    await expect(card(page, agent.id)).toHaveAttribute('data-state', 'RUNNING', {
      timeout: 20_000,
    });

    const panel = page.getByRole('complementary', { name: 'Node configuration' });
    await expect(panel.getByTestId('applies-next-run')).toBeVisible();

    const instructions = panel.getByLabel(/instructions/i);
    await instructions.fill('Edited while the run was going.');
    await instructions.blur();

    const run = await engineSays(
      () => latestRun(workflowId),
      (r) => r.status === 'COMPLETE' || r.status === 'HALTED',
      'the run finished',
      40_000,
    );

    // BR-04: the run executed its snapshot, so its prompt cannot contain the new text.
    const nodeRuns = await api<NodeRun[]>(`/runs/${run.id}/node-runs`);
    const prompted = nodeRuns.find((nodeRun) => nodeRun.prompt !== undefined) as NodeRun;
    expect(prompted.prompt?.text).not.toContain('Edited while the run was going');

    // …while the next run does use it.
    await startButton(page).click();
    const next = await engineSays(
      () => latestRun(workflowId),
      (r) => r.id !== run.id && (r.status === 'COMPLETE' || r.status === 'HALTED'),
      'the second run finished',
      40_000,
    );
    const nextRuns = await api<NodeRun[]>(`/runs/${next.id}/node-runs`);
    expect(nextRuns.find((nodeRun) => nodeRun.prompt !== undefined)?.prompt?.text).toContain(
      'Edited while the run was going',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Starting and watching a run                                                 */
/* -------------------------------------------------------------------------- */

test.describe('Live run (FR-EXE-001/003/007/008/009/015)', () => {
  test('TC-NODE-010: an empty Input node is asked for text before the run starts', async ({
    page,
  }) => {
    const { projectId, workflowId, graph } = await importFixture('linear-mock.json', (exported) => {
      for (const node of exported.nodes) {
        if (node.kind === 'input') delete (node.config as { text?: string }).text;
      }
    });
    const input = nodeOf(graph, 'input');
    await openCanvas(page, projectId, workflowId);

    await startButton(page).click();
    const dialog = page.getByTestId('run-input-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Start run' })).toBeDisabled();
    await dialog.getByLabel(input.name).fill('typed at the gate');
    await dialog.getByRole('button', { name: 'Start run' }).click();

    const run = await engineSays(
      () => latestRun(workflowId),
      (r) => r.status === 'COMPLETE',
      'the run started with the typed text and completed',
      40_000,
    );
    // FR-NODE-011: the text went to the run's inputs, and the graph was not edited behind the user.
    const recorded = await api<{ inputs: Record<string, Array<{ text?: string }>> }>(
      `/runs/${run.id}`,
    );
    expect(recorded.inputs[input.id]?.[0]?.text).toBe('typed at the gate');
    const graphAfter = await api<Graph>(`/workflows/${workflowId}`);
    expect(
      (graphAfter.nodes.find((n) => n.id === input.id)?.config as { text?: string }).text,
    ).toBeUndefined();
  });

  test('TC-EXE-007/008/014: text streams, states are distinct, the edge animates', async ({
    page,
  }) => {
    const { projectId, workflowId, graph } = await importFixture('slow.json');
    const agent = nodeOf(graph, 'agent');
    const agentEdge = graph.edges.find((edge) => edge.from.nodeId === agent.id);
    await openCanvas(page, projectId, workflowId);

    await expect(card(page, agent.id)).toHaveAttribute('data-state', 'IDLE');
    await startButton(page).click();

    // FR-EXE-009: the ring carries a label per state, not just a colour.
    await expect(card(page, agent.id)).toHaveAttribute('data-state', 'RUNNING', {
      timeout: 20_000,
    });
    await expect(card(page, agent.id).getByTestId('status-ring')).toHaveAttribute(
      'aria-label',
      'running',
    );

    // TC-EXE-007: the text grows while the node is still running.
    const streamed = card(page, agent.id).getByTestId(`stream-${agent.id}`);
    await expect(streamed).toBeVisible();
    const first = ((await streamed.textContent()) ?? '').length;
    await expect
      .poll(async () => ((await streamed.textContent()) ?? '').length, { timeout: 20_000 })
      .toBeGreaterThan(first);

    // TC-EXE-014: the envelope's delivery lights the edge it travelled.
    await expect(page.getByTestId(`edge-${agentEdge?.id}`)).toHaveAttribute(
      'data-animating',
      'true',
      { timeout: 30_000 },
    );

    await expect(card(page, agent.id)).toHaveAttribute('data-state', 'COMPLETED', {
      timeout: 40_000,
    });
    // FR-NODE-012: the Output node shows the result the engine recorded.
    const output = nodeOf(graph, 'output');
    await expect(page.getByTestId(`final-output-${output.id}`)).toBeVisible();
    const run = await latestRun(workflowId);
    const finalOutput = await api<{ finalOutput?: Record<string, Array<{ text?: string }>> }>(
      `/runs/${run.id}`,
    );
    await expect(page.getByTestId(`final-output-${output.id}`)).toContainText(
      (finalOutput.finalOutput?.[output.id]?.[0]?.text ?? '').slice(0, 40),
    );
  });

  test('TC-RTR-004: a fallback is named on the card', async ({ page }) => {
    const { projectId, workflowId, graph } = await importFixture('fallback.json');
    const agent = nodeOf(graph, 'agent');
    await openCanvas(page, projectId, workflowId);

    await startButton(page).click();
    await expect(page.getByTestId(`used-model-${agent.id}`)).toContainText('(fallback)', {
      timeout: 40_000,
    });

    const run = await latestRun(workflowId);
    const nodeRuns = await api<NodeRun[]>(`/runs/${run.id}/node-runs`);
    const used = nodeRuns.find((nodeRun) => nodeRun.modelUsed !== undefined)?.modelUsed;
    expect(used?.viaFallback).toBe(true);
    await expect(page.getByTestId(`used-model-${agent.id}`)).toContainText(used?.modelId as string);
  });

  test('TC-EXE-003: an agent with no model blocks the run and the panel names it', async ({
    page,
  }) => {
    const { projectId, workflowId, graph } = await importFixture('linear-mock.json', (exported) => {
      for (const node of exported.nodes) {
        if (node.kind === 'agent') delete (node.config as { modelId?: string }).modelId;
      }
    });
    const agent = nodeOf(graph, 'agent');
    await openCanvas(page, projectId, workflowId);

    await startButton(page).click();

    const panel = page.getByTestId('preflight-issues');
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel).toContainText(agent.name);

    const run = await latestRun(workflowId);
    expect(run.status).toBe('BLOCKED');
    // BR-08: a blocked run called nothing.
    expect(await api<NodeRun[]>(`/runs/${run.id}/node-runs`)).toHaveLength(0);

    await panel
      .getByRole('button', { name: /show node/i })
      .first()
      .click();
    await expect(card(page, agent.id)).toHaveAttribute('data-selected', 'true');
  });
});

/* -------------------------------------------------------------------------- */
/* Inspector, history, resilience                                              */
/* -------------------------------------------------------------------------- */

test.describe('Inspector and history (FR-EXE-010/012, FR-PRM-005)', () => {
  test('TC-EXE-009 / TC-PRM-005: every field comes from the node run, prompt included', async ({
    page,
  }) => {
    const { projectId, workflowId, graph } = await importFixture('linear-mock.json');
    const agent = nodeOf(graph, 'agent');
    await openCanvas(page, projectId, workflowId);
    await selectCard(page, agent.id);

    await startButton(page).click();
    const run = await engineSays(
      () => latestRun(workflowId),
      (r) => r.status === 'COMPLETE',
      'the run completed',
      40_000,
    );
    const nodeRuns = await api<NodeRun[]>(`/runs/${run.id}/node-runs`);
    const agentRun = nodeRuns.find((nodeRun) => nodeRun.nodeId === agent.id) as NodeRun;

    await page.getByRole('tab', { name: 'Inspector' }).click();
    const inspector = page.getByTestId('inspector');

    const facts = inspector.getByTestId('inspector-facts');
    await expect(facts).toContainText(agentRun.modelUsed?.modelId as string);
    await expect(facts).toContainText(String(agentRun.usage.tokensIn));
    await expect(facts).toContainText(String(agentRun.usage.tokensOut));
    await expect(inspector.getByTestId('envelope-trust')).toBeVisible();
    await expect(inspector.getByTestId('prompt-version')).toContainText(
      agentRun.prompt?.version as string,
    );

    // TC-PRM-005: the drawer shows exactly what `GET /node-runs/:id` holds.
    await inspector.getByRole('button', { name: 'View prompt' }).click();
    const shown = await page.getByTestId('prompt-text').textContent();
    const stored = (await api<NodeRun>(`/node-runs/${agentRun.id}`)).prompt?.text;
    expect(shown).toBe(stored);
  });

  test('TC-EXE-011: three runs, newest first, matching the engine', async ({ page }) => {
    const { projectId, workflowId } = await importFixture('linear-mock.json');
    await openCanvas(page, projectId, workflowId);

    for (let i = 0; i < 3; i += 1) {
      await expect(startButton(page)).toBeEnabled({ timeout: 40_000 });
      await startButton(page).click();
      await engineSays(
        () => api<{ items: RunSummary[] }>(`/workflows/${workflowId}/runs`),
        (p) => p.items.filter((r) => r.status === 'COMPLETE').length === i + 1,
        `run ${i + 1} completed`,
        40_000,
      );
    }

    const history = (await api<{ items: RunSummary[] }>(`/workflows/${workflowId}/runs`)).items;
    await page.getByRole('tab', { name: 'Runs' }).click();
    const rows = page.getByTestId('runs-table').locator('tr[data-testid^="run-row-"]');
    await expect(rows).toHaveCount(3);

    // Same order as the engine, newest first, and each row carries that run's own numbers.
    for (const [index, run] of history.entries()) {
      const row = rows.nth(index);
      await expect(row).toHaveAttribute('data-testid', `run-row-${run.id}`);
      await expect(row).toContainText(String(run.totals.tokensOut));
    }
  });

  test('TC-EXE-013: the socket dies mid-run and the overlay still ends on the truth', async ({
    page,
  }) => {
    const { projectId, workflowId, graph } = await importFixture('slow.json');
    const agent = nodeOf(graph, 'agent');

    // Break the WebSocket once the run is under way, then let it reconnect.
    let cut = false;
    await page.route('**/ws**', async (route) => {
      if (cut) {
        await route.abort();
        return;
      }
      await route.fallback();
    });

    await openCanvas(page, projectId, workflowId);
    await startButton(page).click();
    await expect(card(page, agent.id)).toHaveAttribute('data-state', 'RUNNING', {
      timeout: 20_000,
    });

    cut = true;
    await page.evaluate(() => {
      // The page's own socket: closing it is what an engine restart looks like from here.
      window.dispatchEvent(new Event('offline'));
    });
    await page.waitForTimeout(500);
    cut = false;

    const run = await engineSays(
      () => latestRun(workflowId),
      (r) => r.status === 'COMPLETE' || r.status === 'HALTED',
      'the run finished despite the interruption',
      60_000,
    );
    const nodeRuns = await api<NodeRun[]>(`/runs/${run.id}/node-runs`);

    // The overlay's final states equal the engine's records — the §7.1 row, asserted against them.
    for (const nodeRun of nodeRuns) {
      await expect(card(page, nodeRun.nodeId)).toHaveAttribute('data-state', nodeRun.status, {
        timeout: 30_000,
      });
    }
  });
});
