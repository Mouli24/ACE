import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FORMAT_VERSION,
  derivePorts,
  type Edge,
  type Node,
  type Provider,
  type WorkflowExport,
} from '@ace/contracts';
import { test, type Browser, type Page } from '@playwright/test';

import { IN_PAGE_AUDIT, type AuditResult } from './in-page-audit.js';

/**
 * Product gaps, Phase 0 items 3 and 4 (PG-0). A recorder, not a test: it reproduces the six
 * user-reported symptoms and the mode symptoms against the real engine (mock provider) and the
 * production build, saves screenshots to `docs/team-prompts/product-gaps/`, and walks every route
 * in both themes for the visibility audit. It asserts nothing about the product; what it saw is
 * written to `<tmp>/ace-pg-audit.json` and read into `inventory-audit.md` by hand.
 *
 * It runs only with ACE_PG_AUDIT=1, so it never joins a suite that has to be green:
 *
 *   ACE_PG_AUDIT=1 ACE_ACCEPTANCE_PORT=47610 pnpm exec playwright test \
 *     --config tests/acceptance/playwright.config.ts product-gaps/audit
 *
 * No local Ollama was running when this was written, so the "local models" symptom uses a tiny
 * loopback stub that answers `/v1/models` the way Ollama and LM Studio do (see `localModels`).
 */

test.skip(process.env['ACE_PG_AUDIT'] !== '1', 'PG-0 audit recorder: set ACE_PG_AUDIT=1 to run');
test.describe.configure({ mode: 'serial', retries: 0, timeout: 600_000 });

const OUT = fileURLToPath(new URL('../../../docs/team-prompts/product-gaps/', import.meta.url));
const RESULTS = join(tmpdir(), 'ace-pg-audit.json');
const STUB_PORT = Number(process.env['ACE_PG_STUB_PORT'] ?? 47_612);
const results: Record<string, unknown> = {};
const record = (key: string, value: unknown): void => {
  results[key] = value;
  writeFileSync(RESULTS, JSON.stringify(results, null, 2));
};

/* ------------------------------------------------------------------ engine + REST */

interface EngineHandle {
  url: string;
  token: string;
  controlUrl: string;
  controlToken: string;
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
  const text = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${response.status} ${text}`);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}
async function control(action: 'fresh' | 'original'): Promise<void> {
  const { controlUrl, controlToken } = engine();
  const response = await fetch(`${controlUrl}/engine/${action}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${controlToken}` },
  });
  if (!response.ok) throw new Error(`control ${action} → ${response.status}`);
}

async function provider(body: Record<string, unknown>, refresh = true): Promise<string> {
  const { items } = await api<{ items: Provider[] }>('/providers?limit=500');
  const known = items.find((p) => p.name === body['name']);
  if (known !== undefined) return known.id;
  const created = await api<Provider>('/providers', { method: 'POST', body: JSON.stringify(body) });
  if (refresh) {
    await api(`/providers/${created.id}/refresh-models`, { method: 'POST' }).catch(
      (error: unknown) => record(`refresh-${String(body['name'])}`, String(error)),
    );
  }
  return created.id;
}
const mockProvider = (): Promise<string> => provider({ type: 'mock', name: 'PG mock' });

interface Board {
  projectId: string;
  workflowId: string;
  ids: Record<string, string>;
  base: string;
}

let serial = 0;
/** Agents on the mock, laid out in one row; `links` are [from, to] by name. */
async function board(
  label: string,
  agents: [name: string, modelId: string][],
  links: [string, string][] = [],
): Promise<Board> {
  const providerId = await mockProvider();
  const project = await api<{ id: string }>('/projects', {
    method: 'POST',
    body: JSON.stringify({ name: `pg-${label}-${Date.now().toString(36)}` }),
  });
  serial += 1;
  const workflowId = `01PG0AXD1TWF${String(serial).padStart(12, '0')}WF`;
  const nodes: Node[] = agents.map(([name, modelId], index) => {
    const draft = {
      id: `01PG0AXD1TN${String(serial).padStart(2, '0')}${String(index + 1).padStart(13, '0')}`,
      workflowId,
      kind: 'agent' as const,
      name,
      position: { x: 80 + index * 420, y: 120 },
      config: {
        providerId,
        modelId,
        instructions: `Act as the ${name}.`,
        inputTypes: ['text'],
        outputTypes: ['text'],
      },
    };
    return { ...draft, ...derivePorts(draft as unknown as Parameters<typeof derivePorts>[0]) } as Node;
  });
  const byName = (name: string): Node => {
    const node = nodes.find((n) => n.name === name);
    if (node === undefined) throw new Error(name);
    return node;
  };
  const edges: Edge[] = links.map(([from, to], index) => ({
    id: `01PG0AXD1TE${String(serial).padStart(2, '0')}${String(index + 1).padStart(13, '0')}`,
    workflowId,
    kind: 'data',
    from: { nodeId: byName(from).id, portId: byName(from).outputs[0]?.id ?? '' },
    to: { nodeId: byName(to).id, portId: byName(to).inputs[0]?.id ?? '' },
  }));
  const exported: WorkflowExport = {
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    name: `PG ${label}`,
    nodes,
    edges,
  };
  const imported = await api<{ workflow: { id: string }; nodes: Node[] }>(
    `/projects/${project.id}/workflows/import`,
    { method: 'POST', body: JSON.stringify(exported) },
  );
  const ids = Object.fromEntries(imported.nodes.map((n) => [n.name, n.id]));
  return {
    projectId: project.id,
    workflowId: imported.workflow.id,
    ids,
    base: `/projects/${project.id}/workflows/${imported.workflow.id}`,
  };
}

interface Graph {
  nodes: Node[];
  edges: Edge[];
}
const graph = (workflowId: string): Promise<Graph> => api<Graph>(`/workflows/${workflowId}`);

/* ------------------------------------------------------------------ the browser */

type Theme = 'light' | 'dark';
const LOOKS: { theme: Theme; width: number }[] = [
  { theme: 'light', width: 1440 },
  { theme: 'light', width: 380 },
  { theme: 'dark', width: 1440 },
  { theme: 'dark', width: 380 },
];

async function themedPage(browser: Browser, theme: Theme, width: number): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width, height: width <= 400 ? 760 : 900 },
    baseURL: test.info().project.use.baseURL ?? 'http://127.0.0.1:47611',
  });
  // a control a look does not have must fail fast, not wait out the test
  context.setDefaultTimeout(8_000);
  await context.addInitScript((t) => {
    try {
      localStorage.setItem('ace-theme', t);
    } catch {
      /* the page keeps its default */
    }
  }, theme);
  return context.newPage();
}

async function open(page: Page, path: string): Promise<void> {
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}token=${engine().token}`);
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
  await page.waitForTimeout(500);
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: `${OUT}${name}.png`, type: 'png' });
}

/** The same steps in the four looks; `go` leaves the page in the state to photograph. */
async function inEachLook(
  browser: Browser,
  slug: string,
  go: (page: Page, look: { theme: Theme; width: number }) => Promise<void>,
): Promise<void> {
  for (const look of LOOKS) {
    const page = await themedPage(browser, look.theme, look.width);
    try {
      await go(page, look);
    } catch (error) {
      record(`${slug}-${look.theme}-${look.width}-error`, String(error).slice(0, 400));
    }
    await shot(page, `${slug}-${look.theme}-${look.width}`);
    await page.context().close();
  }
}

/**
 * Opens a node's chat: on a phone the Chat tab first; a node past the first three chips is under
 * "More".
 */
async function pickChatNode(page: Page, nodeId: string): Promise<void> {
  const width = page.viewportSize()?.width ?? 1440;
  if (width < 700) {
    // the phone's Chat tab has no node chips: select the card on the Canvas tab first
    const tab = (name: string) =>
      page
        .getByRole('tab', { name, exact: true })
        .or(page.getByRole('button', { name, exact: true }))
        .first();
    await tab('Canvas').click();
    await page.waitForTimeout(300);
    await page.locator(`.react-flow__node[data-id="${nodeId}"]`).click({ force: true });
    await page.waitForTimeout(300);
    await tab('Chat').click();
    await page.waitForTimeout(400);
    return;
  }
  const chip = page.getByTestId(`chat-mention-${nodeId}`);
  if ((await chip.count()) === 0) {
    await page.getByTestId('chat-mention-more').click();
    await page.waitForTimeout(200);
  }
  await chip.first().click();
  await page.waitForTimeout(300);
}

const card = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const port = (page: Page, id: string, dir: 'source' | 'target') =>
  card(page, id).locator(`.react-flow__handle.${dir}`).first();

/* ------------------------------------------------------------------ local model stub */

let stub: Server | undefined;
/** Answers `/v1/models` as a local Ollama / LM Studio does: three tags, no network. */
async function localModels(): Promise<string> {
  if (stub === undefined) {
    stub = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          object: 'list',
          data: ['llama3.2:3b', 'qwen2.5-coder:7b', 'phi4-mini:latest'].map((id) => ({
            id,
            object: 'model',
            owned_by: 'library',
          })),
        }),
      );
      request.resume();
    });
    await new Promise<void>((resolve) => stub?.listen(STUB_PORT, '127.0.0.1', resolve));
  }
  return `http://127.0.0.1:${STUB_PORT}`;
}

test.afterAll(async () => {
  await new Promise<void>((resolve) => (stub ? stub.close(() => resolve()) : resolve()));
});

/* ================================================================== item 3: symptoms */

let free: Board;
let linked: Board;

test('setup: providers and boards', async () => {
  const ollama = await (async () => {
    try {
      const r = await fetch('http://127.0.0.1:11434/api/tags', {
        signal: AbortSignal.timeout(1_500),
      });
      return r.ok ? await r.text() : `HTTP ${r.status}`;
    } catch (error) {
      return `not running (${String(error).slice(0, 80)})`;
    }
  })();
  record('ollama', ollama);
  const local = await localModels();
  await mockProvider();
  await provider({ type: 'ollama', name: 'Ollama (local stub)', baseUrl: local });
  await provider({ type: 'openai_compatible', name: 'LM Studio (local stub)', baseUrl: local });
  await provider({ type: 'anthropic', name: 'Anthropic', apiKey: 'pg-audit-not-a-key' });
  await provider(
    {
      type: 'openai_compatible',
      name: 'Remote endpoint',
      baseUrl: 'https://llm.example.invalid',
    },
    false,
  );
  for (const p of (await api<{ items: Provider[] }>('/providers?limit=500')).items) {
    await api(`/providers/${p.id}/check`, { method: 'POST' }).catch(() => undefined);
  }
  const providers = (await api<{ items: Provider[] }>('/providers?limit=500')).items;
  record(
    'providers',
    providers.map((p) => ({ name: p.name, type: p.type, status: p.status })),
  );
  free = await board('free', [
    ['Writer', 'mock-text'],
    ['Review', 'mock-text'],
    ['Failing', 'mock-503'],
    ['Silent', 'mock-timeout'],
  ]);
  linked = await board(
    'linked',
    [
      ['Draft', 'mock-slow'],
      ['Edit', 'mock-slow'],
      ['Polish', 'mock-slow'],
    ],
    [
      ['Draft', 'Edit'],
      ['Edit', 'Polish'],
    ],
  );
  record('boards', { free, linked });
});

test('S1 a node cannot be connected by dragging a line', async ({ browser }) => {
  // Measure once, light 1440: what the port is, and what four kinds of drag do.
  const page = await themedPage(browser, 'light', 1440);
  await open(page, free.base);
  const out = port(page, free.ids['Writer'] ?? '', 'source');
  const into = port(page, free.ids['Review'] ?? '', 'target');
  await out.waitFor({ state: 'attached' });
  const style = await out.evaluate((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { opacity: cs.opacity, width: r.width, height: r.height, bg: cs.backgroundColor };
  });
  await card(page, free.ids['Writer'] ?? '').hover();
  const onHover = await out.evaluate((el) => getComputedStyle(el).opacity);
  const zoom = await page
    .getByText(/^\d+%$/u)
    .first()
    .textContent()
    .catch(() => '');
  record('s1-port', { ...style, opacityOnCardHover: onHover, zoom });
  await page.context().close();

  type Pt = { x: number; y: number };
  type Aim = (g: { out: Pt; into: Pt; writer: Box; review: Box }) => [Pt, Pt];
  type Box = { x: number; y: number; width: number; height: number };
  // Each drag on a board of its own, so a card one drag moves cannot spoil the next.
  const tryDrag = async (label: string, aim: Aim): Promise<unknown> => {
    const b = await board(`s1${label.slice(0, 1)}`, [
      ['Writer', 'mock-text'],
      ['Review', 'mock-text'],
    ]);
    const p = await themedPage(browser, 'light', 1440);
    await open(p, b.base);
    const centre = async (locator: ReturnType<typeof port>): Promise<Pt> => {
      const box = await locator.boundingBox();
      if (box === null) throw new Error('no box');
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    const geometry = {
      out: await centre(port(p, b.ids['Writer'] ?? '', 'source')),
      into: await centre(port(p, b.ids['Review'] ?? '', 'target')),
      writer: (await card(p, b.ids['Writer'] ?? '').boundingBox()) as Box,
      review: (await card(p, b.ids['Review'] ?? '').boundingBox()) as Box,
    };
    const [from, to] = aim(geometry);
    const before = await graph(b.workflowId);
    await p.mouse.move(from.x, from.y);
    await p.mouse.down();
    await p.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 10 });
    const lineDrawn = await p.locator('.react-flow__connection').count();
    await p.mouse.move(to.x, to.y, { steps: 10 });
    await p.mouse.up();
    await p.waitForTimeout(1_500);
    const after = await graph(b.workflowId);
    const moved = (name: string): boolean => {
      const a = before.nodes.find((n) => n.name === name)?.position;
      const z = after.nodes.find((n) => n.name === name)?.position;
      return a?.x !== z?.x || a?.y !== z?.y;
    };
    const result = {
      from,
      to,
      lineDrawnMidDrag: lineDrawn > 0,
      edgeCreated: after.edges.length > before.edges.length,
      writerCardMoved: moved('Writer'),
      settingsOpened: await p
        .getByRole('dialog')
        .isVisible()
        .catch(() => false),
      toast: (await p.locator('[data-sonner-toast]').allInnerTexts()).join(' | '),
    };
    await shot(p, `s1-drag-${label}-light-1440`);
    await p.context().close();
    return result;
  };
  const drags: Record<string, unknown> = {};
  // a) where a user aims: the card's right edge, at the port's height
  drags['a-card-edge-to-card'] = await tryDrag('a-card-edge', (g) => [
    { x: g.writer.x + g.writer.width - 6, y: g.out.y },
    { x: g.review.x + 10, y: g.into.y },
  ]);
  // b) the exact (invisible) output handle to the Review card's body, not its port
  drags['b-handle-to-card-body'] = await tryDrag('b-handle-to-body', (g) => [
    g.out,
    { x: g.review.x + g.review.width / 2, y: g.review.y + g.review.height * 0.75 },
  ]);
  // c) a near miss: 6 px beside the output handle, onto the exact input handle
  drags['c-near-miss-6px'] = await tryDrag('c-near-miss', (g) => [
    { x: g.out.x + 6, y: g.out.y },
    g.into,
  ]);
  // d) exact handle centre to exact handle centre (what a pixel-perfect user would need)
  drags['d-handle-to-handle'] = await tryDrag('d-exact', (g) => [g.out, g.into]);
  record('s1-drags', drags);

  await inEachLook(browser, 's1-connect', async (p) => {
    await open(p, free.base);
    // the pointer exactly on the Writer's output port: nothing shows there to drag from
    const box = await port(p, free.ids['Writer'] ?? '', 'source').boundingBox();
    if (box !== null) await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await p.waitForTimeout(300);
  });
});

test('S2 settings and other controls are hard to see', async ({ browser }) => {
  const sizes: Record<string, unknown> = {};
  await inEachLook(browser, 's2-controls', async (page, look) => {
    await open(page, free.base);
    const gear = page.getByTestId('settings-menu').first();
    const box = await gear.boundingBox().catch(() => null);
    const visible = await gear.isVisible().catch(() => false);
    const font = await gear.evaluate((el) => getComputedStyle(el).fontSize).catch(() => 'absent');
    const runControls = await page
      .getByRole('button', { name: /^(Run|Start run|Pause|Stop|Restart)$/u })
      .count();
    sizes[`${look.theme}-${look.width}`] = { gear: { visible, box, font }, runControls };
  });
  record('s2', sizes);
});

test('S3 a node is created with no (or a silently chosen) provider', async ({ browser }) => {
  // With providers: Add node picks one without asking.
  const page = await themedPage(browser, 'light', 1440);
  const added = await board('add', [['Only', 'mock-text']]);
  await open(page, added.base);
  const before = (await graph(added.workflowId)).nodes.map((n) => n.id);
  await page.getByTestId('new-node-button').click();
  await page.waitForTimeout(1_200);
  const after = await graph(added.workflowId);
  const made = after.nodes.find((n) => !before.includes(n.id));
  const providers = (await api<{ items: Provider[] }>('/providers?limit=500')).items;
  const config = (made?.config ?? {}) as { providerId?: string; modelId?: string };
  const chosen = providers.find((p) => p.id === config.providerId);
  record('s3-with-providers', {
    dialogShown: await page
      .getByRole('dialog')
      .isVisible()
      .catch(() => false),
    providerId: config.providerId,
    provider: chosen ? { name: chosen.name, type: chosen.type, status: chosen.status } : null,
    modelId: config.modelId,
  });
  await page.context().close();
  await inEachLook(browser, 's3-add-node', async (p) => {
    const b = await board('addlook', [['Only', 'mock-text']]);
    await open(p, b.base);
    await p.getByTestId('new-node-button').click();
    await p.waitForTimeout(1_200);
  });
});

test('S4 local models sit in one flat list with cloud and mock', async ({ browser }) => {
  const lists: Record<string, unknown> = {};
  await inEachLook(browser, 's4-provider-picker', async (page, look) => {
    await open(page, free.base);
    await card(page, free.ids['Writer'] ?? '').click({ position: { x: 60, y: 60 } });
    await page.waitForTimeout(500);
    const trigger = page.getByRole('combobox', { name: 'Provider' }).first();
    await trigger.click();
    await page.waitForTimeout(400);
    const options = await page.getByRole('option').allTextContents();
    const groups = await page.locator('[role=listbox] [role=group]').count();
    lists[`${look.theme}-${look.width}`] = { options, groups };
  });
  record('s4-provider-options', lists);
  await inEachLook(browser, 's4-models-tab', async (page) => {
    await open(page, '/providers');
    await page.getByRole('tab', { name: 'Models' }).click();
    await page.waitForTimeout(600);
  });
  const models = await api<{ items: { providerId: string; modelId: string }[] }>(
    '/models?limit=500',
  ).catch((error: unknown) => ({ items: [], error: String(error) }));
  record('s4-model-count', models.items.length);
});

test('S5 a failed message never shows', async ({ browser }) => {
  const seen: Record<string, unknown> = {};
  const say = async (page: Page, nodeName: string, text: string): Promise<void> => {
    await pickChatNode(page, free.ids[nodeName] ?? '');
    await page.getByTestId('chat-input').fill(text);
    await page.getByTestId('chat-send').click();
  };
  // A provider error (mock-503): does the turn end as "could not answer"?
  await inEachLook(browser, 's5-failed-reply', async (page, look) => {
    await open(page, free.base);
    await say(page, 'Failing', 'Summarise the brief');
    await page.waitForTimeout(6_000);
    seen[`503-${look.theme}-${look.width}`] = {
      errorTurn: await page.getByTestId('chat-error-turn').count(),
      streaming: await page.getByTestId('chat-streaming').count(),
      sendError: await page.getByTestId('chat-send-error').count(),
      text: (
        await page
          .getByTestId('chat-conversation')
          .innerText()
          .catch(() => '')
      ).slice(-300),
    };
  });
  // A reply that never comes (mock-timeout): how long does "typing…" last?
  await inEachLook(browser, 's5-no-answer', async (page, look) => {
    await open(page, free.base);
    await say(page, 'Silent', 'Are you there?');
    await page.waitForTimeout(look.width === 1440 && look.theme === 'light' ? 45_000 : 4_000);
    seen[`timeout-${look.theme}-${look.width}`] = {
      errorTurn: await page.getByTestId('chat-error-turn').count(),
      streaming: await page.getByTestId('chat-streaming').count(),
      text: (
        await page
          .getByTestId('chat-conversation')
          .innerText()
          .catch(() => '')
      ).slice(-300),
    };
  });
  record('s5-chat', seen);
  // After a turn that never ends: does another node of the same project still answer?
  {
    const page = await themedPage(browser, 'light', 1440);
    await open(page, free.base);
    await say(page, 'Writer', 'Draft a tagline for ACE');
    await page.waitForTimeout(20_000);
    record('s5-queue', {
      afterSeconds: 20,
      text: (
        await page
          .getByTestId('chat-conversation')
          .innerText()
          .catch(() => '')
      ).slice(-200),
      typing: /is typing/u.test(await page.getByTestId('chat-conversation').innerText()),
    });
    await shot(page, 's5-queue-blocked-light-1440');
    await page.context().close();
  }
  // Domain: a team run on the same board — the Failing node fails; what does Domain say?
  const domainSeen: Record<string, unknown> = {};
  await inEachLook(browser, 's5-domain', async (page, look) => {
    const fresh = await board('domainfail', [
      ['Writer', 'mock-text'],
      ['Failing', 'mock-503'],
    ]);
    await open(page, `${fresh.base}/domain`);
    // on a phone the team panel lies over the composer (see s5-domain-*-380): typed regardless
    await page.getByRole('textbox', { name: 'Message' }).fill('Write a tagline', { force: true });
    await page.getByRole('button', { name: 'Start team run' }).click({ force: true });
    await page.waitForTimeout(15_000);
    const body = await page
      .getByRole('region', { name: 'Domain', exact: true })
      .innerText()
      .catch(() => '');
    const runId = new URL(page.url()).searchParams.get('run') ?? '';
    type NodeRunRow = { nodeId: string; status: string; failureReason?: string };
    const raw = runId
      ? await api<NodeRunRow[] | { items: NodeRunRow[] }>(`/runs/${runId}/node-runs`).catch(
          () => [],
        )
      : [];
    const nodeRuns = Array.isArray(raw) ? raw : raw.items;
    domainSeen[`${look.theme}-${look.width}`] = {
      runId,
      run: runId ? await api<{ status: string }>(`/runs/${runId}`).then((r) => r.status) : '',
      mentionsFailure: /fail|error|could not|503|unavailable/iu.test(body),
      excerpt: body.slice(0, 700),
      nodeRuns: nodeRuns.map((n) => ({ status: n.status, failureReason: n.failureReason })),
    };
  });
  record('s5-domain', domainSeen);
});

test('S6 chat messages have no copy / retry / edit / delete', async ({ browser }) => {
  const seen: Record<string, unknown> = {};
  // a project of its own: S5's never-ending turn holds `free`'s project queue
  const chat = await board('chat', [['Writer', 'mock-text']]);
  await inEachLook(browser, 's6-chat-actions', async (page, look) => {
    await open(page, chat.base);
    await pickChatNode(page, chat.ids['Writer'] ?? '');
    await page.getByTestId('chat-input').fill('Draft a tagline for ACE');
    await page.getByTestId('chat-send').click();
    await page.waitForTimeout(3_000);
    const bodies = page.getByTestId('message-body');
    const count = await bodies.count();
    if (count > 0) await bodies.nth(count - 1).hover();
    await page.waitForTimeout(300);
    const conversation = page.getByTestId('chat-conversation');
    seen[`${look.theme}-${look.width}`] = {
      messages: count,
      actionButtons: await conversation
        .getByRole('button', { name: /copy|retry|resend|edit|delete|regenerate|stop/iu })
        .count(),
      allButtonsInConversation: await conversation.getByRole('button').allTextContents(),
      stopInComposer: await page.getByRole('button', { name: /stop/iu }).count(),
    };
  });
  record('s6', seen);
});

test('S7 mode symptoms: canvas after Domain, following a node across modes', async ({
  browser,
}) => {
  const page = await themedPage(browser, 'light', 1440);
  await open(page, linked.base);
  await page.getByTestId('workspace-menu').click();
  await page.getByTestId('menu-start-run').click();
  await page.waitForTimeout(800);
  const runs = await api<{ items: { id: string; status: string }[] }>(
    `/workflows/${linked.workflowId}/runs`,
  );
  const runId = runs.items[0]?.id ?? '';
  const ideateWhileRunning = await page.locator('.react-flow__node').allInnerTexts();
  await page.getByRole('radio', { name: /Domain/u }).click();
  await page.waitForTimeout(500);
  const domainUrl = page.url();
  let status = '';
  for (let i = 0; i < 60; i += 1) {
    status = (await api<{ status: string }>(`/runs/${runId}`)).status;
    if (status !== 'RUNNING' && status !== 'PREFLIGHT') break;
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(800);
  await shot(page, 's7-domain-after-run-light-1440');
  await page.getByRole('radio', { name: /Ideate/u }).click();
  await page.waitForTimeout(2_500);
  const cards = await page.locator('.react-flow__node').allInnerTexts();
  await page.getByTestId('workspace-menu').click();
  await page.waitForTimeout(300);
  const startItem = page.getByTestId('menu-start-run');
  const menu = {
    startPresent: await startItem.count(),
    startDisabled: (await startItem.count()) ? await startItem.getAttribute('data-disabled') : null,
    items: await page.getByRole('menuitem').allTextContents(),
  };
  await page.keyboard.press('Escape');
  record('s7-stuck', {
    runId,
    apiStatus: status,
    domainUrl,
    ideateWhileRunning: ideateWhileRunning.map((t) => t.replace(/\s+/gu, ' ').slice(0, 80)),
    ideateAfterDomain: cards.map((t) => t.replace(/\s+/gu, ' ').slice(0, 80)),
    menu,
  });
  await page.context().close();

  await inEachLook(browser, 's7-stuck-running', async (p) => {
    // the same walk per look, on a new run of the same board
    await open(p, linked.base);
    if ((p.viewportSize()?.width ?? 1440) < 700) {
      // the phone's top bar has its own Run button
      await p.getByRole('button', { name: 'Start run', exact: true }).first().click();
    } else {
      await p.getByTestId('workspace-menu').click();
      await p.getByTestId('menu-start-run').click();
    }
    await p.waitForTimeout(600);
    const mode = p.getByRole('radio', { name: /Domain/u });
    if (await mode.isVisible().catch(() => false)) await mode.click();
    else await open(p, `${linked.base}/domain`);
    for (let i = 0; i < 60; i += 1) {
      const latest = (
        await api<{ items: { id: string; status: string }[] }>(
          `/workflows/${linked.workflowId}/runs`,
        )
      ).items[0];
      if (latest !== undefined && latest.status !== 'RUNNING' && latest.status !== 'PREFLIGHT')
        break;
      await p.waitForTimeout(500);
    }
    const back = p.getByRole('radio', { name: /Ideate/u });
    if (await back.isVisible().catch(() => false)) await back.click();
    else await p.goBack();
    await p.waitForTimeout(2_500);
  });

  // Following a node: select Draft in Ideate, switch to Forge and Domain, read the URLs.
  const follow = await themedPage(browser, 'light', 1440);
  await open(follow, linked.base);
  await card(follow, linked.ids['Edit'] ?? '').click({ position: { x: 60, y: 60 } });
  await follow.waitForTimeout(400);
  await follow.keyboard.press('Escape');
  const urls: Record<string, string> = { ideate: follow.url() };
  await follow.getByRole('radio', { name: /Forge/u }).click();
  await follow.waitForTimeout(800);
  urls['forge'] = follow.url();
  await follow.getByRole('radio', { name: /Domain/u }).click();
  await follow.waitForTimeout(1_200);
  urls['domain'] = follow.url();
  const showOnCanvas = await follow.getByRole('button', { name: /canvas/iu }).count();
  const links = await follow.getByRole('link', { name: /canvas|ideate/iu }).count();
  record('s7-follow', { urls, showOnCanvasButtons: showOnCanvas, canvasLinks: links });
  await follow.context().close();
  await inEachLook(browser, 's7-follow-node', async (p) => {
    await open(p, linked.base);
    await card(p, linked.ids['Edit'] ?? '')
      .click({ position: { x: 60, y: 60 } })
      .catch(() => undefined);
    await p.waitForTimeout(300);
    await p.keyboard.press('Escape');
    const mode = p.getByRole('radio', { name: /Domain/u });
    if (await mode.isVisible().catch(() => false)) await mode.click();
    else await open(p, `${linked.base}/domain`);
    await p.waitForTimeout(1_200);
  });
});

/* ================================================================== item 4: visibility */

test('A visibility audit: every route, both themes', async ({ browser }) => {
  const runs = await api<{ items: { id: string }[] }>(`/workflows/${linked.workflowId}/runs`);
  const runId = runs.items[0]?.id ?? '';
  await api(`/projects/${linked.projectId}/files/content`, {
    method: 'PUT',
    body: JSON.stringify({
      path: 'index.ts',
      content: 'export const answer = 42;\n',
      baseVersion: null,
      eol: 'lf',
      bom: false,
    }),
  }).catch((error: unknown) => record('forge-file', String(error)));
  type Step = (page: Page) => Promise<void>;
  const routes: [string, string, Step?][] = [
    ['home', '/projects'],
    ['project', `/projects/${linked.projectId}`],
    ['ideate', linked.base],
    [
      'ideate-node-settings',
      linked.base,
      async (page) => {
        await card(page, linked.ids['Draft'] ?? '').click({ position: { x: 60, y: 60 } });
        await page.waitForTimeout(500);
      },
    ],
    [
      'ideate-chat',
      linked.base,
      async (page) => {
        await pickChatNode(page, linked.ids['Draft'] ?? '');
        await page.waitForTimeout(500);
      },
    ],
    [
      'forge',
      `${linked.base}/forge`,
      async (page) => {
        await page.getByText('index.ts').first().click();
        await page.waitForTimeout(800);
      },
    ],
    ['domain', `${linked.base}/domain${runId ? `?run=${runId}` : ''}`],
    ['run-detail', `/runs/${runId}`],
    ['timeline', `${linked.base}/timeline`],
    ['providers', '/providers'],
    [
      'providers-models',
      '/providers',
      async (page) => {
        await page.getByRole('tab', { name: 'Models' }).click();
        await page.waitForTimeout(500);
      },
    ],
    ['settings', '/settings'],
    ['onboarding', '/onboarding'],
  ];
  const audit: Record<string, AuditResult | string> = {};
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1440, 380]) {
      for (const [name, path, step] of routes) {
        const page = await themedPage(browser, theme, width);
        try {
          await open(page, path);
          // a step a look cannot take (a phone has no node settings) is noted; the page is audited
          const stepError = step
            ? await step(page).then(
                () => '',
                (error: unknown) => String(error).split('\n')[0] ?? '',
              )
            : '';
          if (stepError !== '') record(`audit-step|${name}|${theme}|${width}`, stepError);
          audit[`${name}|${theme}|${width}`] = await page.evaluate<AuditResult>(IN_PAGE_AUDIT);
          if (width === 1440) await shot(page, `a-${name}-${theme}-${width}`);
        } catch (error) {
          audit[`${name}|${theme}|${width}`] = String(error).slice(0, 300);
        }
        await page.context().close();
      }
    }
  }
  record('audit', audit);
});

/* ================================================================== last: a clean engine */

test('S3b Add node on an engine with no providers makes a providerless node', async ({
  browser,
}) => {
  await control('fresh');
  try {
    const project = await api<{ id: string }>('/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'pg-no-provider' }),
    });
    const workflow = await api<{ id: string }>(`/projects/${project.id}/workflows`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Empty' }),
    });
    const base = `/projects/${project.id}/workflows/${workflow.id}`;
    let made: Node | undefined;
    await inEachLook(browser, 's3-no-provider', async (page) => {
      await open(page, base);
      await page.getByTestId('new-node-button').click();
      await page.waitForTimeout(1_200);
      made = (await graph(workflow.id)).nodes.at(-1);
      if (made !== undefined) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
    });
    const nodes = (await graph(workflow.id)).nodes;
    record('s3-no-provider', {
      nodes: nodes.length,
      configs: nodes.map((n) => n.config),
      validation: await api(`/workflows/${workflow.id}/validate`, { method: 'POST' }).catch(
        (error: unknown) => String(error).slice(0, 300),
      ),
    });
  } finally {
    await control('original');
  }
});
