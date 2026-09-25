import { POLICY_TEST_POINTS, type GuardrailPolicy } from '@ace/contracts';
import {
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@ace/ui';
import { useState } from 'react';

import { VerdictList, toDisplayVerdicts } from './VerdictList';
import { useTestGuardrailPolicy } from './hooks';

type TestPoint = (typeof POLICY_TEST_POINTS)[number];

const POINT_LABEL: Readonly<Record<TestPoint, string>> = {
  input: 'as input',
  output: 'as output',
};

/**
 * Try a policy on a piece of text (FR-GRD-001, §2.5 `POST /guardrail-policies/:id/test`): paste it,
 * say whether it is going in or coming out, and read the verdicts the policy would record.
 *
 * The text is sent as typed and the verdicts are rendered by `VerdictList`, which shows a
 * redaction's types and never a value (FR-GRD-014).
 */
export function PolicyTestPanel({ policy }: { policy: GuardrailPolicy }) {
  const test = useTestGuardrailPolicy();
  const [text, setText] = useState('');
  const [point, setPoint] = useState<TestPoint>('input');

  const run = () => {
    test.mutate({ id: policy.id, text, point });
  };

  return (
    <section
      data-testid="policy-test-panel"
      className="flex flex-col gap-3 rounded-card border border-border bg-panel p-4"
    >
      <div>
        <h2 className="font-human text-base font-semibold">Test this policy</h2>
        <p className="text-xs text-fg-muted">
          Nothing runs a model — the checks of version {policy.version} are applied to the text
          below.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="policy-test-text">Text</Label>
        <Textarea
          id="policy-test-text"
          rows={4}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Paste the text to check…"
        />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="policy-test-point">Check it</Label>
          <Select value={point} onValueChange={(value) => setPoint(value as TestPoint)}>
            <SelectTrigger id="policy-test-point" className="w-44" aria-label="Check it">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {POLICY_TEST_POINTS.map((value) => (
                <SelectItem key={value} value={value}>
                  {POINT_LABEL[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={run} disabled={test.isPending || text.trim().length === 0}>
          Run test
        </Button>
      </div>

      {test.error && (
        <p role="alert" className="text-sm text-danger">
          {test.error.message}
        </p>
      )}

      {test.data && (
        <div data-testid="policy-test-verdicts" className="flex flex-col gap-2">
          <h3 className="font-human text-sm font-semibold">
            {test.data.verdicts.length} verdict{test.data.verdicts.length === 1 ? '' : 's'}
          </h3>
          <VerdictList verdicts={toDisplayVerdicts(test.data.verdicts)} />
        </div>
      )}
    </section>
  );
}
