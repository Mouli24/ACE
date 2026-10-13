import { rosterFor, type Node, type RosterEntry } from '@ace/contracts';

import { createNode } from '../nodes/factory';
import { completeHandle, handleOptions, handlePartial, previewChatTarget } from './target';

/*
 * D302: the chat composer names another node with `@handle`, read by the engine's own
 * `resolveChatTarget`, so the preview is what the engine will do — and the session never switches.
 */

const WF = '01JBXQ8Z9KQ4R7N2VWXYZ0WKFW';
function agent(name: string): Node {
  return { ...createNode('agent', WF, { x: 0, y: 0 }), name } as Node;
}
const coder = agent('Coder');
const critic = agent('Critic');
const writer = agent('Draft writer');
const roster: RosterEntry[] = rosterFor([coder, critic, writer]);

describe('D302 the send preview', () => {
  it('goes to the main node without a handle', () => {
    expect(previewChatTarget('fix the build', roster, coder.id)).toEqual({
      canSend: true,
      targetNodeId: coder.id,
      name: 'Coder',
    });
  });

  it('goes to the one node an @handle names, wherever it sits', () => {
    expect(previewChatTarget('what do you think @critic?', roster, coder.id)).toEqual({
      canSend: true,
      targetNodeId: critic.id,
      name: 'Critic',
    });
  });

  it('refuses an unknown handle, two nodes or @all, with the reason', () => {
    const unknown = previewChatTarget('@critc look', roster, coder.id);
    expect(unknown.canSend).toBe(false);
    expect(unknown.error).toContain('@critc');
    expect(unknown.error).toContain('@critic');
    expect(previewChatTarget('@coder @critic both', roster, coder.id).canSend).toBe(false);
    expect(previewChatTarget('@all hi', roster, coder.id).error).toMatch(/@all/);
  });
});

describe('D302 the @ picker', () => {
  it('opens on an @partial at the caret, never inside an email address', () => {
    expect(handlePartial('ask @cr', 7)).toEqual({ start: 4, partial: 'cr' });
    expect(handlePartial('@', 1)).toEqual({ start: 0, partial: '' });
    expect(handlePartial('mail me@cr', 10)).toBeUndefined();
    expect(handlePartial('@critic done', 12)).toBeUndefined();
  });

  it('offers the handles that start with it, or whose name holds it', () => {
    expect(handleOptions(roster, 'c').map((entry) => entry.handle)).toEqual(['coder', 'critic']);
    expect(handleOptions(roster, 'writ').map((entry) => entry.handle)).toEqual(['draft-writer']);
    expect(handleOptions(roster, '')).toHaveLength(3);
  });

  it('completes the partial to the handle and a space, keeping the rest', () => {
    expect(completeHandle('ask @cr now', { start: 4, partial: 'cr' }, 7, 'critic')).toEqual({
      text: 'ask @critic  now',
      caret: 12,
    });
    expect(completeHandle('@', { start: 0, partial: '' }, 1, 'coder')).toEqual({
      text: '@coder ',
      caret: 7,
    });
  });
});
