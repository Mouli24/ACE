import { expect, type Locator, type Page } from '@playwright/test';

import { freshApp, selectInSheet } from './helpers';

// Type-only: brings the `window.__aceMock` declaration from the mock bootstrap into scope.
import type {} from '../src/mocks/browser';

/**
 * Round 3 e2e plumbing (§5 items 2–10).
 *
 * Round 2's `seedRunnable` gives one runnable shape — Input → Agent → Output — and three of round 3's
 * stories need more of a graph than that: a second executable node for a pause to be caught before
 * (FR-CTL-001) and for a failure to block something downstream (FR-ERR-006), a Merge with two
 * branches feeding it (FR-PAR-002), and a loop edge to iterate (FR-CON-007, FR-PAR-005).
 *
 * Rather than a second mock engine, these build on `seedRunnable`'s own project, provider and node
 * config and extend the graph through the same `window.__aceMock.db` the round 1 helpers use. The
 * port ids follow the contract's one convention (`<nodeId>:<in|out>:<name>`), which
 * `connections.spec.ts` already asserts against the engine, so a graph seeded here is a graph the
 * app and the mock engine both read as real.
 */

export type Scenario = Parameters<NonNullable<Window['__aceMock']>['setScenario']>[0];
export type Pace = Parameters<NonNullable<Window['__aceMock']>['setStreamPace']>[0];

/** Which graph to build. `chain` is two agents in a row; the other two are named after their node. */
export type Shape = 'chain' | 'merge' | 'loop';

export interface Seeded3 {
  projectId: string;
  workflowId: string;
  providerId: string;
  inputId: string;
  outputId: string;
  /** The executable nodes, in the order a run reaches them. */
  agentIds: string[];
  /** The names those nodes carry on the Canvas, in the same order. */
  agentNames: string[];
  mergeId?: string;
  loopEdgeId?: string;
}

/** The names the shapes use, so an assertion can quote what the screen says. */
export const NODE_NAMES = {
  first: 'Writer',
  second: 'Editor',
  reviewer: 'Reviewer',
  checker: 'Checker',
} as const;

/**
 * Seed a graph, choose the scenario the next run plays, and open the Canvas on it. The scenario is
 * chosen before the navigation because the mock keeps it in localStorage (round 2 §5 item 11); the
 * pace is chosen the same way and for the same reason (D200).
 */
export async function openRound3(
  page: Page,
  shape: Shape,
  scenario: Scenario,
  options: {
    text?: string;
    maxIterations?: number;
    omitLoopEdge?: boolean;
    /** Give the Reviewer a text output beside its json one, so a backward drag is type-compatible. */
    reviewerTextOutput?: boolean;
    /** Give the Writer a spare json input, so a backward drag lands on a free, matching port. */
    writerJsonInput?: boolean;
    /**
     * `slow` makes every node stream at `mock-slow`'s pace against the real engine (~2 s a node).
     * A test that clicks a run control needs it: at the default pace the whole story can be over
     * before the click lands, which is how the §1 loop walk failed on CI (D200).
     */
    pace?: Pace;
  } = {},
): Promise<Seeded3> {
  await freshApp(page);
  const seeded = await seedShape(page, shape, options);
  await page.evaluate((name) => window.__aceMock!.setScenario(name), scenario);
  if (options.pace !== undefined) {
    await page.evaluate((pace) => window.__aceMock!.setStreamPace(pace), options.pace);
  }
  await page.goto(`/projects/${seeded.projectId}/workflows/${seeded.workflowId}`);
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  return seeded;
}

/** Build one of the three shapes in the mock engine's database. */
export async function seedShape(
  page: Page,
  shape: Shape,
  options: {
    text?: string;
    maxIterations?: number;
    omitLoopEdge?: boolean;
    /** Give the Reviewer a text output beside its json one, so a backward drag is type-compatible. */
    reviewerTextOutput?: boolean;
    /** Give the Writer a spare json input, so a backward drag lands on a free, matching port. */
    writerJsonInput?: boolean;
  } = {},
): Promise<Seeded3> {
  return page.evaluate(
    ({ shape, options, names }) => {
      const mock = window.__aceMock!;
      const db = mock.db;
      const base = mock.seedRunnable({
        ...(options.text === undefined ? {} : { text: options.text }),
      });
      db.load();

      const wf = base.workflowId;
      type Port = { id: string; name: string; dataType: string; multi: boolean };
      type Loose = {
        id: string;
        workflowId: string;
        kind: string;
        name: string;
        position: { x: number; y: number };
        config: Record<string, unknown>;
        inputs: Port[];
        outputs: Port[];
      };
      type LooseEdge = {
        id: string;
        workflowId: string;
        kind: string;
        from: { nodeId: string; portId: string };
        to: { nodeId: string; portId: string };
        loop?: unknown;
      };

      const all = db.nodesOf(wf) as unknown as Loose[];
      const input = all.find((node) => node.id === base.inputId)!;
      const first = all.find((node) => node.id === base.agentId)!;
      const output = all.find((node) => node.id === base.outputId)!;
      first.name = names.first;

      const portId = (nodeId: string, dir: 'in' | 'out', name: string) =>
        `${nodeId}:${dir}:${name}`;
      const inPort = (nodeId: string, name: string, dataType: string, multi = false): Port => ({
        id: portId(nodeId, 'in', name),
        name,
        dataType,
        multi,
      });
      const outPort = (nodeId: string, name: string, dataType: string): Port => ({
        id: portId(nodeId, 'out', name),
        name,
        dataType,
        multi: true,
      });
      const link = (from: string, fromPort: string, to: string, toPort: string): LooseEdge => ({
        id: db.nextId(),
        workflowId: wf,
        kind: 'data',
        from: { nodeId: from, portId: portId(from, 'out', fromPort) },
        to: { nodeId: to, portId: portId(to, 'in', toPort) },
      });

      /*
       * A second agent, cloned from the one `seedRunnable` already configured so it carries the same
       * provider and the same valid `AgentConfig`; only its id, name, position, ports and model
       * change. A `json` agent answers on `mock-json`, which is what a loop's exit condition and a
       * Merge's json slot need.
       */
      const agentLike = (spec: {
        name: string;
        x: number;
        y?: number;
        json?: boolean;
        alsoText?: boolean;
      }): Loose => {
        const id = db.nextId();
        const clone = JSON.parse(JSON.stringify(first)) as Loose;
        clone.id = id;
        clone.name = spec.name;
        clone.position = { x: spec.x, y: spec.y ?? first.position.y };
        clone.inputs = [inPort(id, 'text', 'text')];
        const outputTypes =
          spec.json === true ? (spec.alsoText === true ? ['text', 'json'] : ['json']) : ['text'];
        clone.outputs = outputTypes.map((type) => outPort(id, type, type));
        clone.config = {
          ...clone.config,
          modelId: spec.json === true ? 'mock-json' : 'mock-text',
          inputTypes: ['text'],
          outputTypes,
        };
        return clone;
      };

      let nodes: Loose[];
      let edges: LooseEdge[];
      let agents: Loose[];
      let mergeId: string | undefined;
      let loopEdgeId: string | undefined;

      if (shape === 'chain') {
        const second = agentLike({ name: names.second, x: 640 });
        output.position = { x: 900, y: output.position.y };
        nodes = [input, first, second, output];
        agents = [first, second];
        edges = [
          link(input.id, 'text', first.id, 'text'),
          link(first.id, 'text', second.id, 'text'),
          link(second.id, 'text', output.id, 'text'),
        ];
      } else if (shape === 'merge') {
        const checker = agentLike({
          name: names.checker,
          x: 420,
          y: first.position.y + 200,
          json: true,
        });
        const mergeNodeId = db.nextId();
        const merge: Loose = {
          id: mergeNodeId,
          workflowId: wf,
          kind: 'merge',
          name: 'Merge',
          position: { x: 700, y: first.position.y + 80 },
          config: { mode: 'any' },
          inputs: [
            inPort(mergeNodeId, 'in', 'text', true),
            inPort(mergeNodeId, 'in_json', 'json', true),
          ],
          outputs: [outPort(mergeNodeId, 'out', 'json')],
        };
        mergeId = mergeNodeId;
        output.position = { x: 960, y: first.position.y + 80 };
        nodes = [input, first, checker, merge, output];
        agents = [first, checker];
        edges = [
          link(input.id, 'text', first.id, 'text'),
          link(input.id, 'text', checker.id, 'text'),
          link(first.id, 'text', merge.id, 'in'),
          link(checker.id, 'json', merge.id, 'in_json'),
          link(merge.id, 'out', output.id, 'json'),
        ];
      } else {
        if (options.writerJsonInput === true) {
          first.inputs = [inPort(first.id, 'text', 'text'), inPort(first.id, 'json', 'json')];
          first.config = { ...first.config, inputTypes: ['text', 'json'] };
        }
        const reviewer = agentLike({
          name: names.reviewer,
          x: 660,
          json: true,
          ...(options.reviewerTextOutput === true ? { alsoText: true } : {}),
        });
        output.position = { x: 940, y: output.position.y };
        nodes = [input, first, reviewer, output];
        agents = [first, reviewer];
        const loop: LooseEdge = {
          id: db.nextId(),
          workflowId: wf,
          kind: 'loop',
          from: { nodeId: reviewer.id, portId: portId(reviewer.id, 'out', 'json') },
          to: { nodeId: first.id, portId: portId(first.id, 'in', 'text') },
          loop: {
            maxIterations: options.maxIterations ?? 3,
            exitCondition: { path: 'verdict', equals: 'approved' },
            onMax: 'continue',
          },
        };
        edges = [
          link(input.id, 'text', first.id, 'text'),
          link(first.id, 'text', reviewer.id, 'text'),
          link(reviewer.id, 'json', output.id, 'json'),
        ];
        // `omitLoopEdge` leaves the cycle to be drawn by hand, which is what TC-CON-007 does.
        if (options.omitLoopEdge !== true) {
          loopEdgeId = loop.id;
          edges.push(loop);
        }
      }

      db.commitGraph(
        wf,
        nodes as unknown as Parameters<typeof db.commitGraph>[1],
        edges as unknown as Parameters<typeof db.commitGraph>[2],
        { silent: true },
      );

      return {
        projectId: base.projectId,
        workflowId: wf,
        providerId: base.providerId,
        inputId: input.id,
        outputId: output.id,
        agentIds: agents.map((node) => node.id),
        agentNames: agents.map((node) => node.name),
        ...(mergeId === undefined ? {} : { mergeId }),
        ...(loopEdgeId === undefined ? {} : { loopEdgeId }),
      };
    },
    { shape, options, names: NODE_NAMES },
  );
}

/* -------------------------------------------------------------------------- */
/* Reading what the mock engine holds — the side an assertion compares against */
/* -------------------------------------------------------------------------- */

/**
 * The mock engine starts asynchronously, so a read taken straight after a navigation can land before
 * `window.__aceMock` exists. Every reader below waits for it rather than racing it.
 */
async function mockReady(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__aceMock !== undefined);
}

export interface EngineRun {
  id: string;
  status: string;
  allowedActions: string[];
  haltReason?: string;
}

/**
 * The newest run of a workflow, as the engine recorded it. `listRuns` answers newest first and two
 * runs can share a millisecond, so the ULID breaks the tie — a restart must never be read as the run
 * it replaced.
 */
export async function engineRun(page: Page, workflowId: string): Promise<EngineRun | undefined> {
  await mockReady(page);
  return page.evaluate((id) => {
    const db = window.__aceMock!.db;
    db.load();
    const run = [...db.listRuns(id)].sort(
      (a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id),
    )[0];
    if (run === undefined) return undefined;
    return {
      id: run.id,
      status: run.status as string,
      allowedActions: [...(run.allowedActions ?? [])] as string[],
      ...(run.haltReason === undefined ? {} : { haltReason: run.haltReason as string }),
    };
  }, workflowId);
}

export async function engineRunCount(page: Page, workflowId: string): Promise<number> {
  await mockReady(page);
  return page.evaluate((id) => {
    const db = window.__aceMock!.db;
    db.load();
    return db.listRuns(id).length;
  }, workflowId);
}

export interface EngineNodeRun {
  id: string;
  nodeId: string;
  status: string;
  attempt: number;
  iteration: number;
  failureReason?: string;
  errorKind?: string;
}

/** Every node run the engine has recorded for a run. */
export async function engineNodeRuns(page: Page, runId: string): Promise<EngineNodeRun[]> {
  await mockReady(page);
  return page.evaluate((id) => {
    const db = window.__aceMock!.db;
    db.load();
    return db.listNodeRuns(id).map((nodeRun) => ({
      id: nodeRun.id,
      nodeId: nodeRun.nodeId,
      status: nodeRun.status as string,
      attempt: nodeRun.attempt,
      iteration: nodeRun.iteration,
      ...(nodeRun.failureReason === undefined
        ? {}
        : { failureReason: nodeRun.failureReason as string }),
      ...(nodeRun.error === undefined ? {} : { errorKind: nodeRun.error.kind as string }),
    }));
  }, runId);
}

/** The seq of the newest event the mock engine has emitted — 0 when it has emitted none. */
export async function lastEventSeq(page: Page): Promise<number> {
  await mockReady(page);
  return page.evaluate(() => {
    const db = window.__aceMock!.db;
    db.load();
    return db.events.at(-1)?.seq ?? 0;
  });
}

/** The graph the mock engine holds, including each loop edge's config. */
export async function engineEdges(page: Page, workflowId: string) {
  await mockReady(page);
  return page.evaluate((id) => {
    const db = window.__aceMock!.db;
    db.load();
    return db.edgesOf(id).map((edge) => ({
      id: edge.id,
      kind: edge.kind as string,
      from: edge.from.nodeId,
      to: edge.to.nodeId,
      ...(edge.loop === undefined ? {} : { loop: edge.loop }),
    }));
  }, workflowId);
}

/** The project as the engine holds it, for the per-run cost cap (FR-GRD-008). */
export async function engineProject(page: Page, projectId: string) {
  await mockReady(page);
  return page.evaluate((id) => {
    const db = window.__aceMock!.db;
    db.load();
    const project = db.getProject(id);
    return project === undefined
      ? undefined
      : { id: project.id, maxCostPerRunUsd: project.maxCostPerRunUsd ?? null };
  }, projectId);
}

/** The engine settings, for the daily budget (FR-GRD-008). */
export async function engineDailyBudget(page: Page): Promise<number | null> {
  await mockReady(page);
  return page.evaluate(() => {
    const db = window.__aceMock!.db;
    db.load();
    return db.settings.dailyBudgetUsd ?? null;
  });
}

/** Set the project's per-run cost cap, which `budget-halt` measures itself against (§2.3, D80). */
export async function setRunCostCap(page: Page, projectId: string, capUsd: number): Promise<void> {
  await mockReady(page);
  await page.evaluate(
    ({ projectId, capUsd }) => {
      const db = window.__aceMock!.db;
      db.load();
      db.updateProject(projectId, { maxCostPerRunUsd: capUsd });
    },
    { projectId, capUsd },
  );
}

/** Give an agent node a guardrail policy override, as the config panel's picker would (FR-GRD-002). */
export async function setNodePolicy(
  page: Page,
  workflowId: string,
  nodeId: string,
  policyId: string,
): Promise<void> {
  await mockReady(page);
  await page.evaluate(
    ({ workflowId, nodeId, policyId }) => {
      const db = window.__aceMock!.db;
      db.load();
      const nodes = db.nodesOf(workflowId);
      for (const node of nodes) {
        if (node.id !== nodeId) continue;
        (node.config as { guardrailPolicyId?: string }).guardrailPolicyId = policyId;
      }
      db.commitGraph(workflowId, nodes, db.edgesOf(workflowId), { silent: true });
    },
    { workflowId, nodeId, policyId },
  );
}

/** The policies of a project, as the engine holds them. */
export async function enginePolicies(page: Page, projectId: string) {
  await mockReady(page);
  return page.evaluate((id) => {
    const db = window.__aceMock!.db;
    db.load();
    return db.listPolicies(id).map((policy) => ({
      id: policy.id,
      name: policy.name,
      version: policy.version,
      isProjectDefault: policy.isProjectDefault,
    }));
  }, projectId);
}

/* -------------------------------------------------------------------------- */
/* The run controls (FR-CTL-006)                                               */
/* -------------------------------------------------------------------------- */

/*
 * Where a run is started, read and controlled depends on the width (D330, D331): on desktop the
 * workspace "…" menu starts and controls it and the footer carries its state as `data-run-status`;
 * at phone width (≤ 640 px) the compact bar keeps the run bar (`run-bar`, `run-status`,
 * `run-controls`). The helpers below that do not say which one ask the viewport.
 */
const isPhone = (page: Page): boolean => (page.viewportSize()?.width ?? Infinity) <= 640;

/** The workspace "…" menu's content (the menu that holds "Workflow panel"). */
export const workspaceMenu = (page: Page): Locator =>
  page.getByRole('menu').filter({ has: page.getByTestId('menu-sheet') });

/** Open the workspace "…" menu, unless it is open already. */
export async function openWorkspaceMenu(page: Page): Promise<Locator> {
  const menu = workspaceMenu(page);
  if (!(await menu.isVisible())) await page.getByTestId('workspace-menu').click();
  await expect(menu).toBeVisible();
  return menu;
}

/** Close the workspace "…" menu if it is open: it is modal, so nothing else takes a click under it. */
export async function closeWorkspaceMenu(page: Page): Promise<void> {
  const menu = workspaceMenu(page);
  if (await menu.isVisible()) await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
}

export interface ControlState {
  /** What the screen read out of `run.allowedActions`: the controls it offers. */
  allowed: string[];
  /** The controls a person can actually press. */
  enabled: string[];
}

/**
 * Every run control the workspace menu offers, with no list of actions written here: the actions
 * are read off the items themselves (`menu-run-<action>`; "Run details" is a link, not a control),
 * so this cannot drift from `RUN_ACTIONS` and cannot quietly stop checking a control that was added.
 * The menu renders a control only when `run.allowedActions` names it, so what it shows is what is
 * allowed; an item it shows but disables is allowed and not pressable.
 */
export async function controlState(page: Page): Promise<ControlState> {
  const menu = await openWorkspaceMenu(page);
  const items = menu.locator('[data-testid^="menu-run-"]:not([data-testid="menu-run-details"])');
  const count = await items.count();
  const allowed: string[] = [];
  const enabled: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const item = items.nth(i);
    const action = ((await item.getAttribute('data-testid')) ?? '').replace('menu-run-', '');
    allowed.push(action);
    if ((await item.getAttribute('aria-disabled')) !== 'true') enabled.push(action);
  }
  await closeWorkspaceMenu(page);
  return { allowed: allowed.sort(), enabled: enabled.sort() };
}

/**
 * The same read on the Run details page, which keeps the toolbar (`run-controls`): every control is
 * drawn there, `data-allowed` saying whether the engine allows it.
 */
export async function runPageControlState(page: Page): Promise<ControlState> {
  const buttons = page.getByTestId('run-controls').locator('[data-testid^="run-action-"]');
  await expect(buttons.first()).toBeVisible();
  const count = await buttons.count();
  const allowed: string[] = [];
  const enabled: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const button = buttons.nth(i);
    const action = ((await button.getAttribute('data-testid')) ?? '').replace('run-action-', '');
    if ((await button.getAttribute('data-allowed')) === 'true') allowed.push(action);
    if (await button.isEnabled()) enabled.push(action);
  }
  return { allowed: allowed.sort(), enabled: enabled.sort() };
}

/** Press one run control in the workspace menu (Pause, Resume, Restart, End; Stop… asks first). */
export async function runAction(page: Page, action: string): Promise<void> {
  const menu = await openWorkspaceMenu(page);
  await menu.getByTestId(`menu-run-${action}`).click();
  await expect(menu).toHaveCount(0);
}

/**
 * A control is only meaningful while the engine still allows it, and a run does not wait for a test.
 * Reading `allowedActions` off the engine before the click turns the one failure this class produces
 * into a sentence: a bare `toHaveAttribute` timeout says only "not PAUSED", which is what both the
 * `slow-stream` defect and the §1 loop walk (D200) failed with, twice, on a loaded CI runner.
 */
export async function stillAllows(page: Page, workflowId: string, action: string): Promise<void> {
  const run = await engineRun(page, workflowId);
  expect(
    run?.allowedActions ?? [],
    `the engine no longer allows ${action}: the run is ${run?.status} — the tour raced the run`,
  ).toContain(action);
}

/**
 * The phone run bar's Start button (≤ 640 px; desktop has no run bar — use `clickStartRun`).
 * `exact`, because the run bar's own "Restart" contains "start" (D-031). The button shows "Run";
 * its accessible name is "Start run" (D259).
 */
export const startRun = (page: Page): Locator =>
  page.getByTestId('run-bar').getByRole('button', { name: 'Start run', exact: true });

/** The phone run bar's state chip (≤ 640 px; desktop reads the footer — use `expectRunStatus`). */
export const runStatus = (page: Page): Locator => page.getByTestId('run-status');

/** Start the run: the workspace menu's "Start run" on desktop, the run bar's at phone width. */
export async function clickStartRun(page: Page): Promise<void> {
  if (isPhone(page)) {
    await startRun(page).click();
    return;
  }
  const menu = await openWorkspaceMenu(page);
  await menu.getByTestId('menu-start-run').click();
  await expect(menu).toHaveCount(0);
}

/** The workspace footer, which carries the run's state as `data-run-status` (D330). */
export const runFooter = (page: Page): Locator =>
  page.getByRole('contentinfo').filter({ has: page.getByTestId('footer-mode') });

/** The run is in `status`: the footer's `data-run-status` on desktop, the run bar's chip on phones. */
export async function expectRunStatus(
  page: Page,
  status: string,
  options: { timeout?: number } = {},
): Promise<void> {
  if (isPhone(page)) {
    await expect(runStatus(page)).toHaveAttribute('data-status', status, options);
  } else {
    await expect(runFooter(page)).toHaveAttribute('data-run-status', status, options);
  }
}

/** Stop asks first; this answers the dialog (FR-CTL-003). The workspace menu's "Stop…" opens it. */
export async function stopRun(page: Page): Promise<void> {
  await runAction(page, 'stop');
  const confirm = page.getByTestId('stop-confirm');
  await expect(confirm).toBeVisible();
  await confirm.getByTestId('stop-confirm-stop').click();
}

/**
 * Open one of the bottom panel's tabs (Validation · Events · Errors · Timeline; names carry a
 * count). The panel is hidden until the workspace menu's "Problems & events" opens it (D332).
 */
export async function openBottomTab(
  page: Page,
  name: 'Validation' | 'Events' | 'Errors' | 'Timeline',
): Promise<void> {
  const tab = page.getByTestId('bottom-section').getByRole('tab', { name });
  if (!(await tab.isVisible())) {
    const menu = await openWorkspaceMenu(page);
    await menu.getByTestId('menu-problems').click();
  }
  await tab.click();
}

/** Select a node and open the inspector on it (the V2 sheet's Inspector tab). */
export async function inspect(page: Page, nodeId: string): Promise<Locator> {
  await selectInSheet(page, nodeId, 'Inspector');
  const inspector = page.getByTestId('inspector');
  await expect(inspector).toBeVisible();
  return inspector;
}
