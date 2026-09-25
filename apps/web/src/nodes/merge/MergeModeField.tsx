import { MERGE_MODES, type MergeConfig } from '@ace/contracts';

import { SelectField } from '../../config-panel/fields';

export type MergeMode = MergeConfig['mode'];

/** What each mode does, in the words FR-PAR-002 uses. The values stay the contract's enum. */
const MODE_LABEL: Record<MergeMode, string> = {
  all: 'all',
  any: 'any',
};

export const MERGE_MODE_HINT = 'all: wait for every input · any: continue on the first';

/**
 * The merge node's mode (FR-PAR-002). `all` waits for every connected input, `any` continues on the
 * first to arrive — the other branches still run and are recorded, they simply do not feed the
 * merge. The options are the contract's `MERGE_MODES`, in its order, so a mode the engine does not
 * know cannot be chosen.
 */
export function MergeModeField({
  value,
  onChange,
  disabled,
}: {
  value: MergeMode;
  onChange: (mode: MergeMode) => void;
  disabled?: boolean;
}) {
  return (
    <SelectField
      label="Mode"
      value={value}
      options={MERGE_MODES.map((mode) => ({ value: mode, label: MODE_LABEL[mode] }))}
      onChange={onChange}
      hint={MERGE_MODE_HINT}
      {...(disabled === undefined ? {} : { disabled })}
    />
  );
}
