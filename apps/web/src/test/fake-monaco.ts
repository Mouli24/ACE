import type * as Monaco from 'monaco-editor';

/**
 * The slice of Monaco the model registry and the Problems store use, without a browser: models with
 * values, alternative version ids and change events, and markers. `setMarkers` drives Problems.
 */
interface FakeEditor {
  line: number;
  setModel(model: object | null): void;
  getModel(): object | null;
  saveViewState(): { line: number } | null;
  restoreViewState: ReturnType<typeof vi.fn>;
  focus(): void;
  dispose(): void;
  getPosition(): { lineNumber: number; column: number };
  onDidChangeCursorPosition(listener: unknown): { dispose(): void };
  revealLineInCenter(line: number): void;
  setPosition(position: unknown): void;
}

export function createFakeMonaco() {
  class Uri {
    constructor(
      readonly scheme: string,
      readonly path: string,
    ) {}
    toString(): string {
      return `${this.scheme}://${this.path}`;
    }
    static from({ scheme, path }: { scheme: string; path: string }): Uri {
      return new Uri(scheme, path);
    }
  }

  const models = new Map<string, ReturnType<typeof createModel>>();
  let markers: Array<{
    resource: Uri;
    severity: number;
    message: string;
    startLineNumber: number;
    startColumn: number;
    source?: string;
    /** As Monaco's markers carry it: TypeScript's `2345`, or a value with a link. */
    code?: string | { value: string; target: Uri };
  }> = [];
  const markerListeners = new Set<() => void>();
  type FakeModel = ReturnType<typeof createModel>;
  const created = new Set<(model: FakeModel) => void>();
  const disposing = new Set<(model: FakeModel) => void>();

  function createModel(value: string, language: string, uri: Uri) {
    let text = value;
    let alternative = 1;
    let disposed = false;
    const listeners = new Set<() => void>();
    const model = {
      uri,
      getValue: () => text,
      setValue(next: string) {
        text = next;
        alternative += 1;
        listeners.forEach((listener) => listener());
      },
      getAlternativeVersionId: () => alternative,
      onDidChangeContent(listener: () => void) {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      isDisposed: () => disposed,
      dispose() {
        disposing.forEach((listener) => listener(model));
        disposed = true;
        models.delete(uri.toString());
      },
      getEOL: () => (text.includes('\r\n') ? '\r\n' : '\n'),
      getLanguageId: () => language,
      getOptions: () => ({ insertSpaces: true, tabSize: 2 }),
    };
    models.set(uri.toString(), model);
    created.forEach((listener) => listener(model));
    return model;
  }

  const editors: FakeEditor[] = [];
  function createEditor(): FakeEditor {
    let attached: object | null = null;
    let disposed = false;
    const editor: FakeEditor = {
      line: 1,
      setModel: (model) => {
        attached = model;
      },
      getModel: () => attached,
      /** Like Monaco: nothing to save once the editor is disposed and detached from its model. */
      saveViewState: () => (disposed || attached === null ? null : { line: editor.line }),
      restoreViewState: vi.fn(),
      focus: () => undefined,
      dispose: () => {
        disposed = true;
        attached = null;
      },
      getPosition: () => ({ lineNumber: editor.line, column: 1 }),
      onDidChangeCursorPosition: () => ({ dispose: () => undefined }),
      revealLineInCenter: () => undefined,
      setPosition: () => undefined,
    };
    editors.push(editor);
    return editor;
  }

  /** A language service's settings, starting from what Monaco 0.55 starts with. */
  function tsDefaults(compiler: Record<string, unknown>) {
    let compilerOptions = compiler;
    /** Monaco's extra libs: path → content, as `getExtraLibs` answers them. */
    const extraLibs: Record<string, { content: string; version: number }> = {};
    let version = 0;
    let diagnosticsOptions: { diagnosticCodesToIgnore?: number[]; [key: string]: unknown } = {
      noSemanticValidation: false,
      noSyntaxValidation: false,
    };
    return {
      getCompilerOptions: () => compilerOptions,
      getExtraLibs: () => extraLibs,
      /** As Monaco: the same path again replaces it; a dispose removes only its own version. */
      addExtraLib(content: string, path: string) {
        version += 1;
        const mine = version;
        extraLibs[path] = { content, version: mine };
        return {
          dispose: () => {
            if (extraLibs[path]?.version === mine) delete extraLibs[path];
          },
        };
      },
      setCompilerOptions(next: Record<string, unknown>) {
        compilerOptions = next;
      },
      getDiagnosticsOptions: () => diagnosticsOptions,
      setDiagnosticsOptions(next: typeof diagnosticsOptions) {
        diagnosticsOptions = next;
      },
    };
  }
  let jsonOptions: Record<string, unknown> = {
    validate: true,
    allowComments: true,
    schemas: [],
    enableSchemaRequest: false,
    schemaRequest: 'warning',
    schemaValidation: 'warning',
    comments: 'error',
    trailingCommas: 'error',
  };

  return {
    Uri,
    /** Test helper: every editor `editor.create` has made, oldest first. */
    editors,
    /** The numbers Monaco 0.55's enums carry, and its two TS language services. */
    typescript: {
      JsxEmit: { ReactJSX: 4 },
      ModuleKind: { ESNext: 99 },
      ScriptTarget: { ESNext: 99 },
      typescriptDefaults: tsDefaults({ allowNonTsExtensions: true, target: 99 }),
      javascriptDefaults: tsDefaults({ allowNonTsExtensions: true, allowJs: true, target: 99 }),
    },
    json: {
      jsonDefaults: {
        get diagnosticsOptions() {
          return jsonOptions;
        },
        setDiagnosticsOptions(next: Record<string, unknown>) {
          jsonOptions = next;
        },
      },
    },
    MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
    editor: {
      createModel,
      create: createEditor,
      getModel: (uri: Uri) => models.get(uri.toString()) ?? null,
      getModels: () => [...models.values()],
      getModelMarkers: () => markers,
      onDidCreateModel(listener: (model: FakeModel) => void) {
        created.add(listener);
        return { dispose: () => created.delete(listener) };
      },
      onWillDisposeModel(listener: (model: FakeModel) => void) {
        disposing.add(listener);
        return { dispose: () => disposing.delete(listener) };
      },
      onDidChangeMarkers(listener: () => void) {
        markerListeners.add(listener);
        return { dispose: () => markerListeners.delete(listener) };
      },
      defineTheme: () => undefined,
      setTheme: () => undefined,
    },
    /** Test helper: replace every marker, as the TS worker would after a parse. */
    setMarkers(next: typeof markers) {
      markers = next;
      markerListeners.forEach((listener) => listener());
    },
  };
}

export type FakeMonaco = ReturnType<typeof createFakeMonaco>;

export const asMonaco = (fake: FakeMonaco): typeof Monaco => fake as unknown as typeof Monaco;
