import type * as Monaco from 'monaco-editor';

/**
 * The slice of Monaco the model registry and the Problems store use, without a browser: models with
 * values, alternative version ids and change events, and markers. `setMarkers` drives Problems.
 */
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
  }> = [];
  const markerListeners = new Set<() => void>();

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
        disposed = true;
        models.delete(uri.toString());
      },
      getEOL: () => (text.includes('\r\n') ? '\r\n' : '\n'),
      getLanguageId: () => language,
      getOptions: () => ({ insertSpaces: true, tabSize: 2 }),
    };
    models.set(uri.toString(), model);
    return model;
  }

  return {
    Uri,
    MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
    editor: {
      createModel,
      getModel: (uri: Uri) => models.get(uri.toString()) ?? null,
      getModels: () => [...models.values()],
      getModelMarkers: () => markers,
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
