import type { TextFileContent } from '@ace/contracts';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db, installMockServer, renderWithQuery } from '../../test/app';
import { asMonaco, createFakeMonaco, type FakeMonaco } from '../../test/fake-monaco';
import { StatusBar } from '../layout/StatusBar';
import { useEditorStore } from './editor-store';
import type * as EditorHostTypes from './EditorHost';
import { ensureModel, resetModels, setMonaco, viewStateOf } from './models';

const hoisted = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('../../config-panel/monaco-loader', () => ({
  get monaco() {
    return hoisted.current;
  },
}));

const INITIAL: TextFileContent = {
  kind: 'text',
  path: 'a.ts',
  content: 'x',
  version: 'v1',
  eol: 'lf',
  bom: false,
  size: 1,
};
installMockServer();

const P = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';
let fake: FakeMonaco;

type EditorHostModule = typeof EditorHostTypes;

async function realHost() {
  const { EditorHost } = await vi.importActual<EditorHostModule>('./EditorHost');
  return EditorHost;
}

beforeEach(() => {
  resetModels();
  fake = createFakeMonaco();
  hoisted.current = fake;
  setMonaco(asMonaco(fake));
});

describe('D299 the real editor host keeps each file’s place', () => {
  it('saves the shown file’s view state before the editor is disposed, and restores it on remount', async () => {
    const EditorHost = await realHost();
    const initial = INITIAL;
    const first = render(<EditorHost projectId={P} path="a.ts" initial={initial} />);
    const editor = fake.editors[0]!;
    editor.line = 42;
    first.unmount();
    expect(viewStateOf(P, 'a.ts')).toEqual({ line: 42 });

    const second = render(<EditorHost projectId={P} path="a.ts" initial={initial} />);
    expect(fake.editors[1]!.restoreViewState).toHaveBeenCalledWith({ line: 42 });
    second.unmount();
  });

  it('switching files saves the previous file’s state', async () => {
    const EditorHost = await realHost();
    ensureModel(P, 'b.ts', 'y', 'plaintext', () => undefined);
    const initial = INITIAL;
    const view = render(<EditorHost projectId={P} path="a.ts" initial={initial} />);
    fake.editors[0]!.line = 7;
    view.rerender(<EditorHost projectId={P} path="b.ts" initial={undefined} />);
    expect(viewStateOf(P, 'a.ts')).toEqual({ line: 7 });
    view.unmount();
  });
});

describe('D299 the status bar reports the encoding of the content actually loaded', () => {
  it('a file opened with a BOM says so on first open, before any edit or save', async () => {
    const EditorHost = await realHost();
    const projectId = db.createProject({ name: 'P' }).id;
    useEditorStore.getState().open(projectId, 'a.ts');
    const view = renderWithQuery(
      <>
        <EditorHost projectId={projectId} path="a.ts" initial={{ ...INITIAL, bom: true }} />
        <StatusBar projectId={projectId} />
      </>,
    );
    expect(await view.findByText('UTF-8 with BOM')).toBeInTheDocument();
    view.unmount();
  });
});
