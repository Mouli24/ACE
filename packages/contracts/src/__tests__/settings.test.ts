import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ALLOWED_ORIGINS,
  DEFAULT_CONCURRENCY,
  SettingsPatchSchema,
  SettingsSchema,
  THEMES,
  type Settings,
} from '../settings.js';
import { PROJECT_ID } from './fixtures.js';

const minimal = { dataDir: 'C:/Users/dev/.ace' };

describe('FR-SYS-010 Settings defaults', () => {
  it('fills every default round 1 §2.7 states', () => {
    expect(SettingsSchema.parse(minimal)).toEqual({
      dataDir: 'C:/Users/dev/.ace',
      concurrency: 20,
      theme: 'dark',
      onboardingCompleted: false,
      allowedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    });
  });

  it('exports the defaults §2.7 names', () => {
    expect(DEFAULT_CONCURRENCY).toBe(20);
    expect([...DEFAULT_ALLOWED_ORIGINS]).toEqual([
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ]);
  });

  it('gives each parse its own allowedOrigins array', () => {
    const a = SettingsSchema.parse(minimal);
    const b = SettingsSchema.parse(minimal);

    expect(a.allowedOrigins).not.toBe(b.allowedOrigins);
  });

  it('requires dataDir', () => {
    expect(SettingsSchema.safeParse({}).success).toBe(false);
  });
});

describe('FR-SYS-010 Settings bounds', () => {
  it.each([1, 20, 64])('accepts concurrency %i', (concurrency) => {
    expect(SettingsSchema.safeParse({ ...minimal, concurrency }).success).toBe(true);
  });

  it.each([0, -1, 65, 20.5])('rejects concurrency %s', (concurrency) => {
    expect(SettingsSchema.safeParse({ ...minimal, concurrency }).success).toBe(false);
  });

  it('declares exactly the three themes of §2.7', () => {
    expect([...THEMES]).toEqual(['dark', 'light', 'system']);
  });

  it('rejects a theme §2.7 does not define', () => {
    expect(SettingsSchema.safeParse({ ...minimal, theme: 'auto' }).success).toBe(false);
  });

  it('accepts the optional project and provider ids', () => {
    const parsed = SettingsSchema.parse({ ...minimal, lastProjectId: PROJECT_ID });

    expect(parsed.lastProjectId).toBe(PROJECT_ID);
  });

  it('rejects a lastProjectId that is not a ULID', () => {
    expect(SettingsSchema.safeParse({ ...minimal, lastProjectId: 'last' }).success).toBe(false);
  });
});

describe('FR-SYS-005 PATCH /settings takes a partial', () => {
  it('accepts a patch of one field', () => {
    expect(SettingsPatchSchema.parse({ concurrency: 5 })).toEqual({ concurrency: 5 });
  });

  it('accepts an empty patch', () => {
    expect(SettingsPatchSchema.safeParse({}).success).toBe(true);
  });

  it('still enforces the bounds on the field it patches', () => {
    expect(SettingsPatchSchema.safeParse({ concurrency: 65 }).success).toBe(false);
  });

  it('does not invent defaults for fields the patch leaves out', () => {
    expect(SettingsPatchSchema.parse({ theme: 'light' })).toEqual({ theme: 'light' });
  });
});

describe('FR-GRD-008 the daily budget (round 3 §2.3)', () => {
  it('is absent until the user sets one — no default, no cap', () => {
    expect(SettingsSchema.parse(minimal).dailyBudgetUsd).toBeUndefined();
    expect(SettingsSchema.parse({ ...minimal, dailyBudgetUsd: 5 }).dailyBudgetUsd).toBe(5);
  });

  it.each([0, -1])('refuses a budget of %s — a set cap is above zero (D72)', (dailyBudgetUsd) => {
    expect(SettingsSchema.safeParse({ ...minimal, dailyBudgetUsd }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ dailyBudgetUsd }).success).toBe(false);
  });

  it('is removed by a null in PATCH /settings (D72)', () => {
    expect(SettingsPatchSchema.parse({ dailyBudgetUsd: null })).toEqual({ dailyBudgetUsd: null });
  });

  it('reads a null as no cap, so a patch applies to the settings as it is (D72)', () => {
    expect(SettingsSchema.parse({ ...minimal, dailyBudgetUsd: null }).dailyBudgetUsd).toBeNull();

    // Typed, so `tsc` keeps the patch assignable where the engine and the web mocks merge it.
    const patch: Partial<Settings> = SettingsPatchSchema.parse({ dailyBudgetUsd: null });
    const merged: Settings = { ...SettingsSchema.parse(minimal), ...patch };
    expect(SettingsSchema.parse(merged).dailyBudgetUsd).toBeNull();
  });
});
