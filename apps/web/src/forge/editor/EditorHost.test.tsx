import type { TextFileContent } from '@ace/contracts';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db, installMockServer, renderWithQuery } from '../../test/app';
import { asMonaco, createFakeMonaco, type FakeMonaco } from '../../test/fake-monaco';
import { useComposerChips } from '../../chat/composer-chips';
import type { FileTouch } from '../attribution';
import { CursorInfo } from '../layout/StatusBar';
import { useEditorStatus } from './editor-status';
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
/** Every decoration list the editors were given, newest last. */
let painted: Array<Array<{ range: unknown; options: { glyphMarginClassName?: string } }>>;
let options: Array<Record<string, unknown>>;
/** Every editor action the host added, and the selection the fake editor reports. */
let actions: Array<{ id: string; label: string; keybindings?: number[]; run: () => void }>;
let selection: {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
};

type EditorHostModule = typeof EditorHostTypes;

async function realHost() {
  const { EditorHost } = await vi.importActual<EditorHostModule>('./EditorHost');
  return EditorHost;
}

beforeEach(() => {
  resetModels();
  fake = createFakeMonaco();
  painted = [];
  options = [];
  actions = [];
  selection = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
  useComposerChips.getState().reset();
  // The shared fake has no decorations or ranges; the agent bars need both.
  const create = fake.editor.create;
  Object.assign(fake.editor, {
    create: (_element: unknown, given: Record<string, unknown>) => {
      options.push(given);
      return Object.assign(create(), {
        createDecorationsCollection: () => ({
          set: (list: (typeof painted)[number]) => painted.push(list),
          clear: () => painted.push([]),
        }),
        addAction: (action: (typeof actions)[number]) => {
          actions.push(action);
          return { dispose: () => undefined };
        },
        getSelection: () => selection,
      });
    },
  });
  Object.assign(fake, {
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { KeyL: 42 },
    Range: class {
      constructor(
        readonly startLineNumber: number,
        readonly startColumn: number,
        readonly endLineNumber: number,
        readonly endColumn: number,
      ) {}
    },
  });
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

describe('D334 the editor in the theme’s code view', () => {
  it('uses the theme’s type and gutter, without a minimap or folding', async () => {
    const EditorHost = await realHost();
    render(<EditorHost projectId={P} path="a.ts" initial={INITIAL} />).unmount();
    expect(options[0]).toMatchObject({
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: false },
      padding: { top: 12 },
      glyphMargin: true,
      folding: false,
      renderLineHighlight: 'all',
    });
  });

  it('tells the footer which text file it shows, and that it shows none once unmounted', async () => {
    const EditorHost = await realHost();
    const view = render(<EditorHost projectId={P} path="a.ts" initial={INITIAL} />);
    expect(useEditorStatus.getState().path).toBe('a.ts');
    view.unmount();
    expect(useEditorStatus.getState().path).toBeNull();
  });

  it('draws the agent’s bar beside the lines its last write covers', async () => {
    const EditorHost = await realHost();
    ensureModel(P, 'c.ts', 'one\ntwo\nthree\n', 'typescript', () => undefined);
    const touch: FileTouch = {
      agent: { nodeId: 'n2', name: 'Writer', letter: 'W', color: '#7a62d6', index: 1 },
      at: '2026-10-10T10:00:00.000Z',
      edit: ['two\nthree'],
    };
    const view = render(<EditorHost projectId={P} path="c.ts" initial={undefined} touch={touch} />);
    expect(painted.at(-1)).toEqual([
      {
        range: { startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 1 },
        options: { isWholeLine: true, glyphMarginClassName: 'forge-agent-bar forge-agent-1' },
      },
    ]);
    view.rerender(<EditorHost projectId={P} path="c.ts" initial={undefined} />);
    expect(painted.at(-1)).toEqual([]);
    view.unmount();
  });
});

describe('D299 the footer’s file facts report the encoding of the content actually loaded', () => {
  it('a file opened with a BOM says so on first open, before any edit or save', async () => {
    const EditorHost = await realHost();
    const projectId = db.createProject({ name: 'P' }).id;
    useEditorStore.getState().open(projectId, 'a.ts');
    const view = renderWithQuery(
      <>
        <EditorHost projectId={projectId} path="a.ts" initial={{ ...INITIAL, bom: true }} />
        <CursorInfo projectId={projectId} />
      </>,
    );
    expect(await view.findByText('UTF-8 with BOM')).toBeInTheDocument();
    view.unmount();
  });
});

describe('D302 Ask agent from the editor', () => {
  it('adds "Ask agent" to the editor’s menu with Ctrl/⌘+L, and it sends the selection to the composer', async () => {
    const EditorHost = await realHost();
    const view = render(
      <EditorHost
        projectId={P}
        path="src/sum.ts"
        initial={{ ...INITIAL, path: 'src/sum.ts', content: 'const a = 1;\nconst b = 2;\n' }}
      />,
    );
    const action = actions.find((each) => each.id === 'ace.askAgent');
    expect(action).toMatchObject({ label: 'Ask agent', keybindings: [2048 | 42] });

    selection = { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 13 };
    action!.run();
    expect(useComposerChips.getState().chips).toMatchObject([
      {
        path: 'src/sum.ts',
        startLine: 1,
        endLine: 2,
        text: 'const a = 1;\nconst b = 2;',
        language: 'typescript',
      },
    ]);
    view.unmount();
  });
});
