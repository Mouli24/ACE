import type * as Monaco from 'monaco-editor';
import { Suspense, lazy, useEffect, useRef, useState } from 'react';

import { useResolvedTheme } from '../app/theme';
import { applyForgeTheme } from '../forge/editor/forge-theme';
import { ERROR_CLASS, Field, HELP_CLASS } from './fields';

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
  /*
   * FR-SYS-005: Monaco has one palette for every editor on the page, so this editor wears Forge's
   * (the app's own theme) rather than setting Monaco's stock vs / vs-dark over it.
   */
  const theme = useResolvedTheme();
  const monacoRef = useRef<typeof Monaco | undefined>(undefined);
  useEffect(() => {
    if (monacoRef.current !== undefined) applyForgeTheme(monacoRef.current, theme);
  }, [theme]);

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
    <Field label="Output contract (JSON schema)">
      <div
        className="overflow-hidden rounded-[9px] border border-[var(--line)] bg-[var(--canvas)]"
        data-testid="json-schema-editor"
      >
        <Suspense
          fallback={
            <div className="flex h-40 items-center justify-center text-[13px] text-[var(--muted)]">
              Loading editor…
            </div>
          }
        >
          <MonacoEditor
            height="10rem"
            language="json"
            // the name `applyForgeTheme` defines, so creating the editor never sets a stock theme
            theme={theme === 'dark' ? 'ace-dark' : 'ace-light'}
            value={text}
            onChange={onChange}
            beforeMount={(monaco) => {
              monacoRef.current = monaco;
              applyForgeTheme(monaco, theme);
            }}
            onMount={(_editor, monaco) => applyForgeTheme(monaco, theme)}
            aria-label="JSON schema"
            options={{
              minimap: { enabled: false },
              lineNumbers: 'off',
              fontSize: 12,
              fontFamily: "'JetBrains Mono', monospace",
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              ariaLabel: 'JSON schema',
            }}
          />
        </Suspense>
      </div>
      {error ? (
        <p role="alert" className={ERROR_CLASS}>
          {error}
        </p>
      ) : (
        <p className={HELP_CLASS}>Leave empty for free-form output.</p>
      )}
    </Field>
  );
}
