import type {
  GuardrailAction,
  GuardrailCheck,
  GuardrailCheckType,
  GuardrailPolicy,
  PolicyGuardrailPoint,
} from '@ace/contracts';
import {
  Button,
  DIALOG_CLOSE_CLASS,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  guardrailActionLabels,
} from '@ace/ui';
import { useState } from 'react';

import { newId } from '../lib/ulid';
import { Toggle } from '../theme/primitives';
import {
  CHECK_NOTE,
  CHECK_PARAM_FIELDS,
  EDITOR_POINT_ORDER,
  POINT_DESCRIPTION,
  POINT_LABEL,
  checkTypesFor,
  numberToText,
  patternsToText,
  textToPatterns,
  unknownParams,
  type ParamField,
} from './check-meta';
import { useUpdateGuardrailPolicy } from './hooks';

const ACTION_OPTIONS = guardrailActionLabels();

/* The theme's vocabulary (D328): cards, inner boxes, 11px help. */
const CARD =
  'flex flex-col gap-3 rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-4';
const INNER = 'rounded-[10px] border border-[var(--line)] bg-[var(--soft)]';
const HELP = 'text-[11px] leading-[1.45] text-[var(--muted)]';

/**
 * The policy editor (FR-GRD-001, FR-GRD-011, TC-GRD-001, TC-GRD-016): every check grouped by the
 * point it runs at, each with its action, an on/off switch and the params §2.2 gives its type.
 *
 * Two rules from the contract are visible in the markup rather than only in a comment:
 *
 *  - a point offers only the check types `GUARDRAIL_CHECK_TYPES_BY_POINT` allows there, so a check
 *    the engine would refuse cannot be built (D75);
 *  - the `data` point is not here at all, because `POLICY_GUARDRAIL_POINTS` does not contain it —
 *    data guardrails are always on and have no policy setting (BR-15, FR-GRD-010). The section at
 *    the bottom says so and shows them switched on and not switchable.
 *
 * Saving PATCHes the policy, which writes version + 1 (FR-GRD-001, Arch §13.4); the answer's version
 * is what the editor then reports. Theme cards per point, the theme's switch per check (D328).
 */
export function PolicyEditor({ policy }: { policy: GuardrailPolicy }) {
  const update = useUpdateGuardrailPolicy();
  const [name, setName] = useState(policy.name);
  const [checks, setChecks] = useState<GuardrailCheck[]>(policy.checks);

  const replace = (id: string, change: (check: GuardrailCheck) => GuardrailCheck) => {
    setChecks((current) => current.map((check) => (check.id === id ? change(check) : check)));
  };

  const setParam = (id: string, key: string, value: unknown) => {
    replace(id, (check) => {
      const params = { ...check.params };
      if (value === undefined) delete params[key];
      else params[key] = value;
      return { ...check, params };
    });
  };

  const addCheck = (point: PolicyGuardrailPoint, type: GuardrailCheckType) => {
    setChecks((current) => [
      ...current,
      { id: newId(), point, type, action: 'warn', enabled: true, params: {} },
    ]);
  };

  const save = () => {
    update.mutate({
      id: policy.id,
      ...(name.trim() && name.trim() !== policy.name ? { name: name.trim() } : {}),
      checks: checks.map((check) => ({ ...check, params: { ...check.params } })),
    });
  };

  return (
    <section data-testid="policy-editor" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex w-full max-w-[280px] flex-col gap-[7px]">
          <Label htmlFor="policy-name">Name</Label>
          <Input
            id="policy-name"
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="flex items-center gap-3">
          {update.data && (
            <span
              data-testid="policy-saved-version"
              className="font-machine text-[10px] text-[var(--muted)]"
            >
              saved as version {update.data.version}
            </span>
          )}
          <Button onClick={save} disabled={update.isPending || name.trim().length === 0}>
            Save as new version
          </Button>
        </div>
      </div>

      {update.error && (
        <p role="alert" className="text-[12px] text-[#c94c27]">
          {update.error.message}
        </p>
      )}

      <p className={HELP}>
        Saving never edits a version in place: the engine writes the next version and runs record
        which one they used (FR-GRD-001, FR-GRD-002).
      </p>

      {EDITOR_POINT_ORDER.map((point) => (
        <PointGroup
          key={point}
          point={point}
          checks={checks.filter((check) => check.point === point)}
          onAdd={(type) => addCheck(point, type)}
          onChange={replace}
          onParam={setParam}
          onRemove={(id) => setChecks((current) => current.filter((check) => check.id !== id))}
        />
      ))}

      <DataGuardrailsSection />
    </section>
  );
}

function PointGroup({
  point,
  checks,
  onAdd,
  onChange,
  onParam,
  onRemove,
}: {
  point: PolicyGuardrailPoint;
  checks: GuardrailCheck[];
  onAdd: (type: GuardrailCheckType) => void;
  onChange: (id: string, change: (check: GuardrailCheck) => GuardrailCheck) => void;
  onParam: (id: string, key: string, value: unknown) => void;
  onRemove: (id: string) => void;
}) {
  const used = new Set(checks.map((check) => check.type));
  const addable = checkTypesFor(point).filter((type) => !used.has(type));

  return (
    <div data-testid={`point-group-${point}`} className={CARD}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[14px] font-bold">{POINT_LABEL[point]}</h3>
          <p className={`mt-0.5 ${HELP}`}>{POINT_DESCRIPTION[point]}</p>
        </div>
        {addable.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" size="sm" aria-label={`Add a ${point} check`}>
                Add check
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {addable.map((type) => (
                <DropdownMenuItem key={type} onSelect={() => onAdd(type)}>
                  {type}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {checks.length === 0 && (
        <p className="text-[12px] text-[var(--muted)]">No checks at this point.</p>
      )}

      {checks.map((check) => (
        <CheckRow
          key={check.id}
          check={check}
          onChange={onChange}
          onParam={onParam}
          onRemove={onRemove}
        />
      ))}
    </div>
  );
}

function CheckRow({
  check,
  onChange,
  onParam,
  onRemove,
}: {
  check: GuardrailCheck;
  onChange: (id: string, change: (check: GuardrailCheck) => GuardrailCheck) => void;
  onParam: (id: string, key: string, value: unknown) => void;
  onRemove: (id: string) => void;
}) {
  const extra = unknownParams(check);
  const note = CHECK_NOTE[check.type];

  return (
    <div
      data-testid={`check-${check.type}-${check.point}`}
      className={`flex flex-col gap-[10px] px-3 py-[10px] ${INNER}`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="min-w-40 flex-1 font-machine text-[12px] font-medium">{check.type}</span>

        {/* The theme's switch (its Skills rows); the row button carries the state. */}
        <button
          type="button"
          role="switch"
          aria-checked={check.enabled}
          aria-label={`Enable ${check.type} at ${check.point}`}
          onClick={() =>
            onChange(check.id, (current) => ({ ...current, enabled: !current.enabled }))
          }
          className="flex cursor-pointer items-center gap-2 rounded-full text-[11px] text-[var(--muted)] outline-none focus-visible:shadow-[0_0_0_2px_#ef6b3f]"
        >
          <Toggle on={check.enabled} />
          enabled
        </button>

        <Select
          value={check.action}
          onValueChange={(value) =>
            onChange(check.id, (current) => ({ ...current, action: value as GuardrailAction }))
          }
        >
          <SelectTrigger
            className="w-[150px]"
            aria-label={`Action for ${check.type} at ${check.point}`}
            data-testid={`action-${check.type}-${check.point}`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ACTION_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <button
          type="button"
          className={DIALOG_CLOSE_CLASS}
          aria-label={`Remove ${check.type} at ${check.point}`}
          onClick={() => onRemove(check.id)}
        >
          <span aria-hidden>✕</span>
        </button>
      </div>

      {CHECK_PARAM_FIELDS[check.type].length > 0 && (
        <div className="flex flex-wrap items-start gap-4">
          {CHECK_PARAM_FIELDS[check.type].map((field) => (
            <ParamInput
              key={field.key}
              check={check}
              field={field}
              onParam={(value) => onParam(check.id, field.key, value)}
            />
          ))}
        </div>
      )}

      {note && <p className={HELP}>{note}</p>}

      {Object.keys(extra).length > 0 && (
        <p
          data-testid={`check-extra-params-${check.id}`}
          className="font-machine text-[10px] text-[var(--muted)]"
        >
          kept as saved: {JSON.stringify(extra)}
        </p>
      )}
    </div>
  );
}

function ParamInput({
  check,
  field,
  onParam,
}: {
  check: GuardrailCheck;
  field: ParamField;
  onParam: (value: unknown) => void;
}) {
  const id = `param-${check.id}-${field.key}`;
  const label = `${field.label} for ${check.type}`;

  return (
    <div className="flex flex-col gap-[7px]">
      <Label htmlFor={id}>{field.label}</Label>
      {field.kind === 'number' ? (
        <Input
          id={id}
          type="number"
          aria-label={label}
          className="w-40 font-machine text-[12px]"
          value={numberToText(check.params[field.key])}
          {...(field.min === undefined ? {} : { min: field.min })}
          {...(field.max === undefined ? {} : { max: field.max })}
          onChange={(event) => {
            const raw = event.target.value.trim();
            onParam(raw === '' ? undefined : Number(raw));
          }}
        />
      ) : (
        <Textarea
          id={id}
          rows={3}
          aria-label={label}
          className="w-64 font-machine text-[12px]"
          value={patternsToText(check.params[field.key])}
          onChange={(event) => {
            const patterns = textToPatterns(event.target.value);
            onParam(patterns.length === 0 ? undefined : patterns);
          }}
        />
      )}
      {field.hint && <p className={`max-w-64 ${HELP}`}>{field.hint}</p>}
    </div>
  );
}

/** The two data guardrails FR-GRD-010 names. They are here to be seen, not to be configured. */
const DATA_GUARDRAILS: readonly { key: string; title: string; detail: string }[] = [
  {
    key: 'secret-redaction',
    title: 'Secret redaction',
    detail: 'Keys are never stored in prompts, outputs, logs or exports.',
  },
  {
    key: 'file-confinement',
    title: 'File confinement',
    detail: 'File access stays inside the project folder.',
  },
];

/**
 * FR-GRD-010 and BR-15: data guardrails are always on. The contract says so by leaving `data` out of
 * `POLICY_GUARDRAIL_POINTS` — a policy has no field that could switch one off — so this section
 * shows them on, with the switch disabled, and says why (TC-GRD-015).
 */
function DataGuardrailsSection() {
  return (
    <div data-testid="data-guardrails-always-on" className={CARD}>
      <h3 className="flex items-center gap-2 text-[14px] font-bold">
        <span aria-hidden className="text-[12px]">
          🔒︎
        </span>
        Data — always on
      </h3>
      <p className={HELP}>
        Data guardrails cannot be switched off and are not part of a policy: the contract gives a
        policy no setting for them (BR-15, FR-GRD-010).
      </p>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-2">
        {DATA_GUARDRAILS.map((guardrail) => (
          <div
            key={guardrail.key}
            data-testid={`data-guardrail-${guardrail.key}`}
            className="flex items-center gap-[10px] rounded-[9px] border border-[var(--line)] px-3 py-[10px]"
          >
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] font-semibold">{guardrail.title}</p>
              <p className="mt-px text-[10.5px] text-[var(--muted)]">{guardrail.detail}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked
              disabled
              aria-label={`${guardrail.title} (always on)`}
              className="cursor-not-allowed rounded-full"
            >
              <Toggle on />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
