import { expect, test } from '@playwright/test';

import { dragConnect, nodeCard, openSheet, port, serverGraph } from './helpers';
import {
  NODE_NAMES,
  engineEdges,
  engineNodeRuns,
  engineRun,
  inspect,
  openRound3,
  runStatus,
  startRun,
} from './round3';

/**
 * Loop edges, iterations and the Merge node on the real Canvas (round 3 §5 items 8, 9, §7.1):
 * FR-CON-007, FR-PAR-002, FR-PAR-005, TC-CON-007, TC-PAR-006.
 *
 * `runs/control-wiring.test.tsx` covers the iteration selector with the Canvas mocked out, so what is
 * added here is everything that needs a real React Flow: the dashed loop edge and its badge, the
 * editor on a selected edge, the edge context menu, and the merge node's slots.
 */
test.describe('Loop edges (FR-CON-007, TC-CON-007)', () => {
  test('TC-CON-007: the loop editor refuses 0 and 51 inline, saves nothing while refused, and takes 3', async ({
    page,
  }) => {
    const seeded = await openRound3(page, 'loop', 'linear-complete');
    const loopEdgeId = seeded.loopEdgeId!;

    // The loop edge is drawn as the one legal cycle: dashed, in its own hue, with an arrow back.
    const edge = page.getByTestId(`loop-edge-${loopEdgeId}`);
    await expect(edge).toHaveAttribute('data-kind', 'loop');
    await expect(page.getByTestId(`loop-edge-glyph-${loopEdgeId}`)).toBeVisible();
    await expect(edge.locator('title')).toHaveText(
      'Loops at most 3× · exits when verdict = approved · at the maximum: continue',
    );
    const dash = await edge
      .locator('path')
      .first()
      .evaluate((el) => getComputedStyle(el).strokeDasharray);
    expect(dash).not.toBe('none');

    // Selecting it puts its settings on the sheet's Configure tab.
    await edge.locator('path').first().click({ force: true });
    await openSheet(page, 'Configure');
    const editor = page.getByTestId('loop-edge-editor');
    await expect(editor).toBeVisible();
    await expect(editor).toContainText(`${NODE_NAMES.reviewer} sends its output back to`);

    const savedLoop = async () => {
      const found = (await engineEdges(page, seeded.workflowId)).find(
        (each) => each.id === loopEdgeId,
      );
      return found?.loop as
        | { maxIterations: number; exitCondition: { path: string; equals: unknown }; onMax: string }
        | undefined;
    };

    const maxIterations = editor.getByLabel('Max iterations');
    await expect(maxIterations).toHaveValue('3');

    // A valid change is one `update_edge` op and it reaches the engine — the baseline to move from.
    await maxIterations.fill('12');
    await maxIterations.blur();
    await expect.poll(async () => (await savedLoop())?.maxIterations).toBe(12);

    // 0 is refused inline, with the contract's own wording, and nothing is saved.
    await maxIterations.fill('0');
    await maxIterations.blur();
    await expect(editor.getByRole('alert')).toContainText(
      'Max iterations must be a whole number from 1 to 50',
    );
    await expect(maxIterations).toHaveAttribute('aria-invalid', 'true');
    expect((await savedLoop())?.maxIterations).toBe(12);

    // 51 likewise — the boundary above the maximum, not just "some big number".
    await maxIterations.fill('51');
    await maxIterations.blur();
    await expect(editor.getByRole('alert')).toContainText(
      'Max iterations must be a whole number from 1 to 50',
    );
    expect((await savedLoop())?.maxIterations).toBe(12);

    /*
     * A refused draft commits nothing at all — not even the field that is fine. Editing the exit
     * condition while the iteration count is out of range must leave the saved loop untouched.
     */
    await editor.getByLabel('Exit when path').fill('review.verdict');
    await editor.getByLabel('Exit when path').blur();
    expect((await savedLoop())?.exitCondition.path).toBe('verdict');

    // 3 is accepted, the error goes, and the whole draft commits — exit condition included.
    await maxIterations.fill('3');
    await maxIterations.blur();
    await expect(editor.getByRole('alert')).toHaveCount(0);
    await expect(maxIterations).not.toHaveAttribute('aria-invalid', 'true');
    await expect.poll(async () => (await savedLoop())?.maxIterations).toBe(3);
    expect((await savedLoop())?.exitCondition.path).toBe('review.verdict');

    // And it survives a reload: it is the engine's graph now, not a draft (BR-01).
    await page.reload();
    await expect(page.getByTestId(`loop-edge-${loopEdgeId}`)).toBeVisible();
    expect((await savedLoop())?.maxIterations).toBe(3);
  });

  test('FR-CON-007: what to do at the maximum is part of the loop, and the edge can be removed', async ({
    page,
  }) => {
    const seeded = await openRound3(page, 'loop', 'linear-complete');
    const loopEdgeId = seeded.loopEdgeId!;
    await page
      .getByTestId(`loop-edge-${loopEdgeId}`)
      .locator('path')
      .first()
      .click({ force: true });
    await openSheet(page, 'Configure');
    const editor = page.getByTestId('loop-edge-editor');
    await expect(editor).toBeVisible();

    const onMax = editor.getByLabel('At the maximum');
    await onMax.click();
    await expect(page.getByRole('option')).toHaveText([
      'continue with the last output',
      'fail the node',
    ]);
    await page.getByRole('option', { name: 'fail the node' }).click();
    await expect
      .poll(async () => {
        const found = (await engineEdges(page, seeded.workflowId)).find(
          (each) => each.id === loopEdgeId,
        );
        return (found?.loop as { onMax?: string } | undefined)?.onMax;
      })
      .toBe('fail');

    await editor.getByRole('button', { name: 'Delete loop edge' }).click();
    await expect
      .poll(async () =>
        (await engineEdges(page, seeded.workflowId)).some((each) => each.kind === 'loop'),
      )
      .toBe(false);
    await expect(page.getByTestId(`loop-edge-${loopEdgeId}`)).toHaveCount(0);
  });

  /*
   * The loop edge is offered where the cycle is drawn (D89). `isValidConnection` accepts a cycle that
   * `canBeLoopEdge` would allow — React Flow calls `onConnect` only for a connection it accepts — and
   * `tryConnect` opens the editor instead of refusing. Before that, the dialog was unreachable: the
   * drop was refused before anything could offer it, and the context menu cannot substitute, because
   * an existing data edge whose target is upstream of its source is the cycle a data edge can never be.
   *
   * The drag below is made as favourable as it can be — a free input port of a matching type — so
   * nothing but the offer itself can be blamed for the outcome.
   */
  test('FR-CON-007: drawing a cycle offers to make it the loop edge', async ({ page }) => {
    const seeded = await openRound3(page, 'loop', 'linear-complete', {
      omitLoopEdge: true,
      writerJsonInput: true,
    });
    const [writer, reviewer] = seeded.agentIds as [string, string];

    await dragConnect(page, port(page, reviewer, 'out', 'json'), port(page, writer, 'in', 'json'));
    await expect(page.getByTestId('make-loop-edge')).toBeVisible();
  });

  test('FR-CON-007: a cycle that cannot be a loop edge says both why', async ({ page }) => {
    /*
     * A cycle the contract will not take as a loop edge either: the shape keeps its loop edge, so a
     * second one over the same body is refused `loop_bodies_overlap` — a node belongs to one loop only
     * (D84). That is what makes this the case for the *message* rather than the offer; a cycle that
     * does qualify opens the editor instead, which the test above covers.
     */
    const seeded = await openRound3(page, 'loop', 'linear-complete', { writerJsonInput: true });
    const [writer, reviewer] = seeded.agentIds as [string, string];
    const before = (await engineEdges(page, seeded.workflowId)).length;

    // Refused with a reason rather than silently (FR-CON-003), and nothing is saved.
    await dragConnect(page, port(page, reviewer, 'out', 'json'), port(page, writer, 'in', 'json'));
    await expect(page.getByText('Connection refused').first()).toBeVisible();
    // Both halves, so the operator hears what was wrong and why the loop edge is not the way out
    // either (NFR-USE-03).
    await expect(page.getByText(/cannot close a cycle/i).first()).toBeVisible();
    await expect(page.getByText(/one loop only/i).first()).toBeVisible();
    expect(await engineEdges(page, seeded.workflowId)).toHaveLength(before);
  });

  test('FR-CON-007: the edge menu offers "Make loop edge" disabled, with the reason', async ({
    page,
  }) => {
    const seeded = await openRound3(page, 'loop', 'linear-complete', { omitLoopEdge: true });
    const [writer, reviewer] = seeded.agentIds as [string, string];

    /*
     * A forward data edge is not a cycle, so the item is offered *disabled* carrying the contract's
     * own reason, rather than disappearing and leaving the operator guessing why.
     */
    const forward = (await engineEdges(page, seeded.workflowId)).find(
      (edge) => edge.from === writer && edge.to === reviewer,
    )!;
    await page
      .getByTestId(`edge-${forward.id}`)
      .locator('path')
      .first()
      .click({ force: true, button: 'right' });
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    const item = menu.getByRole('menuitem', { name: 'Make loop edge' });
    await expect(item).toBeDisabled();
    // Whichever of the contract's rules it fails, the reason is the contract's own sentence.
    await expect(item).toHaveAttribute(
      'title',
      /(must lead back to a node upstream|no json output for the loop's exit condition)/,
    );
  });

  test('TC-PAR-006: three iterations, each with its own output, and the edge counts them', async ({
    page,
  }) => {
    const seeded = await openRound3(page, 'loop', 'loop-3-iterations');
    const [writer] = seeded.agentIds as [string];
    const loopEdgeId = seeded.loopEdgeId!;

    await startRun(page).click();
    await expect(runStatus(page)).toHaveAttribute('data-status', 'COMPLETE', { timeout: 30_000 });

    // The engine recorded three iterations of the loop body.
    const run = (await engineRun(page, seeded.workflowId))!;
    const writerRuns = (await engineNodeRuns(page, run.id)).filter(
      (nodeRun) => nodeRun.nodeId === writer,
    );
    expect(writerRuns.map((nodeRun) => nodeRun.iteration)).toEqual([1, 2, 3]);

    // FR-PAR-005: the selector lists each one, and each row previews what that round produced.
    const inspector = await inspect(page, writer);
    const selector = inspector.getByTestId('iteration-selector');
    await expect(selector).toBeVisible();
    await expect(selector).toContainText('3 iterations');
    const options = selector.locator('[role="radio"]');
    await expect(options).toHaveCount(3);
    for (const iteration of [1, 2, 3]) {
      await expect(inspector.getByTestId(`iteration-option-${iteration}`)).toContainText(
        `iteration ${iteration}`,
      );
    }

    // Distinct outputs, or a selector would be telling the operator nothing (TC-PAR-006).
    const previews = await options.evaluateAll((items) =>
      items.map((item) => item.textContent ?? ''),
    );
    expect(new Set(previews).size).toBe(3);

    // Picking an iteration shows that node run, not the newest.
    await inspector.getByTestId('iteration-option-1').click();
    await expect(inspector.getByTestId('iteration-option-1')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    const firstOutput = await inspector.getByTestId('inspector-output').textContent();
    await inspector.getByTestId('iteration-option-3').click();
    await expect(inspector.getByTestId('iteration-option-3')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(await inspector.getByTestId('inspector-output').textContent()).not.toBe(firstOutput);

    // FR-PAR-005: the loop edge itself carries the iteration it reached, against its maximum.
    const badge = page.getByTestId(`loop-edge-iteration-${loopEdgeId}`);
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText('3/3');
    await expect(page.getByTestId(`loop-edge-${loopEdgeId}`)).toHaveAttribute(
      'data-iteration',
      '3',
    );
  });
});

test.describe('Merge node (FR-PAR-002)', () => {
  test('FR-PAR-002: the mode is chosen on the node and each slot names the branch feeding it', async ({
    page,
  }) => {
    const seeded = await openRound3(page, 'merge', 'merge-any');
    const mergeId = seeded.mergeId!;

    await nodeCard(page, mergeId).click();
    await openSheet(page, 'Configure');
    const panel = page.getByTestId('config-panel');
    const mode = panel.getByLabel('Mode');
    await expect(mode).toBeVisible();
    await expect(mode).toContainText('any');

    // Both modes the contract knows, and no third one.
    await mode.click();
    await expect(page.getByRole('option')).toHaveText(['all', 'any']);
    await page.getByRole('option', { name: 'all' }).click();
    await expect
      .poll(async () => {
        const graph = await serverGraph(page, seeded.workflowId);
        const node = graph.nodes.find((each) => each.id === mergeId);
        return (node?.config as { mode?: string }).mode;
      })
      .toBe('all');
    await expect(panel.getByTestId('merge-slots')).toContainText('Waits for every input');

    await mode.click();
    await page.getByRole('option', { name: 'any' }).click();
    await expect(panel.getByTestId('merge-slots')).toContainText(
      'Continues on the first to arrive',
    );

    // One slot per connected input port, each labelled with the node feeding it (FR-PAR-002).
    const slots = panel.getByTestId('merge-slots');
    await expect(slots.getByTestId('merge-slot-in')).toContainText(NODE_NAMES.first);
    await expect(slots.getByTestId('merge-slot-in_json')).toContainText(NODE_NAMES.checker);
    await expect(slots.getByTestId('merge-slot-in')).toHaveAttribute('data-arrival', 'waiting');

    // During a run the slots say which branch arrived, and in which position.
    await startRun(page).click();
    await expect(runStatus(page)).toHaveAttribute('data-status', 'COMPLETE', { timeout: 30_000 });
    await expect(nodeCard(page, mergeId)).toHaveAttribute('data-state', 'COMPLETED');
    await expect
      .poll(async () => slots.getByTestId('merge-slot-in').getAttribute('data-arrival'))
      .toBe('1');
    await expect(slots.getByTestId('merge-slot-in')).toContainText('1st to arrive');
  });
});
