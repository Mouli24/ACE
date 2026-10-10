import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PRICING_FILE, createPricingLoader } from '../pricing.js';

/*
 * D306: `<dataDir>/ace.pricing.json` prices what a provider did not — per provider type and model,
 * input and output per 1M tokens. It ships empty, is read again whenever it changes, and a file
 * that cannot be read prices nothing rather than stopping the engine.
 */

let dir: string;
const warnings: string[] = [];
const logger = { warn: (_fields: unknown, message: string) => void warnings.push(message) };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-pricing-'));
  warnings.length = 0;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const entry = { provider: 'claude_code', model: 'haiku', inputPer1M: 1, outputPer1M: 5 };

/** Writes the file and moves its clock on, so a reader that watches the mtime sees the change. */
function write(content: string, tick: number): void {
  const path = join(dir, PRICING_FILE);
  writeFileSync(path, content);
  const at = new Date(Date.UTC(2026, 9, 10, 12, 0, tick));
  utimesSync(path, at, at);
}

describe('D306 the ace.pricing.json loader', () => {
  it('ships empty: a data folder without the file gets one, and nothing is priced', () => {
    const pricing = createPricingLoader({ dataDir: dir, logger });
    expect(pricing.current()).toEqual({ models: [] });
    const path = join(dir, PRICING_FILE);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ models: [] });
  });

  it('reads the prices it holds, and reads them again when the file changes', () => {
    write(JSON.stringify({ models: [entry] }), 1);
    const pricing = createPricingLoader({ dataDir: dir, logger });
    expect(pricing.current()).toEqual({ models: [entry] });

    write(JSON.stringify({ models: [{ ...entry, outputPer1M: 6 }] }), 2);
    expect(pricing.current().models[0]?.outputPer1M).toBe(6);
  });

  it('a file that is not valid prices nothing, says why once, and recovers when fixed', () => {
    write('{ "models": [ ', 1);
    const pricing = createPricingLoader({ dataDir: dir, logger });
    expect(pricing.current()).toEqual({ models: [] });
    expect(pricing.current()).toEqual({ models: [] });
    expect(warnings).toHaveLength(1);

    write(JSON.stringify({ models: [{ ...entry, inputPer1M: -1 }] }), 2);
    expect(pricing.current()).toEqual({ models: [] });
    expect(warnings).toHaveLength(2);

    write(JSON.stringify({ models: [entry] }), 3);
    expect(pricing.current()).toEqual({ models: [entry] });
  });
});
