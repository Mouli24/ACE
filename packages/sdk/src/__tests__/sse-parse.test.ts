import { describe, expect, it } from 'vitest';

import { createSseParser, type SseEvent } from '../sse-parse.js';

/* D314: the SDK reads Domain's stream with fetch, so it parses Server-Sent Events itself. */

function parse(...chunks: string[]): SseEvent[] {
  const events: SseEvent[] = [];
  const parser = createSseParser((event) => events.push(event));
  for (const chunk of chunks) parser.feed(chunk);
  parser.end();
  return events;
}

describe('D314 createSseParser', () => {
  it('reads an event, its id and its data, whatever the chunks cut through', () => {
    const text = 'event: chat.message\nid: 42\ndata: {"a":1}\n\n';
    const whole = parse(text);
    expect(whole).toEqual([{ event: 'chat.message', id: '42', data: '{"a":1}' }]);
    // One character at a time, the same event.
    expect(parse(...text.split(''))).toEqual(whole);
  });

  it('joins data lines, reads CRLF, and takes one optional space after the colon', () => {
    expect(parse('event:x\r\ndata:one\r\ndata:  two\r\n\r\n')).toEqual([
      { event: 'x', data: 'one\n two' },
    ]);
  });

  it('skips comments, and dispatches nothing for an event with no data', () => {
    expect(parse(': keep-alive\n\n', 'event: ping\n\n', 'data: hi\n\n')).toEqual([
      { event: 'message', data: 'hi' },
    ]);
  });

  it('keeps an unfinished event until the blank line that ends it', () => {
    const events: SseEvent[] = [];
    const parser = createSseParser((event) => events.push(event));
    parser.feed('event: a\ndata: 1\n');
    expect(events).toEqual([]);
    parser.feed('\n');
    expect(events).toEqual([{ event: 'a', data: '1' }]);
  });
});
