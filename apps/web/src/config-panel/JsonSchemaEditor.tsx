import { Label } from '@ace/ui';
import { Suspense, lazy, useEffect, useId, useState } from 'react';

import { useResolvedTheme } from '../app/theme';

/** Monaco is several MB; it loads (from the bundle, not a CDN) only when an agent panel is open. */
const MonacoEditor = lazy(() =>
  import('./monaco-loader').then((m) => ({ default: m.MonacoEditor })),
);

function stringify(value: Record<string, unknown> | undefined): string {
  return value ? JSON.stringify(value, null, 2) : '';
}

/**
 * The output contract JSON schema (FR-NODE-003, §2.4 `outputContract.jsonSchema`). Text is
 * parsed on every change: invalid JSON is an inline error and is not saved; an empty editor
 * clears the contract.
 */
export function JsonSchemaEditor({
  value,
  onCommit,
}: {
  value: Record<string, unknown> | undefined;
  onCommit: (schema: Record<string, unknown> | undefined) => void;
}) {
  const id = useId();
  /* FR-SYS-005: Monaco has its own palette, so it is told which theme is on screen. */
  const editorTheme = useResolvedTheme() === 'light' ? 'vs' : 'vs-dark';
  const [text, setText] = useState(() => stringify(value));
  const [error, setError] = useState<string>();
  useEffect(() => {
    setText(stringify(value));
    setError(undefined);
  }, [value]);

  const onChange = (next: string | undefined) => {
    const raw = next ?? '';
    setText(raw);
    if (raw.trim() === '') {
      setError(undefined);
      if (value !== undefined) onCommit(undefined);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setError('The schema must be a JSON object.');
        return;
      }
      setError(undefined);
      if (JSON.stringify(parsed) !== JSON.stringify(value ?? null)) {
        onCommit(parsed as Record<string, unknown>);
      }
    } catch {
      setError('Enter valid JSON.');
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Output contract (JSON schema)</Label>
      <div
        className="overflow-hidden rounded-md border border-border"
        data-testid="json-schema-editor"
      >
        <Suspense
          fallback={
            <div className="h-40 bg-canvas p-2 font-machine text-xs text-fg-muted">
              loading editor…
            </div>
          }
        >
          <MonacoEditor
            height="10rem"
            language="json"
            theme={editorTheme}
            value={text}
            onChange={onChange}
            aria-label="JSON schema"
            options={{
              minimap: { enabled: false },
              lineNumbers: 'off',
              fontSize: 12,
              fontFamily: 'JetBrains Mono, Menlo, Consolas, monospace',
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              ariaLabel: 'JSON schema',
            }}
          />
        </Suspense>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : (
        <p className="text-xs text-fg-muted">Leave empty for free-form output.</p>
      )}
    </div>
  );
}
