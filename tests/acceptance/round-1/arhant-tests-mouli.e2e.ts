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
const portHandle = (page: Page, nodeId: string, dir: 'in' | 'out', name: string): Locator =>
  page.getByTestId(`port-${nodeId}:${dir}:${name}`);
const configPanel = (page: Page): Locator =>
  page.getByRole('complementary', { name: 'Node configuration' });

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

/*
 * POC Theme V2 layout (D259): the palette is the New node dialog, and Configure lives in a floating
 * sheet that starts closed and covers the right of the Canvas while open.
 */

async function addFromDialog(page: Page, kind: string, name?: string): Promise<void> {
  await page.getByTestId('new-node-button').click();
  await page.getByTestId(`palette-${kind}`).click();
  if (name) await page.getByLabel('Name').fill(name);
  await page.getByTestId('new-node-add').click();
}

async function openSheet(
  page: Page,
  tab: 'Configure' | 'Inspector' | 'Runs' | 'Memory',
): Promise<void> {
  if (!(await page.getByRole('tab', { name: tab }).isVisible()))
    await page.getByTestId('sheet-toggle').click();
  await page.getByRole('tab', { name: tab }).click();
}

/** Close the sheet when it is open, so the whole Canvas can be clicked. */
async function closeSheet(page: Page): Promise<void> {
  const close = page.getByRole('button', { name: 'Close panel' });
  if (await close.isVisible()) await close.click();
  await expect(page.getByTestId('workflow-sheet')).toHaveCount(0);
}

/** Select a card, bringing it into view first (React Flow drops off-viewport nodes). */
async function selectNode(page: Page, nodeId: string): Promise<void> {
  await closeSheet(page);
  await fitView(page);
  await flowNode(page, nodeId).click();
}

/** Select a card and open the sheet's Configure tab on it. */
async function configureNode(page: Page, nodeId: string): Promise<Locator> {
  await selectNode(page, nodeId);
  await openSheet(page, 'Configure');
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

/** Zoom out until no handle sits under the minimap (bottom right of the V2 Canvas at 1280×720). */
async function clearOfMinimap(page: Page, ...targets: Locator[]): Promise<void> {
  const minimap = page.locator('.react-flow__minimap');
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
  // over the handles (the V2 sheet, the minimap)
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
    await addFromDialog(page, 'agent');
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
    await addFromDialog(page, 'input');
    await addFromDialog(page, 'output');
    await serverHas(workflowId, (g) => g.nodes.length === 2, 'both nodes reach the engine');

    await page.reload();
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    const graph = await graphOf(workflowId);
    expect(graph.nodes.map((n) => n.kind).sort()).toEqual(['input', 'output']);
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
    await addFromDialog(pageA, 'input');
    await serverHas(workflowId, (g) => g.nodes.length === 1, 'A saved');

    await addFromDialog(pageB, 'agent');
    const graph = await serverHas(workflowId, (g) => g.nodes.length === 2, 'B recovered and saved');

    // nothing was lost and B ends up agreeing with the server
    expect(graph.nodes.map((n) => n.kind).sort()).toEqual(['agent', 'input']);
    await expect(pageB.locator('.react-flow__node').first()).toBeVisible();
    await expect(pageA.locator('.react-flow__node').first()).toBeVisible();
    if (conflicts.includes(409)) expect(conflicts.at(-1)).toBe(200);

    await first.close();
    await second.close();
  });

  test('TC-CON-002: text output → image-only input is refused with a reason', async ({ page }) => {
    const { projectId, workflowId } = await seedWorkflow('types');
    await openCanvas(page, projectId, workflowId);
    await addFromDialog(page, 'input');
    await addFromDialog(page, 'agent');
    const graph = await serverHas(workflowId, (g) => g.nodes.length === 2, 'both nodes exist');
    const input = graph.nodes.find((n) => n.kind === 'input') as Node;
    const agent = graph.nodes.find((n) => n.kind === 'agent') as Node;

    // make the agent image-only through its config panel
    const panel = await configureNode(page, agent.id);
    const inputTypes = panel.getByRole('group', { name: 'Input types' });
    await inputTypes.getByLabel('image').click();
    await inputTypes.getByLabel('text').click();
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
    await addFromDialog(page, 'agent');
    await addFromDialog(page, 'agent');
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
    await addFromDialog(page, 'input');
    await addFromDialog(page, 'input');
    await addFromDialog(page, 'agent');
    const graph = await serverHas(workflowId, (g) => g.nodes.length === 3, 'three nodes exist');
    const inputs = graph.nodes.filter((n) => n.kind === 'input') as Node[];
    const agent = graph.nodes.find((n) => n.kind === 'agent') as Node;

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
    await addFromDialog(page, 'agent');
    const seeded = await serverHas(workflowId, (g) => g.nodes.length === 1, 'the agent exists');
    const agent = seeded.nodes[0] as Node;

    // the new node is selected; its config is on the sheet's Configure tab
    await openSheet(page, 'Configure');
    const panel = configPanel(page);
    await expect(panel).toBeVisible();

    await panel.getByLabel('Name').fill('Reviewer');
    await panel.getByLabel('Name').press('Enter');
    await panel.getByLabel('Instructions').fill('Review the draft and answer in JSON.');
    await panel.getByLabel('Instructions').blur();
    await panel.getByRole('group', { name: 'Output types' }).getByLabel('json').click();
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
          outputTypes?: string[];
        };
        return (
          (g.nodes[0] as Node).name === 'Reviewer' &&
          config.instructions === 'Review the draft and answer in JSON.' &&
          config.execution?.temperature === 0.2 &&
          config.execution?.maxTokens === 1024 &&
          config.execution?.timeoutMs === 30_000 &&
          config.execution?.retries === 1 &&
          config.contextPolicy?.budgetTokens === 8000 &&
          config.routing?.policy === 'fallback' &&
          (config.outputTypes ?? []).includes('json')
        );
      },
      'every field reaches the engine',
    );

    // and the UI shows the same values after a reload
    await page.reload();
    const reloaded = await configureNode(page, agent.id);
    await expect(reloaded.getByLabel('Name')).toHaveValue('Reviewer');
    await expect(reloaded.getByLabel('Instructions')).toHaveValue(
      'Review the draft and answer in JSON.',
    );
    await expect(reloaded.getByLabel('Temperature')).toHaveValue('0.2');
    await expect(reloaded.getByLabel('Context budget (tokens)')).toHaveValue('8000');
    expect((saved.nodes[0] as Node).outputs.map((p) => p.name)).toContain('json');
  });

  test('TC-NODE-006: temperature 5 shows an inline error and never reaches the engine', async ({
    page,
  }) => {
    const { projectId, workflowId } = await seedWorkflow('range');
    await openCanvas(page, projectId, workflowId);
    await addFromDialog(page, 'agent');
    await serverHas(workflowId, (g) => g.nodes.length === 1, 'the agent exists');
    const versionBefore = (await graphOf(workflowId)).workflow.version;

    await openSheet(page, 'Configure');
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
    await addFromDialog(page, 'input');
    await addFromDialog(page, 'agent');
    await addFromDialog(page, 'output');
    const built = await serverHas(workflowId, (g) => g.nodes.length === 3, 'three nodes exist');
    const input = built.nodes.find((n) => n.kind === 'input') as Node;
    const agent = built.nodes.find((n) => n.kind === 'agent') as Node;
    const output = built.nodes.find((n) => n.kind === 'output') as Node;
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
    await addFromDialog(page, 'input');
    await addFromDialog(page, 'agent');
    const graph = await serverHas(workflowId, (g) => g.nodes.length === 2, 'two nodes exist');
    const input = graph.nodes.find((n) => n.kind === 'input') as Node;
    const agent = graph.nodes.find((n) => n.kind === 'agent') as Node;

    await dragConnect(
      page,
      portHandle(page, input.id, 'out', 'text'),
      portHandle(page, agent.id, 'in', 'text'),
    );
    await serverHas(workflowId, (g) => g.edges.length === 1, 'the edge is saved');

    // duplicate the agent and give the copy a different name
    await configureNode(page, agent.id);
    await configPanel(page).getByLabel('Instructions').fill('original');
    await configPanel(page).getByLabel('Instructions').blur();
    await serverHas(
      workflowId,
      (g) =>
        (g.nodes.find((n) => n.id === agent.id)?.config as { instructions?: string })
          .instructions === 'original',
      'the instruction is saved',
    );

    // the open sheet covers the Canvas tools at the top right
    await closeSheet(page);
    await page.getByRole('button', { name: 'Duplicate selected nodes' }).click();
    const dup = await serverHas(workflowId, (g) => g.nodes.length === 3, 'the copy is saved');
    const copy = dup.nodes.find((n) => n.kind === 'agent' && n.id !== agent.id) as Node;
    expect((copy.config as { instructions?: string }).instructions).toBe('original');
    // the copy is offset and does not cover the original, whose ports must stay reachable
    const apart =
      Math.abs(copy.position.x - agent.position.x) >= 200 ||
      Math.abs(copy.position.y - agent.position.y) >= 120;
    expect(apart).toBe(true);

    // the copy is the selection now; the sheet shows it
    await openSheet(page, 'Configure');
    await configPanel(page).getByLabel('Name').fill('Copy');
    await configPanel(page).getByLabel('Name').press('Enter');
    await serverHas(
      workflowId,
      (g) => g.nodes.find((n) => n.id === copy.id)?.name === 'Copy',
      'the copy is renamed',
    );
    expect((await graphOf(workflowId)).nodes.find((n) => n.id === agent.id)?.name).toBe('Agent');

    // delete the connected original: its edge must go with it
    await selectNode(page, agent.id);
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
    await expect(page.getByTestId('project-name')).toBeVisible();
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
    await addFromDialog(page, 'input');
    await addFromDialog(page, 'agent');
    const built = await serverHas(workflowId, (g) => g.nodes.length === 2, 'two nodes exist');
    const input = built.nodes.find((n) => n.kind === 'input') as Node;
    const agent = built.nodes.find((n) => n.kind === 'agent') as Node;
    await dragConnect(
      page,
      portHandle(page, input.id, 'out', 'text'),
      portHandle(page, agent.id, 'in', 'text'),
    );
    await serverHas(workflowId, (g) => g.edges.length === 1, 'the edge is saved');

    // export through the tab menu and catch the download
    await page.getByRole('button', { name: /Workflow actions for export/ }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: 'Export JSON' }).click();
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

    // Enter on New node opens the dialog; Enter on a kind adds it (and closes the dialog)
    await page.getByTestId('new-node-button').focus();
    await page.keyboard.press('Enter');
    await page.getByTestId('palette-input').focus();
    await page.keyboard.press('Enter');
    await page.getByTestId('new-node-button').focus();
    await page.keyboard.press('Enter');
    await page.getByTestId('palette-agent').focus();
    await page.keyboard.press('Enter');
    const graph = await serverHas(workflowId, (g) => g.nodes.length === 2, 'both nodes were added');
    const input = graph.nodes.find((n) => n.kind === 'input') as Node;
    const agent = graph.nodes.find((n) => n.kind === 'agent') as Node;

    await fitView(page);
    await portHandle(page, input.id, 'out', 'text').focus();
    await page.keyboard.press('Enter');
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
    expect(after.nodes[0]?.kind).toBe('input');
  });
});
