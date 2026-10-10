import { DomainMessageSchema, type DomainMessage } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { createDomainProjection } from '../projection.js';
import { filterForNode, projectChat } from '../project-chat.js';
import { RUN, RunLog, agent, envOf, msgOf, nodeId, runOf, text } from './run-log.js';

/*
 * D303 projectChat: a run's conversation is a pure fold of its event log. Fixtures are written
 * event by event, the way the engine emits them.
 */

const summaryOf = (messages: readonly DomainMessage[]) =>
  messages.map(
    (message) => `${message.type}:${message.author.nodeId ?? message.author.kind}:${message.text}`,
  );

describe('D303 projectChat — a plain run', () => {
  const log = new RunLog([agent(1, 'Writer')])
    .started()
    .turn(1, 1, 'A tagline: Go further.')
    .completed();
  const messages = projectChat(log.events, log.context());

  it('narrates the start, the turn and the end', () => {
    expect(summaryOf(messages)).toEqual([
      'system:system:Run started.',
      `agent:${nodeId(1)}:A tagline: Go further.`,
      'system:system:Run COMPLETE.',
    ]);
  });

  it('gives the turn its outcome, duration, output and auto text (D327)', () => {
    const turn = messages[1];
    expect(turn).toMatchObject({
      id: `turn:${runOf(1)}`,
      textSource: 'auto',
      output: text('A tagline: Go further.'),
      turn: { turnId: runOf(1), trigger: 'dispatch', outcome: 'OK', durationMs: 2000, steps: [] },
    });
  });

  it('every message parses against the contract and has a unique, ordered cursor', () => {
    for (const message of messages) expect(DomainMessageSchema.parse(message)).toEqual(message);
    const cursors = messages.map((message) => message.cursor);
    expect(new Set(cursors).size).toBe(cursors.length);
    const asNumbers = cursors.map((cursor) => cursor.split('.').map(Number) as [number, number]);
    const sorted = [...asNumbers].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    expect(asNumbers).toEqual(sorted);
  });

  it('is deterministic: the same events give the same messages', () => {
    expect(projectChat(log.events, log.context())).toEqual(messages);
    expect(projectChat([...log.events].reverse(), log.context())).toEqual(messages);
  });

  it('shortens a long output to ~280 characters at a word, marked auto', () => {
    const long = new RunLog([agent(1, 'Writer')]).started().turn(1, 1, 'word '.repeat(200));
    const turn = projectChat(long.events, long.context())[1];
    expect(turn?.text.length).toBeLessThanOrEqual(281);
    expect(turn?.text.endsWith('…')).toBe(true);
    expect(turn?.textSource).toBe('auto');
  });
});

describe('D303/D310 projectChat — a handoff chain', () => {
  const log = new RunLog([
    agent(1, 'Writer'),
    agent(2, 'Review'),
    agent(3, 'Director', { brain: true }),
  ])
    .started()
    .turn(1, 1, 'Draft: Go further.')
    .envelope(1, 1, 1, [2], 'HANDOFF', 'First draft of the tagline.')
    .routed(1, 'FORWARDED', 'brain')
    .transfer(1, 2, 1)
    .turn(2, 2, 'Approved.', undefined, { kind: 'envelope', envelopeIds: [envOf(1)] })
    .completed();
  const messages = projectChat(log.events, log.context());

  it('shows the handoff from → to, forwarded by the Brain', () => {
    const handoff = messages.find((message) => message.type === 'envelope');
    expect(handoff).toMatchObject({
      author: { kind: 'node', nodeId: nodeId(1) },
      to: [nodeId(2)],
      text: 'First draft of the tagline.',
      textSource: 'summary',
      envelope: { id: envOf(1), kind: 'HANDOFF', from: nodeId(1), routing: 'FORWARDED' },
    });
    expect(handoff?.envelope?.history).toEqual([
      expect.objectContaining({ decision: 'FORWARDED', by: 'brain' }),
    ]);
  });

  it("uses the envelope's summary as the sender's turn text (D327)", () => {
    expect(messages.find((message) => message.id === `turn:${runOf(1)}`)).toMatchObject({
      text: 'First draft of the tagline.',
      textSource: 'summary',
      output: text('Draft: Go further.'),
    });
  });

  it('records why the next turn started', () => {
    expect(messages.find((message) => message.id === `turn:${runOf(2)}`)?.turn?.trigger).toBe(
      'envelope',
    );
  });

  it('a transfer that delivered a team envelope adds no second message', () => {
    expect(messages.filter((message) => message.type === 'envelope')).toHaveLength(1);
  });

  it("a HANDOFF's files come from its turn's output, so the log never repeats them (FR-MM-004)", () => {
    const image = {
      type: 'image' as const,
      artifactId: '01JBXQ8Z9KQ4R7N2VWXYZ0ART1',
      mime: 'image/png',
      name: 'logo.png',
      size: 512,
    };
    const withFile = new RunLog([agent(1, 'Writer'), agent(2, 'Review')])
      .started()
      .state(1, 1, 'RUNNING')
      .output(1, 1, [image])
      .state(1, 1, 'COMPLETED')
      .envelope(1, 1, 1, [2], 'HANDOFF', 'The logo.');
    const handoff = projectChat(withFile.events, withFile.context()).find(
      (message) => message.type === 'envelope',
    );
    expect(handoff?.artifacts).toEqual([
      { path: 'logo.png', bytes: 512, commit: null, artifactId: image.artifactId },
    ]);
  });

  it('narrates a run from before Domain, whose handoffs are bare edge transfers', () => {
    const legacy = new RunLog([agent(1, 'Writer'), agent(2, 'Review')])
      .started()
      .turn(1, 1, 'Draft: Go further.')
      .transfer(1, 2)
      .turn(2, 2, 'Approved.')
      .completed();
    const handoff = projectChat(legacy.events, legacy.context()).find(
      (message) => message.type === 'envelope',
    );
    expect(handoff).toMatchObject({
      author: { nodeId: nodeId(1) },
      to: [nodeId(2)],
      text: 'Draft: Go further.',
      textSource: 'auto',
      envelope: { kind: 'HANDOFF', from: nodeId(1) },
    });
  });

  it('a human edit logs both versions (D310)', () => {
    const edited = new RunLog([agent(1, 'Writer'), agent(2, 'Review')])
      .started()
      .turn(1, 1, 'draft')
      .envelope(1, 1, 1, [2], 'FLAG', 'Too long.')
      .routed(1, 'HELD', 'brain', { reason: 'manual routing' })
      .routed(1, 'EDITED', 'human', { edit: { summary: 'Cut it to six words.' } });
    const messages = projectChat(edited.events, edited.context());
    const envelope = messages.find((message) => message.type === 'envelope');
    expect(envelope?.text).toBe('Cut it to six words.');
    expect(envelope?.envelope?.original).toEqual({
      kind: 'FLAG',
      to: [nodeId(2)],
      summary: 'Too long.',
    });
    expect(envelope?.envelope?.history.map((step) => step.decision)).toEqual(['HELD', 'EDITED']);
    // The Brain says what it held, to both ends.
    expect(messages.find((message) => message.type === 'brain')).toMatchObject({
      text: 'Held FLAG from @writer to @review for your decision: manual routing.',
      to: [nodeId(1), nodeId(2)],
    });
  });
});

describe('D309 projectChat — a direct instruction', () => {
  const log = new RunLog([agent(1, 'Nova'), agent(2, 'Iris')])
    .started()
    .state(1, 1, 'RUNNING')
    .human(1, 'Nova, tighten the hook', [{ node: 1, handle: 'nova' }])
    .instruction(1, 1, 'PENDING')
    .output(1, 1, text('first try'))
    .state(1, 1, 'COMPLETED')
    .state(1, 2, 'RUNNING', {
      attempt: 2,
      trigger: { kind: 'instruction', messageIds: [msgOf(1)] },
    })
    .instruction(1, 1, 'DELIVERED', 2)
    .output(1, 2, text('tighter'))
    .state(1, 2, 'COMPLETED')
    .instruction(1, 1, 'DONE', 2);
  const messages = projectChat(log.events, log.context());

  it('shows the message, who it is for, and its delivery state as it moves', () => {
    const human = messages.find((message) => message.type === 'human');
    expect(human).toMatchObject({
      id: msgOf(1),
      author: { kind: 'human' },
      text: 'Nova, tighten the hook',
      to: [nodeId(1)],
      delivery: [{ nodeId: nodeId(1), state: 'DONE' }],
    });
  });

  it('streams each state change as an update to that one message', () => {
    const projection = createDomainProjection(log.context());
    const updates = log.events.flatMap((event) =>
      projection.apply(event).filter((op) => op.message.id === msgOf(1)),
    );
    expect(updates.map((op) => `${op.op}:${op.message.delivery?.[0]?.state ?? ''}`)).toEqual([
      'append:PENDING',
      'update:DELIVERED',
      'update:DONE',
    ]);
  });

  it('the turn that carried it says it was an instruction', () => {
    expect(messages.find((message) => message.id === `turn:${runOf(2)}`)?.turn).toMatchObject({
      trigger: 'instruction',
      attempt: 2,
      outcome: 'OK',
    });
  });

  it('a delivery still PENDING when the run ends is DROPPED', () => {
    const dropped = new RunLog([agent(1, 'Nova')])
      .started()
      .human(1, 'Nova, one more', [{ node: 1, handle: 'nova' }])
      .instruction(1, 1, 'PENDING')
      .completed('HALTED');
    const human = projectChat(dropped.events, dropped.context()).find(
      (message) => message.type === 'human',
    );
    expect(human?.delivery).toEqual([{ nodeId: nodeId(1), state: 'DROPPED' }]);
  });

  it('a goal has no recipients and no delivery: every node reads it', () => {
    const goal = new RunLog([agent(1, 'Nova')]).started().human(1, 'Write a tagline', []);
    const human = projectChat(goal.events, goal.context())[1];
    expect(human).toMatchObject({ type: 'human', text: 'Write a tagline' });
    expect(human?.to).toBeUndefined();
    expect(human?.delivery).toBeUndefined();
  });
});

describe('D309 projectChat — an interrupted turn', () => {
  const log = new RunLog([agent(1, 'Nova')])
    .started()
    .state(1, 1, 'RUNNING')
    .human(1, 'Nova, stop — new angle', [{ node: 1, handle: 'nova' }], {
      deliveryMode: 'interrupt',
    })
    .push('node.interrupted', {
      runId: RUN,
      nodeRunId: runOf(1),
      nodeId: nodeId(1),
      messageId: msgOf(1),
      partialOutput: text('Half a dra'),
    })
    .state(1, 1, 'STOPPED')
    .state(1, 2, 'RUNNING', {
      attempt: 2,
      trigger: { kind: 'instruction', messageIds: [msgOf(1)] },
    });
  const messages = projectChat(log.events, log.context());

  it('keeps the partial output and marks the turn INTERRUPTED, not STOPPED', () => {
    expect(messages.find((message) => message.id === `turn:${runOf(1)}`)).toMatchObject({
      text: 'Half a dra',
      output: text('Half a dra'),
      turn: { outcome: 'INTERRUPTED' },
    });
  });

  it('a turn the run Stop cut short is STOPPED', () => {
    const stopped = new RunLog([agent(1, 'Nova')])
      .started()
      .state(1, 1, 'RUNNING')
      .state(1, 1, 'STOPPED');
    expect(projectChat(stopped.events, stopped.context())[1]?.turn?.outcome).toBe('STOPPED');
  });

  it('the new turn follows it', () => {
    expect(messages.at(-1)).toMatchObject({ id: `turn:${runOf(2)}`, turn: { outcome: 'RUNNING' } });
  });
});

describe('D303 projectChat — the steps of a turn', () => {
  const toolCall = (resultSummary: string) => ({
    runId: RUN,
    nodeRunId: runOf(1),
    toolCall: {
      id: '01JBXQ8Z9KQ4R7N2VWXYZ0TCA1',
      nodeRunId: runOf(1),
      toolName: 'cli_read',
      args: {},
      resultSummary,
      durationMs: 12,
      status: 'ok',
      verdicts: [],
      at: '2026-10-10T09:00:03.000Z',
    },
  });

  it('lists each tool call on its turn, its result on one line and cut at 120 characters', () => {
    const long = `1 <!DOCTYPE html>\n2 <html lang="en">\n${'3 body styles '.repeat(20)}`;
    const log = new RunLog([agent(1, 'Writer')])
      .started()
      .state(1, 1, 'RUNNING')
      .push('tool.call', toolCall('Files saved'))
      .push('tool.call', toolCall(long));
    const steps = projectChat(log.events, log.context())[1]?.turn?.steps ?? [];
    expect(steps.map((step) => step.label)).toEqual([
      'cli_read: Files saved',
      `cli_read: ${long.replace(/\s+/g, ' ').slice(0, 120)}…`,
    ]);
    expect(steps[0]).toMatchObject({ status: 'ok', durationMs: 12 });
  });
});

describe('D308 projectChat — a handle collision', () => {
  const log = new RunLog([agent(1, 'Review'), agent(2, 'Review')])
    .started()
    .human(1, '@review-2 check the numbers', [{ node: 2, handle: 'review-2' }]);
  const messages = projectChat(log.events, log.context());

  it('the second Review is @review-2, and only its lens sees the message', () => {
    expect(log.context().roster.map((entry) => entry.handle)).toEqual(['review', 'review-2']);
    expect(filterForNode(messages, nodeId(2)).map((message) => message.id)).toEqual([msgOf(1)]);
    expect(filterForNode(messages, nodeId(1))).toEqual([]);
  });
});

describe('D5 filterForNode', () => {
  const log = new RunLog([agent(1, 'Writer'), agent(2, 'Review'), agent(3, 'Fact')])
    .started()
    .turn(1, 1, 'draft')
    .envelope(1, 1, 1, [2], 'HANDOFF', 'Draft.')
    .turn(2, 2, 'looks fine')
    .envelope(2, 2, 2, [3], 'QUERY', 'Is 1969 right?')
    .human(1, 'Fact, check the year', [{ node: 3, handle: 'fact' }]);
  const messages = projectChat(log.events, log.context());

  it("a node's lens: what it sent, what was addressed to it, envelopes it is on either end of", () => {
    expect(filterForNode(messages, nodeId(2)).map((message) => message.id)).toEqual([
      `env:${envOf(1)}`,
      `turn:${runOf(2)}`,
      `env:${envOf(2)}`,
    ]);
    expect(filterForNode(messages, nodeId(3)).map((message) => message.id)).toEqual([
      `env:${envOf(2)}`,
      msgOf(1),
    ]);
  });
});

describe('D305/D313/D323 run-level notices', () => {
  const log = new RunLog([agent(1, 'Nova'), agent(2, 'Iris')])
    .started()
    .config({ tokenBudget: 1000, stayOpen: true })
    .push('run.token_budget', { runId: RUN, limit: 1000, used: 820, level: 'WARN' })
    .push('run.blocked', {
      runId: RUN,
      reason: 'LOOP_GUARD',
      detail: 'A fourth QUERY/FLAG round trip was held.',
      nodeIds: [nodeId(1), nodeId(2)],
    })
    .push('run.resumed', { runId: RUN })
    .push('run.parked', { runId: RUN, graph: 'complete' });
  const messages = projectChat(log.events, log.context());

  it('says what the config is, warns on the budget, says why it is blocked and that it is parked', () => {
    expect(messages.map((message) => message.text)).toEqual([
      'Run started.',
      'Supervised routing: the Brain forwards envelopes. Loop guard: 3 round trips per pair. Token budget: 1,000 tokens. The run stays open after the graph finishes; End it when done.',
      '80% of the token budget used: 820 of 1,000 tokens.',
      'Run BLOCKED (LOOP_GUARD: @nova and @iris). A fourth QUERY/FLAG round trip was held. Resume or end the run.',
      'Run resumed.',
      'The graph has finished. The run stays open: address any node to continue, or End it.',
    ]);
    expect(messages[3]?.to).toEqual([nodeId(1), nodeId(2)]);
  });
});
