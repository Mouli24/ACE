import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';

/**
 * Serve Monaco from the bundle, not the default CDN: ACE is local-first and must work offline.
 * Imported lazily with the editor so none of this lands in the initial chunk.
 */
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    return label === 'json' ? new jsonWorker() : new editorWorker();
  },
};

loader.config({ monaco });

export { default as MonacoEditor } from '@monaco-editor/react';
