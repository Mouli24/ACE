import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  FORMAT_VERSION,
  derivePorts,
  type Edge,
  type Node,
  type Provider,
  type Run,
  type RunSummary,
  type WorkflowExport,
} from '@ace/contracts';
import { expect, test, type Page } from '@playwright/test';

/**
 * Domain Gate 5, end to end (D303–D327): the real UI — the production build served by
 * `vite preview` — against the real engine on a temp data dir, with `mock-script` agents (D315).
 * No MSW, no fake socket, no env vars, no network. Everything is done by clicking and typing in
 * Domain; the engine is asked over REST only to set the board up and to check what the page says.
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
  const text = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${response.status} ${text}`);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

async function mockProvider(): Promise<string> {
  const { items } = await api<{ items: Provider[] }>('/providers?limit=500');
  const known = items.find(
    (provider) => provider.type === 'mock' && provider.name === 'Domain mock',
  );
  if (known !== undefined) return known.id;
  const created = await api<Provider>('/providers', {
    method: 'POST',
    body: JSON.stringify({ type: 'mock', name: 'Domain mock' }),
  });
  await api(`/providers/${created.id}/refresh-models`, { method: 'POST' });
  return created.id;
}

const fence = (body: Record<string, unknown>): string =>
  ['```ace-envelope', JSON.stringify(body), '```'].join('\n');

/** Writer → Review, with Director as the Brain; each agent plays its `[[turn N]]` script. */
async function team(
  label: string,
): Promise<{ projectId: string; workflowId: string; ids: Record<string, string> }> {
  const providerId = await mockProvider();
  const project = await api<{ id: string }>('/projects', {
    method: 'POST',
    body: JSON.stringify({ name: `domain-${label}-${Date.now().toString(36)}` }),
  });
  const workflowId = '01M6D0MA1NWF000000000000WF';
  const nodes: Node[] = [];
  const add = (name: string, script: string[], brain = false): Node => {
    const draft = {
      id: `01M6D0MA1NN0${String(nodes.length + 1).padStart(14, '0')}`,
      workflowId,
      kind: 'agent' as const,
      name,
      position: { x: nodes.length * 320, y: 80 },
      config: {
        providerId,
        modelId: 'mock-script',
        instructions: [`Act as the ${name}.`, ...script].join('\n'),
        inputTypes: ['text'],
        outputTypes: ['text'],
        ...(brain ? { brain: true } : {}),
      },
    };
    const node = { ...draft, ...derivePorts(draft as Parameters<typeof derivePorts>[0]) } as Node;
    nodes.push(node);
    return node;
  };
  const writer = add('Writer', [
    '[[turn 1]]',
    'Draft: Go further.',
    '[[turn 2]]',
    'Draft two: Go further, faster.',
    '[[turn *]]',
    'Draft three: Further.',
  ]);
  const review = add('Review', [
    '[[turn 1]]',
    'The opening drags.',
    fence({ kind: 'FLAG', to: ['@writer'], summary: 'The hook is weak.' }),
    '[[turn *]]',
    'Approved.',
  ]);
  add('Director', ['[[turn *]]', 'Noted.'], true);
  const edges: Edge[] = [
    {
      id: '01M6D0MA1NED00000000000001',
      workflowId,
      kind: 'data',
      from: { nodeId: writer.id, portId: writer.outputs[0]?.id ?? '' },
      to: { nodeId: review.id, portId: review.inputs[0]?.id ?? '' },
    },
  ];
  const exported: WorkflowExport = {
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    name: `Domain ${label}`,
    nodes,
    edges,
  };
  const imported = await api<{ workflow: { id: string }; nodes: Node[] }>(
    `/projects/${project.id}/workflows/import`,
    { method: 'POST', body: JSON.stringify(exported) },
  );
  const ids = Object.fromEntries(imported.nodes.map((node) => [node.name, node.id]));
  return { projectId: project.id, workflowId: imported.workflow.id, ids };
}

async function open(page: Page, path: string): Promise<void> {
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}token=${engine().token}`);
}

/** Domain's conversation column: the footer has a message count of its own (D330). */
const domain = (page: Page) => page.getByRole('region', { name: 'Domain', exact: true });
const messages = (page: Page) => domain(page).getByTestId('domain-message');
const message = (page: Page, text: string) => messages(page).filter({ hasText: text });
/** A FLAG's summary is also its sender's turn text (D327): an envelope is found by its type. */
const envelope = (page: Page, text: string) =>
  domain(page)
    .locator('[data-testid="domain-message"][data-type="envelope"]')
    .filter({ hasText: text });
const said = (page: Page, text: string) =>
  domain(page)
    .locator('[data-testid="domain-message"][data-type="agent"]')
    .filter({ hasText: text });
/** A lens is a filter pill named for its node, in the header's Lenses (D336). */
const lens = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Lenses' }).getByRole('button', { name, exact: true });

test.describe('Domain end to end on mock-script agents', () => {
  test('a run started from Domain: flag, revise, message a node, lens, blocked handle, reload, End', async ({
    page,
  }) => {
    const { projectId, workflowId, ids } = await team('supervised');
    await open(page, `/projects/${projectId}/workflows/${workflowId}/domain`);

    // No run yet: the first message starts one, with itself as the goal (D312, D323).
    await page.getByRole('textbox', { name: 'Message' }).fill('Write a tagline for ACE');
    await page.getByRole('button', { name: 'Start team run' }).click();
    await expect(page).toHaveURL(/[?&]run=/u);

    // Review flags the Writer; the revised draft goes back to Review, who approves (D310).
    await expect(envelope(page, 'The hook is weak.')).toHaveCount(1);
    await expect(envelope(page, 'The hook is weak.')).toContainText('@review → @writer');
    await expect(envelope(page, 'The hook is weak.')).toContainText('FLAG');
    await expect(said(page, 'Draft two: Go further, faster.')).toHaveCount(1);
    await expect(said(page, 'Approved.').first()).toBeVisible();
    const runId = new URL(page.url()).searchParams.get('run') ?? '';
    await expect.poll(async () => (await api<Run>(`/runs/${runId}`)).status).toBe('RUNNING');

    // An agent message expands to its steps and output ("What it did", D336).
    const draft = said(page, 'Draft: Go further.').first();
    const whatItDid = draft.getByRole('button', { name: /What it did/ });
    await whatItDid.click();
    await expect(whatItDid).toHaveAttribute('aria-expanded', 'true');

    // A handle nobody has cannot be sent (D324).
    const box = page.getByRole('textbox', { name: 'Message' });
    await box.fill('@nobody hello');
    const composer = page.getByRole('form', { name: 'Composer' });
    await expect(composer.getByRole('alert')).toContainText('@nobody');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();

    // Message the Writer by name: it takes a turn, and the delivery reaches DONE (D309).
    await box.fill('Writer, make it shorter');
    await expect(page.getByTestId('composer-reaches')).toContainText('@writer');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const sent = message(page, 'Writer, make it shorter');
    await expect(sent.getByTestId('delivery-writer')).toContainText('DONE');
    await expect(said(page, 'Draft three: Further.').first()).toBeVisible();

    // The team panel has each node's state and numbers — tokens, input / output (D336); the mock
    // reports its usage, so no estimate here.
    const writerCard = page.getByTestId('team-node-writer');
    await expect(writerCard.getByTestId('team-node-state')).toHaveText(
      /^(Done|Working|Waiting|Failed|Blocked|Stopped)$/u,
    );
    await expect(writerCard).toContainText(/Tokens\s*[\d.]+[kM]?\s*[\d.]+[kM]? \/ [\d.]+[kM]?/u);
    await expect(page.getByTestId('team-totals')).toBeVisible();

    // A lens is the Review's view only (D5). (By the node's name in the Lenses: "@review" is the
    // composer's mention chip now.)
    await lens(page, 'Review').click();
    await expect(page).toHaveURL(new RegExp(`node=${ids['Review']}`));
    await expect(message(page, 'Write a tagline for ACE')).toHaveCount(0);
    await expect(envelope(page, 'The hook is weak.')).toHaveCount(1);
    await lens(page, 'All').click();

    // A reload replays the stream from the start: every message exactly once (D314).
    // The page shows exactly the server's conversation — no message missing, none twice.
    const served = (await api<{ messages: unknown[] }>(`/runs/${runId}/chat?limit=500`)).messages
      .length;
    await expect(messages(page)).toHaveCount(served);
    await page.reload();
    await expect(envelope(page, 'The hook is weak.')).toHaveCount(1);
    await expect(messages(page)).toHaveCount(served);

    // End: COMPLETE, and the conversation is read-only (D323) — but the composer still writes: a
    // message now starts a new run. End run is in the run pill's menu (D336).
    await domain(page)
      .getByRole('button', { name: /^Run ·/u })
      .click();
    await page.getByRole('menuitem', { name: 'End run' }).click();
    await expect(domain(page).getByText(/read-only/iu)).toBeVisible();
    await expect(box).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Start team run' })).toBeVisible();
    await expect.poll(async () => (await api<Run>(`/runs/${runId}`)).status).toBe('COMPLETE');

    // Domain is a mode beside Ideate and Forge.
    await expect(page.getByRole('radio', { name: /Domain/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await page.getByRole('radio', { name: /Ideate/ }).click();
    await expect(page).toHaveURL(new RegExp(`/workflows/${workflowId}$`));
  });

  test('manual routing: a held envelope is approved from the conversation', async ({ page }) => {
    const { projectId, workflowId } = await team('manual');
    const run = await api<Run>(`/workflows/${workflowId}/runs`, {
      method: 'POST',
      body: JSON.stringify({ goal: 'A tagline', domain: { routing: 'manual', stayOpen: true } }),
    });
    await open(page, `/projects/${projectId}/workflows/${workflowId}/domain?run=${run.id}`);

    const held = messages(page).filter({ hasText: 'HELD' }).first();
    await expect(held).toContainText('@writer → @review');
    await held.getByRole('button', { name: 'Approve' }).click();
    await expect(messages(page).filter({ hasText: '@writer → @review' }).first()).toContainText(
      'FORWARDED',
    );
    // Forwarded, the draft reaches Review, whose FLAG is held in turn.
    await expect(envelope(page, 'The hook is weak.')).toContainText('HELD');
    const runs = await api<{ items: RunSummary[] }>(`/workflows/${workflowId}/runs`);
    expect(runs.items.map((each) => each.id)).toContain(run.id);
    await api(`/runs/${run.id}/end`, { method: 'POST' });
  });
});
