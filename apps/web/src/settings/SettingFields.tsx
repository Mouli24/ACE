import { Input } from '@ace/ui';
import { useEffect, useId, useState, type KeyboardEvent } from 'react';

import { Field } from '../config-panel/fields';

/** What a draft reads as: a value the contract accepts, nothing to save, or why not. */
export type DraftRead<T> = { value: T } | { skip: true } | { error: string };

const blurOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
  if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
};

/**
 * One settings box committed on blur or Enter (FR-SYS-005). `read` checks the draft against the
 * contract's own field schema, so a value the engine would refuse is shown inline and never sent.
 * The box re-reads the server value whenever it changes, so after a save (or a refused save) it
 * shows what the engine holds, not the draft.
 */
export function SettingInput<T>({
  label,
  hint,
  testId,
  value,
  read,
  onSave,
  disabled,
  numeric = false,
  placeholder,
}: {
  label: string;
  hint: string;
  testId: string;
  value: T | undefined;
  read: (raw: string) => DraftRead<T>;
  /** Resolves `false` when the engine refused the value, so the box goes back to the saved one. */
  onSave: (value: T) => Promise<boolean>;
  disabled: boolean;
  numeric?: boolean;
  placeholder?: string;
}) {
  const id = useId();
  const asText = value === undefined ? '' : String(value);
  const [draft, setDraft] = useState(asText);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    setDraft(asText);
    setError(undefined);
  }, [asText]);

  const commit = () => {
    const result = read(draft);
    if ('error' in result) {
      setError(result.error);
      return;
    }
    setError(undefined);
    if ('skip' in result) return;
    if (result.value === value) return;
    void onSave(result.value).then((saved) => {
      if (!saved) setDraft(asText);
    });
  };

  return (
    <Field label={label} htmlFor={id} {...(error === undefined ? { hint } : { error })}>
      <Input
        id={id}
        type={numeric ? 'number' : 'text'}
        inputMode={numeric ? 'numeric' : 'url'}
        step={numeric ? '1' : undefined}
        placeholder={placeholder}
        value={draft}
        disabled={disabled}
        data-testid={testId}
        aria-invalid={error === undefined ? undefined : true}
        onChange={(event) => {
          setDraft(event.target.value);
          setError(undefined);
        }}
        onBlur={commit}
        onKeyDown={blurOnEnter}
        className="font-machine"
      />
    </Field>
  );
}
