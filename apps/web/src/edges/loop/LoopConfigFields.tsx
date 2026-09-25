import { LOOP_ON_MAX, type LoopConfig } from '@ace/contracts';
import { Input } from '@ace/ui';
import { useEffect, useId, useState, type KeyboardEvent } from 'react';

import { Field, SelectField } from '../../config-panel/fields';
import {
  exitValueKind,
  loopFieldErrors,
  toLoopConfig,
  toLoopDraft,
  type LoopDraft,
} from './validate';

const ON_MAX_LABEL: Record<LoopConfig['onMax'], string> = {
  continue: 'continue with the last output',
  fail: 'fail the node',
};

const blurOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
  if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
};

/**
 * The loop edge editor (FR-CON-007, TC-CON-007): max iterations, the exit condition, and what to do
 * when the maximum is reached.
 *
 * Every field is refused inline by the contract's own rules — 0 and 51 iterations both carry the
 * contract's reason — and a refused draft commits nothing, so an out-of-range loop never reaches
 * the engine as a graph-op. A field is committed on blur or Enter, one graph-op per edit rather
 * than one per keystroke, which is how the config panel's fields behave.
 */
export function LoopConfigFields({
  value,
  onCommit,
  disabled,
}: {
  value: LoopConfig;
  onCommit: (next: LoopConfig) => void;
  disabled?: boolean;
}) {
  const maxId = useId();
  const pathId = useId();
  const equalsId = useId();

  const [draft, setDraft] = useState<LoopDraft>(() => toLoopDraft(value));
  useEffect(() => setDraft(toLoopDraft(value)), [value]);

  const errors = loopFieldErrors(draft);

  /** Commit the whole draft, or nothing at all while any field is refused (TC-CON-007). */
  const commit = (next: LoopDraft) => {
    const config = toLoopConfig(next);
    if (config === undefined) return;
    if (JSON.stringify(config) === JSON.stringify(value)) return;
    onCommit(config);
  };

  const edit = (patch: Partial<LoopDraft>) => setDraft((current) => ({ ...current, ...patch }));

  return (
    <div className="flex flex-col gap-3" data-testid="loop-config-fields">
      <Field
        label="Max iterations"
        htmlFor={maxId}
        {...(errors.maxIterations === undefined
          ? { hint: 'The loop stops here even if the exit condition never matches.' }
          : { error: `Max iterations ${errors.maxIterations}.` })}
      >
        <Input
          id={maxId}
          type="number"
          inputMode="numeric"
          step={1}
          value={draft.maxIterations}
          disabled={disabled}
          aria-invalid={errors.maxIterations === undefined ? undefined : true}
          onChange={(event) => edit({ maxIterations: event.target.value })}
          onBlur={() => commit(draft)}
          onKeyDown={blurOnEnter}
          className="font-machine"
        />
      </Field>

      <Field
        label="Exit when path"
        htmlFor={pathId}
        {...(errors.path === undefined
          ? { hint: "A dotted path into the source node's json output." }
          : { error: `The path ${errors.path}.` })}
      >
        <Input
          id={pathId}
          value={draft.path}
          disabled={disabled}
          placeholder="verdict"
          aria-invalid={errors.path === undefined ? undefined : true}
          onChange={(event) => edit({ path: event.target.value })}
          onBlur={() => commit(draft)}
          onKeyDown={blurOnEnter}
          className="font-machine"
        />
      </Field>

      <Field
        label="equals"
        htmlFor={equalsId}
        {...(errors.equals === undefined
          ? { hint: `read as ${exitValueKind(draft.equals)}` }
          : { error: `The value ${errors.equals}.` })}
      >
        <Input
          id={equalsId}
          value={draft.equals}
          disabled={disabled}
          placeholder="approved"
          aria-invalid={errors.equals === undefined ? undefined : true}
          onChange={(event) => edit({ equals: event.target.value })}
          onBlur={() => commit(draft)}
          onKeyDown={blurOnEnter}
          className="font-machine"
        />
      </Field>

      <SelectField
        label="At the maximum"
        value={draft.onMax}
        options={LOOP_ON_MAX.map((onMax) => ({ value: onMax, label: ON_MAX_LABEL[onMax] }))}
        onChange={(onMax) => {
          edit({ onMax });
          commit({ ...draft, onMax });
        }}
        disabled={disabled}
      />
    </div>
  );
}
