import { AgentConfigSchema, rosterFor, type Node } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { previewMessage } from './preview';

/*
 * D324–D326: the composer previews who a message reaches with the very parser the server uses, so
 * what it shows is what will happen — and a message the server would refuse cannot be sent.
 */

const WF = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const id = (n: number) => `01ARZ3NDEKTSV4RRFFQ69G5N0${n}`;
const agent = (n: number, name: string, brain = false): Node => ({
  id: id(n),
  workflowId: WF,
  kind: 'agent',
  name,
  position: { x: 0, y: 0 },
  inputs: [],
  outputs: [],
  config: AgentConfigSchema.parse({
    instructions: '',
    inputTypes: ['text'],
    outputTypes: ['text'],
    ...(brain ? { brain } : {}),
  }),
});

const roster = rosterFor([
  agent(1, 'Nova'),
  agent(2, 'Iris'),
  agent(3, 'Theo'),
  agent(4, 'Director', true),
]);
const base = { roster, states: {}, exclude: [], deliveryMode: 'queue' as const };

describe('previewMessage', () => {
  it('names the nodes a message reaches, by plain name or @handle', () => {
    const nova = previewMessage({ ...base, text: 'Nova, tighten the hook' });
    expect(nova).toMatchObject({ canSend: true, addressing: 'direct' });
    expect(nova.reaches.map((entry) => entry.handle)).toEqual(['nova']);
    expect(
      previewMessage({ ...base, text: 'can iris and @theo check this' }).reaches.map(
        (entry) => entry.handle,
      ),
    ).toEqual(['iris', 'theo']);
  });

  it('an unaddressed message reaches the Brain', () => {
    const unaddressed = previewMessage({ ...base, text: 'how is it going?' });
    expect(unaddressed).toMatchObject({ canSend: true, addressing: 'unaddressed' });
    expect(unaddressed.reaches.map((entry) => entry.handle)).toEqual(['brain']);
  });

  it('a removed recipient leaves the rest; the removal travels as exclude', () => {
    const preview = previewMessage({ ...base, text: 'Iris and Theo, check it', exclude: [id(2)] });
    expect(preview.reaches.map((entry) => entry.handle)).toEqual(['theo']);
    expect(preview.canSend).toBe(true);
  });

  it('an unknown handle blocks the send and suggests the closest', () => {
    const preview = previewMessage({ ...base, text: '@nvoa go' });
    expect(preview.canSend).toBe(false);
    expect(preview.errors[0]).toMatchObject({ code: 'unknown_handle', suggestions: ['@nova'] });
  });

  it('@all reaches every node not finished and says which it skips', () => {
    const preview = previewMessage({
      ...base,
      text: '@all wrap up',
      states: { [id(1)]: 'COMPLETED', [id(2)]: 'RUNNING' },
    });
    expect(preview.addressing).toBe('all');
    expect(preview.reaches.map((entry) => entry.handle)).toEqual(['iris', 'theo', 'brain']);
    expect(preview.skips.map((entry) => entry.handle)).toEqual(['nova']);
    expect(previewMessage({ ...base, text: '@all now', deliveryMode: 'interrupt' }).canSend).toBe(
      false,
    );
  });

  it('nothing to send is not an error, just not sendable', () => {
    expect(previewMessage({ ...base, text: '   ' })).toMatchObject({ canSend: false, errors: [] });
  });
});
