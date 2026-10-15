import { AgentConfigSchema, rosterFor, type Node } from '@ace/contracts';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Composer } from './Composer';

/*
 * Domain Gate 5, the composer (D3, D4, D324–D326, D336): it previews who a message reaches, lets
 * the human remove a recipient, refuses to send what the server would refuse, autocompletes
 * handles, appends one from a mention chip, picks queue or interrupt, sends on Enter, and — with
 * no live run — starts one with the message as its goal.
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

function setup(props: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSend = vi.fn(async () => undefined);
  const onStart = vi.fn(async () => undefined);
  const { unmount } = render(
    <Composer roster={roster} states={{}} live onSend={onSend} onStart={onStart} {...props} />,
  );
  return { onSend, onStart, unmount, box: screen.getByRole('textbox', { name: 'Message' }) };
}

const reaches = () =>
  within(screen.getByTestId('composer-reaches'))
    .queryAllByTestId('recipient')
    .map((chip) => chip.getAttribute('data-handle'));

describe('Domain composer', () => {
  it('previews who a message reaches; a removed recipient travels as exclude', async () => {
    const user = userEvent.setup();
    const { onSend, box } = setup();
    await user.type(box, 'Iris and Theo, check it');
    expect(reaches()).toEqual(['iris', 'theo']);

    await user.click(screen.getByRole('button', { name: 'Remove @iris' }));
    expect(reaches()).toEqual(['theo']);
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith({
      text: 'Iris and Theo, check it',
      deliveryMode: 'queue',
      exclude: [id(2)],
    });
    expect(box).toHaveValue('');
  });

  it('an unaddressed message shows it goes to the Brain', async () => {
    const user = userEvent.setup();
    const { box } = setup();
    await user.type(box, 'how is it going?');
    expect(reaches()).toEqual(['brain']);
  });

  it('blocks a handle nobody has, and offers the closest', async () => {
    const user = userEvent.setup();
    const { onSend, box } = setup();
    await user.type(box, '@nvoa go');
    expect(screen.getByRole('alert')).toHaveTextContent('@nvoa');
    expect(screen.getByRole('alert')).toHaveTextContent('@nova');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await user.keyboard('{Enter}');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('Enter sends; Shift+Enter breaks the line (D336)', async () => {
    const user = userEvent.setup();
    const { onSend, box } = setup();
    await user.type(box, 'Nova, first line{Shift>}{Enter}{/Shift}second line');
    expect(onSend).not.toHaveBeenCalled();
    expect(box).toHaveValue('Nova, first line\nsecond line');
    await user.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledWith({
      text: 'Nova, first line\nsecond line',
      deliveryMode: 'queue',
    });
    expect(box).toHaveValue('');
  });

  it('a mention chip per agent appends its handle, with a space when needed', async () => {
    const user = userEvent.setup();
    const { box } = setup();
    expect(
      ['@nova', '@iris', '@theo', '@brain'].map((name) => screen.getByRole('button', { name })),
    ).toHaveLength(4);
    await user.click(screen.getByRole('button', { name: '@theo' }));
    expect(box).toHaveValue('@theo ');
    await user.type(box, 'and');
    await user.click(screen.getByRole('button', { name: '@iris' }));
    expect(box).toHaveValue('@theo and @iris ');
    expect(reaches()).toEqual(['theo', 'iris']);
  });

  it('the send button names what it does: Send when live, Start team run otherwise', () => {
    const { unmount } = render(
      <Composer roster={roster} states={{}} live onSend={vi.fn()} onStart={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Send' }).querySelector('svg')).not.toBeNull();
    unmount();
    render(
      <Composer roster={roster} states={{}} live={false} onSend={vi.fn()} onStart={vi.fn()} />,
    );
    expect(
      screen.getByRole('button', { name: 'Start team run' }).querySelector('svg'),
    ).not.toBeNull();
  });

  it('"Enter starts a team run" shows only when Enter does start one', () => {
    const { unmount } = setup();
    expect(screen.queryByText('Enter starts a team run')).not.toBeInTheDocument();
    unmount();
    setup({ live: false });
    expect(screen.getByText('Enter starts a team run')).toBeInTheDocument();
    // No live run: a handle means nothing yet, so no mention chips either.
    expect(screen.queryByRole('button', { name: '@nova' })).not.toBeInTheDocument();
  });

  it('with no live run, Enter starts one with the message as its goal', async () => {
    const user = userEvent.setup();
    const { onStart, box } = setup({ live: false });
    await user.type(box, 'Write a tagline{Enter}');
    expect(onStart).toHaveBeenCalledWith('Write a tagline');
  });

  it('@all says whom it reaches and whom it skips, and refuses to interrupt', async () => {
    const user = userEvent.setup();
    const { box } = setup({ states: { [id(1)]: 'COMPLETED' } });
    await user.type(box, '@all wrap up');
    expect(reaches()).toEqual(['iris', 'theo', 'brain']);
    expect(screen.getByTestId('composer-skips')).toHaveTextContent('@nova');
    await user.click(screen.getByRole('radio', { name: 'Interrupt' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/queue-only/);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('sends with interrupt when the human picks it', async () => {
    const user = userEvent.setup();
    const { onSend, box } = setup();
    await user.click(screen.getByRole('radio', { name: 'Interrupt' }));
    await user.type(box, 'Nova, stop and shorten');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith({
      text: 'Nova, stop and shorten',
      deliveryMode: 'interrupt',
    });
  });

  it('autocompletes a handle from the roster', async () => {
    const user = userEvent.setup();
    const { box } = setup();
    await user.type(box, 'hi @th');
    await user.click(screen.getByRole('option', { name: '@theo' }));
    expect(box).toHaveValue('hi @theo ');
  });

  it('with no live run, the message starts a run with it as its goal', async () => {
    const user = userEvent.setup();
    const { onStart, onSend, box } = setup({ live: false });
    await user.type(box, 'Write a tagline for ACE');
    await user.click(screen.getByRole('button', { name: 'Start team run' }));
    expect(onStart).toHaveBeenCalledWith('Write a tagline for ACE');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('after a run has ended, the composer still writes: it starts a new run', async () => {
    const user = userEvent.setup();
    const { onStart, box } = setup({ live: false, ended: true });
    expect(screen.getByText(/has ended/i)).toBeInTheDocument();
    expect(box).toBeEnabled();
    await user.type(box, 'Once more');
    await user.click(screen.getByRole('button', { name: 'Start team run' }));
    expect(onStart).toHaveBeenCalledWith('Once more');
  });

  it('an ended run is read-only: nothing can be written', () => {
    setup({ readOnly: true });
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
  });
});
