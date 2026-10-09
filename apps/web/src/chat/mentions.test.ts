import { insertMention, mentionMatches, mentionQuery, parseMention } from './mentions';

const writer = { id: 'w', name: 'Writer' };
const writer2 = { id: 'w2', name: 'Writer 2' };
const critic = { id: 'c', name: 'Draft critic' };
const nodes = [writer, writer2, critic];

describe('FR-CHAT-004 @mentions', () => {
  it('opens a query only while an @word is being typed at the end', () => {
    expect(mentionQuery('@Wr')).toBe('wr');
    expect(mentionQuery('hello @dr')).toBe('dr');
    expect(mentionQuery('@')).toBe('');
    expect(mentionQuery('@Writer write a poem')).toBeUndefined();
    expect(mentionQuery('mail me@example')).toBeUndefined();
  });

  it('matches every node whose name contains the query', () => {
    expect(mentionMatches('@wri', nodes)).toEqual([writer, writer2]);
    expect(mentionMatches('@crit', nodes)).toEqual([critic]);
    expect(mentionMatches('no mention', nodes)).toEqual([]);
  });

  it('completes the open query to the full name, ready for the message', () => {
    expect(insertMention('@Dr', 'Draft critic')).toBe('@Draft critic ');
    expect(insertMention('ask @wr', 'Writer')).toBe('ask @Writer ');
  });

  it('routes a message that opens with a mention to that node, without the mention', () => {
    expect(parseMention('@Writer write a haiku', nodes)).toEqual({
      node: writer,
      body: 'write a haiku',
    });
    expect(parseMention('@writer: shorter please', nodes)).toEqual({
      node: writer,
      body: 'shorter please',
    });
  });

  it('takes the longest name, so names with spaces and shared prefixes resolve', () => {
    expect(parseMention('@Writer 2 go', nodes)).toEqual({ node: writer2, body: 'go' });
    expect(parseMention('@Draft critic review it', nodes)).toEqual({
      node: critic,
      body: 'review it',
    });
  });

  it('leaves a message without a known mention for the node already in the chat', () => {
    expect(parseMention('write a haiku', nodes)).toEqual({
      node: undefined,
      body: 'write a haiku',
    });
    expect(parseMention('@Nobody hi', nodes)).toEqual({ node: undefined, body: '@Nobody hi' });
    expect(parseMention('@Writers hi', nodes)).toEqual({ node: undefined, body: '@Writers hi' });
  });

  it('accepts a bare mention with nothing to say yet', () => {
    expect(parseMention('@Writer', nodes)).toEqual({ node: writer, body: '' });
  });
});
