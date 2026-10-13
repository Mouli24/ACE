import { beforeEach, describe, expect, it } from 'vitest';

import { asMonaco, createFakeMonaco, type FakeMonaco } from '../../test/fake-monaco';
import { ensureModel, fileUri, resetModels, setMonaco } from '../editor/models';
import {
  clearChecks,
  problemCounts,
  setChecks,
  useProblemsStore,
  watchMarkers,
  type ChecksRun,
} from './problems-store';

const P = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';
let fake: FakeMonaco;

beforeEach(() => {
  resetModels();
  fake = createFakeMonaco();
  setMonaco(asMonaco(fake));
  useProblemsStore.setState({ byProject: {}, checks: {} });
});

describe('D299 §6.4 Problems follows Monaco’s markers for open files', () => {
  it('groups markers by project and file, errors first, hints left out', () => {
    for (const path of ['src/a.ts', 'src/b.ts']) {
      ensureModel(P, path, '', 'typescript', () => undefined);
    }
    const stop = watchMarkers(asMonaco(fake));
    const marker = (path: string, severity: number, message: string, line = 1) => ({
      resource: fileUri(P, path) as unknown as InstanceType<FakeMonaco['Uri']>,
      severity,
      message,
      startLineNumber: line,
      startColumn: 3,
      source: 'ts',
    });
    fake.setMarkers([
      marker('src/a.ts', fake.MarkerSeverity.Warning, 'unused', 4),
      marker('src/a.ts', fake.MarkerSeverity.Error, 'type error', 9),
      marker('src/b.ts', fake.MarkerSeverity.Hint, 'a hint'),
    ]);
    expect(useProblemsStore.getState().byProject[P]).toEqual([
      {
        path: 'src/a.ts',
        line: 9,
        column: 3,
        severity: 'error',
        message: 'type error',
        source: 'ts',
      },
      {
        path: 'src/a.ts',
        line: 4,
        column: 3,
        severity: 'warning',
        message: 'unused',
        source: 'ts',
      },
    ]);
    stop();
  });
});

describe('D299 Phase 4 fix C2: Problems lists only the open files', () => {
  it('leaves out the markers of a model the registry did not create', () => {
    ensureModel(P, 'open.ts', '', 'typescript', () => undefined);
    // Monaco's own model, made from an extra lib for go-to-definition: validated, never open
    fake.editor.createModel('', 'typescript', fileUri(P, 'lib.ts') as never);
    const stop = watchMarkers(asMonaco(fake));
    const marker = (path: string) => ({
      resource: fileUri(P, path) as unknown as InstanceType<FakeMonaco['Uri']>,
      severity: fake.MarkerSeverity.Error,
      message: `bad ${path}`,
      startLineNumber: 1,
      startColumn: 1,
    });
    fake.setMarkers([marker('open.ts'), marker('lib.ts'), marker('never-made.ts')]);
    expect(useProblemsStore.getState().byProject[P]?.map((problem) => problem.path)).toEqual([
      'open.ts',
    ]);
    stop();
  });
});

describe('D299 Phase 4 the checks slice', () => {
  const run = (problems: ChecksRun['problems']): ChecksRun => ({
    status: 'done',
    command: 'pnpm tsc --noEmit',
    processId: '01J9ZZZZZZZZZZZZZZZZZZZZZY',
    startedAt: '2026-10-14T10:00:00.000Z',
    finishedAt: '2026-10-14T10:00:03.000Z',
    exitCode: 1,
    problems,
  });
  const problem = (severity: 'error' | 'warning', path = 'src/a.ts') => ({
    path,
    line: 1,
    column: 1,
    severity,
    message: 'x',
    source: 'tsc' as const,
  });

  it('is never overwritten by the markers, and a new run replaces it', () => {
    const stop = watchMarkers(asMonaco(fake));
    setChecks(P, run([problem('error')]));
    fake.setMarkers([]);
    expect(useProblemsStore.getState().checks[P]?.problems).toHaveLength(1);
    setChecks(P, run([problem('warning'), problem('warning', 'b.ts')]));
    expect(useProblemsStore.getState().checks[P]?.problems.map((p) => p.severity)).toEqual([
      'warning',
      'warning',
    ]);
    stop();
  });

  it('Clear empties it for that project only', () => {
    setChecks(P, run([problem('error')]));
    setChecks('other', run([problem('error')]));
    clearChecks(P);
    expect(useProblemsStore.getState().checks[P]).toBeUndefined();
    expect(useProblemsStore.getState().checks.other).toBeDefined();
  });

  it('counts errors and warnings from the markers and the checks together', () => {
    ensureModel(P, 'a.ts', '', 'typescript', () => undefined);
    const stop = watchMarkers(asMonaco(fake));
    fake.setMarkers([
      {
        resource: fileUri(P, 'a.ts') as unknown as InstanceType<FakeMonaco['Uri']>,
        severity: fake.MarkerSeverity.Error,
        message: 'm',
        startLineNumber: 1,
        startColumn: 1,
      },
    ]);
    setChecks(P, run([problem('error'), problem('warning'), problem('warning', 'b.ts')]));
    expect(problemCounts(useProblemsStore.getState(), P)).toEqual({
      errors: 2,
      warnings: 2,
      total: 4,
    });
    expect(problemCounts(useProblemsStore.getState(), 'none')).toEqual({
      errors: 0,
      warnings: 0,
      total: 0,
    });
    stop();
  });
});
