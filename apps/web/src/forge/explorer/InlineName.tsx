import { useEffect, useRef, useState } from 'react';

/**
 * The tree's inline name field (VS Code): Enter commits, Escape cancels, leaving the field commits
 * a changed name. A problem shows under it as an alert, and the field stays open until it is fixed
 * or cancelled.
 */
export function InlineName({
  label,
  initial,
  problemOf,
  onCommit,
  onCancel,
  depth,
}: {
  label: string;
  initial: string;
  /** The reason a name cannot be used, checked locally, or undefined. */
  problemOf(name: string): string | undefined;
  /** Resolves with a refusal to show (the engine's), or undefined when done. */
  onCommit(name: string): Promise<string | undefined>;
  onCancel(): void;
  depth: number;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  const [problem, setProblem] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const element = input.current;
    if (element === null) return;
    element.focus();
    const dot = initial.lastIndexOf('.');
    element.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);

  const commit = async (): Promise<void> => {
    if (busy) return;
    if (value === initial) {
      onCancel();
      return;
    }
    const local = problemOf(value);
    if (local !== undefined) {
      setProblem(local);
      return;
    }
    setBusy(true);
    const refused = await onCommit(value);
    setBusy(false);
    setProblem(refused);
  };

  return (
    <div className="relative" style={{ paddingLeft: 8 + depth * 12 + 32 }}>
      <input
        ref={input}
        aria-label={label}
        value={value}
        disabled={busy}
        onChange={(event) => {
          setValue(event.target.value);
          setProblem(undefined);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') void commit();
          if (event.key === 'Escape') onCancel();
        }}
        onBlur={() => {
          if (value.trim() === '' || value === initial) onCancel();
          else void commit();
        }}
        className="h-[22px] w-full rounded-sm border border-accent bg-canvas px-1 font-machine text-[12px] text-fg outline-none"
      />
      {problem !== undefined && (
        <p
          role="alert"
          className="absolute left-0 right-0 z-10 mt-0.5 border border-danger bg-panel px-2 py-1 text-[11.5px] text-danger"
          style={{ marginLeft: 8 + depth * 12 + 32 }}
        >
          {problem}
        </p>
      )}
    </div>
  );
}
