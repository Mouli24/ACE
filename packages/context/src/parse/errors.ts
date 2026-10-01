/**
 * A document could not be parsed. `message` is the human reason the user sees on the document
 * (FR-RAG-003), so it never carries a stack or library jargon.
 */
export class ParseError extends Error {
  override readonly name = 'ParseError';
}

export const EMPTY_DOCUMENT_MESSAGE = 'The document has no text to index.';
