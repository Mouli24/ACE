import { expect, test } from '@playwright/test';

/**
 * TC-NFR-001 / NFR-PERF-01: pan the 200-node / 400-edge fixture and measure frame time with
 * requestAnimationFrame. The gate is a mean frame ≤ 20 ms (≥ 50 fps, the floor for "≈60 fps" on a
 * headless CI runner); the measured numbers are printed so the report carries them.
 */
// Tracing snapshots the DOM after every pointer move, which alone costs ~8 ms a frame here.
test.use({ trace: 'off' });

test.describe('Canvas performance (NFR-PERF-01)', () => {
  test('TC-NFR-001: 200 nodes / 400 edges stay smooth while panning', async ({ page }) => {
    await page.goto('/projects');
    await page.evaluate(() => localStorage.clear());
    await page.goto('/?fixture=200');
    await expect(page).toHaveURL(/\/workflows\/[0-9A-Z]{26}$/);
    await expect(page.getByTestId('canvas')).toBeVisible();
    await expect(page.locator('.react-flow__node').first()).toBeVisible();

    const counts = await page.evaluate(() => {
      const id = window.location.pathname.split('/').pop() as string;
      const db = window.__aceMock!.db;
      db.load();
      return { nodes: db.nodesOf(id).length, edges: db.edgesOf(id).length };
    });
    expect(counts).toEqual({ nodes: 200, edges: 400 });

    // zoom out so a good share of the graph is on screen, then measure while panning
    await page.keyboard.press('f');
    await page.waitForTimeout(500);
    const box = (await page.getByTestId('canvas').boundingBox())!;

    const startFrames = () =>
      page.evaluate(() => {
        const w = window as unknown as { __frames: number[]; __stop?: () => void };
        w.__frames = [];
        let last = performance.now();
        let raf = 0;
        const tick = (now: number) => {
          w.__frames.push(now - last);
          last = now;
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        w.__stop = () => cancelAnimationFrame(raf);
      });
    const stopFrames = () =>
      page.evaluate(() => {
        const w = window as unknown as { __frames: number[]; __stop?: () => void };
        w.__stop?.();
        return w.__frames.slice(1);
      });

    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // phase 1: drag-pan (mouse)
    await startFrames();
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 0; i < 60; i += 1) {
      await page.mouse.move(cx + Math.sin(i / 6) * 240, cy + Math.cos(i / 6) * 160);
    }
    await page.mouse.up();
    const dragFrames = await stopFrames();

    // phase 2: wheel-pan (trackpad two-finger scroll)
    await startFrames();
    for (let i = 0; i < 20; i += 1) await page.mouse.wheel(30, 20);
    const wheelFrames = await stopFrames();

    const stats = (frames: number[]) => {
      const mean = frames.reduce((a, b) => a + b, 0) / frames.length;
      const sorted = [...frames].sort((a, b) => a - b);
      const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
      return { n: frames.length, mean, p95, fps: 1000 / mean };
    };
    const drag = stats(dragFrames);
    const wheel = stats(wheelFrames);
    const line = (label: string, s: ReturnType<typeof stats>) =>
      `${label}: frames=${s.n} mean=${s.mean.toFixed(2)}ms (${s.fps.toFixed(1)} fps) p95=${s.p95.toFixed(2)}ms`;
    test.info().annotations.push({
      type: 'TC-NFR-001',
      description: `${line('drag', drag)} · ${line('wheel', wheel)}`,
    });
    console.log(`TC-NFR-001 ${line('drag', drag)}`);
    console.log(`TC-NFR-001 ${line('wheel', wheel)}`);

    expect(drag.n).toBeGreaterThan(30);
    expect(drag.mean).toBeLessThanOrEqual(20);
    expect(wheel.mean).toBeLessThanOrEqual(20);
  });
});
