import { BudgetUsdSchema, DATA_TYPES, type DataType } from '@ace/contracts';
import {
  Checkbox,
  FIELD_LABEL_CLASS,
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
import { useId, type KeyboardEvent, type ReactNode } from 'react';

import { useAutosaveDraft } from './pending-edits';
import { validateNumber, type NumberRange } from './validation';

/*
 * The node settings modal's fields, in the Ace UI theme (D328, D333): a mono 9.5px label, 7px above
 * a 38px control, with an 11px help line under it. Text and number fields save as you type
 * (debounced), on blur, and when the modal closes; selects and checkboxes save at once.
 */

/** The theme's field label: JetBrains Mono 9.5px, 0.1em, muted, 500, uppercase. */
export const FIELD_LABEL = FIELD_LABEL_CLASS;

/** The theme's help line under a field: 11px / 1.45, muted. */
export const HELP_CLASS = 'text-[11px] leading-[1.45] text-[var(--muted)] [text-wrap:pretty]';

/** The same line when it reports a problem: the theme's destructive ink. */
export const ERROR_CLASS = 'text-[11px] leading-[1.45] text-[#c94c27] [text-wrap:pretty]';

/** The theme's paired-fields grid: as many 220px-or-wider columns as fit, gap 20px 16px. */
export const FIELD_GRID_CLASS =
  'grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-4 gap-y-5';

/** Inputs the theme sets in JetBrains Mono (URLs, keys, model names, paths, numbers). */
const MONO_INPUT_CLASS = 'font-machine text-[12px]';

/** Label + control + optional inline error, the one layout every field uses. */
export function Field({
  label,
  htmlFor,
  error,
  hint,
  aside,
  className,
  children,
}: {
  label: string;
  htmlFor?: string;
  error?: string;
  hint?: string;
  /** Shown at the right of the label row (the theme puts small chips there). */
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-[7px]', className)}>
      <div className="flex min-h-4 items-center justify-between gap-2">
        <Label htmlFor={htmlFor}>{label}</Label>
        {aside}
      </div>
      {children}
      {error && (
        <p role="alert" className={ERROR_CLASS}>
          {error}
        </p>
      )}
      {hint && !error && <p className={HELP_CLASS}>{hint}</p>}
    </div>
  );
}

const blurOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
  if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
};

/**
 * A one-line text field that saves as you type. `normalize` turns the draft into what is saved,
 * or `undefined` when it cannot be (the name field trims, and refuses an empty name).
 */
export function TextField({
  label,
  value,
  onCommit,
  mono,
  maxLength,
  placeholder,
  hint,
  normalize,
}: {
  label: string;
  value: string;
  onCommit: (value: string) => void;
  mono?: boolean;
  maxLength?: number;
  placeholder?: string;
  hint?: string;
  normalize?: (draft: string) => string | undefined;
}) {
  const id = useId();
  const field = useAutosaveDraft<string, string>({
    value,
    toDraft: (saved) => saved,
    parse: normalize ?? ((draft) => draft),
    onCommit,
    revertInvalidOnBlur: true,
  });
  return (
    <Field label={label} htmlFor={id} {...(hint === undefined ? {} : { hint })}>
      <Input
        id={id}
        value={field.draft}
        onChange={(e) => field.change(e.target.value)}
        onBlur={field.blur}
        onKeyDown={blurOnEnter}
        maxLength={maxLength}
        placeholder={placeholder}
        className={cn(mono && MONO_INPUT_CLASS)}
      />
    </Field>
  );
}

/** A multi-line text field that saves as you type (the system prompt, a template, input text). */
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
  const field = useAutosaveDraft<string, string>({
    value,
    toDraft: (saved) => saved,
    parse: (draft) => draft,
    onCommit,
  });
  return (
    <Field label={label} htmlFor={id}>
      <Textarea
        id={id}
        rows={rows}
        value={field.draft}
        onChange={(e) => field.change(e.target.value)}
        onBlur={field.blur}
        placeholder={placeholder}
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
  const field = useAutosaveDraft<number, string>({
    value,
    toDraft: (saved) => String(saved),
    parse: (draft) => (validateNumber(draft, range) === undefined ? Number(draft) : undefined),
    onCommit,
  });
  // the draft is checked as it is typed; the saved value is always in range
  const error = field.draft === String(value) ? undefined : validateNumber(field.draft, range);
  return (
    <Field label={label} htmlFor={id} error={error} hint={`${range.min} – ${range.max}`}>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        step={step ?? (range.integer ? 1 : 0.1)}
        min={range.min}
        max={range.max}
        value={field.draft}
        aria-invalid={error ? true : undefined}
        onChange={(e) => field.change(e.target.value)}
        onBlur={field.blur}
        onKeyDown={blurOnEnter}
        className={MONO_INPUT_CLASS}
      />
    </Field>
  );
}

/**
 * PG-4.3: a USD cap that may be left blank — blank is no cap and saves `null`, how a patch clears
 * one (D72); an amount `BudgetUsdSchema` refuses (0, negative) is shown and never saved.
 */
export function UsdCapField({
  label,
  hint,
  testId,
  value,
  onCommit,
}: {
  label: string;
  hint: string;
  testId?: string;
  value: number | null | undefined;
  onCommit: (value: number | null) => void;
}) {
  const id = useId();
  const read = (raw: string): number | null | undefined => {
    if (raw.trim() === '') return null;
    const parsed = BudgetUsdSchema.safeParse(Number(raw));
    return parsed.success ? parsed.data : undefined;
  };
  const field = useAutosaveDraft<number | null, string>({
    value: value ?? null,
    toDraft: (saved) => (saved === null ? '' : String(saved)),
    parse: read,
    onCommit,
  });
  const error = read(field.draft) === undefined ? 'Must be an amount above 0.' : undefined;
  return (
    <Field label={label} htmlFor={id} {...(error === undefined ? { hint } : { error })}>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        step="0.01"
        min="0"
        placeholder="no cap"
        value={field.draft}
        aria-invalid={error ? true : undefined}
        {...(testId === undefined ? {} : { 'data-testid': testId })}
        onChange={(e) => field.change(e.target.value)}
        onBlur={field.blur}
        onKeyDown={blurOnEnter}
        className={MONO_INPUT_CLASS}
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
    <Field label={label} htmlFor={id} {...(hint === undefined ? {} : { hint })}>
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
    <div role="group" aria-labelledby={id} className="flex min-w-0 flex-col gap-[7px]">
      <div className="flex min-h-4 items-center">
        <span id={id} className={FIELD_LABEL_CLASS}>
          {label}
        </span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-x-4 gap-y-2">
        {DATA_TYPES.map((type) => {
          const boxId = `${id}-${type}`;
          return (
            <div key={type} className="flex items-center gap-2">
              <Checkbox
                id={boxId}
                checked={value.includes(type)}
                onCheckedChange={(checked) => toggle(type, checked === true)}
              />
              <label
                htmlFor={boxId}
                className="cursor-pointer font-machine text-[12px] text-[var(--ink)]"
              >
                {type}
              </label>
            </div>
          );
        })}
      </div>
    </div>
  );
}
