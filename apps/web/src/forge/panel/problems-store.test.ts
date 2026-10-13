import { beforeEach, describe, expect, it } from 'vitest';

import { asMonaco, createFakeMonaco, type FakeMonaco } from '../../test/fake-monaco';
import { ensureModel, fileUri, resetModels, setMonaco } from '../editor/models';
import {
  clearChecks,
  problemCounts,
  sameProblem,
  setChecks,
  useProblemsStore,
  watchMarkers,
  type ChecksRun,
  type Problem,
} from './problems-store';
import type { CheckProblem } from './check-parser';

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

describe('smoke S-2: one error seen live and by the checks counts once', () => {
  const marker = (over: Partial<Problem> = {}): Problem => ({
    path: 'src/main.ts',
    line: 3,
    column: 5,
    severity: 'error',
    message: "Argument of type 'string' is not assignable to parameter of type 'number'.",
    source: undefined,
    code: '2345',
    ...over,
  });
  const check = (over: Partial<CheckProblem> = {}): CheckProblem => ({
    path: 'src/main.ts',
    line: 3,
    column: 5,
    severity: 'error',
    message: "Argument of type 'string' is not assignable to parameter of type 'number'.",
    source: 'tsc',
    code: 'TS2345',
    ...over,
  });

  it.each([
    ['tsc’s TS2345 and Monaco’s 2345 at the same place', check(), marker(), true],
    ['the same code written the same way', check(), marker({ code: 'TS2345' }), true],
    [
      'an eslint rule on both',
      check({ code: 'no-undef', source: 'eslint' }),
      marker({ code: 'no-undef' }),
      true,
    ],
    ['another code at the same place', check({ code: 'TS2322' }), marker(), false],
    ['codes match but the line differs', check({ line: 4 }), marker(), false],
    ['codes match but the column differs', check({ column: 6 }), marker(), false],
    ['codes match but the file differs', check({ path: 'src/other.ts' }), marker(), false],
    ['no code on the marker: the same message', check(), marker({ code: undefined }), true],
    ['no code on the check: the same message', check({ code: undefined }), marker(), true],
    ['an empty code is no code', check({ code: '' }), marker(), true],
    [
      'no code on the marker, another message',
      check(),
      marker({ code: undefined, message: 'Other.' }),
      false,
    ],
    [
      'no code on either, another message',
      check({ code: undefined }),
      marker({ code: undefined, message: 'Other.' }),
      false,
    ],
  ])('%s', (_name, a, b, same) => {
    expect(sameProblem(a, b)).toBe(same);
  });

  it('takes each marker’s code from Monaco, a plain one or a linked one', () => {
    ensureModel(P, 'src/main.ts', '', 'typescript', () => undefined);
    const stop = watchMarkers(asMonaco(fake));
    const resource = fileUri(P, 'src/main.ts') as unknown as InstanceType<FakeMonaco['Uri']>;
    fake.setMarkers([
      {
        resource,
        severity: fake.MarkerSeverity.Error,
        message: 'a',
        startLineNumber: 1,
        startColumn: 1,
        code: '2345',
      },
      {
        resource,
        severity: fake.MarkerSeverity.Warning,
        message: 'b',
        startLineNumber: 2,
        startColumn: 1,
        code: { value: 'no-undef', target: resource },
      },
      {
        resource,
        severity: fake.MarkerSeverity.Warning,
        message: 'c',
        startLineNumber: 3,
        startColumn: 1,
      },
    ]);
    expect(useProblemsStore.getState().byProject[P]?.map((problem) => problem.code)).toEqual([
      '2345',
      'no-undef',
      undefined,
    ]);
    stop();
  });

  it('counts a check entry only when no live marker matches it; both stay listed', () => {
    useProblemsStore.setState({
      byProject: {
        [P]: [marker(), marker({ line: 9, severity: 'warning', code: '6133', message: 'unused' })],
      },
    });
    setChecks(P, {
      status: 'done',
      command: 'tsc --noEmit -p .',
      startedAt: '2026-10-13T10:00:00.000Z',
      finishedAt: '2026-10-13T10:00:02.000Z',
      exitCode: 2,
      problems: [check(), check({ path: 'src/closed.ts', code: 'TS2304', message: 'gone' })],
    });
    expect(problemCounts(useProblemsStore.getState(), P)).toEqual({
      errors: 2,
      warnings: 1,
      total: 3,
    });
    // the Problems list keeps both groups as they are
    expect(useProblemsStore.getState().byProject[P]).toHaveLength(2);
    expect(useProblemsStore.getState().checks[P]?.problems).toHaveLength(2);
  });

  // one live marker stands for one check entry at most: tsc's second report is still counted
  it.each([
    ['two same checks at one place, one marker: tsc said 2', 1, 2, 2],
    ['two same checks, two markers', 2, 2, 2],
    ['one check, two markers', 2, 1, 2],
    ['one check, one marker', 1, 1, 1],
    ['three same checks, one marker', 1, 3, 3],
  ])('matches one to one: %s', (_name, markerCount, checkCount, errors) => {
    useProblemsStore.setState({
      byProject: { [P]: Array.from({ length: markerCount }, () => marker()) },
    });
    setChecks(P, {
      status: 'done',
      command: 'tsc --noEmit -p .',
      startedAt: '2026-10-13T10:00:00.000Z',
      exitCode: 2,
      problems: Array.from({ length: checkCount }, () => check()),
    });
    expect(problemCounts(useProblemsStore.getState(), P)).toEqual({
      errors,
      warnings: 0,
      total: errors,
    });
  });
});
