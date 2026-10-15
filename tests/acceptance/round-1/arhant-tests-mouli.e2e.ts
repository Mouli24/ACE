import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Round 1 cross-test: verifying Mouli's M1 web shell and Canvas
 * (`docs/team-prompts/01-round-1-skeleton.md` §8.1).
 *
 * Playwright drives the **real UI** against the **real engine** — the temp-database engine started
 * by `helpers/start-for-playwright.ts` and the production build served by `vite preview`. No MSW,
 * no mock socket: whatever passes here is true of the seam between the two halves.
 *
 * Every "is it saved?" assertion asks the engine over REST rather than trusting the page, because
 * the point of the exercise is that the UI and the engine agree.
 */

interface EngineHandle {
  url: string;
  wsUrl: string;
  token: string;
}

/** `start-for-playwright.ts` drops the engine's address and token here (Playwright cannot pass it back). */
function engine(): EngineHandle {
  const handleFile = fileURLToPath(new URL('../.playwright-engine.json', import.meta.url));
  return JSON.parse(readFileSync(handleFile, 'utf8')) as EngineHandle;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function newId(now = Date.now()): string {
  let time = now;
  let out = '';
  for (let i = 0; i < 10; i += 1) {
    const mod = time % 32;
    out = CROCKFORD[mod] + out;
    time = (time - mod) / 32;
  }
  for (let i = 0; i < 16; i += 1) out += CROCKFORD[Math.floor(Math.random() * 32)];
  return out;
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

interface Workflow {
  id: string;
  projectId: string;
  version: number;
  name: string;
}
interface Port {
  id: string;
  name: string;
  dataType: string;
  multi: boolean;
}
interface Node {
  id: string;
  kind: string;
  name: string;
  position: { x: number; y: number };
  inputs: Port[];
  outputs: Port[];
  config: Record<string, unknown>;
}
interface Edge {
  id: string;
  from: { nodeId: string; portId: string };
  to: { nodeId: string; portId: string };
}
interface Graph {
  workflow: Workflow;
  nodes: Node[];
  edges: Edge[];
}

/** A project and an empty workflow, created through the engine so the UI starts from server truth. */
async function seedWorkflow(name = 'cross'): Promise<{ projectId: string; workflowId: string }> {
  // D351: the provider the picker is answered with exists before the page loads its providers
  await mockProvider();
  const project = await api<{ id: string }>('/projects', {
    method: 'POST',
    body: JSON.stringify({ name: `${name}-${newId().slice(-6)}` }),
  });
  const workflow = await api<Workflow>(`/projects/${project.id}/workflows`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  return { projectId: project.id, workflowId: workflow.id };
}

const graphOf = (workflowId: string): Promise<Graph> => api<Graph>(`/workflows/${workflowId}`);

/** The web app takes its session token from `?token=` on first load (§2.10). */
async function openCanvas(page: Page, projectId: string, workflowId: string): Promise<void> {
  const { token } = engine();
  await page.goto(`/projects/${projectId}/workflows/${workflowId}?token=${token}`);
  await expect(page.getByTestId('canvas')).toBeVisible();
}

const flowNode = (page: Page, id: string): Locator =>
  page.locator(`.react-flow__node[data-id="${id}"]`);
const nodeCard = (page: Page, id: string): Locator => page.getByTestId(`node-card-${id}`);
const portHandle = (page: Page, nodeId: string, dir: 'in' | 'out', name: string): Locator =>
  page.getByTestId(`port-${nodeId}:${dir}:${name}`);
/** The node settings modal (D333), when open: what the old sheet's Configure tab was. */
const settingsDialog = (page: Page): Locator =>
  page.getByRole('dialog').filter({ has: page.getByTestId('config-panel') });
const configPanel = (page: Page): Locator =>
  settingsDialog(page).getByRole('region', { name: 'Node configuration' });

/** Wait until the engine has the graph the page thinks it has. */
async function serverHas(
  workflowId: string,
  predicate: (graph: Graph) => boolean,
  message: string,
): Promise<Graph> {
  let last: Graph | undefined;
  await expect
    .poll(
      async () => {
        last = await graphOf(workflowId);
        return predicate(last);
      },
      { timeout: 10_000, message },
    )
    .toBe(true);
  return last as Graph;
}

/** One mock provider with its catalogue fetched, shared by every test here (D351 asks for one). */
const PICKER_PROVIDER = 'R1 mock';
async function mockProvider(): Promise<string> {
  const { items } = await api<{ items: Array<{ id: string; type: string; name: string }> }>(
    '/providers?limit=500',
  );
  const known = items.find((p) => p.type === 'mock' && p.name === PICKER_PROVIDER);
  if (known !== undefined) return known.id;
  const created = await api<{ id: string }>('/providers', {
    method: 'POST',
    body: JSON.stringify({ type: 'mock', name: PICKER_PROVIDER }),
  });
  await api(`/providers/${created.id}/refresh-models`, { method: 'POST' });
  return created.id;
}

/**
 * D351 (PG-1.3): an Agent is not created until a provider and a model are picked. Answer the
 * picker with the mock provider and its first available model, the way a person would.
 */
async function answerProviderPicker(
  page: Page,
  { keyboard = false }: { keyboard?: boolean } = {},
): Promise<void> {
  const providerId = await mockProvider();
  const picker = page.getByTestId('provider-picker');
  await expect(picker).toBeVisible();
  // `keyboard`: focus and Enter, as the keyboard-only test drives every other control
  const press = async (target: Locator): Promise<void> => {
    if (!keyboard) return target.click();
    await target.focus();
    await page.keyboard.press('Enter');
  };
  await press(picker.getByTestId(`picker-provider-${providerId}`));
  await press(
    picker
      .getByRole('listbox', { name: /Model/ })
      .locator('[role="option"]:not([disabled])')
      .first(),
  );
  await press(picker.getByRole('button', { name: /^(Add node|Duplicate|Use this model)$/ }));
  await expect(picker).toHaveCount(0);
}

/*
 * Ace UI layout (D330–D333): the Canvas's "Add node" pill adds an Agent after the last stage,
 * linked to it, and opens its settings; the empty-Canvas menu's "Add Agent" adds one that is not
 * linked. A click on a card selects it and opens its settings modal (the old sheet's Configure
 * tab), which covers the Canvas until it is closed.
 */

/** Close the node settings modal if it is open (Done commits whatever is still waiting). */
async function closeSettings(page: Page): Promise<void> {
  const dialog = settingsDialog(page);
  if (await dialog.isVisible()) await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toHaveCount(0);
}

/**
 * The Canvas's "Add node" pill (D332): an Agent after the last stage, linked to it by a data edge,
 * selected, with its settings open — closed again unless `keepOpen`.
 */
async function addStage(page: Page, { keepOpen = false } = {}): Promise<void> {
  await closeSettings(page);
  await page.getByTestId('new-node-button').click();
  // D351: the provider/model picker comes first, then the node and its settings
  await answerProviderPicker(page);
  await expect(settingsDialog(page)).toBeVisible();
  if (!keepOpen) await closeSettings(page);
}

/** A point on the empty Canvas: the pane itself, no card, edge or control over it. */
async function emptyCanvasPoint(page: Page): Promise<{ x: number; y: number }> {
  const point = await page.getByTestId('canvas').evaluate((canvas) => {
    const box = canvas.getBoundingClientRect();
    for (let fy = 0.3; fy <= 0.85; fy += 0.05) {
      for (let fx = 0.08; fx <= 0.7; fx += 0.04) {
        const x = box.left + box.width * fx;
        const y = box.top + box.height * fy;
        const hit = document.elementFromPoint(x, y);
        if (
          hit?.closest('.react-flow__pane') &&
          !hit.closest('.react-flow__node, .react-flow__edge, button, [role="button"]')
        ) {
          return { x, y };
        }
      }
    }
    return null;
  });
  expect(point, 'some of the Canvas is empty').not.toBeNull();
  return point as { x: number; y: number };
}

/**
 * The empty-Canvas menu's "Add Agent" (FR-CAN-011): an Agent where the Canvas was right-clicked,
 * linked to nothing — what the old New node dialog added, for the tests that wire it themselves.
 */
async function addAgentFromMenu(page: Page): Promise<void> {
  await closeSettings(page);
  await closeSheet(page);
  const point = await emptyCanvasPoint(page);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Add Agent' }).click();
  // D351: the Agent is created only once the picker is answered
  await answerProviderPicker(page);
}

/** Close the workflow sheet (and the settings modal) when open, so the whole Canvas can be clicked. */
async function closeSheet(page: Page): Promise<void> {
  await closeSettings(page);
  const close = page.getByTestId('workflow-sheet').getByRole('button', { name: 'Close panel' });
  if (await close.isVisible()) await close.click();
  await expect(page.getByTestId('workflow-sheet')).toHaveCount(0);
}

/**
 * Select a card, bringing it into view first (React Flow drops off-viewport nodes). The click opens
 * its settings modal too (D333).
 */
async function selectNode(page: Page, nodeId: string): Promise<void> {
  await closeSheet(page);
  await fitView(page);
  await clearOfMinimap(page, nodeCard(page, nodeId));
  await nodeCard(page, nodeId).click();
  await expect(nodeCard(page, nodeId)).toHaveAttribute('data-selected', 'true');
}

/** Select a card and return its settings modal's configuration region. */
async function configureNode(page: Page, nodeId: string): Promise<Locator> {
  await selectNode(page, nodeId);
  await expect(configPanel(page)).toBeVisible();
  return configPanel(page);
}

/** Bring every node into view before touching its ports, the way a user presses F. */
async function fitView(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Fit to view' }).click();
  await page.waitForTimeout(400);
}

const overlaps = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Zoom out until no handle sits under the minimap (bottom right of the Canvas at 1280×720). */
async function clearOfMinimap(page: Page, ...targets: Locator[]): Promise<void> {
  const minimap = page.getByTestId('canvas-minimap');
  for (let step = 0; step < 6; step += 1) {
    const map = await minimap.boundingBox();
    const boxes = await Promise.all(targets.map((target) => target.boundingBox()));
    if (!map || boxes.every((box) => !box || !overlaps(box, map))) return;
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await page.waitForTimeout(300);
  }
  throw new Error('a handle is still under the minimap after zooming out');
}

async function dragConnect(page: Page, from: Locator, to: Locator): Promise<void> {
  // every card in view first: React Flow does not render nodes outside the viewport — and nothing
  // over the handles (the settings modal, the sheet, the minimap)
  await closeSheet(page);
  await fitView(page);
  await clearOfMinimap(page, from, to);
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (!a || !b) throw new Error('a handle has no box');
  const [ax, ay] = [a.x + a.width / 2, a.y + a.height / 2];
  const [bx, by] = [b.x + b.width / 2, b.y + b.height / 2];
  await page.mouse.move(ax, ay);
  await page.mouse.down();
  for (let i = 1; i <= 15; i += 1) {
    await page.mouse.move(ax + ((bx - ax) * i) / 15, ay + ((by - ay) * i) / 15);
  }
  await page.mouse.up();
}

/* -------------------------------------------------------------------------- */

test.describe('M1 against the real engine (§8.1)', () => {
  test('TC-CAN-003: move a node, reload → the position comes back from the server', async ({
    page,
  }) => {
    const { projectId, workflowId } = await seedWorkflow('move');
    await openCanvas(page, projectId, workflowId);
    await addStage(page);
    const graph = await serverHas(
      workflowId,
      (g) => g.nodes.length === 1,
      'the node reaches the engine',
    );
    const node = graph.nodes[0] as Node;

    const card = flowNode(page, node.id);
    const before = (await card.boundingBox()) as { x: number; y: number };
    await page.mouse.move(before.x + 40, before.y + 20);
    await page.mouse.down();
    for (let i = 1; i <= 12; i += 1) {
      await page.mouse.move(before.x + 40 + (140 * i) / 12, before.y + 20 + (90 * i) / 12);
    }
    await page.mouse.up();

    const moved = await serverHas(
      workflowId,
      (g) => (g.nodes[0] as Node).position.x !== node.position.x,
      'the move is persisted',
    );
    const saved = (moved.nodes[0] as Node).position;

    await page.reload();
    await expect(flowNode(page, node.id)).toBeVisible();
    const style = await flowNode(page, node.id).getAttribute('style');
    expect(style).toContain(`translate(${saved.x}px, ${saved.y}px)`);
    expect((await graphOf(workflowId)).nodes[0]?.position).toEqual(saved);
  });

  test('TC-WF-004: add a node, reload → still there (autosave went through graph-ops)', async ({
    page,
  }) => {
    const { projectId, workflowId } = await seedWorkflow('autosave');
    await openCanvas(page, projectId, workflowId);
    // D285, D332: "Add node" adds one kind, an Agent
    await addStage(page);
    await addStage(page);
    await serverHas(workflowId, (g) => g.nodes.length === 2, 'both nodes reach the engine');

    await page.reload();
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    const graph = await graphOf(workflowId);
    expect(graph.nodes.map((n) => n.kind).sort()).toEqual(['agent', 'agent']);
    expect(graph.workflow.version).toBeGreaterThan(0);
  });

  test('TC-WF-005: two browser contexts, the stale one gets 409 and still shows the latest graph', async ({
    browser,
  }) => {
    const { projectId, workflowId } = await seedWorkflow('conflict');
    const { token } = engine();

    const first = await browser.newContext();
    const second = await browser.newContext();
    const pageA = await first.newPage();
    const pageB = await second.newPage();

    const conflicts: number[] = [];
    pageB.on('response', (response) => {
      if (response.url().includes('/graph-ops')) conflicts.push(response.status());
    });

    await pageA.goto(`/projects/${projectId}/workflows/${workflowId}?token=${token}`);
    await pageB.goto(`/projects/${projectId}/workflows/${workflowId}?token=${token}`);
    await expect(pageA.getByTestId('canvas')).toBeVisible();
    await expect(pageB.getByTestId('canvas')).toBeVisible();

    // A writes first; B still believes in the older version
    await addStage(pageA);
    await serverHas(workflowId, (g) => g.nodes.length === 1, 'A saved');

    await addStage(pageB);
    const graph = await serverHas(workflowId, (g) => g.nodes.length === 2, 'B recovered and saved');

    // nothing was lost and B ends up agreeing with the server
    expect(graph.nodes.map((n) => n.kind).sort()).toEqual(['agent', 'agent']);
    await expect(pageB.locator('.react-flow__node').first()).toBeVisible();
    await expect(pageA.locator('.react-flow__node').first()).toBeVisible();
    if (conflicts.includes(409)) expect(conflicts.at(-1)).toBe(200);

    await first.close();
    await second.close();
  });

  test('TC-CON-002: text output → image-only input is refused with a reason', async ({ page }) => {
    const { projectId, workflowId } = await seedWorkflow('types');
    await openCanvas(page, projectId, workflowId);
    // two Agents linked to nothing (the empty-Canvas menu; "Add node" would link them itself)
    await addAgentFromMenu(page);
    await addAgentFromMenu(page);
    const graph = await serverHas(workflowId, (g) => g.nodes.length === 2, 'both nodes exist');
    const [input, agent] = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)) as [
      Node,
      Node,
    ];

    // D285: the config panel no longer offers typed ports, but a workflow made before it can hold
    // an image-only agent — written through the engine — and the Canvas must still refuse it.
    await api(`/workflows/${workflowId}/graph-ops`, {
      method: 'POST',
      body: JSON.stringify({
        baseVersion: graph.workflow.version,
        ops: [
          { op: 'update_node', nodeId: agent.id, patch: { config: { inputTypes: ['image'] } } },
        ],
      }),
    });
    // a fresh load, as a workflow saved that way would open: the Canvas measures the new handle
    await page.reload();
    await expect(portHandle(page, agent.id, 'in', 'image')).toBeVisible();

    await fitView(page);
    await dragConnect(
      page,
      portHandle(page, input.id, 'out', 'text'),
      portHandle(page, agent.id, 'in', 'image'),
    );

    await expect(page.getByText('Connection refused').first()).toBeVisible();
    await expect(page.getByText(/image/i).first()).toBeVisible();
    await expect(page.locator('.react-flow__edge')).toHaveCount(0);
    expect((await graphOf(workflowId)).edges).toHaveLength(0);
  });

  test('TC-CON-003: A→B then B→A as a plain edge is refused with a reason', async ({ page }) => {
    const { projectId, workflowId } = await seedWorkflow('cycle');
    await openCanvas(page, projectId, workflowId);
    // unlinked, so the first edge is the one drawn here
    await addAgentFromMenu(page);
    await addAgentFromMenu(page);
    const graph = await serverHas(workflowId, (g) => g.nodes.length === 2, 'two agents exist');
    const [a, b] = graph.nodes as [Node, Node];

    await dragConnect(
      page,
      portHandle(page, a.id, 'out', 'text'),
      portHandle(page, b.id, 'in', 'text'),
    );
    await serverHas(workflowId, (g) => g.edges.length === 1, 'the first edge is saved');

    await dragConnect(
      page,
      portHandle(page, b.id, 'out', 'text'),
      portHandle(page, a.id, 'in', 'text'),
    );
    await expect(page.getByText('Connection refused').first()).toBeVisible();
    await expect(page.getByText(/cycle/i).first()).toBeVisible();

    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
    expect((await graphOf(workflowId)).edges).toHaveLength(1);
  });

  test('TC-CON-006: a second edge into a single-input port is refused', async ({ page }) => {
    const { projectId, workflowId } = await seedWorkflow('arity');
    await openCanvas(page, projectId, workflowId);
    // D285: two source Agents and a target Agent, oldest first, none of them linked yet
    await addAgentFromMenu(page);
    await addAgentFromMenu(page);
    await addAgentFromMenu(page);
    const graph = await serverHas(workflowId, (g) => g.nodes.length === 3, 'three nodes exist');
    const [first, second, agent] = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)) as [
      Node,
      Node,
      Node,
    ];
    const inputs = [first, second];

    await fitView(page);
    await dragConnect(
      page,
      portHandle(page, (inputs[0] as Node).id, 'out', 'text'),
      portHandle(page, agent.id, 'in', 'text'),
    );
    await serverHas(workflowId, (g) => g.edges.length === 1, 'the first edge is saved');

    await dragConnect(
      page,
      portHandle(page, (inputs[1] as Node).id, 'out', 'text'),
      portHandle(page, agent.id, 'in', 'text'),
    );
    await expect(page.getByText(/only one|already has a connection/i).first()).toBeVisible();
    expect((await graphOf(workflowId)).edges).toHaveLength(1);
  });

  test('TC-NODE-002: fill every Agent field, reload → every value is on the server', async ({
    page,
  }) => {
    const { projectId, workflowId } = await seedWorkflow('config');
    await openCanvas(page, projectId, workflowId);
    await addStage(page, { keepOpen: true });
    const seeded = await serverHas(workflowId, (g) => g.nodes.length === 1, 'the agent exists');
    const agent = seeded.nodes[0] as Node;

    // the new node is selected; its settings modal is open on it (D333)
    const panel = configPanel(page);
    await expect(panel).toBeVisible();

    await panel.getByLabel('Persona name').fill('Reviewer');
    await panel.getByLabel('Persona name').press('Enter');
    await panel.getByLabel('System prompt').fill('Review the draft and answer in JSON.');
    await panel.getByLabel('System prompt').blur();
    await panel.getByLabel('Temperature').fill('0.2');
    await panel.getByLabel('Temperature').blur();
    await panel.getByLabel('Max tokens').fill('1024');
    await panel.getByLabel('Max tokens').blur();
    await panel.getByLabel('Timeout (ms)').fill('30000');
    await panel.getByLabel('Timeout (ms)').blur();
    await panel.getByLabel('Retries').fill('1');
    await panel.getByLabel('Retries').blur();
    await panel.getByLabel('Context budget (tokens)').fill('8000');
    await panel.getByLabel('Context budget (tokens)').blur();
    await panel.getByLabel('Routing policy').click();
    await page.getByRole('option', { name: 'fallback' }).click();

    const saved = await serverHas(
      workflowId,
      (g) => {
        const config = (g.nodes[0] as Node).config as {
          instructions?: string;
          execution?: {
            temperature?: number;
            maxTokens?: number;
            timeoutMs?: number;
            retries?: number;
          };
          contextPolicy?: { budgetTokens?: number };
          routing?: { policy?: string };
        };
        return (
          (g.nodes[0] as Node).name === 'Reviewer' &&
          config.instructions === 'Review the draft and answer in JSON.' &&
          config.execution?.temperature === 0.2 &&
          config.execution?.maxTokens === 1024 &&
          config.execution?.timeoutMs === 30_000 &&
          config.execution?.retries === 1 &&
          config.contextPolicy?.budgetTokens === 8000 &&
          config.routing?.policy === 'fallback'
        );
      },
      'every field reaches the engine',
    );

    // and the UI shows the same values after a reload
    await page.reload();
    const reloaded = await configureNode(page, agent.id);
    await expect(reloaded.getByLabel('Persona name')).toHaveValue('Reviewer');
    await expect(reloaded.getByLabel('System prompt')).toHaveValue(
      'Review the draft and answer in JSON.',
    );
    await expect(reloaded.getByLabel('Temperature')).toHaveValue('0.2');
    await expect(reloaded.getByLabel('Context budget (tokens)')).toHaveValue('8000');
    // D285: a goal-driven node answers in text — one text port, no typed outputs to wire
    expect((saved.nodes[0] as Node).outputs.map((p) => p.name)).toEqual(['text']);
  });

  test('TC-NODE-006: temperature 5 shows an inline error and never reaches the engine', async ({
    page,
  }) => {
    const { projectId, workflowId } = await seedWorkflow('range');
    await openCanvas(page, projectId, workflowId);
    // the new Agent's settings open with it (D333)
    await addStage(page, { keepOpen: true });
    await serverHas(workflowId, (g) => g.nodes.length === 1, 'the agent exists');
    const versionBefore = (await graphOf(workflowId)).workflow.version;

    const panel = configPanel(page);
    await panel.getByLabel('Temperature').fill('5');
    await panel.getByLabel('Temperature').blur();

    await expect(panel.getByRole('alert').first()).toContainText(/between 0 and 2/i);
    await expect(panel.getByLabel('Temperature')).toHaveAttribute('aria-invalid', 'true');

    await page.waitForTimeout(1000);
    const after = await graphOf(workflowId);
    expect(after.workflow.version).toBe(versionBefore);
    const config = (after.nodes[0] as Node).config as { execution?: { temperature?: number } };
    expect(config.execution?.temperature).toBe(0.7);
  });

  test('TC-CAN-009: on a slow link the Canvas shows a loading state, then the whole graph at once', async ({
    page,
  }) => {
    const { projectId, workflowId } = await seedWorkflow('slow');
    const { token } = engine();

    // build a three-node, two-edge graph through the engine
    await page.goto(`/projects/${projectId}/workflows/${workflowId}?token=${token}`);
    await expect(page.getByTestId('canvas')).toBeVisible();
    // D285: a chain of three Agents, oldest first, wired below
    await addAgentFromMenu(page);
    await addAgentFromMenu(page);
    await addAgentFromMenu(page);
    const built = await serverHas(workflowId, (g) => g.nodes.length === 3, 'three nodes exist');
    const [input, agent, output] = [...built.nodes].sort((a, b) => a.id.localeCompare(b.id)) as [
      Node,
      Node,
      Node,
    ];
    await dragConnect(
      page,
      portHandle(page, input.id, 'out', 'text'),
      portHandle(page, agent.id, 'in', 'text'),
    );
    await dragConnect(
      page,
      portHandle(page, agent.id, 'out', 'text'),
      portHandle(page, output.id, 'in', 'text'),
    );
    await serverHas(workflowId, (g) => g.edges.length === 2, 'two edges exist');

    // Slow 3G on the graph fetch only
    await page.route(`**/api/v1/workflows/${workflowId}`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });

    await page.goto(`/projects/${projectId}/workflows/${workflowId}`);
    await expect(page.getByTestId('canvas-loading')).toBeVisible();
    expect(await page.locator('.react-flow__node').count()).toBe(0);
    expect(await page.locator('.react-flow__edge').count()).toBe(0);

    await expect(page.getByTestId('canvas-loading')).toBeHidden({ timeout: 10_000 });
    // the first frame after the loading state already carries the whole graph
    expect(await page.locator('.react-flow__node').count()).toBe(3);
    expect(await page.locator('.react-flow__edge').count()).toBe(2);
  });

  test('TC-CAN-004 / TC-CAN-005: delete leaves no dangling edge; duplicate is independent', async ({
    page,
  }) => {
    const { projectId, workflowId } = await seedWorkflow('delete-dup');
    await openCanvas(page, projectId, workflowId);
    // D285: a source Agent feeding the Agent under test, oldest first, wired below
    await addAgentFromMenu(page);
    await addAgentFromMenu(page);
    const graph = await serverHas(workflowId, (g) => g.nodes.length === 2, 'two nodes exist');
    const [input, agent] = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)) as [
      Node,
      Node,
    ];

    await dragConnect(
      page,
      portHandle(page, input.id, 'out', 'text'),
      portHandle(page, agent.id, 'in', 'text'),
    );
    await serverHas(workflowId, (g) => g.edges.length === 1, 'the edge is saved');

    // duplicate the agent and give the copy a different name
    await configureNode(page, agent.id);
    await configPanel(page).getByLabel('System prompt').fill('original');
    await configPanel(page).getByLabel('System prompt').blur();
    await serverHas(
      workflowId,
      (g) =>
        (g.nodes.find((n) => n.id === agent.id)?.config as { instructions?: string })
          .instructions === 'original',
      'the instruction is saved',
    );

    // the open modal covers the Canvas (and keeps the keyboard); "Duplicate selected nodes" is
    // Ctrl+D on the selection now (D332)
    await closeSettings(page);
    await expect(nodeCard(page, agent.id)).toHaveAttribute('data-selected', 'true');
    await page.keyboard.press('Control+d');
    const dup = await serverHas(workflowId, (g) => g.nodes.length === 3, 'the copy is saved');
    const copy = dup.nodes.find((n) => n.id !== agent.id && n.id !== input.id) as Node;
    expect((copy.config as { instructions?: string }).instructions).toBe('original');
    // the copy is offset and does not cover the original, whose ports must stay reachable
    const apart =
      Math.abs(copy.position.x - agent.position.x) >= 200 ||
      Math.abs(copy.position.y - agent.position.y) >= 120;
    expect(apart).toBe(true);

    // the copy is the selection now (soft, so the rest — independence and delete — is still checked
    // when it is not); its settings open on it
    await expect.soft(nodeCard(page, copy.id)).toHaveAttribute('data-selected', 'true');
    await configureNode(page, copy.id);
    await configPanel(page).getByLabel('Persona name').fill('Copy');
    await configPanel(page).getByLabel('Persona name').press('Enter');
    await serverHas(
      workflowId,
      (g) => g.nodes.find((n) => n.id === copy.id)?.name === 'Copy',
      'the copy is renamed',
    );
    expect((await graphOf(workflowId)).nodes.find((n) => n.id === agent.id)?.name).toBe('Agent');

    // delete the connected original: its edge must go with it (the click on it opened its settings,
    // which keep the keyboard to themselves until they close)
    await selectNode(page, agent.id);
    await closeSettings(page);
    await page.keyboard.press('Delete');
    const afterDelete = await serverHas(
      workflowId,
      (g) => g.nodes.every((n) => n.id !== agent.id),
      'the node is deleted',
    );
    expect(afterDelete.edges).toHaveLength(0);
    const nodeIds = new Set(afterDelete.nodes.map((n) => n.id));
    for (const edge of afterDelete.edges) {
      expect(nodeIds.has(edge.from.nodeId) && nodeIds.has(edge.to.nodeId)).toBe(true);
    }
  });

  test('TC-PRJ-004: open project B, close the tab, open the app → project B', async ({
    page,
    context,
  }) => {
    const { token } = engine();
    const a = await seedWorkflow('project-a');
    const b = await seedWorkflow('project-b');

    await page.goto(`/projects/${a.projectId}?token=${token}`);
    await expect(page.getByTestId('project-page-name')).toContainText('project-a');
    await page.goto(`/projects`);
    await page.getByRole('link', { name: /project-b/ }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${b.projectId}$`));

    await page.close();
    const reopened = await context.newPage();
    await reopened.goto(`/?token=${token}`);
    await expect(reopened).toHaveURL(new RegExp(`/projects/${b.projectId}$`));
    await reopened.close();
  });

  test('FR-WF-007 / FR-WF-008: export from the UI, import it back → identical graph', async ({
    page,
  }) => {
    const { projectId, workflowId } = await seedWorkflow('export');
    await openCanvas(page, projectId, workflowId);
    // D285: Agent → Agent, oldest first, wired below
    await addAgentFromMenu(page);
    await addAgentFromMenu(page);
    const built = await serverHas(workflowId, (g) => g.nodes.length === 2, 'two nodes exist');
    const [input, agent] = [...built.nodes].sort((a, b) => a.id.localeCompare(b.id)) as [
      Node,
      Node,
    ];
    await dragConnect(
      page,
      portHandle(page, input.id, 'out', 'text'),
      portHandle(page, agent.id, 'in', 'text'),
    );
    await serverHas(workflowId, (g) => g.edges.length === 1, 'the edge is saved');

    // export through the workspace "…" menu (D331) and catch the download
    await page.getByTestId('workspace-menu').click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('menu-export-workflow').click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const file = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      formatVersion: number;
      nodes: Node[];
      edges: Edge[];
    };

    expect(file.formatVersion).toBe(1);
    expect(file.nodes).toHaveLength(2);
    expect(file.edges).toHaveLength(1);
    expect(JSON.stringify(file)).not.toMatch(/apiKey|"token"|secret/i);

    // import it back into the same project through the UI
    await page.goto(`/projects/${projectId}`);
    await page.getByLabel('Import JSON').setInputFiles({
      name: 'flow.ace.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(file)),
    });
    await expect(page).toHaveURL(/\/workflows\/[0-9A-Z]{26}$/, { timeout: 10_000 });

    const importedId = page.url().split('/').pop() as string;
    expect(importedId).not.toBe(workflowId);
    const imported = await graphOf(importedId);
    expect(imported.nodes).toHaveLength(2);
    expect(imported.edges).toHaveLength(1);
    expect(imported.nodes.map((n) => n.kind).sort()).toEqual(file.nodes.map((n) => n.kind).sort());
    // same structure, fresh ids
    expect(imported.nodes.map((n) => n.id)).not.toContain(input.id);
  });

  test('NFR-USE-02: add, connect and delete with the keyboard only', async ({ page }) => {
    const { projectId, workflowId } = await seedWorkflow('keyboard');
    await openCanvas(page, projectId, workflowId);

    // Enter on "Add node" adds an Agent and opens its settings (D332, D333); Esc closes them. D285:
    // the one kind it adds is an Agent, so the chain is two of them. The second comes from Ctrl+D on
    // the first (still selected): a second "Add node" would link the two itself, and the link is
    // what the keyboard is asked to make below.
    await page.getByTestId('new-node-button').focus();
    await page.keyboard.press('Enter');
    // D351: provider and model are picked first — with the keyboard too
    await answerProviderPicker(page, { keyboard: true });
    await expect(settingsDialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(settingsDialog(page)).toHaveCount(0);
    await serverHas(workflowId, (g) => g.nodes.length === 1, 'the first node was added');
    await page.keyboard.press('Control+d');
    const graph = await serverHas(workflowId, (g) => g.nodes.length === 2, 'both nodes were added');
    const [input, agent] = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)) as [
      Node,
      Node,
    ];

    await fitView(page);
    await portHandle(page, input.id, 'out', 'text').focus();
    await page.keyboard.press('Enter');
    // the armed output shows its ring (D332) before the user moves on to the input
    await expect(portHandle(page, input.id, 'out', 'text')).toHaveAttribute('data-armed', 'true');
    await portHandle(page, agent.id, 'in', 'text').focus();
    await page.keyboard.press('Enter');
    await serverHas(workflowId, (g) => g.edges.length === 1, 'the keyboard connection is saved');

    await fitView(page);
    await flowNode(page, agent.id).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Delete');
    const after = await serverHas(
      workflowId,
      (g) => g.nodes.length === 1 && g.edges.length === 0,
      'the keyboard delete is saved',
    );
    // the source Agent is what is left
    expect(after.nodes[0]?.id).toBe(input.id);
  });
});
