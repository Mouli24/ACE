import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

/**
 * The §8.1 manual pass — "ten minutes of abuse" — written down instead of described, so the next
 * person gets the same answer rather than a claim.
 *
 * `REPORT.md` listed four of these as **not done**: pane resize to the minimum, a 3,000-character
 * paste into Instructions, killing the engine mid-drag and verifying recovery, and browser zoom at
 * 50 % and 200 %. They are the four here.
 *
 * The engine is started by this file rather than by Playwright's `webServer` because one of the
 * checks kills it on purpose; Playwright would treat that as the run falling over.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_PORT = 47_492;
const WEB_PORT = 47_493;
const ORIGINS = `http://127.0.0.1:${WEB_PORT},http://localhost:${WEB_PORT}`;

interface EngineHandle {
  url: string;
  token: string;
  pid: number;
}

let dataDir = '';
let handleFile = '';
let engine: EngineHandle;
let child: ChildProcess | undefined;

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

async function startEngineProcess(): Promise<void> {
  if (existsSync(handleFile)) rmSync(handleFile);
  child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      join(HERE, '..', 'helpers', 'standalone-engine.ts'),
      dataDir,
      String(ENGINE_PORT),
      handleFile,
      ORIGINS,
    ],
    { cwd: join(HERE, '..'), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  for (let i = 0; i < 120; i += 1) {
    if (existsSync(handleFile)) break;
    if (child.exitCode !== null) throw new Error(`engine exited ${child.exitCode}\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!existsSync(handleFile)) throw new Error(`engine never came up\n${stderr}`);
  engine = JSON.parse(readFileSync(handleFile, 'utf8')) as EngineHandle;
}

/** Windows has no SIGKILL; `taskkill /F` is the same unclean death. */
function sigkill(pid: number): void {
  spawn('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' }).unref();
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${engine.url}/api/v1${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${engine.token}`,
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

interface Graph {
  workflow: { id: string; version: number };
  nodes: {
    id: string;
    kind: string;
    position: { x: number; y: number };
    config: Record<string, unknown>;
  }[];
  edges: unknown[];
}

async function freshWorkflow(name: string): Promise<{ projectId: string; workflowId: string }> {
  const project = await api<{ id: string }>('/projects', {
    method: 'POST',
    body: JSON.stringify({ name: `${name}-${newId().slice(-6)}` }),
  });
  const workflow = await api<{ id: string }>(`/projects/${project.id}/workflows`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  return { projectId: project.id, workflowId: workflow.id };
}

async function openCanvas(page: Page, projectId: string, workflowId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/workflows/${workflowId}?token=${engine.token}`);
  await expect(page.getByTestId('canvas')).toBeVisible();
}

const canvasBox = (page: Page): Promise<{ width: number; height: number } | null> =>
  page.getByTestId('canvas').boundingBox();

/** POC Theme V2 (D259): the palette is the New node dialog; this adds one node from it. */
async function addFromDialog(page: Page, kind: string, name?: string): Promise<void> {
  await page.getByTestId('new-node-button').click();
  await page.getByTestId(`palette-${kind}`).click();
  if (name) await page.getByLabel('Name').fill(name);
  await page.getByTestId('new-node-add').click();
}

/** POC Theme V2: Configure lives in a floating sheet that starts closed. */
async function openSheet(
  page: Page,
  tab: 'Configure' | 'Inspector' | 'Runs' | 'Memory',
): Promise<void> {
  if (!(await page.getByRole('tab', { name: tab }).isVisible()))
    await page.getByTestId('sheet-toggle').click();
  await page.getByRole('tab', { name: tab }).click();
}

/**
 * String-form `evaluate` on purpose: this package's tsconfig has no DOM lib (nothing else in the
 * suite reaches into the page), and widening it for one probe is the wrong trade.
 */
const horizontalOverflow = (page: Page): Promise<number> =>
  page.evaluate(
    'document.documentElement.scrollWidth - document.documentElement.clientWidth',
  ) as Promise<number>;

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ace-manual-'));
  handleFile = join(dataDir, 'handle.json');
  await startEngineProcess();
});

test.afterAll(async () => {
  if (engine) sigkill(engine.pid);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  rmSync(dataDir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */

test('§8.1 abuse — every pane dragged to its minimum, the Canvas stays usable', async ({
  page,
}) => {
  const { projectId, workflowId } = await freshWorkflow('resize');
  await openCanvas(page, projectId, workflowId);
  // D285: the dialog offers one node, an Agent
  await addFromDialog(page, 'agent');
  await addFromDialog(page, 'agent');
  await expect
    .poll(async () => (await api<Graph>(`/workflows/${workflowId}`)).nodes.length)
    .toBe(2);

  const before = await canvasBox(page);
  expect(before?.height ?? 0).toBeGreaterThan(0);

  /*
   * The POC Theme V2 layout (D259) has no drag handles left: the bottom panel collapses to its
   * header, the sheet floats over the Canvas, Chat is a fixed column. So every pane is pushed to its
   * extreme the ways the layout allows — bottom panel open and collapsed, sheet open and closed,
   * and the window at the narrowest and shortest desktop size — and, as before, D-004 (a Canvas
   * that measured 0 px high) is what is checked after each step.
   */
  expect(await page.locator('[data-panel-resize-handle-id]').count()).toBe(0);
  const toggleBottom = page.getByRole('button', { name: 'Toggle panel' });
  // (the bottom panel's toggle sits under an open sheet, so it is pressed with the sheet closed)
  const steps: Array<[string, () => Promise<void>]> = [
    ['bottom panel collapsed', () => toggleBottom.click()],
    ['sheet open over it', () => openSheet(page, 'Configure')],
    ['narrowest, shortest desktop window', () => page.setViewportSize({ width: 641, height: 480 })],
    ['sheet closed', () => page.getByRole('button', { name: 'Close panel' }).click()],
    ['bottom panel open again', () => toggleBottom.click()],
    ['back to 1280 × 720', () => page.setViewportSize({ width: 1280, height: 720 })],
  ];
  for (const [step, act] of steps) {
    await act();
    await page.waitForTimeout(250);
    const now = await canvasBox(page);
    expect(now?.width ?? 0, `canvas width with the ${step}`).toBeGreaterThan(0);
    expect(now?.height ?? 0, `canvas height with the ${step}`).toBeGreaterThan(0);
  }

  // and still usable: fit-to-view works and the cards are reachable
  await page.getByRole('button', { name: 'Fit to view' }).click();
  await page.waitForTimeout(400);
  await expect(page.locator('.react-flow__node').first()).toBeVisible();

  expect(
    await horizontalOverflow(page),
    'no horizontal page scroll at any pane size',
  ).toBeLessThanOrEqual(1);
});

test('§8.1 abuse — 3,000 characters pasted into Instructions reach the engine intact', async ({
  page,
}) => {
  const { projectId, workflowId } = await freshWorkflow('paste');
  await openCanvas(page, projectId, workflowId);
  await addFromDialog(page, 'agent');

  await expect
    .poll(async () => (await api<Graph>(`/workflows/${workflowId}`)).nodes.length, {
      timeout: 10_000,
      message: 'the agent card reached the engine',
    })
    .toBe(1);
  const graph = await api<Graph>(`/workflows/${workflowId}`);
  const agent = graph.nodes.find((node) => node.kind === 'agent');
  expect(agent, 'the agent card was created').toBeTruthy();

  await page.locator(`.react-flow__node[data-id="${agent?.id}"]`).click();
  await openSheet(page, 'Configure');
  const instructions = page.getByLabel('Goal');
  await expect(instructions).toBeVisible();

  // A real paste, not a typed 3,000 characters: the clipboard path is what a user takes.
  const text = `${'The quick brown fox jumps over the lazy dog. '.repeat(67)}END`.slice(0, 3000);
  expect(text).toHaveLength(3000);

  // `insertText` is what a paste looks like to the page — one bulk input event, not 3,000
  // keystrokes — which is the thing §8.1 asks to abuse.
  await instructions.focus();
  await page.keyboard.insertText(text);
  await instructions.blur();

  await expect
    .poll(
      async () => {
        const after = await api<Graph>(`/workflows/${workflowId}`);
        const node = after.nodes.find((candidate) => candidate.id === agent?.id);
        return ((node?.config as { instructions?: string })?.instructions ?? '').length;
      },
      { timeout: 15_000, message: 'the engine stored the whole paste' },
    )
    .toBe(3000);

  // and the page is still alive after it
  await expect(instructions).toHaveValue(text);
  await page.reload();
  await expect(page.getByTestId('canvas')).toBeVisible();
});

test('§8.1 abuse — the engine is killed mid-drag; the app recovers when it comes back', async ({
  page,
}) => {
  const { projectId, workflowId } = await freshWorkflow('kill-mid-drag');
  await openCanvas(page, projectId, workflowId);
  await addFromDialog(page, 'agent');
  await expect
    .poll(async () => (await api<Graph>(`/workflows/${workflowId}`)).nodes.length)
    .toBe(1);

  const before = await api<Graph>(`/workflows/${workflowId}`);
  const nodeId = before.nodes[0]?.id as string;
  const card = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
  const box = await card.boundingBox();
  expect(box).toBeTruthy();

  // Start the drag, kill the engine with the mouse still down, finish the drag against a dead
  // engine. The autosave lands on a closed socket and a refused connection.
  const [sx, sy] = [(box?.x ?? 0) + (box?.width ?? 0) / 2, (box?.y ?? 0) + (box?.height ?? 0) / 2];
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 60, sy + 40, { steps: 8 });

  sigkill(engine.pid);
  await new Promise((resolve) => setTimeout(resolve, 2500));

  await page.mouse.move(sx + 180, sy + 120, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(1500);

  // The page must still be a page — not a white screen, not a crash.
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect(card).toBeVisible();

  // Bring the engine back on the same data directory.
  await startEngineProcess();
  const health = await api<{ status: string; db: string }>('/health');
  expect(health.status).toBe('ok');
  expect(health.db, 'the database reopened after the kill').toBe('ok');

  // The graph the engine kept is intact and still writable, and a reload gets the app working
  // again against the restarted engine.
  const after = await api<Graph>(`/workflows/${workflowId}`);
  expect(after.nodes).toHaveLength(1);

  // A restarted engine mints a fresh session token (§2.10), so recovery for the user is reopening
  // the printed `?token=` URL — that is the path this asserts. What the page shows *before* that,
  // on the stale token, is D-009: a 401 is rendered as "Workflow not found.".
  await openCanvas(page, projectId, workflowId);
  await expect(page.locator(`.react-flow__node[data-id="${nodeId}"]`)).toBeVisible();

  // and the recovered app can still write: move the card and see the engine take it.
  await page.getByRole('button', { name: 'Fit to view' }).click();
  await page.waitForTimeout(400);
  const again = await page.locator(`.react-flow__node[data-id="${nodeId}"]`).boundingBox();
  await page.mouse.move((again?.x ?? 0) + 20, (again?.y ?? 0) + 20);
  await page.mouse.down();
  await page.mouse.move((again?.x ?? 0) + 140, (again?.y ?? 0) + 90, { steps: 10 });
  await page.mouse.up();

  await expect
    .poll(
      async () => {
        const graph = await api<Graph>(`/workflows/${workflowId}`);
        const node = graph.nodes.find((candidate) => candidate.id === nodeId);
        return (
          node?.position.x !== before.nodes[0]?.position.x ||
          node?.position.y !== before.nodes[0]?.position.y
        );
      },
      { timeout: 15_000, message: 'the restarted engine accepts edits from the recovered page' },
    )
    .toBe(true);
});

for (const zoom of [0.5, 2]) {
  test(`§8.1 abuse — browser zoom at ${zoom * 100} %`, async ({ page }) => {
    const { projectId, workflowId } = await freshWorkflow(`zoom-${zoom}`);
    await openCanvas(page, projectId, workflowId);

    // Browser zoom, not a viewport resize: the CSS pixel ratio is what changes.
    await page.evaluate(`document.documentElement.style.zoom = '${zoom}'`);
    await page.waitForTimeout(500);

    const box = await canvasBox(page);
    expect(box?.width ?? 0, `canvas measurable at ${zoom * 100} %`).toBeGreaterThan(0);
    expect(box?.height ?? 0, `canvas measurable at ${zoom * 100} %`).toBeGreaterThan(0);

    // the palette (V2: the New node dialog) is still reachable and still adds exactly one card
    // (D-006 was a double add)
    await expect(page.getByTestId('new-node-button')).toBeVisible();
    await page.getByTestId('new-node-button').click();
    // D285: the one kind it offers is an Agent
    await expect(page.getByTestId('palette-agent')).toBeVisible();
    await page.getByTestId('palette-agent').click();
    await page.getByTestId('new-node-add').click();
    await expect
      .poll(async () => (await api<Graph>(`/workflows/${workflowId}`)).nodes.length, {
        timeout: 10_000,
        message: `one card added at ${zoom * 100} % zoom`,
      })
      .toBe(1);

    await page.getByRole('button', { name: 'Fit to view' }).click();
    await page.waitForTimeout(400);
    await expect(page.locator('.react-flow__node').first()).toBeVisible();

    expect(
      await horizontalOverflow(page),
      `no horizontal page scroll at ${zoom * 100} % zoom`,
    ).toBeLessThanOrEqual(1);
  });
}
