/**
 * A Server-Sent Events parser, fed text as it arrives (D314). A browser's `EventSource` cannot send
 * the Bearer token, so the SDK reads Domain's stream with `fetch` and parses it here, following the
 * HTML spec's event-stream rules: lines end in LF, CRLF or CR; a blank line dispatches; a line
 * starting with `:` is a comment; `data` lines join with LF; an event with no data is not
 * dispatched; the event type defaults to `message`.
 */

export interface SseEvent {
  event: string;
  data: string;
  /** Present when the event carried an `id` field. */
  id?: string;
}

export interface SseParser {
  feed(chunk: string): void;
  /** The stream ended: an unterminated last event is dropped, as the spec says. */
  end(): void;
}

export function createSseParser(onEvent: (event: SseEvent) => void): SseParser {
  let buffer = '';
  /** A CR ended the last chunk: a LF opening the next one belongs to it. */
  let pendingCr = false;
  let event = '';
  let data: string[] = [];
  let id: string | undefined;

  const dispatch = (): void => {
    if (data.length > 0) {
      onEvent({
        event: event === '' ? 'message' : event,
        data: data.join('\n'),
        ...(id === undefined ? {} : { id }),
      });
    }
    event = '';
    data = [];
    id = undefined;
  };

  const line = (text: string): void => {
    if (text === '') {
      dispatch();
      return;
    }
    if (text.startsWith(':')) return;
    const colon = text.indexOf(':');
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id' && !value.includes('\0')) id = value;
  };

  return {
    feed(chunk) {
      let text = chunk;
      if (pendingCr && text.startsWith('\n')) text = text.slice(1);
      pendingCr = false;
      buffer += text;
      for (;;) {
        const match = /\r\n|\r|\n/u.exec(buffer);
        if (match === null) break;
        // A CR at the very end may be the first half of a CRLF still on its way.
        if (match[0] === '\r' && match.index === buffer.length - 1) {
          line(buffer.slice(0, match.index));
          buffer = '';
          pendingCr = true;
          break;
        }
        line(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
      }
    },
    end() {
      buffer = '';
      event = '';
      data = [];
      id = undefined;
    },
  };
}
