import { DATA_TYPES, type DataType } from '@ace/contracts';
import {
  Checkbox,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  cn,
} from '@ace/ui';
import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from 'react';

import { validateNumber, type NumberRange } from './validation';

/** The V2 field label: tiny uppercase mono, faint. */
export const FIELD_LABEL =
  'font-machine text-[9px] font-normal uppercase tracking-[0.2em] text-fg-faint';

/** Label + control + optional inline error, the one layout every field uses. */
export function Field({
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
    <div className="flex flex-col gap-1.5">
      <Label className={FIELD_LABEL} htmlFor={htmlFor}>
        {label}
      </Label>
      {children}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      {hint && !error && <p className="text-xs text-fg-muted">{hint}</p>}
    </div>
  );
}

/** Text committed on blur or Enter, so one graph-op per edit rather than one per keystroke. */
export function TextField({
  label,
  value,
  onCommit,
  mono,
  maxLength,
  placeholder,
}: {
  label: string;
  value: string;
  onCommit: (value: string) => void;
  mono?: boolean;
  maxLength?: number;
  placeholder?: string;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
  };
  return (
    <Field label={label} htmlFor={id}>
      <Input
        id={id}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        maxLength={maxLength}
        placeholder={placeholder}
        className={cn(mono && 'font-machine')}
      />
    </Field>
  );
}

export function TextAreaField({
  label,
  value,
  onCommit,
  rows = 5,
  placeholder,
}: {
  label: string;
  value: string;
  onCommit: (value: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Field label={label} htmlFor={id}>
      <Textarea
        id={id}
        rows={rows}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== value && onCommit(draft)}
        placeholder={placeholder}
        className="font-human"
      />
    </Field>
  );
}

/**
 * A bounded number (FR-NODE-007/008): the range is validated on every change, the error shows
 * inline and blocks the save — an out-of-range value never reaches the engine (TC-NODE-006).
 */
export function NumberField({
  label,
  value,
  range,
  step,
  onCommit,
}: {
  label: string;
  value: number;
  range: NumberRange;
  step?: number;
  onCommit: (value: number) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    setDraft(String(value));
    setTouched(false);
  }, [value]);
  const error = touched ? validateNumber(draft, range) : undefined;
  const commit = () => {
    setTouched(true);
    if (validateNumber(draft, range)) return;
    const next = Number(draft);
    if (next !== value) onCommit(next);
  };
  return (
    <Field label={label} htmlFor={id} error={error} hint={`${range.min} – ${range.max}`}>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        step={step ?? (range.integer ? 1 : 0.1)}
        min={range.min}
        max={range.max}
        value={draft}
        aria-invalid={error ? true : undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          setTouched(true);
        }}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        className="font-machine"
      />
    </Field>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  placeholder,
  hint,
}: {
  label: string;
  value: T | undefined;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  placeholder?: string;
  hint?: string;
}) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <Select value={value ?? ''} onValueChange={(v) => onChange(v as T)} disabled={disabled}>
        <SelectTrigger id={id} aria-label={label}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/** Multi-select of `DataType` (FR-NODE-006): order follows the contract enum, never the click order. */
export function DataTypeGroup({
  label,
  value,
  onChange,
}: {
  label: string;
  value: readonly DataType[];
  onChange: (value: DataType[]) => void;
}) {
  const id = useId();
  const toggle = (type: DataType, checked: boolean) => {
    const set = new Set(value);
    if (checked) set.add(type);
    else set.delete(type);
    onChange(DATA_TYPES.filter((t) => set.has(t)));
  };
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-1.5">
      <Label className={FIELD_LABEL} id={id}>
        {label}
      </Label>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        {DATA_TYPES.map((type) => {
          const boxId = `${id}-${type}`;
          return (
            <div key={type} className="flex items-center gap-2">
              <Checkbox
                id={boxId}
                checked={value.includes(type)}
                onCheckedChange={(checked) => toggle(type, checked === true)}
              />
              <label htmlFor={boxId} className="font-machine text-xs text-fg">
                {type}
              </label>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A field that exists in the contract but is wired in a later round: shown, disabled, dated. */
export function LaterField({
  label,
  round,
  testId,
}: {
  label: string;
  round: string;
  testId: string;
}) {
  const id = useId();
  return (
    <div data-testid={`later-${testId}`} className="flex flex-col gap-1.5 opacity-70">
      <Label className={FIELD_LABEL} htmlFor={id}>
        {label}
      </Label>
      <Input id={id} disabled value="" placeholder={`available in ${round}`} aria-disabled="true" />
      <p className="text-xs text-fg-muted">available in {round}</p>
    </div>
  );
}
