/**
 * Agentic nodes, Phase 1 (FR-TOOL-008): what a command's output looks like by the time a model
 * reads it. A model gets the head (what the command was doing) and the tail (how it ended), with
 * the cut between them said plainly, never a silent truncation.
 */

/** What a model is given of one stream of one command (`agentic-nodes-prompt.md`, Command runner). */
export const MODEL_OUTPUT_CHARS = 30_000;

const marker = (cut: number): string => `\n[… ${cut} chars cut …]\n`;

/** `text` if it fits in `max` characters; otherwise its first and last halves around a cut marker. */
export function capOutput(text: string, max: number = MODEL_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const head = Math.ceil(max / 2);
  const tail = max - head;
  return text.slice(0, head) + marker(text.length - max) + (tail === 0 ? '' : text.slice(-tail));
}

/**
 * A stream's output as it arrives, kept to at most `limit` characters: the first half that came,
 * and a rolling last half. Whatever fell between them is counted, so the cut can be reported.
 */
export class OutputBuffer {
  private head = '';
  private tail = '';
  private droppedChars = 0;

  constructor(private readonly limit: number) {}

  /** Characters received since the buffer was last emptied, retained or not. */
  get length(): number {
    return this.head.length + this.tail.length + this.droppedChars;
  }

  /** Characters received but no longer retained. */
  get dropped(): number {
    return this.droppedChars;
  }

  push(chunk: string): void {
    const half = Math.ceil(this.limit / 2);
    let rest = chunk;
    if (this.head.length < half) {
      const room = half - this.head.length;
      this.head += rest.slice(0, room);
      rest = rest.slice(room);
    }
    if (rest === '') return;
    this.tail += rest;
    const keep = this.limit - half;
    if (this.tail.length > keep) {
      this.droppedChars += this.tail.length - keep;
      this.tail = keep === 0 ? '' : this.tail.slice(-keep);
    }
  }

  /** The output so far, capped at `max` characters with any cut marked. */
  text(max: number = MODEL_OUTPUT_CHARS): string {
    if (this.droppedChars === 0) return capOutput(this.head + this.tail, max);
    const keepHead = Math.min(this.head.length, Math.ceil(max / 2));
    const keepTail = Math.min(this.tail.length, max - keepHead);
    const cut = this.length - keepHead - keepTail;
    return (
      this.head.slice(0, keepHead) +
      marker(cut) +
      (keepTail === 0 ? '' : this.tail.slice(-keepTail))
    );
  }

  /** {@link text}, then empties the buffer: "new output since the last call". */
  take(max: number = MODEL_OUTPUT_CHARS): string {
    const text = this.text(max);
    this.head = '';
    this.tail = '';
    this.droppedChars = 0;
    return text;
  }
}
