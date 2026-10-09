import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_ENGINE_PORT as CONTRACT_ENGINE_PORT,
  DEFAULT_WEB_ORIGIN,
  DESKTOP_BRIDGE_CHANNEL,
  DESKTOP_BRIDGE_KEY,
  DesktopBridgeSchema,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { BRIDGE_CHANNEL, BRIDGE_KEY } from '../bridge.js';
import { DEFAULT_ENGINE_PORT, DEV_WEB_URL } from '../dev-config.js';
import { HEALTH_PATH } from '../readiness.js';

const PRELOAD = readFileSync(fileURLToPath(new URL('../preload.cts', import.meta.url)), 'utf8');

/*
 * The shell ships with no runtime dependencies (D292), so it carries its own copies of the contract
 * values it needs at run time. These pin each copy to the contract, so the two cannot drift.
 */
describe('FR-DSK-002 the shell’s copies of the contract (D294)', () => {
  it('the bridge channel and window key match @ace/contracts', () => {
    expect(BRIDGE_CHANNEL).toBe(DESKTOP_BRIDGE_CHANNEL);
    expect(BRIDGE_KEY).toBe(DESKTOP_BRIDGE_KEY);
  });

  it('the dev defaults match @ace/contracts', () => {
    expect(DEFAULT_ENGINE_PORT).toBe(CONTRACT_ENGINE_PORT);
    expect(DEV_WEB_URL).toBe(DEFAULT_WEB_ORIGIN);
    expect(HEALTH_PATH).toBe('/api/v1/health');
  });

  it('the preload asks on the same channel and exposes the same key', () => {
    expect(PRELOAD).toContain(`'${DESKTOP_BRIDGE_CHANNEL}'`);
    expect(PRELOAD).toContain(`'${DESKTOP_BRIDGE_KEY}'`);
  });

  it('the preload’s local shape check agrees with the contract on the fields it names', () => {
    // The preload's guard lists exactly the contract's keys and modes.
    for (const key of Object.keys(DesktopBridgeSchema.shape)) expect(PRELOAD).toContain(key);
    expect(PRELOAD).toContain("'dev'");
    expect(PRELOAD).toContain("'packaged'");
  });
});

describe('FR-DSK-004 the window-level drop guard', () => {
  it('cancels dragover and drop on the window, and never stops propagation', () => {
    expect(PRELOAD).toMatch(/addEventListener\('dragover'/);
    expect(PRELOAD).toMatch(/addEventListener\('drop'/);
    expect(PRELOAD).toContain('preventDefault()');
    // A stopped event would never reach InputDropZone / AttachmentPicker.
    expect(PRELOAD).not.toMatch(/stopPropagation|stopImmediatePropagation/);
  });

  it('requires nothing but electron at run time (a sandboxed preload cannot)', () => {
    const requires = [...PRELOAD.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
    expect(requires).toEqual(['electron']);
    expect(PRELOAD).not.toMatch(/^\s*import\s+[^=]*\bfrom\b/m);
  });
});
