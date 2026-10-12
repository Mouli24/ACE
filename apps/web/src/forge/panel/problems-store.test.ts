import { beforeEach, describe, expect, it } from 'vitest';

import { asMonaco, createFakeMonaco, type FakeMonaco } from '../../test/fake-monaco';
import { fileUri, resetModels, setMonaco } from '../editor/models';
import { useProblemsStore, watchMarkers } from './problems-store';

const P = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';
let fake: FakeMonaco;

beforeEach(() => {
  resetModels();
  fake = createFakeMonaco();
  setMonaco(asMonaco(fake));
  useProblemsStore.setState({ byProject: {} });
});

describe('D299 §6.4 Problems follows Monaco’s markers for open files', () => {
  it('groups markers by project and file, errors first, hints left out', () => {
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
