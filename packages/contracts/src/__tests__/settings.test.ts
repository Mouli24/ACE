import { describe, expect, it } from 'vitest';

import {
  BACKUP_CONTENT_TYPE,
  BACKUP_UPLOAD_FIELD,
  BackupImportResponseSchema,
  DEFAULT_ALLOWED_ORIGINS,
  DEFAULT_CONCURRENCY,
  MAX_UPLOAD_MB,
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
      // Round 4 §2.1 adds three defaults to §2.7's list.
      maxUploadMb: 100,
      dockerSandbox: 'auto',
      mcpEnabled: true,
      // Round 5 §2.7: telemetry is off, and v1 ships no telemetry code.
      telemetryEnabled: false,
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

  it('caps the upload limit at 2048 MB: a PATCH over it is refused, a stored one reads as the cap [audit S-9]', () => {
    expect(MAX_UPLOAD_MB).toBe(2048);
    expect(SettingsPatchSchema.safeParse({ maxUploadMb: 2048 }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ maxUploadMb: 2049 }).success).toBe(false);
    expect(SettingsSchema.parse({ ...minimal, maxUploadMb: 500 }).maxUploadMb).toBe(500);
    expect(SettingsSchema.parse({ ...minimal, maxUploadMb: 1_000_000 }).maxUploadMb).toBe(2048);
    expect(SettingsSchema.safeParse({ ...minimal, maxUploadMb: 0 }).success).toBe(false);
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

describe('NFR-PRIV-01 telemetry is off and stays off (round 5 §2.7)', () => {
  it('reads telemetryEnabled as false, and refuses true in a file or a patch', () => {
    expect(SettingsSchema.parse(minimal).telemetryEnabled).toBe(false);
    expect(SettingsSchema.safeParse({ ...minimal, telemetryEnabled: true }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ telemetryEnabled: true }).success).toBe(false);
    expect(SettingsPatchSchema.parse({ telemetryEnabled: false })).toEqual({
      telemetryEnabled: false,
    });
  });

  it('patches onboardingCompleted, which the wizard sets', () => {
    expect(SettingsPatchSchema.parse({ onboardingCompleted: true })).toEqual({
      onboardingCompleted: true,
    });
  });
});

describe('FR-SYS-012 backup and restore', () => {
  it('exports a zip and imports one from the upload field', () => {
    expect(BACKUP_CONTENT_TYPE).toBe('application/zip');
    expect(BACKUP_UPLOAD_FIELD).toBe('file');
  });

  it('TC-SYS-014 answers what the restore brought back', () => {
    const restored = { restored: { projects: 2, runs: 14, artifacts: 9 } };
    expect(BackupImportResponseSchema.parse(restored)).toEqual(restored);
    expect(
      BackupImportResponseSchema.safeParse({ restored: { projects: 2, runs: 14 } }).success,
    ).toBe(false);
    expect(
      BackupImportResponseSchema.safeParse({ restored: { ...restored.restored, secrets: 1 } })
        .success,
    ).toBe(false);
  });
});
