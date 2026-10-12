import type { DomainMessage, RosterEntry } from '@ace/contracts';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { configureApi } from '../app/api';
import { Conversation } from './Conversation';
import type { DomainLook } from './looks';

configureApi({ token: 'mock', baseUrl: 'http://mock.local' });

/* A node with no handle (an Input, an Output, a merge) is named by its name, never its id. */

const RUN = '01ARZ3NDEKTSV4RRFFQ69G5FB0';
const INPUT = '01ARZ3NDEKTSV4RRFFQ69G5N09';
const AGENT = '01ARZ3NDEKTSV4RRFFQ69G5N01';
const ENV = '01ARZ3NDEKTSV4RRFFQ69G5E01';
const NOW = '2026-10-10T00:00:00.000Z';

const messages: DomainMessage[] = [
  {
    id: 'turn:1',
    runId: RUN,
    cursor: '3.0',
    author: { kind: 'node', nodeId: INPUT },
    type: 'agent',
    text: 'Write Python code for two sum.',
    at: NOW,
  },
  {
    id: `env:${ENV}`,
    runId: RUN,
    cursor: '4.0',
    author: { kind: 'node', nodeId: INPUT },
    type: 'envelope',
    text: 'Write Python code for two sum.',
    to: [AGENT],
    envelope: { id: ENV, kind: 'HANDOFF', from: INPUT, history: [] },
    at: NOW,
  },
];

describe('Domain conversation names', () => {
  it('names a node with no handle by its name, in the header and on an envelope', () => {
    render(
      <Conversation
        messages={messages}
        roster={[{ nodeId: AGENT, handle: 'agent', name: 'Agent', kind: 'agent', brain: false }]}
        names={new Map([[INPUT, 'Brief']])}
        tokens={{}}
        readOnly
        onRoute={vi.fn()}
      />,
    );
    expect(screen.queryByText(new RegExp(INPUT))).not.toBeInTheDocument();
    expect(screen.getAllByText('Brief').length).toBeGreaterThan(0);
    expect(screen.getByText('Brief → @agent')).toBeInTheDocument();
  });
});

const BRAIN = '01ARZ3NDEKTSV4RRFFQ69G5N03';
const roster: RosterEntry[] = [
  { nodeId: AGENT, handle: 'writer', name: 'Writer', kind: 'agent', brain: false },
  { nodeId: BRAIN, handle: 'brain', name: 'Director', kind: 'agent', brain: true },
];
const looks = new Map<string, DomainLook>([
  [AGENT, { color: '#ef6b3f', letter: 'W', model: undefined }],
  [BRAIN, { color: '#7a62d6', letter: 'D', model: undefined }],
]);
const at = (cursor: string) => ({ runId: RUN, cursor, at: NOW });

function show(list: DomainMessage[], props: Partial<Parameters<typeof Conversation>[0]> = {}) {
  render(
    <Conversation
      messages={list}
      roster={roster}
      looks={looks}
      tokens={{}}
      readOnly={false}
      onRoute={vi.fn()}
      {...props}
    />,
  );
}

const row = (text: string) =>
  screen.getByText(text).closest('[data-testid="domain-message"]') as HTMLElement;

describe('Domain conversation in the theme (D336)', () => {
  it('an agent has its colour, name and @handle chip; you are "You", with no chip', () => {
    show([
      { ...at('1.0'), id: 'h', author: { kind: 'human' }, type: 'human', text: 'Go.' },
      {
        ...at('2.0'),
        id: 'a',
        author: { kind: 'node', nodeId: AGENT },
        type: 'agent',
        text: 'On it.',
      },
    ]);
    expect(row('Go.')).toHaveTextContent('YYou');
    expect(within(row('Go.')).queryByText(/^@/)).not.toBeInTheDocument();
    expect(row('On it.')).toHaveTextContent('WWriter@writer');
    expect(within(row('On it.')).getByText('W')).toHaveStyle({ background: '#ef6b3f' });
  });

  it("the Brain speaks in its node's colour, or as ✳ when the workflow has no Brain node", () => {
    const held: DomainMessage = {
      ...at('1.0'),
      id: 'b',
      author: { kind: 'brain' },
      type: 'brain',
      text: 'Held it for you.',
    };
    show([held]);
    expect(row('Held it for you.')).toHaveTextContent('DDirector@brain');
    cleanup();
    show([held], { roster: roster.slice(0, 1) });
    expect(row('Held it for you.')).toHaveTextContent('✳Brain');
  });

  it('a system message is one compact muted line, with no avatar', () => {
    show([
      {
        ...at('1.0'),
        id: 'sys:1.0',
        author: { kind: 'system' },
        type: 'system',
        text: 'Run started.',
      },
    ]);
    expect(row('Run started.')).toHaveAttribute('data-type', 'system');
    expect(row('Run started.')).not.toHaveTextContent('You');
  });

  it('a running turn shows its live text until its message says what it said', () => {
    const turn = {
      turnId: '01ARZ3NDEKTSV4RRFFQ69G5T01',
      trigger: 'instruction' as const,
      iteration: 1,
      attempt: 2,
      steps: [],
      outcome: 'RUNNING' as const,
    };
    show(
      [
        {
          ...at('1.0'),
          id: 'turn:1',
          author: { kind: 'node', nodeId: AGENT },
          type: 'agent',
          text: '',
          turn,
        },
      ],
      { tokens: { [turn.turnId]: 'Thinking about' } },
    );
    expect(row('Thinking about')).toHaveTextContent('instruction · RUNNING');
  });

  it('"What it did" also opens a turn that has output but no steps', async () => {
    const user = userEvent.setup();
    show([
      {
        ...at('1.0'),
        id: 'turn:1',
        author: { kind: 'node', nodeId: AGENT },
        type: 'agent',
        text: 'Short.',
        textSource: 'auto',
        turn: {
          turnId: '01ARZ3NDEKTSV4RRFFQ69G5T01',
          trigger: 'dispatch',
          iteration: 1,
          attempt: 1,
          steps: [],
          outcome: 'OK',
        },
        output: [{ type: 'text', text: 'Short. And the rest of it.' }],
      },
    ]);
    const toggle = within(row('Short.')).getByRole('button', { name: /What it did/ });
    expect(toggle).not.toHaveTextContent('steps');
    await user.click(toggle);
    expect(screen.getByText('Short. And the rest of it.')).toBeVisible();
  });

  it('an output card without Forge to open in falls back to the artifact', () => {
    show([
      {
        ...at('1.0'),
        id: 'turn:1',
        author: { kind: 'node', nodeId: AGENT },
        type: 'agent',
        text: 'Wrote it.',
        artifacts: [
          { path: 'out/notes.md', bytes: 2048, commit: null, artifactId: AGENT },
          { path: 'out/draft.md', bytes: null, commit: null },
        ],
      },
    ]);
    const cards = within(row('Wrote it.')).getAllByTestId('domain-output');
    expect(cards[0]).toHaveTextContent('notes.md');
    expect(cards[0]).toHaveTextContent('out/notes.md · 2,048 bytes');
    expect(within(cards[0]!).getByRole('link', { name: 'Open notes.md' })).toHaveAttribute(
      'href',
      expect.stringContaining(`/artifacts/${AGENT}/content`),
    );
    expect(within(cards[1]!).queryByRole('link')).not.toBeInTheDocument();
    expect(within(cards[1]!).queryByRole('button')).not.toBeInTheDocument();
  });

  it('with Forge to open in, a project file opens there', async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn();
    show(
      [
        {
          ...at('1.0'),
          id: 'turn:1',
          author: { kind: 'node', nodeId: AGENT },
          type: 'agent',
          text: 'Wrote it.',
          artifacts: [{ path: 'D:\\work\\proj\\src\\app.ts', bytes: null, commit: null }],
        },
      ],
      { folderPath: 'D:\\work\\proj', onOpenFile },
    );
    await user.click(screen.getByRole('button', { name: 'Open app.ts' }));
    expect(onOpenFile).toHaveBeenCalledWith('src/app.ts');
  });

  it('nothing said yet is the empty state', () => {
    show([]);
    expect(screen.getByText('Nothing has been said in this run yet.')).toBeInTheDocument();
  });
});
