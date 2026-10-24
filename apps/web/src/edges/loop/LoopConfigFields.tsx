import { LOOP_ON_MAX, type LoopConfig } from '@ace/contracts';
import { Input } from '@ace/ui';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

import { FIELD_GRID_CLASS, Field, SelectField } from '../../config-panel/fields';
import { useDebouncedCommit } from '../../config-panel/pending-edits';
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

/** Paths and exit values are machine text: the theme sets them in JetBrains Mono 12px. */
const MONO_INPUT_CLASS = 'font-machine text-[12px]';

/**
 * The loop edge editor (FR-CON-007, TC-CON-007): max iterations, the exit condition, and what to do
 * when the maximum is reached. D404: a loop drawn on the Canvas has no exit condition — it runs the
 * number of iterations the person chose — so it shows that one field; the exit condition and the
 * at-the-maximum choice appear only on a loop that has one (a template's Review → Fix).
 *
 * Every field is refused inline by the contract's own rules — 0 and 51 iterations both carry the
 * contract's reason — and a refused draft commits nothing, so an out-of-range loop never reaches
 * the engine as a graph-op. As in the node settings modal (D333), a field saves as you type
 * (debounced), on blur or Enter, and when the modal closes.
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
  /** The loop this editor last saved or was given, so its own save coming back is not a reset. */
  const saved = useRef(JSON.stringify(value));

  /** Commit the whole draft, or nothing at all while any field is refused (TC-CON-007). */
  const commit = (next: LoopDraft) => {
    const config = toLoopConfig(next);
    if (config === undefined) return;
    const json = JSON.stringify(config);
    if (json === saved.current) return;
    saved.current = json;
    onCommit(config);
  };
  const debounced = useDebouncedCommit<LoopDraft>(commit);

  useEffect(() => {
    const json = JSON.stringify(value);
    if (json === saved.current) return;
    saved.current = json;
    debounced.cancel();
    setDraft(toLoopDraft(value));
  }, [value, debounced]);

  const errors = loopFieldErrors(draft);

  const edit = (patch: Partial<LoopDraft>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    if (toLoopConfig(next) === undefined) debounced.cancel();
    else debounced.schedule(next);
  };

  const blur = () => {
    debounced.cancel();
    commit(draft);
  };

  return (
    <div className={FIELD_GRID_CLASS} data-testid="loop-config-fields">
      <Field
        label={draft.exits ? 'Max iterations' : 'Iterations'}
        htmlFor={maxId}
        {...(errors.maxIterations === undefined
          ? {
              hint: draft.exits
                ? 'The loop stops here even if the exit condition never matches.'
                : 'How many times the loop runs. It always runs exactly this many.',
            }
          : { error: `Iterations ${errors.maxIterations}.` })}
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
          onBlur={blur}
          onKeyDown={blurOnEnter}
          className={MONO_INPUT_CLASS}
        />
      </Field>

      {draft.exits && (
        <>
          <SelectField
            label="At the maximum"
            value={draft.onMax}
            options={LOOP_ON_MAX.map((onMax) => ({ value: onMax, label: ON_MAX_LABEL[onMax] }))}
            onChange={(onMax) => {
              debounced.cancel();
              setDraft({ ...draft, onMax });
              commit({ ...draft, onMax });
            }}
            disabled={disabled}
          />

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
              spellCheck={false}
              aria-invalid={errors.path === undefined ? undefined : true}
              onChange={(event) => edit({ path: event.target.value })}
              onBlur={blur}
              onKeyDown={blurOnEnter}
              className={MONO_INPUT_CLASS}
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
              spellCheck={false}
              aria-invalid={errors.equals === undefined ? undefined : true}
              onChange={(event) => edit({ equals: event.target.value })}
              onBlur={blur}
              onKeyDown={blurOnEnter}
              className={MONO_INPUT_CLASS}
            />
          </Field>
        </>
      )}
    </div>
  );
}
