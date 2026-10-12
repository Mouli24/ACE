import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ace/ui';
import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from 'react';

/** What a draft reads as: a value the contract accepts, nothing to save, or why not. */
export type DraftRead<T> = { value: T } | { skip: true } | { error: string };

/** The theme's help line under a field (D328): 11px / 1.45, muted. */
export const HELP_CLASS = 'text-[11px] leading-[1.45] text-[var(--muted)]';

const blurOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
  if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
};

/**
 * One field in the Ace UI theme's layout (D328): the small-caps label, the control 7px below it,
 * then either the help line or the error in the theme's red.
 */
export function SettingField({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-[7px]">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error && (
        <p role="alert" className="text-[11px] leading-[1.45] text-[#c94c27]">
          {error}
        </p>
      )}
      {hint && !error && <p className={HELP_CLASS}>{hint}</p>}
    </div>
  );
}

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
    <SettingField label={label} htmlFor={id} {...(error === undefined ? { hint } : { error })}>
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
        className="font-machine text-[12px]"
      />
    </SettingField>
  );
}

/**
 * One choice from a fixed list in the theme's dropdown (D328), saved as it changes (FR-SYS-005).
 * Shared by the settings screen and the project page (D301's Terminal trust level).
 */
export function SelectField<T extends string>({
  id,
  label,
  hint,
  testId,
  value,
  options,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  hint?: string;
  testId: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled: boolean;
}) {
  return (
    <SettingField label={label} htmlFor={id} {...(hint === undefined ? {} : { hint })}>
      <Select
        value={value}
        onValueChange={(next) => {
          const option = options.find((candidate) => candidate.value === next);
          if (option !== undefined && option.value !== value) onChange(option.value);
        }}
        disabled={disabled}
      >
        <SelectTrigger id={id} data-testid={testId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingField>
  );
}
