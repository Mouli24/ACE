import { LoopConfigSchema } from '@ace/contracts';

import {
  exitValueKind,
  loopFieldErrors,
  readExitValue,
  toLoopConfig,
  toLoopDraft,
  type LoopDraft,
} from './validate';

const draft = (over: Partial<LoopDraft> = {}): LoopDraft => ({
  maxIterations: '3',
  exits: true,
  path: 'verdict',
  equals: 'approved',
  onMax: 'continue',
  ...over,
});

describe('TC-CON-007 Loop limits', () => {
  it('accepts every whole number the contract allows', () => {
    for (const maxIterations of ['1', '3', '50']) {
      expect(loopFieldErrors(draft({ maxIterations }))).toEqual({});
      expect(toLoopConfig(draft({ maxIterations }))?.maxIterations).toBe(Number(maxIterations));
    }
  });

  it.each(['0', '51'])('refuses max iterations %s with the contract’s reason', (value) => {
    const errors = loopFieldErrors(draft({ maxIterations: value }));
    expect(errors.maxIterations).toBe('must be a whole number from 1 to 50');
    expect(errors.path).toBeUndefined();
    expect(errors.equals).toBeUndefined();
  });

  it.each(['0', '51'])('saves nothing while max iterations is %s', (value) => {
    expect(toLoopConfig(draft({ maxIterations: value }))).toBeUndefined();
  });

  it.each([
    ['empty', ''],
    ['a fraction', '2.5'],
    ['not a number', 'ten'],
    ['negative', '-1'],
  ])('refuses %s max iterations', (_name, value) => {
    expect(loopFieldErrors(draft({ maxIterations: value })).maxIterations).toBe(
      'must be a whole number from 1 to 50',
    );
  });
});

describe('FR-CON-007 exit condition', () => {
  it.each(['verdict', 'review.verdict', 'issues.0', 'issues[0]'])('accepts the path %s', (path) => {
    expect(loopFieldErrors(draft({ path }))).toEqual({});
  });

  it.each(['$.verdict', 'review-verdict', '', '[0].verdict', 'review..verdict'])(
    'refuses the path %s',
    (path) => {
      expect(loopFieldErrors(draft({ path })).path).toBe(
        'must be a dotted path such as verdict or review.issues.0',
      );
      expect(toLoopConfig(draft({ path }))).toBeUndefined();
    },
  );

  it('reads true, false and numbers as themselves and everything else as text', () => {
    expect(readExitValue('true')).toBe(true);
    expect(readExitValue('false')).toBe(false);
    expect(readExitValue('8')).toBe(8);
    expect(readExitValue('-1.5')).toBe(-1.5);
    expect(readExitValue('approved')).toBe('approved');
    expect(readExitValue('')).toBe('');
    expect(readExitValue('007')).toBe('007');
    expect(exitValueKind('true')).toBe('true/false');
    expect(exitValueKind('8')).toBe('number');
    expect(exitValueKind('approved')).toBe('text');
  });

  it('round-trips a config through the draft', () => {
    const config = LoopConfigSchema.parse({
      maxIterations: 7,
      exitCondition: { path: 'review.verdict', equals: 'approved' },
      onMax: 'fail',
    });
    expect(toLoopConfig(toLoopDraft(config))).toEqual(config);
  });

  it('only ever hands back a config the contract itself accepts', () => {
    const config = toLoopConfig(draft({ maxIterations: '50', equals: 'true' }));
    expect(LoopConfigSchema.safeParse(config).success).toBe(true);
    expect(config?.exitCondition?.equals).toBe(true);
  });
});
